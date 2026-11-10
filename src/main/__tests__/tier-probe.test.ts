/**
 * G3-1 Tier 探测单测（蓝图 §5.9.5 / II-22）。
 *
 * 四类后端各有结论：claude → Tier 1；codex → Tier 2；opencode / 长尾 CLI → Tier 3；
 * acp 有审批但无续跑 → Tier 3。探测失败（缺 adapter / 无 runtime / 无 driver）一律
 * Tier 3，禁止默认 Tier 1。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  missingTierCapabilities,
  probeAdapterTier,
  probeAdapterTierCached,
  resetTierProbeCacheForTests,
  type TierProbeInput,
} from '../map/tier-probe'

const ready: Omit<TierProbeInput, 'adapterName'> = {
  kernelReady: true,
  runtimeReady: true,
  driverRegistered: true,
}

describe('probeAdapterTier', () => {
  beforeEach(() => {
    resetTierProbeCacheForTests()
  })

  it('claude-code：四项齐全 → Tier 1', () => {
    const result = probeAdapterTier({ adapterName: 'claude-code', ...ready })
    expect(result).toMatchObject({
      tier: 1,
      approval_callback: true,
      resume: true,
      structured_output: true,
      cancel: true,
    })
    expect(result.probe_error).toBeUndefined()
    expect(missingTierCapabilities(result)).toEqual([])
  })

  it('codex：缺写前审批 → Tier 2（仍有续跑/结构化结果）', () => {
    const result = probeAdapterTier({ adapterName: 'codex', ...ready })
    expect(result.tier).toBe(2)
    expect(result.approval_callback).toBe(false)
    expect(result.resume).toBe(true)
    expect(result.structured_output).toBe(true)
  })

  it('opencode：无审批、无续跑、无结构化事件 → Tier 3', () => {
    const result = probeAdapterTier({ adapterName: 'opencode', ...ready })
    expect(result.tier).toBe(3)
    expect(result.approval_callback).toBe(false)
    expect(result.resume).toBe(false)
    expect(result.structured_output).toBe(false)
  })

  it('长尾 CLI（cline）：无审批、无续跑、无结构化事件 → Tier 3', () => {
    const result = probeAdapterTier({ adapterName: 'cline', ...ready })
    expect(result.tier).toBe(3)
  })

  it('acp：有写前审批但无续跑（无 session/load）→ Tier 3', () => {
    const result = probeAdapterTier({ adapterName: 'acp', ...ready })
    expect(result.tier).toBe(3)
    expect(result.approval_callback).toBe(true)
    expect(result.resume).toBe(false)
    expect(missingTierCapabilities(result)).toEqual(['resume'])
  })

  it('kernelReady=false 的 claude-code → Tier 2（不默认 Tier 1）', () => {
    const result = probeAdapterTier({ adapterName: 'claude-code', ...ready, kernelReady: false })
    expect(result.tier).toBe(2)
    expect(result.approval_callback).toBe(false)
  })

  it('探测失败一律 Tier 3：缺 adapter / 无 runtime / 无 driver', () => {
    expect(probeAdapterTier({ adapterName: '  ', ...ready })).toMatchObject({
      tier: 3,
      probe_error: 'ADAPTER_MISSING',
    })
    expect(
      probeAdapterTier({ adapterName: 'claude-code', ...ready, runtimeReady: false }),
    ).toMatchObject({ tier: 3, probe_error: 'RUNTIME_UNAVAILABLE' })
    expect(
      probeAdapterTier({ adapterName: 'claude-code', ...ready, driverRegistered: false }),
    ).toMatchObject({ tier: 3, probe_error: 'DRIVER_MISSING' })
  })

  it('进程内按 (adapter, adapterVersion) 缓存；显式 reset 后重算', () => {
    const first = probeAdapterTierCached({ adapterName: 'claude-code', ...ready })
    // 同一 key 命中缓存：即使输入变化也不重算（进程内缓存口径）。
    const second = probeAdapterTierCached({
      adapterName: 'claude-code',
      ...ready,
      kernelReady: false,
    })
    expect(second).toBe(first)

    // 不同 adapterVersion 是不同 key。
    const versioned = probeAdapterTierCached({
      adapterName: 'claude-code',
      ...ready,
      adapterVersion: '2.0.0',
      kernelReady: false,
    })
    expect(versioned.tier).toBe(2)

    resetTierProbeCacheForTests()
    const recomputed = probeAdapterTierCached({ adapterName: 'claude-code', ...ready })
    expect(recomputed.tier).toBe(1)
  })
})
