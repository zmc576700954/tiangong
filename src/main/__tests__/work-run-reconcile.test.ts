import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyMapS5aSchema } from '../map/schema'
import { WorkRunService, QUEUED_STALE_MS } from '../map/work-run-service'
import { recomputeExecutionState, cancelPendingRecomputes } from '../map/execution-state'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
      status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
    );
    CREATE TABLE node_evidence (
      id               TEXT PRIMARY KEY,
      project_path     TEXT,
      graph_id         TEXT NOT NULL,
      graph_type       TEXT NOT NULL CHECK(graph_type IN ('online','dev','test')),
      node_entity_key  TEXT NOT NULL,
      node_id          TEXT,
      evidence_level   TEXT NOT NULL CHECK(evidence_level IN ('E1','E2','E3','E4')),
      evidence_type    TEXT NOT NULL CHECK(evidence_type IN (
        'changed_files','commit','test_run','session_turn',
        'artifact','human_confirm','runtime_observation')),
      ref_json         TEXT NOT NULL,
      summary          TEXT,
      version_binding  TEXT NOT NULL DEFAULT 'commit'
                       CHECK(version_binding IN ('commit','content_hash','snapshot','none')),
      code_version     TEXT,
      code_dirty       INTEGER,
      base_hash        TEXT,
      current_hash     TEXT,
      freshness        TEXT NOT NULL DEFAULT 'fresh'
                       CHECK(freshness IN ('fresh','stale','unknown')),
      produced_by      TEXT NOT NULL
                       CHECK(produced_by IN ('human','agent','test_executor','system')),
      work_item_id     TEXT,
      work_run_id      TEXT,
      session_id       TEXT,
      turn_id          TEXT,
      created_at       TEXT NOT NULL,
      verified_at      TEXT,
      stale_at         TEXT,
      signed_by               TEXT,
      signed_by_display_name  TEXT,
      signed_at               TEXT,
      coverage_json           TEXT,
      basis_ref_json          TEXT,
      reproducible            INTEGER,
      expires_at       TEXT,
      renewed_from_evidence_id TEXT,
      revoked_at       TEXT,
      revoked_by       TEXT,
      revoke_reason    TEXT
    );
    CREATE TABLE node_execution_state (
      graph_id           TEXT NOT NULL,
      node_entity_key    TEXT NOT NULL,
      execution_state    TEXT NOT NULL CHECK(execution_state IN (
        'untouched','planned','in_progress','implemented',
        'verified','signed_off','failed','blocked','stale')),
      evidence_level     TEXT NOT NULL CHECK(evidence_level IN ('E0','E1','E2','E3','E4')),
      is_reproducible    INTEGER NOT NULL DEFAULT 0,
      evidence_count     INTEGER NOT NULL DEFAULT 0,
      stale_count        INTEGER NOT NULL DEFAULT 0,
      derivation_version INTEGER NOT NULL DEFAULT 1,
      inputs_hash        TEXT,
      computed_at        INTEGER NOT NULL,
      PRIMARY KEY (graph_id, node_entity_key)
    );
  `)
  applyMapS5aSchema(db)
  return db
}

function insertItem(db: BetterSqlite3.Database, status: string, gateStatus: string): string {
  const id = `wi_${randomUUID().slice(0, 8)}`
  const now = '2026-01-01T00:00:00Z'
  db.prepare(
    `INSERT INTO work_items (id, lineage_id, revision, is_current, graph_id, anchor_entity_key, title, status, gate_status, depends_on_json, origin, created_at, updated_at)
     VALUES (?, ?, 1, 1, 'g1', 'key-1', '任务', ?, ?, '[]', 'human', ?, ?)`,
  ).run(id, `wl_${randomUUID().slice(0, 8)}`, status, gateStatus, now, now)
  return id
}

describe('work_runs 启动对账（僵尸 run 清偿）', () => {
  let db: BetterSqlite3.Database
  let runs: WorkRunService

  beforeEach(() => {
    db = setupDb()
    runs = new WorkRunService(db)
  })

  afterEach(() => {
    cancelPendingRecomputes()
    db.close()
  })

  function runStatus(id: string): string {
    return (db.prepare('SELECT status FROM work_runs WHERE id = ?').get(id) as { status: string }).status
  }

  function itemStatus(id: string): string {
    return (db.prepare('SELECT status FROM work_items WHERE id = ?').get(id) as { status: string }).status
  }

  function state(): Record<string, unknown> | undefined {
    return db.prepare("SELECT * FROM node_execution_state WHERE graph_id='g1' AND node_entity_key='key-1'").get() as
      | Record<string, unknown>
      | undefined
  }

  it('running run 重启后置 interrupted，节点不再永久 in_progress', () => {
    const itemId = insertItem(db, 'running', 'pass')
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    runs.claim(run.id)

    recomputeExecutionState(db, 'g1', 'key-1')
    expect(state()?.execution_state).toBe('in_progress')

    const report = runs.reconcileOnStartup()
    expect(report.interruptedRunning).toBe(1)
    expect(report.interruptedItems).toBe(1)
    expect(runStatus(run.id)).toBe('interrupted')
    expect(itemStatus(itemId)).toBe('interrupted')

    recomputeExecutionState(db, 'g1', 'key-1')
    expect(state()?.execution_state).not.toBe('in_progress')
  })

  it('结构性僵尸：queued run 的 item 已非当前 revision 时立即取消', () => {
    const itemId = insertItem(db, 'running', 'pass')
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    db.prepare("UPDATE work_items SET is_current = 0, status = 'superseded' WHERE id = ?").run(itemId)

    const report = runs.reconcileOnStartup()
    expect(report.cancelledStaleQueued).toBe(1)
    expect(runStatus(run.id)).toBe('cancelled')
  })

  it('未到阈值的 queued run 不被误杀（重启后仍可由调度器 claim）', () => {
    const itemId = insertItem(db, 'queued', 'pass')
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })

    const report = runs.reconcileOnStartup()
    expect(report.cancelledStaleQueued).toBe(0)
    expect(runStatus(run.id)).toBe('queued')
  })

  it('超过阈值的 queued run 作为时间性兜底取消，并写入可查询报告', () => {
    const itemId = insertItem(db, 'queued', 'pass')
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    const now = Date.now()
    db.prepare('UPDATE work_runs SET created_at = ? WHERE id = ?').run(now - QUEUED_STALE_MS - 60_000, run.id)

    const report = runs.reconcileOnStartup({ now })
    expect(report.cancelledStaleQueued).toBe(1)
    expect(report.queuedStaleMs).toBe(QUEUED_STALE_MS)
    expect(runStatus(run.id)).toBe('cancelled')

    const row = db
      .prepare("SELECT status, stats_json FROM map_migration_reports WHERE stage='work_runs_reconcile'")
      .get() as { status: string; stats_json: string }
    expect(row.status).toBe('ok')
    expect(JSON.parse(row.stats_json)).toMatchObject({ cancelledStaleQueued: 1 })
  })
})
