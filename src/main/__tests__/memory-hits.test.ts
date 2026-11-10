/**
 * G2-3：memory_hits 表与保留治理（蓝图 II-05 验收）。
 *
 * 覆盖：幂等唯一索引 / hit_kind 与 score 值域 / 180 天滚动删除 /
 * 单项目 20 万上限删最旧 / 不同项目互不影响 / 按 run 查询。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMemorySchema } from '../map/schema'
import {
  MemoryHitService,
  MemoryHitValidationError,
  pruneMemoryHits,
} from '../map/memory-hit-service'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMemorySchema(db)
  return db
}

function makeInput(overrides: Partial<Parameters<MemoryHitService['record']>[0]> = {}) {
  return {
    projectPath: '/repo/a',
    graphId: 'g1',
    runId: 'run_1',
    hitKind: 'context' as const,
    sourceOutcome: 'completed' as const,
    sourceRef: 'work_step:ws_1',
    ...overrides,
  }
}

describe('memory_hits（G2-3）', () => {
  let db: BetterSqlite3.Database
  let service: MemoryHitService

  beforeEach(() => {
    db = setupDb()
    service = new MemoryHitService(db)
  })

  it('同一 (run_id, hit_kind, source_ref) 重复写入返回既有行，只落一条', () => {
    const first = service.record(makeInput())
    const second = service.record(makeInput({ score: 0.1 }))

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.row.id).toBe(first.row.id)
    // 重复写入不覆盖既有 score。
    expect(second.row.score).toBe(1)
    expect(service.listForRun('run_1')).toHaveLength(1)
  })

  it('唯一索引在库层拒绝裸重复行', () => {
    service.record(makeInput())
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_hits
             (id, project_path, graph_id, run_id, hit_kind, source_ref, score, created_at)
           VALUES ('dup', '/repo/a', 'g1', 'run_1', 'context', 'work_step:ws_1', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i)
  })

  it('hit_kind 与 score 值域在服务层拒绝，库层 CHECK 兜底', () => {
    expect(() => service.record(makeInput({ hitKind: 'unknown' as never }))).toThrow(MemoryHitValidationError)
    expect(() => service.record(makeInput({ sourceOutcome: 'unknown' as never }))).toThrow(MemoryHitValidationError)
    expect(() => service.record(makeInput({ score: 1.2 }))).toThrow(MemoryHitValidationError)
    expect(() => service.record(makeInput({ score: -0.1 }))).toThrow(MemoryHitValidationError)
    expect(() => service.record(makeInput({ projectPath: '  ' }))).toThrow(MemoryHitValidationError)
    expect(() => service.record(makeInput({ sourceRef: '' }))).toThrow(MemoryHitValidationError)

    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_hits
             (id, project_path, graph_id, run_id, hit_kind, source_ref, score, created_at)
           VALUES ('bad', '/repo/a', 'g1', 'run_1', 'unknown', 'x', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK/i)
  })

  it('滚动删除：超过 180 天的行被删，未过期行保留', () => {
    const now = new Date('2026-11-10T00:00:00.000Z')
    service.record(makeInput({ runId: 'run_old1', sourceRef: 'a', now: new Date('2026-01-01T00:00:00.000Z') }))
    service.record(makeInput({ runId: 'run_old2', sourceRef: 'b', now: new Date('2026-05-01T00:00:00.000Z') }))
    service.record(makeInput({ runId: 'run_fresh', sourceRef: 'c', now: new Date('2026-11-01T00:00:00.000Z') }))

    const result = pruneMemoryHits(db, { now })
    expect(result.deletedExpired).toBe(2)
    expect(result.deletedOverflow).toBe(0)
    expect(service.listForRun('run_fresh')).toHaveLength(1)
    expect(service.listForRun('run_old1')).toHaveLength(0)
  })

  it('单项目超限按最旧滚动删除，其它项目不受影响', () => {
    const now = new Date('2026-11-10T00:00:00.000Z')
    for (let i = 0; i < 5; i++) {
      service.record(
        makeInput({
          runId: `run_${i}`,
          sourceRef: `ref_${i}`,
          now: new Date(Date.UTC(2026, 10, 1, 0, i)),
        }),
      )
    }
    service.record(makeInput({ projectPath: '/repo/b', runId: 'other', sourceRef: 'x', now }))

    const result = pruneMemoryHits(db, { now, perProjectLimit: 3 })
    expect(result.deletedOverflow).toBe(2)
    expect(service.countForProject('/repo/a')).toBe(3)
    expect(service.countForProject('/repo/b')).toBe(1)
    // 留下的必须是最新的三条（run_2/run_3/run_4）。
    expect(service.listForRun('run_0')).toHaveLength(0)
    expect(service.listForRun('run_1')).toHaveLength(0)
    expect(service.listForRun('run_4')).toHaveLength(1)
  })
})
