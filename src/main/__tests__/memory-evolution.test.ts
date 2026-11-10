/**
 * G2-2：进化 Layer1 采集（蓝图 II-04 验收）。
 *
 * 覆盖：完成/失败/超时/取消/中断五终态都采集且写 source_outcome；
 * 只写 step/evidence/deviation 引用；幂等；非终态与无 project_path 不产；
 * 50 条上限；采集失败不回滚 run、留痕到 map_migration_reports。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  applyMapS5aSchema,
  applyMapS6aSchema,
  applyMapS7Schema,
  applyMemorySchema,
} from '../map/schema'
import { collectMemoryHitsForRun } from '../map/memory-evolution'
import { WorkRunService } from '../map/work-run-service'
import { MemoryHitService } from '../map/memory-hit-service'

const NOW = new Date('2026-11-10T08:00:00.000Z')

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS6aSchema(db)
  applyMapS7Schema(db)
  applyMemorySchema(db)
  // 仅保留本测试用到的列（生产 DDL 见 §7.2）。
  db.exec(`
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      stage TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      stats_json TEXT,
      error_json TEXT
    )
  `)
  return db
}

interface SeedOptions {
  status?: string
  projectPath?: string | null
  anchorNodeId?: string | null
  withStep?: boolean
  evidenceCount?: number
  deviationCount?: number
}

function seedRun(db: BetterSqlite3.Database, options: SeedOptions = {}): { runId: string; stepId: string } {
  const status = options.status ?? 'completed'
  const projectPath = options.projectPath === undefined ? '/repo/a' : options.projectPath
  db.prepare(
    `INSERT INTO work_items
       (id, lineage_id, revision, project_path, graph_id, anchor_entity_key, anchor_node_id,
        title, status, gate_status, origin, created_at, updated_at)
     VALUES ('wi_1', 'lin_1', 1, ?, 'g1', 'node:a', ?, 'T', 'running', 'incomplete', 'human', ?, ?)`,
  ).run(projectPath, options.anchorNodeId ?? 'node_1', NOW.toISOString(), NOW.toISOString())

  const stepId = 'ws_1'
  if (options.withStep !== false) {
    db.prepare(
      `INSERT INTO work_steps
         (id, work_item_id, work_item_revision, seq, title, step_kind, status, created_at, updated_at)
       VALUES (?, 'wi_1', 1, 1, 'S1', 'agent', 'succeeded', 0, 0)`,
    ).run(stepId)
  }

  db.prepare(
    `INSERT INTO work_runs
       (id, work_item_id, work_item_lineage_id, work_item_revision, step_id,
        run_seq, attempt, idempotency_key, executor_kind, status, created_at)
     VALUES ('run_1', 'wi_1', 'lin_1', 1, ?, 1, 1, 'idem_1', 'agent', ?, 0)`,
  ).run(options.withStep === false ? null : stepId, status)

  for (let i = 0; i < (options.evidenceCount ?? 1); i++) {
    db.prepare(
      `INSERT INTO node_evidence
         (id, graph_id, graph_type, node_entity_key, node_id, evidence_level, evidence_type,
          ref_json, produced_by, work_run_id, created_at)
       VALUES (?, 'g1', 'dev', ?, 'node_1', 'E2', 'artifact', '{}', 'test_executor', 'run_1', ?)`,
    ).run(`ev_${i}`, `node:a${i}`, NOW.toISOString())
  }

  for (let i = 0; i < (options.deviationCount ?? 1); i++) {
    db.prepare(
      `INSERT INTO plan_deviations
         (id, work_item_id, work_run_id, derivation_version, observed_rule_version,
          task_type, computed_at)
       VALUES (?, 'wi_1', 'run_1', 'v1', 'v1', 'code', 0)`,
    ).run(`pd_${i}`)
  }

  return { runId: 'run_1', stepId }
}

describe('memory Layer1（G2-2）', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
  })

  it('completed run 采集 step/evidence/deviation，并写 source_outcome', () => {
    seedRun(db)
    const written = collectMemoryHitsForRun(db, 'run_1', NOW)
    expect(written).toBe(3)

    const hits = new MemoryHitService(db).listForRun('run_1')
    expect(hits.map((h) => h.hit_kind).sort()).toEqual(['deviation', 'evidence', 'step'])
    expect(hits.every((h) => h.source_outcome === 'completed')).toBe(true)

    const step = hits.find((h) => h.hit_kind === 'step')
    expect(step?.source_ref).toBe('work_step:ws_1')
    expect(step?.project_path).toBe('/repo/a')
    expect(step?.graph_id).toBe('g1')
    expect(step?.node_id).toBe('node_1')

    const evidence = hits.find((h) => h.hit_kind === 'evidence')
    expect(evidence?.source_ref).toBe('node_evidence:ev_0')
    expect(evidence?.score).toBe(0.8) // E2 = 0.8
  })

  it('同一 run 重复采集不重复写（幂等）', () => {
    seedRun(db)
    expect(collectMemoryHitsForRun(db, 'run_1', NOW)).toBe(3)
    expect(collectMemoryHitsForRun(db, 'run_1', NOW)).toBe(0)
    expect(new MemoryHitService(db).listForRun('run_1')).toHaveLength(3)
  })

  it.each([
    ['failed', 'failed'],
    ['timed_out', 'timeout'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
  ])('run 终态 %s 记录 source_outcome=%s', (status, expected) => {
    seedRun(db, { status })
    collectMemoryHitsForRun(db, 'run_1', NOW)
    const hits = new MemoryHitService(db).listForRun('run_1')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.source_outcome === expected)).toBe(true)
  })

  it('非终态 run 不采集', () => {
    seedRun(db, { status: 'running' })
    expect(collectMemoryHitsForRun(db, 'run_1', NOW)).toBe(0)
    expect(new MemoryHitService(db).listForRun('run_1')).toHaveLength(0)
  })

  it('无 project_path 的 run 不采集（memory_hits.project_path 非空）', () => {
    seedRun(db, { projectPath: null })
    expect(collectMemoryHitsForRun(db, 'run_1', NOW)).toBe(0)
  })

  it('每 run 最多 50 条 hit', () => {
    seedRun(db, { evidenceCount: 60 })
    const written = collectMemoryHitsForRun(db, 'run_1', NOW)
    expect(written).toBe(50)
    expect(new MemoryHitService(db).listForRun('run_1')).toHaveLength(50)
  })

  it('采集失败：run 终态不变，且留痕 map_migration_reports(kind=integrity_check)', () => {
    seedRun(db, { anchorNodeId: null, status: 'running' })
    db.exec('DROP TABLE memory_hits')

    const row = new WorkRunService(db).complete('run_1')
    expect(row?.status).toBe('completed')

    const report = db
      .prepare("SELECT kind, stage, status FROM map_migration_reports WHERE stage = 'memory:run_1'")
      .get() as { kind: string; stage: string; status: string } | undefined
    expect(report).toEqual({ kind: 'integrity_check', stage: 'memory:run_1', status: 'failed' })
  })
})
