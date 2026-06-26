import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionRecoveryManager } from '../session-recovery'

describe('SessionRecoveryManager', () => {
  let manager: SessionRecoveryManager

  beforeEach(() => {
    manager = new SessionRecoveryManager()
  })

  it('recovers claude-code session with same sessionId', async () => {
    const result = await manager.attemptRecovery({
      sessionId: 's1',
      adapterName: 'claude-code',
      lastOutputs: [],
      lastMessages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toBe('s1')
  })

  it('returns null for unknown adapter', async () => {
    const result = await manager.attemptRecovery({
      sessionId: 's1',
      adapterName: 'unknown',
      lastOutputs: [],
    })
    expect(result).toBeNull()
  })

  it('limits recovery attempts to maxRetries', async () => {
    manager.registerStrategy({
      adapterName: 'always-fail',
      canResume: false,
      resume: async () => null,
    })
    for (let i = 0; i < 3; i++) {
      await manager.attemptRecovery({
        sessionId: 's1',
        adapterName: 'always-fail',
        lastOutputs: [],
      })
    }
    expect(manager.getAttempts('s1')).toBe(3)
    const result = await manager.attemptRecovery({
      sessionId: 's1',
      adapterName: 'always-fail',
      lastOutputs: [],
    })
    expect(result).toBeNull()
  })

  it('tracks attempts using originSessionId lineage', async () => {
    manager.registerStrategy({
      adapterName: 'always-fail',
      canResume: false,
      resume: async () => null,
    })
    for (let i = 0; i < 3; i++) {
      await manager.attemptRecovery({
        sessionId: `s${i}`,
        originSessionId: 'origin',
        adapterName: 'always-fail',
        lastOutputs: [],
      })
    }
    expect(manager.getAttempts('origin')).toBe(3)
  })

  it('resets attempts after successful recovery', async () => {
    manager.registerStrategy({
      adapterName: 'eventually-succeed',
      canResume: true,
      resume: async () => 's1',
    })
    await manager.attemptRecovery({ sessionId: 's1', adapterName: 'eventually-succeed', lastOutputs: [] })
    await manager.attemptRecovery({ sessionId: 's1', adapterName: 'eventually-succeed', lastOutputs: [] })
    // Successful recovery resets attempts, so count should remain 0 after each success
    expect(manager.getAttempts('s1')).toBe(0)
  })

  it('stores pending context injection for mcp adapter', async () => {
    const result = await manager.attemptRecovery({
      sessionId: 's1',
      adapterName: 'mcp',
      lastOutputs: [],
      lastMessages: [{ role: 'user', content: 'hello' }],
    })
    expect(result).toBeNull()
    const pending = manager.consumePendingContext('s1')
    expect(pending).toContain('Previous session context')
    expect(pending).toContain('hello')
  })

  it('pending context injection expires after one hour', async () => {
    vi.useFakeTimers()
    await manager.attemptRecovery({
      sessionId: 's1',
      adapterName: 'mcp',
      lastOutputs: [],
      lastMessages: [{ role: 'user', content: 'hello' }],
    })
    vi.advanceTimersByTime(3600001)
    expect(manager.consumePendingContext('s1')).toBeNull()
    vi.useRealTimers()
  })

  it('setPendingContext stores injection text', () => {
    manager.setPendingContext('s1', 'context text')
    expect(manager.consumePendingContext('s1')).toBe('context text')
  })
})
