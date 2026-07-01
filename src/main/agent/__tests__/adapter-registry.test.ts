import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentAdapter } from '@shared/types'
import { AdapterRegistry } from '../adapter-registry'

function makeMockAdapter(name: string, installed = true): AgentAdapter {
  return {
    name,
    version: '1.0.0',
    checkInstalled: vi.fn().mockResolvedValue(installed),
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

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    registry = new AdapterRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('register and get an adapter', () => {
    const adapter = makeMockAdapter('claude-code')
    registry.register(adapter)
    expect(registry.get('claude-code')).toBe(adapter)
  })

  it('get returns undefined for unknown adapter', () => {
    expect(registry.get('unknown')).toBeUndefined()
  })

  it('list returns all registered adapters', () => {
    const a1 = makeMockAdapter('claude-code')
    const a2 = makeMockAdapter('codex')
    registry.register(a1)
    registry.register(a2)
    const list = registry.list()
    expect(list).toContain(a1)
    expect(list).toContain(a2)
    expect(list.length).toBe(2)
  })

  it('register overwrites existing adapter with same name', () => {
    const a1 = makeMockAdapter('claude-code')
    const a2 = makeMockAdapter('claude-code')
    registry.register(a1)
    registry.register(a2)
    expect(registry.get('claude-code')).toBe(a2)
  })

  it('checkAllInstalled returns installation status', async () => {
    registry.register(makeMockAdapter('claude-code'))
    registry.register(makeMockAdapter('codex'))

    const results = await registry.checkAllInstalled()
    expect(results.length).toBe(2)
    expect(results.find((r) => r.name === 'claude-code')?.installed).toBe(true)
    expect(results.find((r) => r.name === 'codex')?.installed).toBe(true)
  })

  it('checkAllInstalled caches results within TTL', async () => {
    const adapter = makeMockAdapter('claude-code')
    registry.register(adapter)

    await registry.checkAllInstalled()
    await registry.checkAllInstalled()

    // checkInstalled should only be called once due to caching
    expect(adapter.checkInstalled).toHaveBeenCalledTimes(1)
  })

  it('checkAllInstalled uses cached result within TTL', async () => {
    const adapter = makeMockAdapter('claude-code')
    registry.register(adapter)

    const results1 = await registry.checkAllInstalled()
    expect(results1[0].installed).toBe(true)

    // Within TTL, should return cached
    const results2 = await registry.checkAllInstalled()
    expect(results2[0].installed).toBe(true)
  })

  it('invalidateCache clears specific adapter cache', async () => {
    const adapter = makeMockAdapter('claude-code')
    registry.register(adapter)

    await registry.checkAllInstalled()
    registry.invalidateCache('claude-code')

    await registry.checkAllInstalled()
    expect(adapter.checkInstalled).toHaveBeenCalledTimes(2)
  })

  it('invalidateCache clears all cache when no name given', async () => {
    const a1 = makeMockAdapter('claude-code')
    const a2 = makeMockAdapter('codex')
    registry.register(a1)
    registry.register(a2)

    await registry.checkAllInstalled()
    registry.invalidateCache()

    await registry.checkAllInstalled()
    expect(a1.checkInstalled).toHaveBeenCalledTimes(2)
    expect(a2.checkInstalled).toHaveBeenCalledTimes(2)
  })

  it('checkAllInstalled handles adapter check failure gracefully', async () => {
    const failing = makeMockAdapter('failing')
    vi.mocked(failing.checkInstalled).mockRejectedValue(new Error('crash'))
    registry.register(failing)

    const results = await registry.checkAllInstalled()
    expect(results[0].installed).toBe(false)
  })
})
