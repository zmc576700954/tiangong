/**
 * 故意破坏的对照实现（只用于证明测试台会红，不参与任何生产路径）。
 *
 * 三个坏版本分别对应历史上真实出现过的隔离缺陷：
 *   sabotage:shared-registry —— 全局共享登记表，取消 A 会连坐 B（第一轮 P0-1 的形态）
 *   sabotage:bare-pid        —— 不做归属证明，直接按 pid 发信号（第二轮 P0-A 的形态）
 *   sabotage:group-wide      —— 按 -pgid 整组发信号（组边界不清时的形态）
 *
 * 安全约束：坏版本也不得向 pid<=1、自身、负 pid 之外的危险目标发信号，
 * 否则会把测试进程（vitest）一起杀掉；因此内置了与生产代码同类的自保判断。
 */
import { listProcesses, type ProcIdentity, type ProcInfo, type ReapReport } from '../../../src/main/agent/runtime/process/reaper'
import type { ReaperUnderTest, RegisterInput } from './adapter'

function emptyReport(expected: number): ReapReport {
  return {
    discovered: expected,
    killed: 0,
    killedPids: [],
    killedGroups: [],
    unresolved: [],
    missing: [],
    stillAlive: [],
  }
}

function isSafeTarget(pid: number | undefined): pid is number {
  return typeof pid === 'number' && pid > 1 && pid !== process.pid
}

function identityOfProcess(pid: number): ProcIdentity | undefined {
  const proc = listProcesses().find((item) => item.pid === pid)
  if (!proc) return undefined
  return { pid: proc.pid, pgid: proc.pgid, command: proc.command, startedAt: proc.startedAt }
}

/** 全局共享登记表：不按 turn 隔离，reap 任意 turn 会杀掉所有登记过的进程。 */
class SharedRegistryReaper implements ReaperUnderTest {
  readonly implId = 'sabotage:shared-registry'
  private readonly all = new Map<number, ProcIdentity>()

  register(_turnId: string, proc: RegisterInput): ProcIdentity | undefined {
    if (!isSafeTarget(proc.pid)) return undefined
    const identity = identityOfProcess(proc.pid) ?? { pid: proc.pid, pgid: proc.pgid }
    this.all.set(proc.pid, identity)
    return identity
  }

  reap(_turnId: string): ReapReport {
    const report = emptyReport(this.all.size)
    for (const identity of this.all.values()) {
      if (!isSafeTarget(identity.pid)) continue
      try {
        process.kill(identity.pid, 'SIGTERM')
        report.killedPids.push(identity.pid)
        report.killed += 1
      } catch {
        report.missing.push(identity.pid)
      }
    }
    this.all.clear()
    return report
  }

  killRegistered(expected: ProcIdentity[]): ReapReport {
    const report = emptyReport(expected.length)
    for (const identity of expected) {
      if (!isSafeTarget(identity.pid)) continue
      try {
        process.kill(identity.pid, 'SIGTERM')
        report.killedPids.push(identity.pid)
        report.killed += 1
      } catch {
        report.missing.push(identity.pid)
      }
    }
    return report
  }

  forget(_turnId: string): void {
    // 故意不清理：模拟跨轮/跨会话共享名单
  }

  residualCount(marker: string): number {
    return listProcesses().filter((proc) => proc.command.includes(marker)).length
  }

  scanResidual(marker: string): ProcInfo[] {
    return listProcesses().filter((proc) => proc.command.includes(marker))
  }
}

/** 无归属证明：登记即视为自己的，killRegistered 直接杀，不比对任何证据。 */
class BarePidReaper implements ReaperUnderTest {
  readonly implId = 'sabotage:bare-pid'
  private readonly states = new Map<string, Map<number, ProcIdentity>>()

  register(turnId: string, proc: RegisterInput): ProcIdentity | undefined {
    if (!isSafeTarget(proc.pid)) return undefined
    const identity = identityOfProcess(proc.pid) ?? { pid: proc.pid, pgid: proc.pgid }
    const state = this.states.get(turnId) ?? new Map<number, ProcIdentity>()
    state.set(proc.pid, identity)
    this.states.set(turnId, state)
    return identity
  }

  reap(turnId: string): ReapReport {
    const state = this.states.get(turnId)
    this.states.delete(turnId)
    return this.killRegistered([...(state?.values() ?? [])])
  }

  killRegistered(expected: ProcIdentity[]): ReapReport {
    const report = emptyReport(expected.length)
    for (const identity of expected) {
      if (!isSafeTarget(identity.pid)) continue
      try {
        process.kill(identity.pid, 'SIGTERM')
        report.killedPids.push(identity.pid)
        report.killed += 1
      } catch {
        report.missing.push(identity.pid)
      }
    }
    return report
  }

  forget(turnId: string): void {
    this.states.delete(turnId)
  }

  residualCount(marker: string): number {
    return listProcesses().filter((proc) => proc.command.includes(marker)).length
  }

  scanResidual(marker: string): ProcInfo[] {
    return listProcesses().filter((proc) => proc.command.includes(marker))
  }
}

/** 整组回收：按 -pgid 发信号；组边界不清时会连坐同组其他会话。 */
class GroupWideReaper implements ReaperUnderTest {
  readonly implId = 'sabotage:group-wide'
  private readonly states = new Map<string, Map<number, ProcIdentity>>()

  register(turnId: string, proc: RegisterInput): ProcIdentity | undefined {
    if (!isSafeTarget(proc.pid)) return undefined
    const identity = identityOfProcess(proc.pid) ?? { pid: proc.pid, pgid: proc.pgid }
    const state = this.states.get(turnId) ?? new Map<number, ProcIdentity>()
    state.set(proc.pid, identity)
    this.states.set(turnId, state)
    return identity
  }

  reap(turnId: string): ReapReport {
    const state = this.states.get(turnId)
    this.states.delete(turnId)
    return this.killRegistered([...(state?.values() ?? [])])
  }

  killRegistered(expected: ProcIdentity[]): ReapReport {
    const report = emptyReport(expected.length)
    const selfPgid = listProcesses().find((proc) => proc.pid === process.pid)?.pgid
    for (const identity of expected) {
      const pgid = identity.pgid
      if (!isSafeTarget(identity.pid) || typeof pgid !== 'number' || pgid <= 1) continue
      // 自保：绝不向测试进程自己所在的组发信号（否则会把 vitest 一起杀掉）
      if (pgid === process.pid || pgid === selfPgid) continue
      try {
        process.kill(-pgid, 'SIGTERM')
        report.killedGroups.push(pgid)
        report.killedPids.push(identity.pid)
        report.killed += 1
      } catch {
        report.missing.push(identity.pid)
      }
    }
    return report
  }

  forget(turnId: string): void {
    this.states.delete(turnId)
  }

  residualCount(marker: string): number {
    return listProcesses().filter((proc) => proc.command.includes(marker)).length
  }

  scanResidual(marker: string): ProcInfo[] {
    return listProcesses().filter((proc) => proc.command.includes(marker))
  }
}

export function createSabotageReaper(implId: string): ReaperUnderTest {
  switch (implId) {
    case 'sabotage:shared-registry':
      return new SharedRegistryReaper()
    case 'sabotage:bare-pid':
      return new BarePidReaper()
    case 'sabotage:group-wide':
      return new GroupWideReaper()
    default:
      throw new Error(`unknown sabotage impl: ${implId}`)
  }
}
