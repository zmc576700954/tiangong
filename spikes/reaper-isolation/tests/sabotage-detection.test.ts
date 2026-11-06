/**
 * 对抗对照：用三个故意破坏的实现，验证测试台**确实能观测到越界信号**。
 *
 * 本文件在正常情况下应全部通过——它断言的是「缺陷被探针抓到」，
 * 而不是「缺陷不存在」。真正的「测试台会红」由 scripts/sabotage.sh 演示：
 * 把 REAPER_IMPL 换成坏实现后跑同一套 isolation.test.ts，断言全部变红。
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createSabotageReaper } from '../src/sabotage'
import { alive, killTap } from '../src/kill-tap'
import { killTrees, spawnProbe, waitMs } from '../src/harness'

beforeAll(() => {
  killTap.install()
})

afterAll(() => {
  killTap.dispose()
})

async function measure<T>(fn: () => Promise<T>): Promise<T> {
  killTap.reset()
  killTap.start()
  try {
    return await fn()
  } finally {
    killTap.stop()
  }
}

it('对照 1：共享登记表缺陷会被 C2 探针抓到（取消 A 连坐 B）', async () => {
  const bad = createSabotageReaper('sabotage:shared-registry')
  const A = await spawnProbe('SAB.shared.A', { children: 'none' })
  const B = await spawnProbe('SAB.shared.B', { children: 'none' })
  try {
    bad.register('turn-A', { pid: A.ownerPid })
    bad.register('turn-B', { pid: B.ownerPid })
    await measure(async () => {
      bad.reap('turn-A')
      await waitMs(200)
    })

    const signalsToB = killTap.countTo(B.ownerPid)
    expect(signalsToB, '测试台应观测到 B 被越界回收').toBeGreaterThan(0)
  } finally {
    await killTrees(A, B)
  }
})

it('对照 2：无归属校验缺陷会被 C4/C6 探针抓到（无关进程被 kill）', async () => {
  const bad = createSabotageReaper('sabotage:bare-pid')
  const canary = await spawnProbe('SAB.bare.canary', { children: 'none' })
  try {
    await measure(async () => {
      bad.killRegistered([{ pid: canary.ownerPid }])
      await waitMs(200)
    })

    expect(killTap.countTo(canary.ownerPid), '测试台应观测到裸 pid kill').toBeGreaterThan(0)
    expect(alive(canary.ownerPid), 'canary 应已被误杀').toBe(false)
  } finally {
    await killTrees(canary)
  }
})

it('对照 3：整组回收缺陷会被 C5 探针抓到（出现负 pid 信号）', async () => {
  const bad = createSabotageReaper('sabotage:group-wide')
  const A = await spawnProbe('SAB.group.A', { children: 'long', detached: true })
  try {
    bad.register('turn-A', { pid: A.ownerPid })
    const report = await measure(async () => {
      const r = bad.reap('turn-A')
      await waitMs(200)
      return r
    })

    expect(report.killedGroups.length, '坏版本会记录整组回收').toBeGreaterThan(0)
    expect(killTap.groupSignals().length, '测试台应观测到 -pgid 信号').toBeGreaterThan(0)
  } finally {
    await killTrees(A)
  }
})
