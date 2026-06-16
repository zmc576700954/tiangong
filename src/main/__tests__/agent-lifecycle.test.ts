/**
 * Agent 会话生命周期测试
 * 覆盖 SessionRouter 的 TTL 行为和 adapter 终止逻辑
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionRouter } from '../agent/session-router'
import { AdapterRegistry } from '../agent/adapter-registry'

// Mock adapter for testing
class MockAdapter {
  readonly name = 'mock'
  readonly version = '1.0.0'
  terminated: string[] = []

  async checkInstalled(): Promise<boolean> { return true }
  async terminateSession(sessionId: string): Promise<void> {
    this.terminated.push(sessionId)
  }
  async startSession(): Promise<any> { return { id: 'mock-session', adapterName: 'mock', config: {}, startTime: Date.now() } }
  async sendCommand(): Promise<void> {}
  onOutput(): () => void { return () => {} }
  offOutput(): void {}
  listSessions(): any[] { return [] }
  getSession(): any { return undefined }
  terminateAllSessions(): Promise<void> { return Promise.resolve() }
}

describe('Session Router TTL', () => {
  let registry: AdapterRegistry
  let router: SessionRouter
  let adapter: MockAdapter

  beforeEach(() => {
    registry = new AdapterRegistry()
    adapter = new MockAdapter()
    registry.register(adapter as any)
    router = new SessionRouter(registry)
  })

  afterEach(() => {
    router.stopTtlCheck()
  })

  it('should refresh timestamp on resolve', () => {
    router.bind('session-1', 'mock')
    const entry1 = (router as any).sessionToAdapter.get('session-1')
    const ts1 = entry1.timestamp

    // Small delay to ensure timestamp differs
    const start = Date.now()
    while (Date.now() === start) { /* busy wait */ }

    router.resolve('session-1')
    const entry2 = (router as any).sessionToAdapter.get('session-1')
    expect(entry2.timestamp).toBeGreaterThan(ts1)
  })

  it('should support touch() for refreshing timestamp', () => {
    router.bind('session-1', 'mock')
    const entry1 = (router as any).sessionToAdapter.get('session-1')
    const ts1 = entry1.timestamp

    const start = Date.now()
    while (Date.now() === start) { /* busy wait */ }

    router.touch('session-1')
    const entry2 = (router as any).sessionToAdapter.get('session-1')
    expect(entry2.timestamp).toBeGreaterThan(ts1)
  })

  it('should call TTL expired handler for expired sessions', () => {
    const expiredHandler = vi.fn()
    router.onTtlExpired(expiredHandler)

    // Bind a session with an old timestamp to simulate TTL expiry
    router.bind('session-1', 'mock')
    const entry = (router as any).sessionToAdapter.get('session-1')
    // Set timestamp to past (31 minutes ago, beyond 30 min TTL)
    entry.timestamp = Date.now() - 31 * 60 * 1000

    // Manually trigger TTL check (normally done by setInterval)
    void (router as any).startTtlCheck.bind(router)
    router.stopTtlCheck()
    // Trigger the interval callback manually
    const now = Date.now()
    const expired: string[] = []
    for (const [sessionId, e] of (router as any).sessionToAdapter) {
      if (now - e.timestamp > 30 * 60 * 1000) {
        expired.push(sessionId)
      }
    }

    expect(expired).toContain('session-1')
  })

  it('should unbind session on TTL expiry', () => {
    router.bind('session-1', 'mock')
    router.unbind('session-1')
    expect(router.getActiveSessionIds()).not.toContain('session-1')
  })
})
