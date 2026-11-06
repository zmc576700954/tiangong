/**
 * D2 验收：tryAcquire/acquire 语义拆分、fail-fast、显式上下文归属、防重入。
 */

import { describe, expect, it } from 'vitest'
import { SessionBusyError } from '../errors'
import { ROOT_LOCK_CONTEXT, SessionLockRegistry, nodeLockKey, sessionLockKey } from '../locks/session-lock'

describe('SessionLockRegistry (D2)', () => {
  it('tryAcquire returns null instead of throwing when busy', () => {
    const registry = new SessionLockRegistry()
    const key = sessionLockKey('s1')
    const first = registry.tryAcquire(key, 'turn-1', ROOT_LOCK_CONTEXT)
    expect(first).not.toBeNull()

    expect(registry.tryAcquire(key, 'turn-2', ROOT_LOCK_CONTEXT)).toBeNull()
    expect(registry.isBusy(key)).toBe(true)
  })

  it('acquire throws SESSION_BUSY (fail-fast, no queueing)', () => {
    const registry = new SessionLockRegistry()
    const key = sessionLockKey('s1')
    registry.acquire(key, 'turn-1', ROOT_LOCK_CONTEXT)
    expect(() => registry.acquire(key, 'turn-2', ROOT_LOCK_CONTEXT)).toThrow(SessionBusyError)
    expect(() => registry.acquire(key, 'turn-2', ROOT_LOCK_CONTEXT)).toThrow(/SESSION_BUSY/)
  })

  it('uses explicit context for attribution and allows reentry', async () => {
    const registry = new SessionLockRegistry()
    const key = sessionLockKey('s1')

    await registry.withLock(key, 'turn-1', ROOT_LOCK_CONTEXT, async (outer) => {
      expect(outer.held.has(key)).toBe(true)
      // 同一显式上下文重入：不阻塞，也不释放外层
      await registry.withLock(key, 'turn-1', outer, async () => {
        expect(registry.isBusy(key)).toBe(true)
      })
      expect(registry.isBusy(key)).toBe(true)
    })
    expect(registry.isBusy(key)).toBe(false)
  })

  it('does not infer ownership from an unrelated stale context', () => {
    const registry = new SessionLockRegistry()
    const key = sessionLockKey('s1')
    registry.acquire(key, 'turn-1', ROOT_LOCK_CONTEXT)

    // 伪造一个 held 集合（例如来自别的异步栈）不能绕过实际持有者
    const forged = { held: new Set([key]) }
    expect(registry.tryAcquire(key, 'turn-2', forged)).toBeNull()
    expect(() => registry.acquire(key, 'turn-2', forged)).toThrow(SessionBusyError)
    expect(registry.snapshot().find((entry) => entry.key === key)?.turnId).toBe('turn-1')
  })

  it('supports independent node locks and reentrant release counting', async () => {
    const registry = new SessionLockRegistry()
    const key = nodeLockKey('n1', 'main')
    const lockA = registry.acquire(key, 'turn-1', ROOT_LOCK_CONTEXT)
    const lockB = registry.acquire(key, 'turn-1', ROOT_LOCK_CONTEXT)
    lockA.release()
    expect(registry.isBusy(key)).toBe(true)
    lockB.release()
    expect(registry.isBusy(key)).toBe(false)
  })

  it('frees the lock even when the guarded function throws', async () => {
    const registry = new SessionLockRegistry()
    const key = sessionLockKey('s1')
    await expect(
      registry.withLock(key, 'turn-1', ROOT_LOCK_CONTEXT, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(registry.isBusy(key)).toBe(false)
  })
})
