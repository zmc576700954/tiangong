/**
 * D5 验收（第二轮复核后）：
 * - 同进程内只回收本轮真实登记、归属可证明的进程树；
 * - 跨重启只回收「start_time + command」两项证据成立的残留；
 * - PID 复用 / 裸 pid / 仅 marker → 一律不杀（只进 unresolved，交由调用方写 residual_risk）。
 *
 * 用真实 detached 子进程与真实 `ps`，不 mock 进程表，也不把 marker 塞进 argv 伪造命中。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { attestProcIdentity, listProcesses, ProcessReaper, type ProcIdentity } from '../process/reaper'

const spawned: ChildProcess[] = []

function spawnChild(extraArgs: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', ...extraArgs], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  if (child.pid) spawned.push(child)
  return child
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timeout waiting for process to appear')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
})

describe('ProcessReaper (D5 / P0-A / P0-2)', () => {
  it('reaps only the registered process tree after proving ownership (same-process)', async () => {
    const reaper = new ProcessReaper()
    const child = spawnChild()
    expect(child.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))

    const identity = reaper.registerProcess('turn-reap', { pid: child.pid!, pgid: child.pid! })
    expect(identity?.startedAt, '登记时必须抓到启动时间，否则无法证明归属').toBeTruthy()
    expect(identity?.command, '登记时必须抓到命令行').toBeTruthy()

    const report = reaper.reap('turn-reap')
    expect(report.killed).toBeGreaterThanOrEqual(1)
    expect(report.unresolved).toHaveLength(0)
    await waitFor(() => !alive(child.pid!))
  }, 15_000)

  it('refuses to kill an unrelated process that occupies a previously recorded pid (PID reuse)', async () => {
    const bystander = spawnChild()
    expect(bystander.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === bystander.pid))

    const reaper = new ProcessReaper()
    // 模拟上一轮落库的句柄：pid 恰好被无关进程复用，但启动时间/命令行对不上
    const staleHandle: ProcIdentity = {
      pid: bystander.pid!,
      command: 'previous-turn-cmd --leaked-handle',
      startedAt: 'Jan 1 00:00:00 2024',
    }
    const report = reaper.killRegistered([staleHandle])
    expect(report.killed).toBe(0)
    expect(report.unresolved).toHaveLength(1)
    expect(report.unresolved[0].reason).toBe('insufficient-proof')
    expect(alive(bystander.pid!), 'PID 复用的无关进程必须存活').toBe(true)
  }, 15_000)

  it('refuses to kill a bare persisted pid that has no ownership evidence', async () => {
    const bystander = spawnChild()
    expect(bystander.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === bystander.pid))

    const reaper = new ProcessReaper()
    const report = reaper.killRegistered([{ pid: bystander.pid! }])
    expect(report.killed).toBe(0)
    expect(report.unresolved[0].reason).toBe('insufficient-proof')
    expect(alive(bystander.pid!)).toBe(true)
  }, 15_000)

  it('marker visible only in the command line is not enough to claim a process', async () => {
    const marker = `bg-marker-only-${process.pid}-${Date.now()}`
    const bystander = spawnChild([marker])
    expect(bystander.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === bystander.pid))

    const reaper = new ProcessReaper()
    // 只有 marker 一项证据（command/startedAt 均不匹配）→ 不满足两项，不允许杀
    const report = reaper.killRegistered([{ pid: bystander.pid!, command: 'other', startedAt: 'Jan 1 00:00:00 2024' }], {
      marker,
    })
    expect(report.killed).toBe(0)
    expect(report.unresolved).toHaveLength(1)
    expect(alive(bystander.pid!)).toBe(true)
  }, 15_000)

  it('cross-restart reclaim succeeds only when started_at and command both match', async () => {
    const child = spawnChild()
    expect(child.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))

    // 用一个 reaper 抓取「上一生命周期」落库的身份，再用全新实例模拟重启后的回收
    const captured = new ProcessReaper().registerProcess('seed', { pid: child.pid!, pgid: child.pid! })
    expect(captured?.startedAt).toBeTruthy()
    expect(captured?.command).toBeTruthy()

    const restarted = new ProcessReaper()
    const report = restarted.killRegistered([captured!])
    expect(report.killed).toBeGreaterThanOrEqual(1)
    expect(report.unresolved).toHaveLength(0)
    await waitFor(() => !alive(child.pid!))
  }, 15_000)

  it('does not claim or kill processes that were never registered for this turn', async () => {
    const bystander = spawnChild()
    expect(bystander.pid).toBeGreaterThan(0)

    const reaper = new ProcessReaper()
    const report = reaper.reap('turn-unregistered')
    expect(report.discovered).toBe(0)
    expect(report.killed).toBe(0)
    expect(alive(bystander.pid!)).toBe(true)
  }, 15_000)

  it('C4b: PID reuse + same-second start + same executable name must not be claimed', async () => {
    // 真实进程 + 真实 ps：canary 是被复用的 pid 持有者。
    const canary = spawnChild()
    expect(canary.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === canary.pid))
    const actual = listProcesses().find((proc) => proc.pid === canary.pid)
    expect(actual, 'canary 应可被 ps 观测').toBeDefined()

    // 伪造上一轮记录：同 pid、同组、同一秒启动、同可执行文件（node），但参数不同。
    const forged: ProcIdentity = {
      pid: canary.pid!,
      pgid: actual!.pgid,
      startedAt: actual!.startedAt,
      command: `${process.execPath} /nonexistent/other-agent-script.js --turn 3`,
    }
    const report = new ProcessReaper().killRegistered([forged])

    // 只有 startedAt 一项成立（command 完整串不等，绝不再退化为 basename）→ 证据不足
    expect(report.killed).toBe(0)
    expect(report.killedGroups).toHaveLength(0)
    expect(report.unresolved).toHaveLength(1)
    expect(report.unresolved[0].matched).toEqual(['startedAt'])
    expect(alive(canary.pid!), 'C4b：同秒 + 同可执行名不得凑成两项证据').toBe(true)
  }, 15_000)

  it('C4b control: a genuine residual with exact command is still reclaimed', async () => {
    const child = spawnChild()
    expect(child.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))

    const captured = new ProcessReaper().registerProcess('seed', {
      pid: child.pid!,
      pgid: child.pid!,
    })
    expect(captured?.command).toBeTruthy()
    expect(captured?.startedAt).toBeTruthy()

    const report = new ProcessReaper().killRegistered([captured!])
    expect(report.killed).toBeGreaterThanOrEqual(1)
    expect(report.unresolved).toHaveLength(0)
    await waitFor(() => !alive(child.pid!))
  }, 15_000)

  it('C5b: a host-shared process group must never be reclaimed as our own group', async () => {
    // 非 detached：子进程与测试进程共享宿主组，pgid 必然不等于子进程 pid。
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], {
      stdio: 'ignore',
    })
    if (child.pid) spawned.push(child)
    expect(child.pid).toBeGreaterThan(0)
    await waitFor(() => listProcesses().some((proc) => proc.pid === child.pid))
    const actual = listProcesses().find((proc) => proc.pid === child.pid)
    expect(actual, '共享组子进程应可被 ps 观测').toBeDefined()
    expect(actual!.pgid, '非 detached 子进程应与宿主共享进程组').toBe(
      listProcesses().find((proc) => proc.pid === process.pid)?.pgid,
    )

    // 即使伪造记录声称「pgid === pid 的自有组长」，实时 pgid 对不上就只能树杀。
    const negativeSignals: number[] = []
    const originalKill = process.kill
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0) {
        negativeSignals.push(pid)
        return true
      }
      return originalKill.call(process, pid, signal)
    }) as typeof process.kill

    try {
      const forged: ProcIdentity = {
        pid: child.pid!,
        pgid: child.pid!,
        startedAt: actual!.startedAt,
        command: actual!.command,
      }
      // 模拟「可信来源」铸造但错误声称自有组：签名有效，组归属仍须实时校验
      forged.attestation = attestProcIdentity(forged)
      const report = new ProcessReaper().killRegistered([forged])
      expect(report.killedGroups, '不得对共享宿主组发整组信号').toHaveLength(0)
      expect(negativeSignals, '不得出现任何 -pgid 信号').toHaveLength(0)
      expect(report.killedPids).toContain(child.pid)
      await waitFor(() => !alive(child.pid!))
      expect(alive(process.pid), '宿主测试进程必须存活').toBe(true)
    } finally {
      process.kill = originalKill
    }
  }, 15_000)

  it('C5b guard: terminateGroup refuses the caller’s own process group', async () => {
    // 逻辑级守卫（注入进程表，不代表真实内核状态）：即使组长 pid 恰好等于
    // 调用方所在组的 pgid，也必须拒绝整组回收、不发任何信号。
    const selfPgid = 777
    const fakeTable = [
      {
        pid: process.pid,
        ppid: 1,
        pgid: selfPgid,
        state: 'S',
        startedAt: 'Nov  4 11:56:10 2026',
        command: 'host-electron',
      },
      {
        pid: selfPgid,
        ppid: 1,
        pgid: selfPgid,
        state: 'S',
        startedAt: 'Nov  4 11:56:10 2026',
        command: 'node fake-leader.js --turn 9',
      },
    ]
    const reaper = new ProcessReaper(() => fakeTable)
    const report = reaper.killRegistered([
      {
        pid: selfPgid,
        pgid: selfPgid,
        startedAt: 'Nov  4 11:56:10 2026',
        command: 'node fake-leader.js --turn 9',
      },
    ])
    expect(report.killedGroups).toHaveLength(0)
    expect(report.killedPids).toHaveLength(0)
  })

  it('two concurrent turns of the same vendor: reaping A must not touch B', async () => {
    const childA = spawnChild()
    const childB = spawnChild()
    expect(childA.pid).toBeGreaterThan(0)
    expect(childB.pid).toBeGreaterThan(0)
    await waitFor(
      () =>
        listProcesses().some((proc) => proc.pid === childA.pid) &&
        listProcesses().some((proc) => proc.pid === childB.pid),
    )

    const reaper = new ProcessReaper()
    reaper.registerProcess('turn-a', { pid: childA.pid!, pgid: childA.pid! })
    reaper.registerProcess('turn-b', { pid: childB.pid!, pgid: childB.pid! })

    const reportA = reaper.reap('turn-a')
    expect(reportA.killed).toBeGreaterThanOrEqual(1)
    await waitFor(() => !alive(childA.pid!))

    expect(alive(childB.pid!), 'B 必须存活').toBe(true)
  }, 15_000)
})
