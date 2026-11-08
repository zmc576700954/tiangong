/**
 * P9 — 非 git E4 不混同（session-map 蓝图 §8.11 / §3.5）。
 *
 * 断言（数据层）：
 *   - E3（`verified`）→ `is_reproducible=1`；E4（`signed_off`）→ `is_reproducible=0`；
 *   - E3/E4 并存时状态取 `verified`，等级取 E3，不把 E4 合并成“等价可复现”；
 *   - 两者都保留独立语义，不做同列合并/等价排序。
 *
 * 前提缺口：§8.11 的“地图徽标/列表/导出/看板逐项检查”属渲染层与导出层；
 * 当前 Node 测试不覆盖 UI。本脚本只锁数据层判据，UI/导出分组仍待 UI 测试补齐。
 */

import { describe, it, expect } from 'vitest'
import { deriveFromInputs } from '../../src/main/map/execution-state'

const item = { id: 'wi-1', status: 'done', gateStatus: 'passed', depsSatisfied: true }

function ev(id: string, level: 'E2' | 'E3' | 'E4', opts: { expired?: boolean; freshness?: 'fresh' | 'stale' } = {}) {
  return {
    id, level,
    freshness: opts.freshness ?? 'fresh',
    revoked: false,
    expired: opts.expired ?? false,
  }
}

describe('P9 E3 / E4 不混同', () => {
  it('E3 → verified + is_reproducible=1', () => {
    const r = deriveFromInputs({ evidence: [ev('e3', 'E3')], workItems: [item], runningRunIds: [], testFail: false })
    expect(r.state).toBe('verified')
    expect(r.evidenceLevel).toBe('E3')
    expect(r.isReproducible).toBe(1)
  })

  it('E4 → signed_off + is_reproducible=0', () => {
    const r = deriveFromInputs({ evidence: [ev('e4', 'E4')], workItems: [item], runningRunIds: [], testFail: false })
    expect(r.state).toBe('signed_off')
    expect(r.evidenceLevel).toBe('E4')
    expect(r.isReproducible).toBe(0)
  })

  it('E3+E4 并存：状态 verified、等级 E3、可复现=1，不合并成等价统计', () => {
    const r = deriveFromInputs({
      evidence: [ev('e3', 'E3'), ev('e4', 'E4')],
      workItems: [item], runningRunIds: [], testFail: false,
    })
    expect(r.state).toBe('verified')
    expect(r.evidenceLevel).toBe('E3')
    expect(r.isReproducible).toBe(1)
    expect(r.evidenceCount).toBe(2)
  })

  it('过期 E4 不计入 signed_off；只有 E4 且过期 → stale', () => {
    const r = deriveFromInputs({
      evidence: [ev('e4', 'E4', { expired: true })],
      workItems: [item], runningRunIds: [], testFail: false,
    })
    expect(r.state).toBe('stale')
  })
})
