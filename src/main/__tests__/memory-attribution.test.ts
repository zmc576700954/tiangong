/**
 * G2-4：Layer2 派发精度归因视图（蓝图 II-06 验收）。
 *
 * 覆盖：只收 `node_session_links.session_origin='map_task'` 的 run；
 * 同一 run 多条链接不重复；outcome/hit_count/evidence_level 正确；
 * 跨图不聚合；样本 <20 标 insufficient_sample；视图重复重建结果一致。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  applyMapS5aSchema,
  applyMapS6aSchema,
  applyMemorySchema,
  applyMapViews,
} from '../map/schema'
import { MemoryHitService } from '../map/memory-hit-service'

const NOW = new Date('2026-11-10T08:00:00.000Z')

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS6aSchema(db)
  applyMemorySchema(db)
  applyMapViews(db)
  return db
}

interface RunSeed {
  runId: string
  runSeq: number
  status?: string
  graphId?: string
  adapter?: string
  modeId?: string | null
  origins?: string[]
  hitCount?: number
  evidence?: boolean
}

function seedRun(db: BetterSqlite3.Database, seed: RunSeed): void {
  const graphId = seed.graphId ?? 'g1'
  db.prepare(
    `INSERT INTO work_items
       (id, lineage_id, revision, project_path, graph_id, title, status, gate_status, origin, created_at, updated_at)
     VALUES (?, ?, 1, '/repo/a', ?, 'T', 'running', 'incomplete', 'human', ?, ?)`,
  ).run(`wi_${seed.runId}`, `lin_${seed.runId}`, graphId, NOW.toISOString(), NOW.toISOString())

  db.prepare(
    `INSERT INTO work_steps
       (id, work_item_id, work_item_revision, seq, title, step_kind, status, created_at, updated_at)
     VALUES (?, ?, 1, 1, 'S1', 'agent', 'succeeded', 0, 0)`,
  ).run(`ws_${seed.runId}`, `wi_${seed.runId}`)

  db.prepare(
    `INSERT INTO work_runs
       (id, work_item_id, work_item_lineage_id, work_item_revision, step_id,
        run_seq, attempt, idempotency_key, executor_kind, status, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 1, ?, 'agent', ?, 0)`,
  ).run(
    seed.runId,
    `wi_${seed.runId}`,
    `lin_${seed.runId}`,
    `ws_${seed.runId}`,
    seed.runSeq,
    `idem_${seed.runId}`,
    seed.status ?? 'completed',
  )

  db.prepare(
    `INSERT INTO routing_decisions
       (id, work_item_id, work_run_id, chosen_adapter, candidate_json, policy, mode_id, created_at)
     VALUES (?, ?, ?, ?, '[]', 'manual_override', ?, 0)`,
  ).run(`rd_${seed.runId}`, `wi_${seed.runId}`, seed.runId, seed.adapter ?? 'claude', seed.modeId === undefined ? 'agent.implement' : seed.modeId)

  const origins = seed.origins ?? ['map_task']
  for (const [i, origin] of origins.entries()) {
    db.prepare(
      `INSERT INTO node_session_links
         (id, project_path, graph_id, work_run_id, thread_id, link_role, session_origin, created_at)
       VALUES (?, '/repo/a', ?, ?, ?, ?, ?, 0)`,
    ).run(`l_${seed.runId}_${i}`, graphId, seed.runId, `th_${seed.runId}`, i === 0 ? 'primary' : 'supporting', origin)
  }

  const service = new MemoryHitService(db)
  const outcome =
    seed.status === 'failed'
      ? 'failed'
      : seed.status === 'timed_out'
        ? 'timeout'
        : seed.status === 'cancelled'
          ? 'cancelled'
          : seed.status === 'interrupted'
            ? 'interrupted'
            : 'completed'
  for (let i = 0; i < (seed.hitCount ?? 0); i++) {
    service.record({
      projectPath: '/repo/a',
      graphId,
      runId: seed.runId,
      stepId: `ws_${seed.runId}`,
      hitKind: 'evidence',
      sourceOutcome: outcome,
      sourceRef: `node_evidence:${seed.runId}_${i}`,
      now: NOW,
    })
  }

  if (seed.evidence !== false) {
    db.prepare(
      `INSERT INTO node_evidence
         (id, graph_id, graph_type, node_entity_key, node_id, evidence_level, evidence_type,
          ref_json, produced_by, work_run_id, created_at)
       VALUES (?, ?, 'dev', 'node:a', 'node_1', 'E2', 'artifact', '{}', 'test_executor', ?, ?)`,
    ).run(`ev_${seed.runId}`, graphId, seed.runId, NOW.toISOString())
  }
}

function rows(db: BetterSqlite3.Database) {
  return db
    .prepare('SELECT * FROM v_memory_attribution ORDER BY run_id')
    .all() as Array<Record<string, unknown>>
}

describe('v_memory_attribution（G2-4）', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
  })

  it('只收 map_task 归因的 run，manual_panel/无链接的 run 不入视图', () => {
    seedRun(db, { runId: 'run_map', runSeq: 1, hitCount: 2 })
    seedRun(db, { runId: 'run_panel', runSeq: 2, origins: ['manual_panel'], hitCount: 2 })
    seedRun(db, { runId: 'run_none', runSeq: 3, origins: [], hitCount: 2 })

    const result = rows(db)
    expect(result.map((r) => r.run_id)).toEqual(['run_map'])
    expect(result[0]).toMatchObject({
      run_id: 'run_map',
      step_id: 'ws_run_map',
      graph_id: 'g1',
      adapter: 'claude',
      mode_id: 'agent.implement',
      outcome: 'completed',
      hit_count: 2,
      evidence_level: 'E2',
    })
  })

  it('同一 run 多条 map_task 链接只出一行', () => {
    seedRun(db, { runId: 'run_dup', runSeq: 1, origins: ['map_task', 'map_task'], hitCount: 1 })
    expect(rows(db)).toHaveLength(1)
  })

  it('取消/中断终态如实出现在 outcome，便于归因剔除', () => {
    seedRun(db, { runId: 'run_cancel', runSeq: 1, status: 'cancelled', hitCount: 1 })
    seedRun(db, { runId: 'run_int', runSeq: 2, status: 'interrupted' })
    const result = rows(db)
    expect(result.find((r) => r.run_id === 'run_cancel')?.outcome).toBe('cancelled')
    expect(result.find((r) => r.run_id === 'run_int')?.outcome).toBe('interrupted')
  })

  it('跨图不聚合：sample_size 只数同图同 adapter 同 mode 的 run', () => {
    seedRun(db, { runId: 'run_a1', runSeq: 1, graphId: 'g1' })
    seedRun(db, { runId: 'run_a2', runSeq: 2, graphId: 'g1' })
    seedRun(db, { runId: 'run_b1', runSeq: 3, graphId: 'g2' })

    const result = rows(db)
    expect(result.find((r) => r.run_id === 'run_a1')?.sample_size).toBe(2)
    expect(result.find((r) => r.run_id === 'run_b1')?.sample_size).toBe(1)
    expect(result.every((r) => r.conclusion === 'insufficient_sample')).toBe(true)
  })

  it('样本达到 20 后 conclusion 变 ok', () => {
    for (let i = 0; i < 20; i++) {
      seedRun(db, { runId: `run_${i}`, runSeq: i + 1 })
    }
    const result = rows(db)
    expect(result).toHaveLength(20)
    expect(result.every((r) => r.sample_size === 20 && r.conclusion === 'ok')).toBe(true)
  })

  it('视图重建两次结果一致（纯派生）', () => {
    seedRun(db, { runId: 'run_x', runSeq: 1, hitCount: 3 })
    const first = rows(db)
    applyMapViews(db)
    const second = rows(db)
    expect(second).toEqual(first)
  })
})
