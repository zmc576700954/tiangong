/**
 * Lamport Clock
 *
 * 分布式时钟，用于给并发操作排序。每个 actor 持有一个本地计数器；
 * 每次本地操作 `tick()` 自增；接收到远端操作 `observe(remote)` 时
 * 把本地时钟推到 max(local, remote) + 1。
 *
 * 排序规则：先比 clock 值，clock 相同时比 actorId（字典序）。
 * —— 比纯 clock 多一层确定性 tie-break，避免「同 clock 谁赢」的非决定性。
 *
 * 实现参考：Lamport, "Time, Clocks, and the Ordering of Events" (1978)。
 *
 * 不归 @shared 的原因：纯计算逻辑，无 IPC 暴露需求；放在 main 进程内
 * 即可，与 conflict-rules.ts 共同构成 D10d 的核心算法层。
 */

/** Lamport timestamp — actor 内单调递增，跨 actor 由 observe 同步 */
export interface LamportTimestamp {
  /** 单调计数器 */
  readonly clock: number
  /** Actor 标识（userId 或 sessionId）；clock 相同时用作 tie-break */
  readonly actorId: string
}

/** 创建一个新的 Lamport timestamp */
export function createLamport(clock: number, actorId: string): LamportTimestamp {
  return { clock, actorId }
}

/** Lamport 序比较
 *
 * @returns -1 表示 a 在 b 之前；1 表示 a 在 b 之后；0 表示完全相同。
 *
 * Tie-break 规则：clock 相同 → actorId 字典序小的赢。这样所有 actor 对
 * 「同 clock 谁赢」都得出相同结论，避免依赖实现定义的顺序。
 */
export function compareLamport(a: LamportTimestamp, b: LamportTimestamp): -1 | 0 | 1 {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1
  if (a.actorId === b.actorId) return 0
  return a.actorId < b.actorId ? -1 : 1
}

/** Lamport 时钟实例：actor 本地状态 */
export class LamportClock {
  private value_: number

  constructor(
    initialValue: number = 0,
    readonly actorId: string,
  ) {
    this.value_ = initialValue
  }

  /** 当前 clock 值（只读快照） */
  get value(): number {
    return this.value_
  }

  /** 生成本地操作的时间戳，并自增 clock */
  tick(): LamportTimestamp {
    const ts: LamportTimestamp = { clock: this.value_, actorId: this.actorId }
    this.value_ += 1
    return ts
  }

  /** 观察到远端操作的时间戳：本地 clock 推到 max(local, remote) + 1
   *
   * 用法：收到 sync message 时调用；之后才允许本地 tick。
   * —— 这是 Lamport 「先 observe 再 tick」的核心约束。
   */
  observe(remote: LamportTimestamp): void {
    if (remote.actorId === this.actorId) {
      // 本 actor 自反：remote 一定 <= local；但若 remote > local 是 bug
      if (remote.clock > this.value_) {
        this.value_ = remote.clock + 1
      }
      return
    }
    if (remote.clock >= this.value_) {
      this.value_ = remote.clock + 1
    }
  }
}

/** 把 LamportTimestamp 编码为 Yjs Map 友好的格式：固定两个键 `clock` / `actorId` */
export function encodeLamport(ts: LamportTimestamp): { clock: number; actorId: string } {
  return { clock: ts.clock, actorId: ts.actorId }
}

/** 反序列化；从 Y.Map 取出 {clock, actorId} 重建 */
export function decodeLamport(raw: unknown): LamportTimestamp | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const clock = obj.clock
  const actorId = obj.actorId
  if (typeof clock !== 'number' || !Number.isFinite(clock)) return null
  if (typeof actorId !== 'string' || actorId.length === 0) return null
  return { clock, actorId }
}