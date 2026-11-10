/**
 * G2-13 published 软阻断：豁免解析、通过记录口径、node:update 拦截、徽标/统计。
 *
 * 通过记录口径（裁决）：test-case 节点 → test_specs.test_node_entity_key →
 * test_results/test_runs → node_evidence(E3, 未撤销)。不能查 test-case 自身证据。
 */

import BetterSqlite3 from 'better-sqlite3'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyMapS6aSchema, applyMapS8Schema } from '../map/schema'
import {
  assertPublishedUpdateAllowed,
  computePassEvidence,
  getPublishedStatus,
  parsePublishedWaiver,
} from '../map/published-guard'
import { ErrorCode } from '../errors'

const NOW = 1_700_000_000_000

let db: BetterSqlite3.Database

beforeEach(() => {
  db = new BetterSqlite3(':memory:')
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      entity_key TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL
    )
  `)
  applyMapS8Schema(db)
  applyMapS6aSchema(db)
})

afterEach(() => {
  db.close()
})

function insertNode(id: string, opts: { status?: string; entityKey?: string; graphId?: string; type?: string; title?: string } = {}): void {
  db.prepare('INSERT INTO nodes (id, graph_id, entity_key, type, status, title) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    opts.graphId ?? 'g1',
    opts.entityKey ?? `ek_${id}`,
    opts.type ?? 'test-case',
    opts.status ?? 'confirmed',
    opts.title ?? id,
  )
}

function insertSpec(id: string, testNodeKey: string, graphId: string | null = 'g1'): void {
  db.prepare(
    `INSERT INTO test_specs (id, project_path, graph_id, test_node_entity_key, name, kind, command, created_at, updated_at)
     VALUES (?, '/p', ?, ?, ?, 'unit', 'npm test', '2026-01-01', '2026-01-01')`,
  ).run(id, graphId, testNodeKey, id)
}

function insertRun(id: string, status: string): void {
  db.prepare(
    `INSERT INTO test_runs (id, plan_id, project_path, graph_id, status, created_at)
     VALUES (?, 'plan1', '/p', 'g1', ?, ?)`,
  ).run(id, status, NOW)
}

function insertResult(
  id: string,
  opts: { specId?: string | null; runId?: string | null; target?: string | null; status?: string; createdAt?: number } = {},
): void {
  db.prepare(
    `INSERT INTO test_results (id, test_run_id, spec_id, test_node_entity_key, target_node_entity_key, status, created_at)
     VALUES (?, ?, ?, 'ek_case', ?, ?, ?)`,
  ).run(
    id,
    opts.runId ?? 'run1',
    opts.specId ?? null,
    opts.target ?? null,
    opts.status ?? 'passed',
    opts.createdAt ?? NOW,
  )
}

function insertE3(id: string, nodeKey: string, opts: { revoked?: boolean; freshness?: string } = {}): void {
  db.prepare(
    `INSERT INTO node_evidence
       (id, graph_id, graph_type, node_entity_key, evidence_level, evidence_type, ref_json,
        version_binding, code_version, code_dirty, reproducible, freshness, produced_by, created_at, revoked_at)
     VALUES (?, 'g1', 'dev', ?, 'E3', 'test_run', '{}', 'commit', 'abc', 0, 1, ?, 'test_executor', '2026-01-01', ?)`,
  ).run(id, nodeKey, opts.freshness ?? 'fresh', opts.revoked ? '2026-01-02' : null)
}

describe('parsePublishedWaiver', () => {
  it('完整对象/JSON 字符串通过', () => {
    const waiver = { by: 'alice', at: NOW, reason: '手动确认', missing: ['pass_evidence'] }
    expect(parsePublishedWaiver(waiver)).toEqual({ ok: true, missing: [], waiver })
    expect(parsePublishedWaiver(JSON.stringify(waiver))).toEqual({ ok: true, missing: [], waiver })
  })

  it('缺字段逐项列出', () => {
    const result = parsePublishedWaiver({ by: ' ', at: 'now', missing: 'x' })
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['by', 'at', 'reason', 'missing'])
  })

  it('非法 JSON / 非对象返回 json 缺失', () => {
    expect(parsePublishedWaiver('{')).toEqual({ ok: false, missing: ['json'] })
    expect(parsePublishedWaiver(null)).toEqual({ ok: false, missing: ['json'] })
    expect(parsePublishedWaiver([])).toEqual({ ok: false, missing: ['json'] })
  })
})

describe('computePassEvidence（test_specs → 执行记录 → E3）', () => {
  it('无 test_spec 关联 → 无通过记录', () => {
    insertNode('n1')
    expect(computePassEvidence(db, 'g1', 'ek_n1')).toMatchObject({ hasPassEvidence: false, specIds: [] })
  })

  it('spec 下有 passed run → 有通过记录', () => {
    insertNode('n1')
    insertSpec('s1', 'ek_n1')
    insertRun('run1', 'passed')
    insertResult('r1', { specId: 's1', runId: 'run1', status: 'passed', target: 'code1' })

    const report = computePassEvidence(db, 'g1', 'ek_n1')
    expect(report.hasPassEvidence).toBe(true)
    expect(report.passedRunCount).toBe(1)
    expect(report.lastTestStatus).toBe('passed')
  })

  it('run 非 passed，但目标节点有未撤销 E3 → 有通过记录', () => {
    insertNode('n1')
    insertSpec('s1', 'ek_n1')
    insertRun('run1', 'failed')
    insertResult('r1', { specId: 's1', runId: 'run1', status: 'failed', target: 'code1' })
    insertE3('e1', 'code1')

    const report = computePassEvidence(db, 'g1', 'ek_n1')
    expect(report.hasPassEvidence).toBe(true)
    expect(report.passedRunCount).toBe(0)
    expect(report.e3TargetCount).toBe(1)
    expect(report.lastTestStatus).toBe('failed')
  })

  it('E3 已撤销 / 非 fresh 不计入', () => {
    insertNode('n1')
    insertSpec('s1', 'ek_n1')
    insertResult('r1', { specId: 's1', target: 'code1' })
    insertE3('e1', 'code1', { revoked: true })
    insertE3('e2', 'code2', { freshness: 'stale' })

    expect(computePassEvidence(db, 'g1', 'ek_n1').hasPassEvidence).toBe(false)
  })

  it('不能直接命中 test-case 节点自身的 E3', () => {
    insertNode('n1')
    insertSpec('s1', 'ek_n1')
    insertE3('e1', 'ek_n1')

    expect(computePassEvidence(db, 'g1', 'ek_n1').hasPassEvidence).toBe(false)
  })
})

describe('assertPublishedUpdateAllowed（node:update 拦截）', () => {
  const node = { type: 'test-case' as const, graphId: 'g1', graphType: 'test' as const, entityKey: 'ek_n1' }

  it('非 test 图 / 非 test-case 节点不拦', () => {
    expect(() =>
      assertPublishedUpdateAllowed(db, { ...node, graphType: 'dev' }, { status: 'published' }),
    ).not.toThrow()
    expect(() =>
      assertPublishedUpdateAllowed(db, { ...node, type: 'feature' as const }, { status: 'published' }),
    ).not.toThrow()
  })

  it('非 published 状态不拦', () => {
    expect(() => assertPublishedUpdateAllowed(db, node, { status: 'confirmed' })).not.toThrow()
  })

  it('无通过记录且无豁免 → PUBLISHED_WAIVER_REQUIRED', () => {
    insertNode('n1')
    let caught: unknown
    try {
      assertPublishedUpdateAllowed(db, node, { status: 'published' })
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe(ErrorCode.PUBLISHED_WAIVER_REQUIRED)
  })

  it('豁免不完整仍拒绝，并列出缺失字段', () => {
    insertNode('n1')
    let caught: unknown
    try {
      assertPublishedUpdateAllowed(db, node, { status: 'published', publishedWaiverJson: '{"by":"alice"}' })
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe(ErrorCode.PUBLISHED_WAIVER_REQUIRED)
    expect((caught as Error).message).toContain('at')
    expect((caught as Error).message).toContain('reason')
  })

  it('完整豁免放行', () => {
    insertNode('n1')
    const waiver = JSON.stringify({ by: 'alice', at: NOW, reason: '无测试环境，人工确认', missing: ['pass_evidence'] })
    expect(() =>
      assertPublishedUpdateAllowed(db, node, { status: 'published', publishedWaiverJson: waiver }),
    ).not.toThrow()
  })

  it('有通过记录时无需豁免', () => {
    insertNode('n1')
    insertSpec('s1', 'ek_n1')
    insertRun('run1', 'passed')
    insertResult('r1', { specId: 's1', runId: 'run1' })
    expect(() => assertPublishedUpdateAllowed(db, node, { status: 'published' })).not.toThrow()
  })
})

describe('getPublishedStatus（徽标与统计，只读）', () => {
  it('区分 verified / unverified / 未发布', () => {
    insertNode('n1', { entityKey: 'ek1', status: 'published', title: 'A' })
    insertNode('n2', { entityKey: 'ek2', status: 'published', title: 'B' })
    insertNode('n3', { entityKey: 'ek3', status: 'confirmed', title: 'C' })
    insertNode('n4', { entityKey: 'ek4', status: 'published', title: 'D', type: 'feature' })

    insertSpec('s1', 'ek1')
    insertRun('run1', 'passed')
    insertResult('r1', { specId: 's1', runId: 'run1', status: 'passed', target: 'code1' })

    insertSpec('s2', 'ek2')
    insertRun('run2', 'failed')
    insertResult('r2', { specId: 's2', runId: 'run2', status: 'failed', target: 'code2' })

    const status = getPublishedStatus(db, 'g1')
    expect(status).toMatchObject({ total: 3, published: 2, verified: 1, publishedWithoutEvidence: 1 })
    expect(status.nodes.find((n) => n.id === 'n1')).toMatchObject({ badge: 'verified', hasPassEvidence: true })
    expect(status.nodes.find((n) => n.id === 'n2')).toMatchObject({
      badge: 'unverified',
      hasPassEvidence: false,
      lastTestStatus: 'failed',
      lastTestFailed: true,
    })
    expect(status.nodes.find((n) => n.id === 'n3')).toMatchObject({ badge: null, lastTestFailed: false })
    expect(status.nodes.some((n) => n.id === 'n4')).toBe(false)
  })
})
