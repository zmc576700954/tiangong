import { AsyncLocalStorage } from 'node:async_hooks'
import { mutation } from '../mutation'
import { SessionBusyError, type SessionLockHandle } from '../types'

interface LockContext {
  keys: Set<string>
  depth: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * per-run 串行锁（命名沿用新文档 SessionExecutor；旧文档叫 per-session）。
 * - 第二个并发 acquire 立即抛 SESSION_BUSY（旧文档 fail-fast 语义）。
 * - 同一异步调用链内二次 acquire 通过 AsyncLocalStorage 识别，直接复用外层锁，不死锁。
 * - 新文档 §7.1 写的是「同 run 第二个 turn 排队」；spike 按旧文档做 fail-fast，冲突见 README。
 */
export class RunLockRegistry {
  private readonly active = new Set<string>()
  private readonly als = new AsyncLocalStorage<LockContext>()

  tryAcquire(key: string): SessionLockHandle {
    if (mutation() === 'no-lock') {
      return { key, release: () => {} }
    }

    if (mutation() !== 'no-reentry') {
      const ctx = this.als.getStore()
      if (ctx && ctx.keys.has(key)) {
        // 重入：不新增持有者，释放是 no-op，由外层 release 负责
        return { key, release: () => {} }
      }
    }

    if (this.active.has(key)) throw new SessionBusyError(key)
    this.active.add(key)
    let released = false
    return {
      key,
      release: () => {
        if (released) return
        released = true
        this.active.delete(key)
      },
    }
  }

  async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const ctx = this.als.getStore()
    if (mutation() !== 'no-reentry' && ctx && ctx.keys.has(key)) {
      ctx.depth += 1
      try {
        return await fn()
      } finally {
        ctx.depth -= 1
      }
    }

    const handle = this.tryAcquire(key)
    if (mutation() === 'slow-lock') await sleep(6)
    if (this.active.size > 0) {
      const next: LockContext = { keys: new Set([key]), depth: 1 }
      try {
        return await this.als.run(next, fn)
      } finally {
        handle.release()
      }
    }
    return fn()
  }

  isHeld(key: string): boolean {
    return this.active.has(key)
  }
}
