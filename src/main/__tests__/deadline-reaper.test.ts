/**
 * DeadlineReaper（F3-A）单测：依赖注入，不起真库。
 *
 * 规格（蓝图 §3.1 R9-6）：setInterval 5s 扫描 status='running' 且 deadline 已过期
 * 的 turn → kill+CAS → terminateSession('timeout')；in-flight 去重 + 终态 CAS
 * 双保险防重复杀；waiting_approval 不进扫描结果（repo 层过滤）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeadlineReaper } from '../agent/runtime/process/deadline-reaper'
import type { DeadlineReaperDeps, ExpiredTurnRef } from '../agent/runtime/process/deadline-reaper'

function createDeps() {
  let expired: ExpiredTurnRef[] = []
  const expireResults = new Map<string, boolean>()
  const expireCalls: string[] = []
  const terminated: Array<{ sessionId: string; reason: string }> = []
  const deps: DeadlineReaperDeps = {
    listExpiredRunningTurns: vi.fn((now: number) => {
      void now
      return expired
    }),
    expireTurn: vi.fn(async (turnId: string) => {
      expireCalls.push(turnId)
      return expireResults.get(turnId) ?? false
    }),
    terminateSession: vi.fn(async (sessionId: string, reason: string) => {
      terminated.push({ sessionId, reason })
    }),
  }
  return {
    deps,
    setExpired: (v: ExpiredTurnRef[]) => {
      expired = v
    },
    expireResults,
    expireCalls,
    terminated,
  }
}

describe('DeadlineReaper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('收口过期 turn：kill+CAS 成功后 terminateSession(sessionId, timeout)', async () => {
    const { deps, setExpired, expireResults, terminated, expireCalls } = createDeps()
    const reaper = new DeadlineReaper(deps, 5000)
    setExpired([{ id: 't1', session_id: 's1' }])
    expireResults.set('t1', true)

    const reaped = await reaper.sweep(1_700_000_000_000)

    expect(reaped).toEqual(['t1'])
    expect(expireCalls).toEqual(['t1'])
    expect(terminated).toEqual([{ sessionId: 's1', reason: 'timeout' }])
  })

  it('expireTurn 返回 false（完成/取消抢先）时不 terminate，不重复收口', async () => {
    const { deps, setExpired, terminated, expireCalls } = createDeps()
    const reaper = new DeadlineReaper(deps, 5000)
    setExpired([{ id: 't1', session_id: 's1' }])

    const reaped = await reaper.sweep(1_700_000_000_000)

    expect(reaped).toEqual([])
    expect(expireCalls).toEqual(['t1'])
    expect(terminated).toEqual([])
  })

  it('in-flight 去重：同一 turn 的并发收口只进行一次', async () => {
    const { deps, setExpired, expireResults } = createDeps()
    setExpired([{ id: 't1', session_id: 's1' }])
    let releaseExpire!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseExpire = resolve
    })
    ;(deps.expireTurn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => gate.then(() => true))
    expireResults.set('t1', true)
    const reaper = new DeadlineReaper(deps, 5000)

    const first = reaper.sweep(1_700_000_000_000)
    // 第一轮仍在等待 expireTurn 返回期间，第二轮扫描到同一 turn 必须跳过。
    const second = await reaper.sweep(1_700_000_000_001)
    expect(second).toEqual([])
    releaseExpire()
    expect(await first).toEqual(['t1'])
    expect(
      (deps.expireTurn as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 't1'),
    ).toHaveLength(1)
  })

  it('terminateSession 失败被容忍（终态已落，不回滚不掩盖）', async () => {
    const { deps, setExpired, expireResults, expireCalls } = createDeps()
    const reaper = new DeadlineReaper(deps, 5000)
    setExpired([{ id: 't1', session_id: 's1' }])
    expireResults.set('t1', true)
    ;(deps.terminateSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('session gone'),
    )

    const reaped = await reaper.sweep(1_700_000_000_000)

    expect(reaped).toEqual(['t1'])
    expect(expireCalls).toEqual(['t1'])
  })

  it('start/stop：按 interval 驱动扫描，stop 后不再触发', async () => {
    const { deps } = createDeps()
    const reaper = new DeadlineReaper(deps, 5000)
    reaper.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.listExpiredRunningTurns).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.listExpiredRunningTurns).toHaveBeenCalledTimes(2)

    reaper.stop()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.listExpiredRunningTurns).toHaveBeenCalledTimes(2)
  })

  it('start 幂等：重复调用不叠加定时器', async () => {
    const { deps } = createDeps()
    const reaper = new DeadlineReaper(deps, 5000)
    reaper.start()
    reaper.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.listExpiredRunningTurns).toHaveBeenCalledTimes(1)
    reaper.stop()
  })
})
