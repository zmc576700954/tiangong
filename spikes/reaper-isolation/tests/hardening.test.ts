/**
 * 加强版归属证据契约（C4b）。
 *
 * D5 重写前：`commandMatches` 会退化为只比可执行文件名，叠加秒级 startedAt，
 * 「PID 复用 + 同秒启动 + 同可执行名」可凑成 2 项证据并误杀（历史 FAIL）。
 * D5 重写后：要求 ≥2 项证据且至少 1 项内容证据（完整命令行精确匹配 / marker），
 * 本条应转为 PASS，作为回归守护。
 *
 * 与 isolation.test.ts 分开跑（npm run test:hardening），避免 500ms 宽限拖慢主套件。
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createReaper } from '../src/adapter'
import { alive, killTap } from '../src/kill-tap'
import { identityOf, killTrees, recordEvidence, spawnProbe, waitMs } from '../src/harness'

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

it('C4b（加强）可执行名退化匹配不得单独凑成归属证据', async () => {
  const reaper = createReaper()
  const canary = await spawnProbe('HARDEN.C4b.canary', { children: 'none' })
  try {
    const actual = identityOf(canary.ownerPid)
    expect(actual, 'canary 应可被 ps 观测').toBeDefined()

    // 模拟：上一轮登记了同可执行文件、不同参数，且 pid 被复用、启动时间恰好落在同一秒
    const forged = {
      pid: canary.ownerPid,
      pgid: actual!.pgid,
      startedAt: actual!.startedAt,
      command: `${process.execPath} /nonexistent/other-agent-script.js --turn 3`,
    }

    const report = await measure(async () => {
      const r = reaper.killRegistered([forged])
      await waitMs(200)
      return r
    })

    const signals = killTap
      .sends()
      .filter((call) => call.pid === canary.ownerPid || call.pid === -canary.ownerPid)
    recordEvidence('C4b', {
      impl: reaper.implId,
      signalsToCanary: signals,
      report,
      canaryAlive: alive(canary.ownerPid),
      note: 'D5 后 commandMatches 已改为完整命令行精确比较，内容证据必选',
    })

    expect(signals, '加强契约：可执行名退化匹配不得导致 kill').toHaveLength(0)
    expect(report.killed).toBe(0)
    expect(report.unresolved[0]?.reason).toBe('insufficient-proof')
    expect(alive(canary.ownerPid)).toBe(true)
  } finally {
    await killTrees(canary)
  }
})
