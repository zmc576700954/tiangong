/**
 * Lamport clock tests (D10d-4)
 *
 * 覆盖：
 *   - 本地 tick 单调递增
 *   - observe(remote) 推进到 max(local, remote) + 1
 *   - 同 actor 自反时不退化
 *   - compareLamport: clock 大者赢；clock 相同时 actorId 字典序小的赢
 *   - encodeLamport / decodeLamport 序列化往返
 */

import { describe, it, expect } from 'vitest'
import { LamportClock, compareLamport, createLamport, encodeLamport, decodeLamport } from '../lamport'

describe('LamportClock', () => {
  it('tick 单调递增', () => {
    const clock = new LamportClock(0, 'actor-a')
    expect(clock.tick().clock).toBe(0)
    expect(clock.tick().clock).toBe(1)
    expect(clock.tick().clock).toBe(2)
    expect(clock.value).toBe(3)
  })

  it('observe(remote) 把本地推到 max(local, remote) + 1', () => {
    const clock = new LamportClock(5, 'actor-a')
    clock.observe({ clock: 10, actorId: 'actor-b' })
    // 期望 max(5, 10) + 1 = 11
    expect(clock.value).toBe(11)
  })

  it('observe(remote) 不退化：remote < local 时不动', () => {
    const clock = new LamportClock(10, 'actor-a')
    clock.observe({ clock: 3, actorId: 'actor-b' })
    expect(clock.value).toBe(10)
  })

  it('observe(同 actor 自反) 防御 remote > local 时推进', () => {
    // 模拟客户端重启后丢失本地 clock 的边界
    const clock = new LamportClock(0, 'actor-a')
    clock.observe({ clock: 5, actorId: 'actor-a' })
    expect(clock.value).toBe(6)
  })

  it('observe(同 actor 自反) remote < local 不退化', () => {
    const clock = new LamportClock(10, 'actor-a')
    clock.observe({ clock: 3, actorId: 'actor-a' })
    expect(clock.value).toBe(10)
  })

  it('多次 observe(remote) 累加：连续收多条远端消息', () => {
    const clock = new LamportClock(0, 'actor-a')
    clock.observe({ clock: 5, actorId: 'b' })
    // 本地 value 应该是 6
    clock.observe({ clock: 100, actorId: 'b' })
    // 本地 value 应该是 101
    expect(clock.value).toBe(101)
  })
})

describe('compareLamport', () => {
  it('clock 大者赢', () => {
    const a = createLamport(5, 'a')
    const b = createLamport(3, 'a')
    expect(compareLamport(a, b)).toBe(1)
    expect(compareLamport(b, a)).toBe(-1)
  })

  it('clock 相同时 actorId 字典序小的赢', () => {
    const a = createLamport(7, 'alpha')
    const b = createLamport(7, 'beta')
    expect(compareLamport(a, b)).toBe(-1)
    expect(compareLamport(b, a)).toBe(1)
  })

  it('clock + actorId 全相等返回 0', () => {
    const a = createLamport(7, 'alpha')
    const b = createLamport(7, 'alpha')
    expect(compareLamport(a, b)).toBe(0)
  })
})

describe('encodeLamport / decodeLamport', () => {
  it('序列化往返一致', () => {
    const ts = createLamport(42, 'actor-x')
    const encoded = encodeLamport(ts)
    expect(encoded).toEqual({ clock: 42, actorId: 'actor-x' })
    expect(decodeLamport(encoded)).toEqual(ts)
  })

  it('decodeLamport 拒绝非法输入', () => {
    expect(decodeLamport(null)).toBeNull()
    expect(decodeLamport(undefined)).toBeNull()
    expect(decodeLamport('bad')).toBeNull()
    expect(decodeLamport({})).toBeNull()
    expect(decodeLamport({ clock: 'not-number', actorId: 'a' })).toBeNull()
    expect(decodeLamport({ clock: NaN, actorId: 'a' })).toBeNull()
    expect(decodeLamport({ clock: 1, actorId: '' })).toBeNull()
  })
})