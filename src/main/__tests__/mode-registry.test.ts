/**
 * G2-1 模式库（代码常量）与 routing_decisions.mode_id 落库单测。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import {
  MODE_REGISTRY_LIMIT,
  assertKnownMode,
  listModes,
  matchMode,
} from '../map/mode-registry'
import { RoutingDecisionRepository } from '../map/work-run-service'

describe('mode-registry', () => {
  it('注册表不超上限、id 唯一且稳定', () => {
    const modes = listModes()
    expect(modes.length).toBeGreaterThan(0)
    expect(modes.length).toBeLessThanOrEqual(MODE_REGISTRY_LIMIT)
    const ids = modes.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_.]*$/)
  })

  it('listModes 返回副本，调用方修改不污染注册表', () => {
    const first = listModes()
    first[0].label = '被改坏'
    first[0].contextBundle.push('polluted')
    expect(listModes()[0].label).not.toBe('被改坏')
    expect(listModes()[0].contextBundle).not.toContain('polluted')
  })

  it('未知 mode_id fail-closed', () => {
    expect(() => assertKnownMode('agent.nope')).toThrowError(/未知 mode_id/)
  })

  it('规则匹配：执行器 + policy 决定模式', () => {
    expect(matchMode({ executorKind: 'agent', policy: 'manual_override', adapterName: 'claude-code' })?.id)
      .toBe('agent.implement')
    expect(matchMode({ executorKind: 'agent', policy: 'fallback', adapterName: 'claude-code' })?.id)
      .toBe('agent.fallback')
    expect(matchMode({ executorKind: 'test', policy: 'single_agent' })?.id).toBe('test.verify')
    expect(matchMode({ executorKind: 'human', policy: 'manual_override' })?.id).toBe('human.review')
  })

  it('无 adapter 的 agent 无匹配（调用方须转 TIER_UNSUPPORTED）', () => {
    expect(matchMode({ executorKind: 'agent', policy: 'manual_override', adapterName: '  ' })).toBeNull()
  })
})

describe('routing_decisions.mode_id', () => {
  let db: BetterSqlite3.Database
  let repo: RoutingDecisionRepository

  beforeEach(() => {
    db = new BetterSqlite3(':memory:')
    applyMapS5aSchema(db)
    repo = new RoutingDecisionRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('未知 mode_id 拒绝写入，不落半条行', () => {
    expect(() =>
      repo.record({
        chosenAdapter: 'claude-code',
        candidates: [],
        policy: 'manual_override',
        modeId: 'agent.nope',
      }),
    ).toThrowError(/未知 mode_id/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get()).toEqual({ n: 0 })
  })

  it('已知 mode_id 落库；历史调用不传时为 NULL', () => {
    const first = repo.record({
      chosenAdapter: 'claude-code',
      candidates: [],
      policy: 'manual_override',
      modeId: 'agent.implement',
    })
    expect(first.mode_id).toBe('agent.implement')

    const legacy = repo.record({ chosenAdapter: 'claude-code', candidates: [], policy: 'manual_override' })
    expect(legacy.mode_id).toBeNull()
  })
})
