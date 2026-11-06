/**
 * C1–C11 隔离契约（硬断言版）。
 *
 * 判定证据同时来自三处：
 *   - kill tap：测试进程实际发出的信号（含 SIGKILL）
 *   - probe 日志：目标进程实际收到的信号（SIGTERM 等）与后代退出方式
 *   - 存活探测：kill(pid, 0)
 *
 * 所有场景都是真实子进程，没有 mock。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { listProcesses } from '../../../src/main/agent/runtime/process/reaper'
import { listProcRegistryRecords, readProcRegistryRecord } from '../../../src/main/shared/process-supervisor'
import { createReaper, type ReapReport } from '../src/adapter'
import { alive, killTap, rawKill } from '../src/kill-tap'
import {
  identityOf,
  killTrees,
  makeTempRegistryDir,
  recordEvidence,
  spawnProbe,
  spawnRegistrySupervisor,
  waitDead,
  waitMs,
} from '../src/harness'

async function waitForRecord(
  marker: string,
  dir: string,
  timeoutMs = 5000,
): Promise<ReturnType<typeof readProcRegistryRecord>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = readProcRegistryRecord(marker, dir)
    if (record) return record
    await waitMs(25)
  }
  return undefined
}

async function waitForChildPid(
  parentPid: number,
  timeoutMs = 3000,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const child = listProcesses().find((proc) => proc.ppid === parentPid)
    if (child) return child.pid
    await waitMs(25)
  }
  return undefined
}

beforeAll(() => {
  killTap.install()
})

afterAll(() => {
  killTap.dispose()
})

/** 打开信号统计窗口；窗口内的 kill 才算「被测实现的回收动作」。 */
async function measure<T>(fn: () => Promise<T>): Promise<T> {
  killTap.reset()
  killTap.start()
  try {
    return await fn()
  } finally {
    killTap.stop()
  }
}

function signalsToAny(pids: Array<number | undefined>): number {
  const targets = pids.filter((pid): pid is number => typeof pid === 'number')
  return killTap.sends().filter((call) => targets.includes(call.pid)).length
}

/** 负 pid（-pgid）也是「对这个组里的每个进程发信号」，必须并入越界统计。 */
function signalsToGroups(pgids: Array<number | undefined>): number {
  const targets = pgids.filter((pgid): pgid is number => typeof pgid === 'number')
  return killTap.sends().filter((call) => call.pid < 0 && targets.includes(-call.pid)).length
}

function signalsToResources(pids: Array<number | undefined>, pgids: Array<number | undefined>): number {
  return signalsToAny(pids) + signalsToGroups(pgids)
}

/** 单个进程「自身或所在自有组」收到的信号数（pid 可能同时是组长的 pid）。 */
function signalsAffecting(pid: number | undefined): number {
  if (typeof pid !== 'number') return 0
  return killTap.sends().filter((call) => call.pid === pid || call.pid === -pid).length
}

describe('跨会话进程回收隔离契约', () => {
  it('C1 正常完成：只 forget，不向任何进程发信号', async () => {
    const reaper = createReaper()
    const A = await spawnProbe('C1.A', { children: 'long' })
    const B = await spawnProbe('C1.B', { children: 'long' })
    try {
      const regA = reaper.register('turn-A', { pid: A.ownerPid, envMarker: 'bizgraph-turn:turn-A' })
      const regB = reaper.register('turn-B', { pid: B.ownerPid, envMarker: 'bizgraph-turn:turn-B' })
      expect(regA, 'A 必须能抓到真实身份').toBeDefined()
      expect(regB, 'B 必须能抓到真实身份').toBeDefined()

      await measure(async () => {
        reaper.forget('turn-A')
        await waitMs(400)
      })

      const sends = killTap.sends()
      recordEvidence('C1', {
        impl: reaper.implId,
        sends: sends.length,
        aAlive: alive(A.ownerPid),
        bAlive: alive(B.ownerPid),
      })
      expect(sends, '正常完成路径不得发出任何信号').toHaveLength(0)
      expect(alive(A.ownerPid), 'A owner 应存活（完成不杀）').toBe(true)
      expect(alive(B.ownerPid), 'B owner 应存活').toBe(true)
    } finally {
      await killTrees(A, B)
    }
  })

  it('C2 取消 A：只回收本轮登记句柄及其后代，B 完全不受影响', async () => {
    const reaper = createReaper()
    const A = await spawnProbe('C2.A', { children: 'long+short' })
    const B = await spawnProbe('C2.B', { children: 'long' })
    try {
      // 等短命子孙自然退出：已退出/已回收的 pid 不得再收到信号
      await waitMs(500)
      const shortPid = A.pidOf('C2.A.short')
      expect(shortPid, '短命子孙应已启动过').toBeDefined()

      const regA = reaper.register('turn-A', { pid: A.ownerPid })
      const regB = reaper.register('turn-B', { pid: B.ownerPid })
      expect(regA).toBeDefined()
      expect(regB).toBeDefined()

      const report = await measure(async () => {
        const r = reaper.reap('turn-A')
        await waitMs(150)
        return r
      })

      const bPids = [B.ownerPid, B.pidOf('C2.B.long')]
      const bPgids = [identityOf(B.ownerPid)?.pgid, identityOf(B.pidOf('C2.B.long')!)?.pgid]
      recordEvidence('C2', {
        impl: reaper.implId,
        killed: report.killed,
        killedPids: report.killedPids,
        killedGroups: report.killedGroups,
        unresolved: report.unresolved.map((item) => `${item.pid}:${item.reason}`),
        signalsToB: signalsToAny(bPids),
        signalsToBGroup: signalsToGroups(bPgids),
        signalsToShort: signalsToAny([shortPid]),
        groupSignals: killTap.groupSignals().length,
      })

      expect(signalsToResources(bPids, bPgids), 'B 的进程与其进程组不得收到任何信号').toBe(0)
      expect(signalsToAny([shortPid]), '已退出的短命子孙不得收到信号').toBe(0)
      expect(alive(B.ownerPid), 'B owner 必须存活').toBe(true)
      // 自建进程组（detached spawn）整组回收是允许的：组长 pid == pgid
      expect(report.killedGroups, '应整组回收 A 自己的进程组').toEqual([A.ownerPid])
      expect(report.killedPids, '组长 pid 仍应出现在 killedPids').toContain(A.ownerPid)
      expect(await waitDead(A.ownerPid), 'A owner 应在取消后被回收').toBe(true)
      expect(await waitDead(A.pidOf('C2.A.long')!), 'A 的后代应随组回收').toBe(true)

      // 接收侧证据：A owner 与长驻后代各收到 1 次 SIGTERM
      const aSignals = A.entries().filter((entry) => entry.type === 'signal')
      recordEvidence('C2.reception', {
        impl: reaper.implId,
        aSignals: aSignals.map((entry) => ({ label: entry.label, signal: entry.signal })),
        shortEntries: A.entries()
          .filter((entry) => entry.label === 'C2.A.short')
          .map((entry) => entry.type),
      })
      expect(aSignals.length, 'A 树应收到 SIGTERM 且仅收到一轮').toBe(2)
    } finally {
      await killTrees(A, B)
    }
  })

  it('C3 崩溃重启清扫：A 宿主 kill -9 后不得误杀 B，且 A 的孤儿按新机制可被认领', async () => {
    const B = await spawnProbe('C3.B', { children: 'long' })
    const canary = await spawnProbe('C3.canary', { children: 'none' })
    const A = await spawnProbe('C3.A', { children: 'long' })
    const registryDir = makeTempRegistryDir()
    let supervisorPid: number | undefined
    let cliPid: number | undefined
    let cliLongPid: number | undefined
    try {
      const beforeRestart = createReaper()
      const persisted = beforeRestart.register('turn-crashed-A', { pid: A.ownerPid })
      expect(persisted, '崩溃前必须已落库 pid/startedAt/command').toBeDefined()

      // 模拟会话宿主崩溃（不是被测实现发的信号，绕过 tap）
      rawKill(A.ownerPid, 'SIGKILL')
      expect(await waitDead(A.ownerPid), 'A owner 应已被崩溃杀掉').toBe(true)

      const fresh = createReaper()
      const report = await measure(async () => {
        const r = fresh.killRegistered([persisted!], { marker: 'bizgraph-turn:turn-crashed-A' })
        await waitMs(300)
        return r
      })

      const bPids = [B.ownerPid, B.pidOf('C3.B.long')]
      recordEvidence('C3.legacy', {
        impl: fresh.implId,
        killed: report.killed,
        missing: report.missing,
        unresolved: report.unresolved.map((item) => `${item.pid}:${item.reason}`),
        signalsToB: signalsToAny(bPids),
        signalsToCanary: signalsAffecting(canary.ownerPid),
        orphanGrandchildAlive: alive(A.pidOf('C3.A.long')!),
      })

      expect(signalsToAny(bPids), '重启清扫不得触碰 B').toBe(0)
      expect(signalsAffecting(canary.ownerPid), '重启清扫不得触碰无关进程').toBe(0)
      expect(report.killed, '被崩溃带走的 owner 已不存在，不得产生 kill').toBe(0)
      expect(report.missing, 'owner 应被判定为 not-found').toContain(A.ownerPid)
      expect(alive(B.ownerPid), 'B 必须存活').toBe(true)
      expect(alive(canary.ownerPid), 'canary 必须存活').toBe(true)

      // ---- D5 新机制：Self-registration（Codex shim）----
      // 真实 shim 替代物 spawn 一个 detached CLI（自有组），把 ps 身份写入注册文件；
      // 随后宿主被 kill -9，新进程只凭这份文件做启动清扫。
      const marker = 'bizgraph-turn:C3-registry'
      const supervisor = spawnRegistrySupervisor(marker, registryDir)
      supervisorPid = supervisor.pid
      const record = await waitForRecord(marker, registryDir)
      expect(record, 'shim 应已写入自注册文件').toBeDefined()
      cliPid = record!.pid
      expect(record!.pgid, 'CLI 应为自有进程组组长').toBe(cliPid)
      cliLongPid = await waitForChildPid(cliPid, 3000)
      expect(cliLongPid, 'CLI 应已派生出长驻后代').toBeDefined()

      // 宿主崩溃：注册文件已落盘，CLI 进程组成为孤儿
      rawKill(supervisorPid!, 'SIGKILL')
      expect(await waitDead(supervisorPid!), 'shim 宿主应已被崩溃杀掉').toBe(true)

      const records = listProcRegistryRecords(registryDir)
      expect(records.map((item) => item.marker), '注册目录应能枚举到该记录').toContain(marker)

      const restarted = createReaper()
      const registryReport = await measure(async () => {
        const r = restarted.killRegistered(
          [
            {
              pid: record!.pid,
              pgid: record!.pgid,
              startedAt: record!.startedAt,
              command: record!.command,
            },
          ],
          { marker: record!.marker },
        )
        await waitMs(300)
        return r
      })

      recordEvidence('C3.registry', {
        impl: restarted.implId,
        marker,
        cliPid,
        cliLongPid,
        record,
        killed: registryReport.killed,
        killedPids: registryReport.killedPids,
        killedGroups: registryReport.killedGroups,
        unresolved: registryReport.unresolved,
        signalsToB: signalsToAny(bPids),
        signalsToBGroup: signalsToGroups([identityOf(B.ownerPid)?.pgid]),
        signalsToOtherGroups: killTap
          .groupSignals()
          .filter((call) => call.pid !== -record!.pid)
          .map((call) => call.pid),
      })

      expect(signalsToAny(bPids), '凭注册文件清扫也不得触碰 B').toBe(0)
      expect(signalsToGroups([identityOf(B.ownerPid)?.pgid]), 'B 的组不得收到整组信号').toBe(0)
      expect(registryReport.killedGroups, '应只回收 A 的 CLI 自有组').toEqual([cliPid])
      expect(registryReport.killedPids, 'CLI 组长应被记账').toContain(cliPid)
      expect(await waitDead(cliPid!), 'A 的孤儿 CLI 应被认领并回收').toBe(true)
      expect(await waitDead(cliLongPid!), 'CLI 的后代应随组回收').toBe(true)
      expect(alive(B.ownerPid), 'B 仍必须存活').toBe(true)
    } finally {
      if (supervisorPid) rawKill(supervisorPid, 'SIGKILL')
      if (cliPid) rawKill(cliPid, 'SIGKILL')
      if (cliLongPid) rawKill(cliLongPid, 'SIGKILL')
      await killTrees(A, B, canary)
      rmSync(registryDir, { recursive: true, force: true })
    }
  })

  it('C4 PID 复用：无证据/陈旧证据不得 kill 占用该 pid 的无关进程', async () => {
    const reaper = createReaper()
    const canary = await spawnProbe('C4.canary', { children: 'none' })
    try {
      const actual = identityOf(canary.ownerPid)
      expect(actual, 'canary 应可被 ps 观测').toBeDefined()

      const cases: Array<{ name: string; expected: Parameters<typeof reaper.killRegistered>[0] }> = [
        { name: 'bare-pid', expected: [{ pid: canary.ownerPid }] },
        { name: 'marker-only', expected: [{ pid: canary.ownerPid }] },
        {
          name: 'stale-identity',
          expected: [
            {
              pid: canary.ownerPid,
              pgid: actual!.pgid,
              startedAt: 'Thu Jan  1 01:00:00 1970',
              command: '/usr/bin/legacy-agent-executor --turn 7',
            },
          ],
        },
      ]

      const reports: ReapReport[] = await measure(async () => {
        const collected: ReapReport[] = []
        collected.push(reaper.killRegistered(cases[0].expected))
        collected.push(
          reaper.killRegistered(cases[1].expected, { marker: 'bizgraph-turn:absent-marker' }),
        )
        collected.push(reaper.killRegistered(cases[2].expected))
        await waitMs(200)
        return collected
      })

      recordEvidence('C4', {
        impl: reaper.implId,
        signalsToCanary: signalsAffecting(canary.ownerPid),
        reports: reports.map((report, index) => ({
          case: cases[index].name,
          killed: report.killed,
          unresolved: report.unresolved.map((item) => `${item.pid}:${item.reason}`),
        })),
        canaryAlive: alive(canary.ownerPid),
      })

      expect(signalsAffecting(canary.ownerPid), 'PID 复用场景 kill 计数必须为 0').toBe(0)
      expect(alive(canary.ownerPid), 'canary 必须存活').toBe(true)
      for (const report of reports) {
        expect(report.killed).toBe(0)
        expect(report.unresolved.length).toBe(1)
        expect(report.unresolved[0].reason).toBe('insufficient-proof')
      }
    } finally {
      await killTrees(canary)
    }
  })

  it('C5 组边界：组不重叠，整组回收只命中自有进程组', async () => {
    const reaper = createReaper()
    const A = await spawnProbe('C5.A', { children: 'long', detached: true })
    const B = await spawnProbe('C5.B', { children: 'long', detached: true })
    try {
      const regA = reaper.register('turn-A', { pid: A.ownerPid })
      const regB = reaper.register('turn-B', { pid: B.ownerPid })
      expect(regA, '应能抓到 A 的 pgid').toBeDefined()
      expect(regB, '应能抓到 B 的 pgid').toBeDefined()
      // setsid 后 owner 自己是组长，且两个会话的组互不重叠
      expect(regA!.pgid, 'detached spawn 的 A owner 应为组长').toBe(A.ownerPid)
      expect(regB!.pgid, 'detached spawn 的 B owner 应为组长').toBe(B.ownerPid)
      expect(regA!.pgid, '不同会话的进程组不得重叠').not.toBe(regB!.pgid)

      const report = await measure(async () => {
        const r = reaper.reap('turn-A')
        await waitMs(150)
        return r
      })

      recordEvidence('C5', {
        impl: reaper.implId,
        pgidA: regA!.pgid,
        pgidB: regB!.pgid,
        groupSignals: killTap.groupSignals(),
        killedGroups: report.killedGroups,
        signalsToBGroup: signalsToGroups([regB!.pgid]),
      })

      expect(killTap.groupSignals(), '整组信号只允许指向 A 自己的组').toEqual([
        expect.objectContaining({ pid: -A.ownerPid }),
      ])
      expect(signalsToGroups([regB!.pgid]), 'B 的组不得收到任何信号').toBe(0)
      expect(report.killedGroups, '只允许回收自有进程组').toEqual([A.ownerPid])
      expect(alive(B.ownerPid), 'B 必须存活').toBe(true)
      expect(await waitDead(A.ownerPid), 'A 应被回收').toBe(true)
    } finally {
      await killTrees(A, B)
    }
  })

  it('C5b 组边界退化：pgid≠pid 时退回进程树回收，绝不整组杀', async () => {
    const reaper = createReaper()
    // 与生产未 setsid 的 spawn 形态一致：子进程落在宿主（这里是 vitest）的进程组
    const C = await spawnProbe('C5b.C', { children: 'long', detached: false })
    try {
      const regC = reaper.register('turn-C', { pid: C.ownerPid })
      expect(regC).toBeDefined()
      const observedPgid = identityOf(C.ownerPid)?.pgid
      expect(observedPgid, '应与宿主同组').not.toBe(C.ownerPid)

      const report = await measure(async () => {
        const r = reaper.reap('turn-C')
        await waitMs(150)
        return r
      })

      recordEvidence('C5b', {
        impl: reaper.implId,
        observedPgid,
        groupSignals: killTap.groupSignals(),
        killedGroups: report.killedGroups,
        killedPids: report.killedPids,
      })

      // 若这里出现 -pgid，说明会连带杀掉宿主/无关会话
      expect(killTap.groupSignals(), '共享组不得整组回收').toHaveLength(0)
      expect(report.killedGroups).toHaveLength(0)
      expect(await waitDead(C.ownerPid), '仍应按进程树回收本 turn').toBe(true)
      expect(alive(process.pid), '宿主必须存活').toBe(true)
    } finally {
      await killTrees(C)
    }
  })

  it('C6 证据不足：kill 计数为 0，且报告暴露 unconfirmed 判定输入', async () => {
    const reaper = createReaper()
    const canary = await spawnProbe('C6.canary', { children: 'none' })
    try {
      const report = await measure(async () => {
        const r = reaper.killRegistered([{ pid: canary.ownerPid }])
        await waitMs(200)
        return r
      })

      recordEvidence('C6', {
        impl: reaper.implId,
        killed: report.killed,
        unresolved: report.unresolved,
        signals: signalsAffecting(canary.ownerPid),
        // runtime.classifyResidual（runtime.ts L68-L76）：unresolved>0 → residual_risk=unconfirmed
        // 该函数未导出，此处以 ReapReport 的判定输入为准，映射在文档中引用源码口径
        expectedResidualRisk: 'unconfirmed',
      })

      expect(signalsAffecting(canary.ownerPid), '无法证明归属时 kill 计数必须为 0').toBe(0)
      expect(report.killed).toBe(0)
      expect(report.unresolved.length, '必须显式给出 unresolved 让上层落 residual_risk').toBeGreaterThan(0)
      expect(report.unresolved[0].reason).toBe('insufficient-proof')
      expect(alive(canary.ownerPid)).toBe(true)
    } finally {
      await killTrees(canary)
    }
  })

  it('C7 短命子孙：已退出的后代不参与回收、不接收信号', async () => {
    const reaper = createReaper()
    const A = await spawnProbe('C7.A', { children: 'long+short' })
    try {
      await waitMs(500)
      const shortPid = A.pidOf('C7.A.short')
      expect(shortPid, '短命子孙应已 ready').toBeDefined()
      const shortEntriesBefore = A.entries().filter((entry) => entry.label === 'C7.A.short')
      expect(shortEntriesBefore.some((entry) => entry.type === 'natural-exit'), '短命子孙应自然退出').toBe(true)

      reaper.register('turn-A', { pid: A.ownerPid })
      const report = await measure(async () => {
        const r = reaper.reap('turn-A')
        await waitMs(150)
        return r
      })

      recordEvidence('C7', {
        impl: reaper.implId,
        killedPids: report.killedPids,
        killedGroups: report.killedGroups,
        shortPid,
        signalsToShort: killTap.countTo(shortPid!),
        shortSignalEntries: A.entries()
          .filter((entry) => entry.label === 'C7.A.short' && entry.type === 'signal')
          .map((entry) => entry.signal),
      })

      expect(killTap.countTo(shortPid!), '已自然退出的后代不得收到信号').toBe(0)
      expect(report.killedPids).not.toContain(shortPid)
      expect(report.killedGroups, 'A 是自有组长，应整组回收').toEqual([A.ownerPid])
      expect(report.killedPids, '组长 pid 仍应记账').toContain(A.ownerPid)
      expect(await waitDead(A.ownerPid)).toBe(true)
      expect(await waitDead(A.pidOf('C7.A.long')!), '长驻后代应随组回收').toBe(true)
    } finally {
      await killTrees(A)
    }
  })

  it('C8 SDK 不暴露 PID 的兜底：只有 marker 时不得 kill，诊断扫描不参与决策', async () => {
    const reaper = createReaper()
    const marker = 'bizgraph-turn:turn-sdk-unknown-pid'
    const sdkChild = await spawnProbe('C8.sdk-child', { children: 'none', extraArgs: [marker] })
    try {
      const reg = reaper.register('turn-sdk', { envMarker: marker })
      expect(reg, '没有 pid 时 register 必须返回 undefined').toBeUndefined()

      const result = await measure(async () => {
        const report = reaper.reap('turn-sdk')
        const diagnosticCount = reaper.residualCount(marker)
        const scan = reaper.scanResidual(marker)
        await waitMs(200)
        return { report, diagnosticCount, scan: scan.length }
      })

      recordEvidence('C8', {
        impl: reaper.implId,
        register: reg ?? null,
        discovered: result.report.discovered,
        killed: result.report.killed,
        diagnosticCount: result.diagnosticCount,
        scanHits: result.scan,
        signals: killTap.sends().length,
      })

      expect(result.report.discovered, '无 pid 时不应有可回收候选').toBe(0)
      expect(result.report.killed).toBe(0)
      expect(killTap.sends(), '仅凭 marker 不得发出任何信号').toHaveLength(0)
      expect(result.diagnosticCount, '命令行含 marker 的进程应被诊断计数（argv 可见）').toBeGreaterThan(0)
      expect(result.scan, 'scanResidual 只能诊断，不得触发 kill').toBeGreaterThan(0)
      expect(alive(sdkChild.ownerPid), 'SDK 隐式子进程必须存活').toBe(true)
    } finally {
      await killTrees(sdkChild)
    }
  })

  it('C9 并发上限：4 会话并发时，取消只影响被取消的两个 turn', async () => {
    const reaper = createReaper()
    const A = await spawnProbe('C9.A', { children: 'long' })
    const B = await spawnProbe('C9.B', { children: 'long' })
    const C = await spawnProbe('C9.C', { children: 'long' })
    const D = await spawnProbe('C9.D', { children: 'long' })
    const canary = await spawnProbe('C9.canary', { children: 'none' })
    try {
      for (const [turn, tree] of [
        ['turn-A', A],
        ['turn-B', B],
        ['turn-C', C],
        ['turn-D', D],
      ] as const) {
        expect(reaper.register(turn, { pid: tree.ownerPid }), `${turn} 应登记成功`).toBeDefined()
      }

      await measure(async () => {
        reaper.forget('turn-A')
        reaper.reap('turn-B')
        reaper.forget('turn-C')
        reaper.reap('turn-D')
        await waitMs(200)
      })

      const protectedPids = [
        A.ownerPid,
        A.pidOf('C9.A.long'),
        C.ownerPid,
        C.pidOf('C9.C.long'),
        canary.ownerPid,
      ]
      const protectedGroups = [A.ownerPid, C.ownerPid, canary.ownerPid]
      const cancelledPids = [
        B.ownerPid,
        B.pidOf('C9.B.long'),
        D.ownerPid,
        D.pidOf('C9.D.long'),
      ]
      const cancelledGroups = [B.ownerPid, D.ownerPid]
      recordEvidence('C9', {
        impl: reaper.implId,
        signalsToProtected: signalsToResources(protectedPids, protectedGroups),
        signalsToCancelled: signalsToResources(cancelledPids, cancelledGroups),
        groupSignals: killTap.groupSignals(),
      })

      expect(signalsToResources(protectedPids, protectedGroups), '完成/无关的会话不得收到任何信号').toBe(0)
      expect(signalsToResources(cancelledPids, cancelledGroups), '被取消的两个会话必须被回收').toBeGreaterThan(0)
      expect(alive(A.ownerPid) && alive(C.ownerPid) && alive(canary.ownerPid)).toBe(true)
      expect(await waitDead(B.ownerPid), 'B 应被回收').toBe(true)
      expect(await waitDead(D.ownerPid), 'D 应被回收').toBe(true)
      expect(await waitDead(B.pidOf('C9.B.long')!), 'B 的后代应随组回收').toBe(true)
      expect(await waitDead(D.pidOf('C9.D.long')!), 'D 的后代应随组回收').toBe(true)
    } finally {
      await killTrees(A, B, C, D, canary)
    }
  })

  it('C10 陈旧句柄：上一轮 pid 即使仍存活，也不得被下一轮回收', async () => {
    const reaper = createReaper()
    const stale = await spawnProbe('C10.stale', { children: 'none' })
    const fresh = await spawnProbe('C10.fresh', { children: 'long' })
    const canary = await spawnProbe('C10.canary', { children: 'none' })
    try {
      reaper.register('turn-1', { pid: stale.ownerPid })
      // 模拟 turn 1 正常完成：Runtime 会 forget + clearSessionProcess
      reaper.forget('turn-1')
      reaper.register('turn-2', { pid: fresh.ownerPid })

      const result = await measure(async () => {
        const reapedTurn1 = reaper.reap('turn-1')
        const reapedTurn2 = reaper.reap('turn-2')
        await waitMs(150)
        return { reapedTurn1, reapedTurn2 }
      })

      recordEvidence('C10', {
        impl: reaper.implId,
        turn1Discovered: result.reapedTurn1.discovered,
        turn1Killed: result.reapedTurn1.killed,
        turn2KilledPids: result.reapedTurn2.killedPids,
        signalsToStale: signalsAffecting(stale.ownerPid),
        signalsToCanary: signalsAffecting(canary.ownerPid),
      })

      expect(result.reapedTurn1.discovered, 'forget 后的 turn 不应有登记句柄').toBe(0)
      expect(result.reapedTurn1.killed).toBe(0)
      expect(signalsAffecting(stale.ownerPid), '陈旧 pid 不得收到信号').toBe(0)
      expect(signalsAffecting(canary.ownerPid), '无关进程不得收到信号').toBe(0)
      expect(reporterTargetAlive(stale.ownerPid, canary.ownerPid)).toBe(true)
      expect(await waitDead(fresh.ownerPid), '新 turn 句柄应被回收').toBe(true)
    } finally {
      await killTrees(stale, fresh, canary)
    }
  })

  it('C11 自我保护：永不向自身、pid<=1 或负 pid 发信号', async () => {
    const reaper = createReaper()
    const selfReg = reaper.register('turn-self', { pid: process.pid })
    expect(selfReg, '不能登记测试进程自身').toBeUndefined()

    const report = await measure(async () => {
      const r1 = reaper.reap('turn-self')
      const r2 = reaper.killRegistered([
        { pid: 1, command: '/sbin/launchd', startedAt: 'Thu Jan  1 00:00:00 1970' },
        { pid: process.pid, command: process.execPath, startedAt: 'Thu Jan  1 00:00:00 1970' },
        { pid: -1 },
      ])
      await waitMs(150)
      return { r1, r2 }
    })

    recordEvidence('C11', {
      impl: reaper.implId,
      discoverSelf: report.r1.discovered,
      killed: report.r2.killed,
      unresolved: report.r2.unresolved.map((item) => `${item.pid}:${item.reason}`),
      signals: killTap.sends().length,
    })

    expect(killTap.sends(), '自我保护场景 kill 计数必须为 0').toHaveLength(0)
    expect(report.r1.discovered).toBe(0)
    expect(report.r2.killed).toBe(0)
    expect(report.r2.unresolved.map((item) => item.reason)).toEqual([
      'unsafe-pid',
      'unsafe-pid',
      'unsafe-pid',
    ])
  })
})

function reporterTargetAlive(...pids: number[]): boolean {
  return pids.every((pid) => alive(pid))
}
