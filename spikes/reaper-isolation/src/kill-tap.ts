/**
 * 信号探针（tap）：记录测试进程向每个 pid 实际发出的信号，同时保留真实调用。
 *
 * 这是「观测」而非「mock」：`process.kill` 的原始实现被原样调用，只是额外记一笔
 * `{pid, signal, at}`。三类独立证据因此可以交叉验证：
 *   1) 发出侧：本文件的 tap（含 SIGKILL，目标进程无法捕获）；
 *   2) 接收侧：probe.mjs / short-lived.mjs 的真实信号处理日志（SIGTERM 等）；
 *   3) 存活侧：`alive()` 的 kill(pid, 0) 探测。
 *
 * 信号 0 是存活探测，不属于「发出信号」，统计时过滤。
 */

type KillFn = (pid: number, signal?: string | number) => boolean

const originalKillImpl = process.kill.bind(process) as KillFn

export interface KillCall {
  pid: number
  signal: string | number
  at: number
}

class KillTap {
  calls: KillCall[] = []
  active = false
  private installed = false
  private restoreTo: KillFn = originalKillImpl

  install(): void {
    if (this.installed) return
    this.restoreTo = process.kill.bind(process) as KillFn
    const tap = this
    process.kill = function patchedKill(pid: number, signal?: string | number): boolean {
      if (tap.active) {
        tap.calls.push({ pid, signal: signal ?? 'SIGTERM', at: Date.now() })
      }
      return tap.restoreTo(pid, signal)
    } as typeof process.kill
    this.installed = true
  }

  dispose(): void {
    if (!this.installed) return
    process.kill = this.restoreTo as typeof process.kill
    this.installed = false
  }

  reset(): void {
    this.calls = []
  }

  start(): void {
    this.active = true
  }

  stop(): void {
    this.active = false
  }

  /** 真正发出的信号（排除 signal 0 存活探测） */
  sends(): KillCall[] {
    return this.calls.filter((call) => call.signal !== 0 && call.signal !== '0')
  }

  signalsTo(pid: number): KillCall[] {
    return this.sends().filter((call) => call.pid === pid)
  }

  countTo(pid: number): number {
    return this.signalsTo(pid).length
  }

  /** pid < 0 表示按进程组发信号（-pgid） */
  groupSignals(): KillCall[] {
    return this.sends().filter((call) => call.pid < 0)
  }
}

export const killTap = new KillTap()

/** 绕过 tap 的原始 kill：用于存活探测与测试自身清理，不污染计数 */
export function rawKill(pid: number, signal: string | number = 0): boolean {
  try {
    return originalKillImpl(pid, signal)
  } catch {
    return false
  }
}

export function alive(pid: number): boolean {
  return rawKill(pid, 0)
}
