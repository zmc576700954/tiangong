/**
 * D2：per-session 串行锁。
 *
 * 设计要点（对应 agent-architecture.md §6.3 与 M0 任务要求）：
 * - 归属由显式 LockContext 传参决定，不依赖 AsyncLocalStorage 栈顶推断；
 * - tryAcquire 只返回 null，不抛错；acquire 抛 SessionBusyError；
 * - 同一上下文的重入（如 runNode → driver 复用同 session）直接放行，release 不释放外层；
 * - 锁只存在于进程内，崩溃后由 RecoveryPlanner 对账，不假装跨进程分布式锁。
 */

import { SessionBusyError } from '../errors'

export interface LockContext {
  readonly held: ReadonlySet<string>
}

export const ROOT_LOCK_CONTEXT: LockContext = { held: new Set<string>() }

export interface TurnLock {
  readonly key: string
  readonly turnId: string
  readonly reentrant: boolean
  release(): void
}

interface LockEntry {
  turnId: string
  count: number
}

export function sessionLockKey(sessionId: string): string {
  return `session:${sessionId}`
}

export function nodeLockKey(nodeId: string, branchKey = ''): string {
  return `node:${nodeId}:${branchKey}`
}

export class SessionLockRegistry {
  private readonly entries = new Map<string, LockEntry>()

  /** 尝试加锁；已被其他 turn 持有时返回 null。同上下文重入直接成功。 */
  tryAcquire(key: string, turnId: string, context: LockContext): TurnLock | null {
    if (context.held.has(key)) {
      const held = this.entries.get(key)
      if (held && held.turnId !== turnId) {
        // 上下文声称持有，但实际持有者不是自己：拒绝，防止伪造上下文绕过互斥
        return null
      }
      if (held) {
        return {
          key,
          turnId,
          reentrant: true,
          release: () => {
            // 重入不减少外层计数
          },
        }
      }
      // 上下文过期（锁已释放）：继续走正常加锁
    }
    const existing = this.entries.get(key)
    if (existing && existing.turnId !== turnId) {
      return null
    }
    if (existing) {
      existing.count += 1
    } else {
      this.entries.set(key, { turnId, count: 1 })
    }
    return {
      key,
      turnId,
      reentrant: false,
      release: () => this.releaseKey(key, turnId),
    }
  }

  /** 加锁或抛 SessionBusyError（fail-fast，M0 不排队）。 */
  acquire(key: string, turnId: string, context: LockContext): TurnLock {
    const lock = this.tryAcquire(key, turnId, context)
    if (!lock) throw new SessionBusyError(key)
    return lock
  }

  /** 持有 key 并执行；fn 收到携带该 key 的子上下文。 */
  async withLock<T>(key: string, turnId: string, context: LockContext, fn: (next: LockContext) => Promise<T>): Promise<T> {
    const lock = this.acquire(key, turnId, context)
    const next: LockContext = lock.reentrant || context.held.has(key)
      ? context
      : { held: new Set([...context.held, key]) }
    try {
      return await fn(next)
    } finally {
      lock.release()
    }
  }

  isBusy(key: string): boolean {
    return this.entries.has(key)
  }

  /** 仅用于诊断/测试，不用于业务判定。 */
  snapshot(): Array<{ key: string; turnId: string; count: number }> {
    return [...this.entries.entries()].map(([key, entry]) => ({ key, turnId: entry.turnId, count: entry.count }))
  }

  private releaseKey(key: string, turnId: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.turnId !== turnId) return
    entry.count -= 1
    if (entry.count <= 0) {
      this.entries.delete(key)
    }
  }
}
