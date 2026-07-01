import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentAdapter } from '@shared/types'
import { SessionRouter } from '../session-router'
import type { AdapterRegistry } from '../adapter-registry'

function makeMockAdapter(name: string): AgentAdapter {
  return {
    name,
    version: '1.0.0',
    checkInstalled: vi.fn().mockResolvedValue(true),
    startSession: vi.fn(),
    sendCommand: vi.fn(),
    terminateSession: vi.fn(),
    getSession: vi.fn(),
    getActiveSessions: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as AgentAdapter
}

function makeMockRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]))
  return {
    get: (name: string) => map.get(name),
    list: () => adapters,
    register: vi.fn(),
    checkAllInstalled: vi.fn(),
    invalidateCache: vi.fn(),
  } as unknown as AdapterRegistry
}

describe('SessionRouter', () => {
  let registry: AdapterRegistry
  let router: SessionRouter

  beforeEach(() => {
    vi.useFakeTimers()
    const adapter = makeMockAdapter('claude-code')
    registry = makeMockRegistry([adapter])
    router = new SessionRouter(registry)
  })

  afterEach(() => {
    router.stopTtlCheck()
    vi.useRealTimers()
  })

  it('bind and resolve returns the correct adapter', () => {
    router.bind('sess-1', 'claude-code')
    const resolved = router.resolve('sess-1')
    expect(resolved.name).toBe('claude-code')
  })

  it('resolve throws SessionNotFoundError for unknown session', () => {
    expect(() => router.resolve('unknown')).toThrow('Session unknown not found')
  })

  it('resolve throws AdapterError if adapter is not registered', () => {
    const emptyRegistry = makeMockRegistry([])
    const r = new SessionRouter(emptyRegistry)
    r.bind('sess-1', 'nonexistent')
    expect(() => r.resolve('sess-1')).toThrow('Adapter nonexistent not found')
    r.stopTtlCheck()
  })

  it('unbind removes the session', () => {
    router.bind('sess-1', 'claude-code')
    router.unbind('sess-1')
    expect(() => router.resolve('sess-1')).toThrow()
  })

  it('getAdapterName returns adapter name', () => {
    router.bind('sess-1', 'claude-code')
    expect(router.getAdapterName('sess-1')).toBe('claude-code')
  })

  it('getAdapterName returns undefined for unknown session', () => {
    expect(router.getAdapterName('unknown')).toBeUndefined()
  })

  it('getActiveSessionIds returns all bound sessions', () => {
    router.bind('s1', 'claude-code')
    router.bind('s2', 'codex')
    expect(router.getActiveSessionIds()).toContain('s1')
    expect(router.getActiveSessionIds()).toContain('s2')
  })

  it('touch refreshes the session timestamp', () => {
    router.bind('sess-1', 'claude-code')
    router.touch('sess-1')
    // Should not throw and resolve should still work
    expect(router.resolve('sess-1')).toBeDefined()
  })

  it('getFallbackInfo returns undefined for non-fallback session', () => {
    router.bind('sess-1', 'claude-code')
    expect(router.getFallbackInfo('sess-1')).toBeUndefined()
  })

  it('getFallbackInfo returns fallback info when originalAdapter differs', () => {
    router.bind('sess-1', 'mcp', 'claude-code')
    const info = router.getFallbackInfo('sess-1')
    expect(info).toEqual({ original: 'claude-code', actual: 'mcp' })
  })

  it('getOriginalAdapterName returns original adapter for fallback', () => {
    router.bind('sess-1', 'mcp', 'claude-code')
    expect(router.getOriginalAdapterName('sess-1')).toBe('claude-code')
  })

  it('getOriginalAdapterName returns undefined for non-fallback', () => {
    router.bind('sess-1', 'claude-code')
    expect(router.getOriginalAdapterName('sess-1')).toBeUndefined()
  })

  it('TTL check cleans up expired sessions', () => {
    const handler = vi.fn()
    router.onTtlExpired(handler)

    router.bind('sess-old', 'claude-code')
    // Simulate session created 31 minutes ago
    const entry = (router as unknown as { sessionToAdapter: Map<string, { timestamp: number }> })
      .sessionToAdapter.get('sess-old')
    if (entry) entry.timestamp = Date.now() - 31 * 60 * 1000

    // Trigger TTL check
    vi.advanceTimersByTime(5 * 60 * 1000)

    expect(() => router.resolve('sess-old')).toThrow()
    expect(handler).toHaveBeenCalledWith('sess-old')
  })

  it('TTL check does not clean up active sessions', () => {
    router.bind('sess-active', 'claude-code')
    router.resolve('sess-active') // refreshes timestamp

    vi.advanceTimersByTime(5 * 60 * 1000)

    // Should still be resolvable
    expect(router.resolve('sess-active')).toBeDefined()
  })

  it('bind overwrites existing entry for same session', () => {
    router.bind('sess-1', 'claude-code')
    router.bind('sess-1', 'codex')
    expect(router.getAdapterName('sess-1')).toBe('codex')
  })
})
