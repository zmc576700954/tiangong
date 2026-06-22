/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentManager } from '../agent/agent-manager'
import { AdapterRegistry } from '../agent/adapter-registry'
import { SessionRouter } from '../agent/session-router'
import { OutputBroadcaster } from '../agent/output-broadcaster'
import { ContextWaterline } from '../memory/context-waterline'
import { BaseAdapter } from '../adapters/base'
import type {
  AgentSession,
  AgentSessionConfig,
  CompactResult,
  CompactStrategy,
  CompactTrigger,
} from '@shared/types'

/**
 * Minimal mock adapter that extends BaseAdapter so the AgentManager's
 * `attachAdapterOutput` happy-path (which calls onUsage on BaseAdapter)
 * works. compactContext is mocked at the instance level per test.
 */
class MockAdapter extends BaseAdapter {
  readonly name = 'mock'
  readonly version = '0.0.1'
  public compactContextMock = vi.fn()

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    return {
      id: 's1',
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }
  }

  protected async doSendCommand(): Promise<void> {
    // no-op
  }

  // Override the public compactContext so the orchestrator dispatches to our mock.
  async compactContext(
    sessionId: string,
    strategy: CompactStrategy,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    return this.compactContextMock(sessionId, strategy, options)
  }
}

function defaultMockResult(strategy: CompactStrategy = 'summary'): CompactResult {
  return {
    sessionId: 's1',
    strategy,
    trigger: 'manual',
    tokensBefore: 1000,
    tokensAfter: 100,
    summary: 'mock summary',
    startedAt: Date.now(),
    durationMs: 10,
  }
}

describe('AgentManager.compactContext', () => {
  let manager: AgentManager
  let registry: AdapterRegistry
  let router: SessionRouter
  let broadcaster: OutputBroadcaster
  let waterline: ContextWaterline
  let mockAdapter: MockAdapter

  beforeEach(() => {
    registry = new AdapterRegistry()
    mockAdapter = new MockAdapter()
    mockAdapter.compactContextMock.mockResolvedValue(defaultMockResult('summary'))
    registry.register(mockAdapter)

    router = new SessionRouter(registry)
    broadcaster = new OutputBroadcaster()
    waterline = new ContextWaterline()

    manager = new AgentManager(registry, router, broadcaster)
    manager.setWaterline(waterline)

    // Seed a session state directly so we don't need to spin up a real session
    ;(manager as any).sessionStates.set('s1', {
      config: {} as AgentSessionConfig,
      broadcastName: 'mock',
      adapterName: 'mock',
      startTime: Date.now(),
      threadId: 't1',
    })
    router.bind('s1', 'mock')
  })

  it('calls adapter.compactContext with resolved strategy (explicit summary)', async () => {
    const result = await manager.compactContext('s1', 'summary')
    expect(mockAdapter.compactContextMock).toHaveBeenCalledWith('s1', 'summary', undefined)
    expect(result.strategy).toBe('summary')
  })

  it('defaults to summary when no strategy is given and adapter has no descriptor default', async () => {
    await manager.compactContext('s1')
    expect(mockAdapter.compactContextMock).toHaveBeenCalledWith('s1', 'summary', undefined)
  })

  it('dedups concurrent calls on the same session', async () => {
    let resolveMock: (r: CompactResult) => void = () => {}
    mockAdapter.compactContextMock.mockImplementationOnce(
      () =>
        new Promise<CompactResult>((resolve) => {
          resolveMock = resolve
        }),
    )

    const p1 = manager.compactContext('s1', 'summary')
    const p2 = manager.compactContext('s1', 'summary')

    resolveMock(defaultMockResult('summary'))
    const [r1, r2] = await Promise.all([p1, p2])

    expect(mockAdapter.compactContextMock).toHaveBeenCalledTimes(1)
    expect(r1).toBe(r2)
  })

  it('falls back native → summary on failure', async () => {
    mockAdapter.compactContextMock.mockImplementation(async (sid, strat) => {
      if (strat === 'native') {
        throw new Error('not supported')
      }
      return {
        sessionId: sid,
        strategy: 'summary',
        trigger: 'manual',
        tokensBefore: 1000,
        tokensAfter: 100,
        startedAt: Date.now(),
        durationMs: 5,
      }
    })
    const result = await manager.compactContext('s1', 'native')
    expect(mockAdapter.compactContextMock).toHaveBeenCalledTimes(2)
    expect(mockAdapter.compactContextMock).toHaveBeenNthCalledWith(1, 's1', 'native', undefined)
    expect(mockAdapter.compactContextMock).toHaveBeenNthCalledWith(2, 's1', 'summary', undefined)
    expect(result.strategy).toBe('summary')
  })

  it('does NOT fall back when summary strategy itself fails', async () => {
    mockAdapter.compactContextMock.mockRejectedValueOnce(new Error('summary blew up'))
    await expect(manager.compactContext('s1', 'summary')).rejects.toThrow(/summary blew up/)
    expect(mockAdapter.compactContextMock).toHaveBeenCalledTimes(1)
  })

  it('throws when session not found', async () => {
    await expect(manager.compactContext('nope')).rejects.toThrow(/not found/i)
  })

  it('broadcasts a "Compacting" system message before and a "Compacted" message after', async () => {
    const broadcasts: string[] = []
    broadcaster.onBroadcast((_adapter, output) => {
      if (output.type === 'system') broadcasts.push(output.data)
    })
    await manager.compactContext('s1', 'summary')
    expect(broadcasts.length).toBeGreaterThanOrEqual(2)
    expect(broadcasts[0]).toMatch(/Compacting/)
    expect(broadcasts[broadcasts.length - 1]).toMatch(/Compacted/)
  })

  it('broadcasts fallback notice when native fails', async () => {
    const broadcasts: string[] = []
    broadcaster.onBroadcast((_adapter, output) => {
      if (output.type === 'system') broadcasts.push(output.data)
    })
    mockAdapter.compactContextMock.mockImplementation(async (sid, strat) => {
      if (strat === 'native') throw new Error('not supported')
      return {
        sessionId: sid,
        strategy: 'summary',
        trigger: 'manual',
        tokensBefore: 1000,
        tokensAfter: 100,
        startedAt: Date.now(),
        durationMs: 5,
      }
    })
    await manager.compactContext('s1', 'native')
    expect(broadcasts.some((b) => /falling back/i.test(b))).toBe(true)
  })

  it('updates waterline state on success', async () => {
    waterline.onAdapterUsageReport('t1', 1000, 200_000)
    expect(waterline.getRatio('t1')).toBeGreaterThan(0)
    await manager.compactContext('s1', 'summary')
    const state = waterline.getState('t1')
    expect(state).not.toBeNull()
    expect(state!.lastCompactedAt).toBeTruthy()
    expect(state!.tokensUsed).toBe(100)
  })

  it('persists to compactHistoryRepo when wired', async () => {
    const insert = vi.fn().mockResolvedValue('compact_123')
    const fakeRepo = { insert } as any
    manager.setCompactHistoryRepo(fakeRepo)
    await manager.compactContext('s1', 'summary')
    expect(insert).toHaveBeenCalledTimes(1)
    const arg = insert.mock.calls[0][0]
    expect(arg.threadId).toBe('t1')
    expect(arg.sessionId).toBe('s1')
    expect(arg.strategy).toBe('summary')
    expect(arg.tokensBefore).toBe(1000)
    expect(arg.tokensAfter).toBe(100)
  })

  it('updates chat thread waterline via chatRepo when wired', async () => {
    const setLastCompactedAt = vi.fn().mockResolvedValue(undefined)
    const resetContextTokens = vi.fn().mockResolvedValue(undefined)
    const fakeChatRepo = { setLastCompactedAt, resetContextTokens } as any
    manager.setChatRepo(fakeChatRepo)
    await manager.compactContext('s1', 'summary')
    expect(setLastCompactedAt).toHaveBeenCalledWith('t1', expect.any(Number))
    expect(resetContextTokens).toHaveBeenCalledWith('t1', 100)
  })

  it('skips history/waterline persistence for deferred compact results', async () => {
    mockAdapter.compactContextMock.mockResolvedValue({
      ...defaultMockResult('native'),
      tokensAfter: 1000, // same as tokensBefore — deferred
      deferred: true,
    })

    const insert = vi.fn().mockResolvedValue('compact_456')
    const setLastCompactedAt = vi.fn().mockResolvedValue(undefined)
    const resetContextTokens = vi.fn().mockResolvedValue(undefined)
    manager.setCompactHistoryRepo({ insert } as any)
    manager.setChatRepo({ setLastCompactedAt, resetContextTokens } as any)

    const result = await manager.compactContext('s1', 'native')

    expect(result.deferred).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(setLastCompactedAt).not.toHaveBeenCalled()
    expect(resetContextTokens).not.toHaveBeenCalled()
  })

  it('broadcasts deferred notice instead of token summary for deferred results', async () => {
    const broadcasts: string[] = []
    broadcaster.onBroadcast((_adapter, output) => {
      if (output.type === 'system') broadcasts.push(output.data)
    })
    mockAdapter.compactContextMock.mockResolvedValue({
      ...defaultMockResult('native'),
      tokensAfter: 1000,
      deferred: true,
    })
    await manager.compactContext('s1', 'native')
    expect(broadcasts.some((b) => /SDK will compact/i.test(b))).toBe(true)
  })
})
