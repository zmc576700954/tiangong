/**
 * S6a 真库回归（session-map 蓝图 §3.2/§3.5/§3.7.1/§3.7.4 + §3.7.5 验收）。
 *
 * 覆盖:E1-E4 写入方矩阵与字段组合校验/E3 CHECK(E3 库层硬约束)/E4 覆盖守卫/
 * run 内唯一性/撤销必填 reason/派生九级判定(含 U1 过期 E4→stale、撤销 E4 落回
 * implemented)/inputs_hash 未变跳过/untouched 不写假行/重算调度合并。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { applyMapS5aSchema } from '../map/schema'
import { EvidenceService, EvidenceValidationError, E4_EXPIRY_DAYS, scanExpiredE4All } from '../map/evidence-service'
import {
  recomputeExecutionState,
  deriveFromInputs,
  cancelPendingRecomputes,
  scheduleRecomputeForWorkItem,
  flushPendingRecomputes,
  refreshStaleDerivationsForGraph,
} from '../map/execution-state'
import { WorkItemService } from '../map/work-item-service'
import { WorkRunService } from '../map/work-run-service'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      project_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
      graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, entity_key TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
      status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
    );
  `)
  applyMapS5aSchema(db)
  db.exec(`
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
      revoke_reason    TEXT,
      CHECK (evidence_level <> 'E3' OR (
        version_binding = 'commit'
        AND code_version IS NOT NULL
        AND code_dirty = 0
        AND reproducible = 1
      )),
      CHECK (evidence_level <> 'E4' OR (
        version_binding = 'none'
        AND code_version IS NULL
        AND reproducible = 0
        AND signed_by IS NOT NULL
        AND signed_at IS NOT NULL
        AND coverage_json IS NOT NULL
      ))
    );
    CREATE UNIQUE INDEX ux_node_evidence_run_type
      ON node_evidence(graph_id, work_run_id, evidence_type, node_entity_key)
      WHERE work_run_id IS NOT NULL AND evidence_level IN ('E2','E3');
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
  const now = '2026-01-01T00:00:00Z'
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('g1', 'dev 图', 'dev', '/p', now, now)
  db.prepare('INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('n1', 'module', '登录', 'g1', 'dev', 'key-1', now, now)
  return db
}

describe('EvidenceService 写入方矩阵（§3.7.1）', () => {
  let db: BetterSqlite3.Database
  let svc: EvidenceService

  beforeEach(() => {
    db = setupDb()
    svc = new EvidenceService(db)
    cancelPendingRecomputes()
  })

  afterEach(() => cancelPendingRecomputes())

  it('E1 人写 ok;agent 写拒绝（走 evidence_suggestions,S6b）', () => {
    const row = svc.create({ level: 'E1', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'session_turn', ref: { note: '计划备注' }, actor: 'human', producedBy: 'human' }).row
    expect(row.evidence_level).toBe('E1')
    expect(() => svc.create({ level: 'E1', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'session_turn', ref: {}, actor: 'agent' })).toThrow(EvidenceValidationError)
  })

  it('E2 agent 直写拒绝;E3 非 test_executor 拒绝', () => {
    expect(() => svc.create({ level: 'E2', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'changed_files', ref: { files: [] }, actor: 'agent' })).toThrow(/evidence_suggestions/)
    expect(() => svc.create({
      level: 'E3', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'test_run',
      ref: { testRunId: 'tr-1' }, actor: 'system', codeVersion: 'abc', codeDirty: 0, workRunId: 'wr-1',
    })).toThrow(/TestExecutor/)
  })

  it('E3:dirty 拒绝;缺 testRunId 拒绝;合法写入后 CHECK 字段齐备', () => {
    const base = { level: 'E3' as const, graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'test_run' as const, actor: 'test_executor' as const, producedBy: 'test_executor' as const }
    expect(() => svc.create({ ...base, ref: { testRunId: 'tr-1' }, codeVersion: 'abc', codeDirty: 1, workRunId: 'wr-1' })).toThrow(/dirty/)
    expect(() => svc.create({ ...base, ref: {}, codeVersion: 'abc', codeDirty: 0, workRunId: 'wr-1' })).toThrow(/testRunId/)
    const { row } = svc.create({ ...base, ref: { testRunId: 'tr-1' }, codeVersion: 'abc', codeDirty: 0, workRunId: 'wr-1' })
    expect(row).toMatchObject({ version_binding: 'commit', code_version: 'abc', code_dirty: 0, reproducible: 1, freshness: 'fresh' })
  })

  it('E4:非人拒绝;coverage 空/无 acceptance 拒绝;合法签收含 30 天过期', () => {
    const base = { level: 'E4' as const, graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm' as const }
    expect(() => svc.create({ ...base, ref: {}, actor: 'system', signedBy: 'u1', coverage: [{ acceptance_ids: ['a1'] }] })).toThrow(/只能由本地用户/)
    expect(() => svc.create({ ...base, ref: {}, actor: 'human', signedBy: 'u1', coverage: [] })).toThrow(/coverage/)
    expect(() => svc.create({ ...base, ref: {}, actor: 'human', signedBy: 'u1', coverage: [{ files: ['src/a.ts'] }] })).toThrow(/acceptance/)
    const { row } = svc.create({ ...base, ref: {}, actor: 'human', signedBy: 'u1', coverage: [{ acceptance_ids: ['a1'] }] })
    expect(row).toMatchObject({ version_binding: 'none', code_version: null, reproducible: 0, signed_by: 'u1' })
    expect(row.expires_at).toBeTruthy()
    const days = (new Date(row.expires_at!).getTime() - new Date(row.signed_at!).getTime()) / 86400000
    expect(Math.round(days)).toBe(E4_EXPIRY_DAYS)
  })

  it('E2/E3 run 内唯一按 graph_id 隔离:同一 key 在两图各落一条', () => {
    const now = '2026-01-01T00:00:00Z'
    db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('g2', 'dev 图 2', 'dev', '/p', now, now)
    db.prepare('INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('n2', 'module', '登录', 'g2', 'dev', 'key-1', now, now)
    const base = {
      level: 'E2' as const, graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'changed_files' as const,
      ref: { files: ['src/a.ts'] }, actor: 'human' as const, workRunId: 'wr-9',
    }
    const a = svc.create(base).row
    const b = svc.create({ ...base, graphId: 'g2' })
    expect(a.graph_id).toBe('g1')
    expect(b.reused).toBe(false)
    expect(b.row.graph_id).toBe('g2')
    expect((db.prepare('SELECT COUNT(*) AS c FROM node_evidence').get() as { c: number }).c).toBe(2)
  })

  it('E2/E3 run 内唯一:重复写入返回既有 id', () => {
    const input = {
      level: 'E2' as const, graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'changed_files' as const,
      ref: { files: ['src/a.ts'] }, actor: 'human' as const, workRunId: 'wr-9',
    }
    const a = svc.create(input).row
    const b = svc.create(input)
    expect(b.reused).toBe(true)
    expect(b.row.id).toBe(a.id)
    expect((db.prepare('SELECT COUNT(*) AS c FROM node_evidence').get() as { c: number }).c).toBe(1)
  })

  it('端点不可解析拒绝;撤销必填 reason;撤销后重算触发', () => {
    expect(() => svc.create({ level: 'E2', graphId: 'g1', nodeEntityKey: 'ghost', evidenceType: 'artifact', ref: {}, actor: 'human' })).toThrow(/端点不可解析/)
    const row = svc.create({ level: 'E1', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm', ref: {}, actor: 'human' }).row
    expect(() => svc.revoke(row.id, 'u1', '')).toThrow(/revoke_reason/)
    svc.revoke(row.id, 'u1', '验收撤回')
    expect(svc.get(row.id)!.revoked_at).toBeTruthy()
  })
})

describe('派生引擎（§3.7.4 九级 + U1）', () => {
  let db: BetterSqlite3.Database
  let svc: EvidenceService

  beforeEach(() => {
    db = setupDb()
    svc = new EvidenceService(db)
    cancelPendingRecomputes()
  })

  afterEach(() => cancelPendingRecomputes())

  function state(): Record<string, unknown> | undefined {
    return db.prepare('SELECT * FROM node_execution_state WHERE graph_id = ? AND node_entity_key = ?').get('g1', 'key-1') as Record<string, unknown> | undefined
  }

  function insertWorkItem(status: string, gateStatus = 'incomplete', depends: string[] = [], createdAt = '2026-01-01T00:00:00Z'): string {
    const id = `wi_${randomUUID().slice(0, 8)}`
    db.prepare(
      `INSERT INTO work_items (id, lineage_id, revision, is_current, graph_id, anchor_entity_key, title, status, gate_status, depends_on_json, origin, created_at, updated_at)
       VALUES (?, ?, 1, 1, 'g1', 'key-1', '任务', ?, ?, ?, 'human', ?, ?)`,
    ).run(id, `wl_${randomUUID().slice(0, 8)}`, status, gateStatus, JSON.stringify(depends), createdAt, createdAt)
    return id
  }

  it('纯函数:九级判定顺序与 U1(过期 E4→stale;撤销 E4 落回 implemented)', () => {
    const ev = (o: Partial<{ id: string; level: 'E1'|'E2'|'E3'|'E4'; freshness: string; revoked: boolean; expired: boolean }>): { id: string; level: 'E1'|'E2'|'E3'|'E4'; freshness: string; revoked: boolean; expired: boolean } => ({
      id: 'e', level: 'E2', freshness: 'fresh', revoked: false, expired: false, ...o,
    })
    const base = { workItems: [], runningRunIds: [], testFail: false }
    expect(deriveFromInputs({ ...base, evidence: [] }).state).toBe('untouched')
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E1' })] }).state).toBe('planned')
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E2' })] }).state).toBe('implemented')
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E3', freshness: 'stale' })] }).state).toBe('stale')
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E3' })] }).state).toBe('verified')
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E4' })] }).state).toBe('signed_off')
    // U1:过期未撤销 E4 → stale(不降 implemented)
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E4', expired: true })] }).state).toBe('stale')
    // 已撤销 E4 不参与 → 落回 untouched(无其他证据时)
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E4', revoked: true })] }).state).toBe('untouched')
    // 撤销 E4 + 存在 E2 → implemented
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E4', revoked: true }), ev({ id: 'e2', level: 'E2' })] }).state).toBe('implemented')
    // running run 优先于证据
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E3' })], runningRunIds: ['wr-1'] }).state).toBe('in_progress')
    // test_fail 最高优先
    expect(deriveFromInputs({ ...base, evidence: [ev({ level: 'E3' })], testFail: true }).state).toBe('failed')
    // blocked:running item + gate incomplete
    expect(deriveFromInputs({ ...base, evidence: [], workItems: [{ id: 'wi', status: 'running', gateStatus: 'incomplete', depsSatisfied: true }] }).state).toBe('blocked')
  })

  it('纯函数:多 lineage 聚合按活跃集折叠（failed > in_progress > blocked）', () => {
    const wi = (id: string, status: string, gate = 'pass', depsSatisfied = true) => ({ id, status, gateStatus: gate, depsSatisfied })
    const base = { evidence: [], runningRunIds: [], testFail: false, workItems: [] as ReturnType<typeof wi>[] }
    // 旧版只看最新一条会得到 blocked；聚合后 running run 优先
    expect(
      deriveFromInputs({
        ...base,
        workItems: [wi('a', 'running'), wi('b', 'blocked', 'incomplete')],
        runningRunIds: ['wr-1'],
      }).state,
    ).toBe('in_progress')
    // 无 run 时 blocked lineage 仍然算数
    expect(deriveFromInputs({ ...base, workItems: [wi('a', 'running'), wi('b', 'blocked', 'incomplete')] }).state).toBe('blocked')
    // 活跃 lineage 的 test_fail 优先于其余状态
    expect(deriveFromInputs({ ...base, testFail: true, workItems: [wi('a', 'done'), wi('b', 'failed')] }).state).toBe('failed')
    // 全部终态时回退到最新一条（调用方保证 newest-first）
    expect(deriveFromInputs({ ...base, workItems: [wi('newest', 'done'), wi('older', 'failed')] }).state).toBe('untouched')
  })

  it('落库:多 lineage 并存时最新一条不再吞掉其他 lineage 的 running/blocked', () => {
    const runs = new WorkRunService(db)
    // 较新的 blocked lineage + 较旧的 running lineage
    insertWorkItem('blocked', 'incomplete', [], '2026-01-02T00:00:00Z')
    const runningOlder = insertWorkItem('running', 'pass', [], '2026-01-01T00:00:00Z')
    const { run } = runs.enqueue({ workItemId: runningOlder, executorKind: 'agent' })

    recomputeExecutionState(db, 'g1', 'key-1')
    expect(state()?.execution_state).toBe('in_progress')

    runs.cancel(run.id, 'shutdown')
  })

  it('落库:较旧 failed lineage 不覆盖较新 done lineage（不永久 failed）', () => {
    const runs = new WorkRunService(db)
    insertWorkItem('done', 'pass', [], '2026-01-02T00:00:00Z')
    const runningOlder = insertWorkItem('running', 'pass', [], '2026-01-01T00:00:00Z')
    const { run } = runs.enqueue({ workItemId: runningOlder, executorKind: 'agent' })
    runs.fail(run.id, { failureClass: 'test_fail' })
    db.prepare("UPDATE work_items SET status = 'failed' WHERE id = ?").run(runningOlder)

    recomputeExecutionState(db, 'g1', 'key-1')
    // 无证据且无活跃 item → untouched 不写假行；若是 failed 会落行，故 undefined 即证明未被旧失败覆盖
    expect(state()).toBeUndefined()
  })

  it('惰性刷新:derivation_version 落后的缓存会在读侧重算', () => {
    insertWorkItem('queued', 'incomplete')
    recomputeExecutionState(db, 'g1', 'key-1')
    expect(state()?.execution_state).toBe('blocked')
    expect(Number(state()?.derivation_version)).toBe(2)

    // 模拟旧版本（v1）留下的缓存：版本与哈希都来自旧算法
    db.prepare("UPDATE node_execution_state SET derivation_version = 1, inputs_hash = 'v1-stale-hash', execution_state = 'in_progress' WHERE graph_id = 'g1' AND node_entity_key = 'key-1'").run()
    expect(refreshStaleDerivationsForGraph(db, 'g1')).toBe(1)
    expect(Number(state()?.derivation_version)).toBe(2)
    expect(state()?.execution_state).toBe('blocked')
    // 已刷新后不再重复重算
    expect(refreshStaleDerivationsForGraph(db, 'g1')).toBe(0)
  })

  it('落库:planned(queued item);in_progress(running run);E2→implemented;hash 未变跳过', () => {
    // untouched 且无既有行 → 不写假行
    recomputeExecutionState(db, 'g1', 'key-1')
    expect(state()).toBeUndefined()

    const wi = insertWorkItem('queued', 'pass')
    let r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.state).toBe('planned')
    expect(r.changed).toBe(true)
    const row1 = state()!
    expect(row1.execution_state).toBe('planned')

    // hash 未变 → 不重复写
    r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.changed).toBe(false)
    expect(state()!.computed_at).toBe(row1.computed_at)

    // 依赖未满足/gate incomplete 且在途 → blocked
    db.prepare("UPDATE work_items SET status = 'running', gate_status = 'incomplete' WHERE id = ?").run(wi)
    r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.state).toBe('blocked')

    // running run → in_progress
    db.prepare("INSERT INTO work_runs (id, work_item_id, work_item_lineage_id, work_item_revision, run_seq, attempt, idempotency_key, executor_kind, status, created_at) VALUES ('wr-r', ?, 'wl', 1, 1, 1, 'k-r', 'agent', 'running', 0)").run(wi)
    r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.state).toBe('in_progress')
  })

  it('E4 过期(真实时间)→ 派生 stale,不降 implemented(U1 验收)', () => {
    svc.create({
      level: 'E4', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm',
      ref: {}, actor: 'human', signedBy: 'u1', coverage: [{ acceptance_ids: ['a1'] }],
      expiresAt: '2020-01-01T00:00:00Z', // 已过期
    })
    const r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.state).toBe('stale')
    expect(r.staleCount).toBe(1)
    expect(state()!.execution_state).toBe('stale')
  })

  it('E4 到期扫描:到期转 stale,扫描记录可查询(§3.7.5)', () => {
    svc.create({
      level: 'E4', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm',
      ref: {}, actor: 'human', signedBy: 'u1', coverage: [{ acceptance_ids: ['a1'] }],
      expiresAt: '2020-01-01T00:00:00Z',
    })
    const now = new Date('2026-01-01T00:00:00Z')
    const res = scanExpiredE4All(db, now)
    expect(res).toMatchObject({ scanned: 1, staled: 1 })

    const ev = db.prepare("SELECT freshness, stale_at FROM node_evidence WHERE evidence_level = 'E4'").get() as Record<string, unknown>
    expect(ev.freshness).toBe('stale')
    expect(ev.stale_at).toBe(now.toISOString())

    // 扫描落库：kind=derivation / stage=e4_expiry，stats 可解析查询
    const report = db
      .prepare("SELECT status, stats_json FROM map_migration_reports WHERE kind = 'derivation' AND stage = 'e4_expiry'")
      .get() as { status: string; stats_json: string }
    expect(report.status).toBe('ok')
    expect(JSON.parse(report.stats_json)).toMatchObject({ scanned: 1, staled: 1 })

    // 到期证据被扫后,派生状态应为 stale,不再长期挂 signed_off
    cancelPendingRecomputes()
    const r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.state).toBe('stale')
    expect(state()!.execution_state).toBe('stale')
  })

  it('E4 到期扫描:未到期/已撤销不动', () => {
    svc.create({
      level: 'E4', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm',
      ref: {}, actor: 'human', signedBy: 'u1', coverage: [{ acceptance_ids: ['a1'] }],
      expiresAt: '2030-01-01T00:00:00Z', // 未到期
    })
    const revoked = svc.create({
      level: 'E4', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm',
      ref: {}, actor: 'human', signedBy: 'u1', coverage: [{ acceptance_ids: ['a1'] }],
      expiresAt: '2020-01-01T00:00:00Z', // 已过期但已撤销
    })
    svc.revoke(revoked.row.id, 'u1', '重新签收')

    const res = scanExpiredE4All(db, new Date('2026-01-01T00:00:00Z'))
    expect(res).toMatchObject({ scanned: 0, staled: 0 })

    // 未到期:保持 fresh（已撤销的过期行也不动）
    const rows = db.prepare("SELECT freshness, stale_at, revoked_at FROM node_evidence WHERE evidence_level = 'E4' ORDER BY expires_at DESC").all() as Array<Record<string, unknown>>
    const notExpired = rows.find((r) => r.revoked_at === null)!
    expect(notExpired.freshness).toBe('fresh')
    expect(notExpired.stale_at).toBeNull()
    // 扫描仍落一条记录（可查询审计）
    const report = db
      .prepare("SELECT stats_json FROM map_migration_reports WHERE kind = 'derivation' AND stage = 'e4_expiry'")
      .get() as { stats_json: string }
    expect(JSON.parse(report.stats_json)).toMatchObject({ scanned: 0, staled: 0 })
  })

  it('E2→implemented;撤销 → verified 消失回 implemented/untouched', () => {
    const e2 = svc.create({ level: 'E2', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'changed_files', ref: { files: [] }, actor: 'human' }).row
    expect(recomputeExecutionState(db, 'g1', 'key-1').state).toBe('implemented')

    const e1 = svc.create({ level: 'E1', graphId: 'g1', nodeEntityKey: 'key-1', evidenceType: 'human_confirm', ref: {}, actor: 'human' }).row
    // E1 存在时仍 implemented(E2 优先)
    expect(recomputeExecutionState(db, 'g1', 'key-1').state).toBe('implemented')

    svc.revoke(e2.id, 'u1', '变更面被回滚')
    const r = recomputeExecutionState(db, 'g1', 'key-1')
    expect(r.state).toBe('planned') // E1 → planned
    expect(r.evidenceCount).toBe(1)
    expect(svc.get(e1.id)).toBeTruthy()
  })
})

describe('状态变更触发派生（§3.7.5）', () => {
  let db: BetterSqlite3.Database
  let svc: EvidenceService
  let items: WorkItemService
  let runs: WorkRunService

  beforeEach(() => {
    db = setupDb()
    svc = new EvidenceService(db)
    items = new WorkItemService(db)
    runs = new WorkRunService(db)
    cancelPendingRecomputes()
  })

  afterEach(() => cancelPendingRecomputes())

  function state(key = 'key-1'): Record<string, unknown> | undefined {
    return db.prepare('SELECT * FROM node_execution_state WHERE graph_id = ? AND node_entity_key = ?').get('g1', key) as Record<string, unknown> | undefined
  }

  it('work_item/work_run 状态变更自动派生:planned → in_progress → failed → planned', () => {
    const wi = items.createDraft({ graphId: 'g1', anchorEntityKey: 'key-1', title: '实现登录', origin: 'derived_plan' })
    flushPendingRecomputes(db, 'g1')
    expect(state()!.execution_state).toBe('planned')

    const { run } = runs.enqueue({ workItemId: wi.id, executorKind: 'agent' })
    flushPendingRecomputes(db, 'g1')
    expect(state()!.execution_state).toBe('in_progress')

    runs.claim(run.id)
    runs.fail(run.id, { failureClass: 'test_fail' })
    flushPendingRecomputes(db, 'g1')
    // 生产可达:最近一次 run 是 test_fail → failed（不再永远 false）
    expect(state()!.execution_state).toBe('failed')

    // 更新的 run 成功收尾 → 解除 test_fail（draft item 回到 planned）
    db.prepare(
      `INSERT INTO work_runs (id, work_item_id, work_item_lineage_id, work_item_revision, run_seq, attempt,
         idempotency_key, executor_kind, status, created_at, ended_at)
       VALUES ('wr-retry', ?, ?, 1, 2, 1, 'k-retry', 'agent', 'completed', 0, 0)`,
    ).run(wi.id, wi.lineage_id)
    scheduleRecomputeForWorkItem(db, wi.id)
    flushPendingRecomputes(db, 'g1')
    expect(state()!.execution_state).toBe('planned')
  })

  it('上游变更只重算直接依赖者,不产生无关节点的假行', () => {
    const up = 'wi_up'
    const dep = 'wi_dep'
    db.prepare(
      `INSERT INTO work_items (id, lineage_id, revision, is_current, graph_id, anchor_entity_key, title,
         status, gate_status, depends_on_json, origin, created_at, updated_at)
       VALUES (?, 'wl_up', 1, 1, 'g1', 'key-up', '上游', 'queued', 'pass', '[]', 'human', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(up)
    db.prepare(
      `INSERT INTO work_items (id, lineage_id, revision, is_current, graph_id, anchor_entity_key, title,
         status, gate_status, depends_on_json, origin, created_at, updated_at)
       VALUES (?, 'wl_dep', 1, 1, 'g1', 'key-dep', '下游', 'queued', 'pass', ?, 'human', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(dep, JSON.stringify([up]))
    // 下游节点需可解析（证据写入校验端点）
    db.prepare(
      `INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at)
       VALUES ('n-dep', 'module', '下游模块', 'g1', 'dev', 'key-dep', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run()
    // 下游有 E2;上游未 done → blocked
    svc.create({ level: 'E2', graphId: 'g1', nodeEntityKey: 'key-dep', evidenceType: 'changed_files', ref: { files: ['a.ts'] }, actor: 'human' })
    expect(recomputeExecutionState(db, 'g1', 'key-dep').state).toBe('blocked')

    db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(up)
    scheduleRecomputeForWorkItem(db, up)
    flushPendingRecomputes(db)
    expect(state('key-dep')!.execution_state).toBe('implemented')
    // 无关节点不被顺手重算
    expect(state('key-other')).toBeUndefined()
  })
})
