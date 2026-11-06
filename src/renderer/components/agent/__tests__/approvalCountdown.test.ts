/**
 * B4：审批倒计时首帧不得出现超过设定上限的值（真机曾出现 126/141 秒）。
 */

import { describe, expect, it } from 'vitest'
import { computeRemainingSeconds } from '../approvalCountdown'

describe('computeRemainingSeconds (B4)', () => {
  const createdAt = 1_000_000
  const timeoutMs = 120_000
  const payload = { createdAt, expiresAt: createdAt + timeoutMs, timeoutMs }

  it('倒计时以 expires_at - now 计算，首帧不会超过 timeout（陈旧 now 场景）', () => {
    // 组件在请求到达前 21 秒挂载：now 早于 createdAt
    const staleNow = createdAt - 21_000
    expect(computeRemainingSeconds(payload, staleNow)).toBe(120)
  })

  it('请求到达后首帧显示真实剩余秒数', () => {
    expect(computeRemainingSeconds(payload, createdAt)).toBe(120)
    expect(computeRemainingSeconds(payload, createdAt + 30_000)).toBe(90)
    expect(computeRemainingSeconds(payload, createdAt + 119_500)).toBe(1)
  })

  it('过期后 clamp 到 0，不被负数击穿', () => {
    expect(computeRemainingSeconds(payload, createdAt + 200_000)).toBe(0)
  })

  it('payload 缺少 timeoutMs 时退化为 createdAt→expiresAt 区间', () => {
    const fallback = { createdAt, expiresAt: createdAt + 45_000 }
    expect(computeRemainingSeconds(fallback, createdAt - 10_000)).toBe(45)
    expect(computeRemainingSeconds(fallback, createdAt + 20_000)).toBe(25)
  })
})
