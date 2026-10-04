import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentAdapter, AgentCommand, AgentSessionConfig } from '@shared/types'
import { SessionLifecycleManager } from '../session-lifecycle-manager'
import type { AdapterRegistry } from '../adapter-registry'
import type { SessionRouter } from '../session-router'
import type { OutputBroadcaster } from '../output-broadcaster'
import type { ScopeGuard } from '../../scope-guard'
import { SessionNotFoundError } from '../../errors'
import type { Sandbox } from '@shared/types'

function makeAdapter(name: string, overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name,
    checkInstalled: vi.fn(async () => true),
    startSession: vi.fn(async () => ({ id: `${name}-sess-1`, startTime: Date.now() })),
    sendCommand: vi.fn(async () => undefined),
    terminateSession: vi.fn(async () => undefined),
    onOutput: vi.fn(),
    offOutput: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    compactContext: vi.fn(async () => ({
      strategy: 'summary' as const,
      trigger: 'manual' as const,
      tokensBefore: 1000,
      tokensAfter: 500,
      durationMs: 100,
      startedAt: Date.now(),
    })),
    ...overrides,
  } as unknown as AgentAdapter
}

function makeRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]))
  return {
    get: (n: string) => map.get(n),
    list: () => adapters,
    register: vi.fn((a: AgentAdapter) => { map.set(a.name, a) }),
    checkAllInstalled: vi.fn(async () => []),
  } as unknown as AdapterRegistry
}

function makeRouter(adapterByName: Record<string, AgentAdapter> = {}): SessionRouter {
  const sessionMap: Record<string, AgentAdapter> = {}
  return {
    resolve: vi.fn((id: string) => {
      const adapter = sessionMap[id] ?? adapterByName[id]
      if (!adapter) throw new SessionNotFoundError(id)
      return adapter
    }),
    bind: vi.fn((sessionId: string, adapterName: string) => {
      // Find the adapter by name from adapterByName, then bind sessionId → adapter
      for (const a of Object.values(adapterByName)) {
        if (a.name === adapterName) {
          sessionMap[sessionId] = a
          return
        }
      }
    }),
    unbind: vi.fn((id: string) => { delete sessionMap[id] }),
    getAdapterName: vi.fn(() => undefined),
    getActiveSessionIds: vi.fn(() => Object.keys(sessionMap)),
    onTtlExpired: vi.fn(() => () => undefined),
  } as unknown as SessionRouter
}

function makeBroadcaster(): OutputBroadcaster {
  return {
    broadcast: vi.fn(),
    onBroadcast: vi.fn(),
    offBroadcast: vi.fn(),
  } as unknown as OutputBroadcaster
}

function makeScopeGuard(): ScopeGuard {
  return {
    prepareSandbox: vi.fn(async (allowed: string[], _cwd: string) => ({
      id: `sandbox-${Math.random().toString(36).slice(2, 8)}`,
      allowedFiles: allowed,
      workingDirectory: _cwd,
      workingDir: _cwd,
      backupDir: `${_cwd}/.bak`,
      createdAt: Date.now(),
    } as unknown as Sandbox)),
    commitChanges: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    onViolation: vi.fn(),
    unbindViolationHandler: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ScopeGuard
}

function makeConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    commandType: 'implement',
    workingDirectory: '/tmp/proj',
    allowedFiles: [],
    threadId: 'thread-1',
    nodeId: undefined,
    ...overrides,
  } as AgentSessionConfig
}

describe('SessionLifecycleManager', () => {
  let adapter: AgentAdapter
  let registry: AdapterRegistry
  let router: SessionRouter
  let broadcaster: OutputBroadcaster
  let scopeGuard: ScopeGuard
  let lifecycle: SessionLifecycleManager

  beforeEach(() => {
    adapter = makeAdapter('claude-code')
    registry = makeRegistry([adapter])
    router = makeRouter({ 'claude-code-sess-1': adapter })
    broadcaster = makeBroadcaster()
    scopeGuard = makeScopeGuard()
    lifecycle = new SessionLifecycleManager(registry, router, broadcaster, scopeGuard)
    lifecycle.initialize()
  })

  describe('start()', () => {
    it('registers session state and returns broadcastName', async () => {
      const config = makeConfig()
      const session = { id: 'sess-A', startTime: Date.now() }

      const result = await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session,
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      expect(result.broadcastName).toBe('claude-code')
      const stored = lifecycle.getSessionState('sess-A')
      expect(stored?.adapterName).toBe('claude-code')
      expect(stored?.config).toBe(config)
      expect(stored?.threadId).toBe('thread-1')
    })

    it('uses broadcastName with -fallback suffix when isFallback=true', async () => {
      const config = makeConfig()
      const session = { id: 'sess-B', startTime: Date.now() }

      const result = await lifecycle.start({
        candidate: 'codex',
        adapter: makeAdapter('codex'),
        session,
        config,
        isFallback: true,
        primaryAdapter: 'claude-code',
      })

      expect(result.broadcastName).toMatch(/^claude-code-fallback-/)
    })

    it('prepares a scope sandbox when allowedFiles is non-empty', async () => {
      const config = makeConfig({ allowedFiles: ['src/foo.ts'] })
      const session = { id: 'sess-S', startTime: Date.now() }

      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session,
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      expect(scopeGuard.prepareSandbox).toHaveBeenCalledWith(['src/foo.ts'], '/tmp/proj')
      const stored = lifecycle.getSessionState('sess-S')
      expect(stored?.sandbox).toBeDefined()
      expect(lifecycle.getSandbox('sess-S')).toBe(stored?.sandbox)
    })

    it('skips sandbox when allowedFiles empty and not verifyOnly', async () => {
      const config = makeConfig({ allowedFiles: [], verifyOnly: false })
      const session = { id: 'sess-N', startTime: Date.now() }

      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session,
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      expect(scopeGuard.prepareSandbox).not.toHaveBeenCalled()
      expect(lifecycle.getSessionState('sess-N')?.sandbox).toBeUndefined()
    })
  })

  describe('terminate()', () => {
    let sessionId: string

    beforeEach(async () => {
      const config = makeConfig({ allowedFiles: ['src/foo.ts'] })
      sessionId = 'sess-T'
      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: sessionId, startTime: Date.now() },
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })
      // Simulate AgentManager's router.bind() call after lifecycle.start()
      router.bind(sessionId, 'claude-code')
    })

    it('calls adapter.terminate, commits scope, unbind router', async () => {
      await lifecycle.terminate(sessionId, 'user')

      expect(adapter.terminateSession).toHaveBeenCalledWith(sessionId, 'user')
      expect(scopeGuard.commitChanges).toHaveBeenCalled()
      expect(router.unbind).toHaveBeenCalledWith(sessionId)
    })

    it('removes session from state maps after terminate', async () => {
      await lifecycle.terminate(sessionId, 'user')
      expect(lifecycle.getSessionState(sessionId)).toBeUndefined()
      expect(lifecycle.getSandbox(sessionId)).toBeUndefined()
      expect(lifecycle.listActive()).not.toContain(sessionId)
    })

    it('invokes phaseB hook after releasing the cleanup lock', async () => {
      const phaseB = vi.fn(async (_args: { sessionId: string; state: unknown; outputs: unknown; reason: string | undefined; scopeGuardError: Error | undefined }) => undefined)
      await lifecycle.terminate(sessionId, 'user', phaseB)

      expect(phaseB).toHaveBeenCalledTimes(1)
      const callArgs = phaseB.mock.calls[0]?.[0] as unknown as { sessionId: string; reason: string | undefined }
      expect(callArgs?.sessionId).toBe(sessionId)
      expect(callArgs?.reason).toBe('user')
    })

    it('is a no-op if cleanup is already in progress', async () => {
      // simulate concurrent termination by pre-occupying the cleanup lock
      // through a synthetic 'crash' path
      const sessionEndedHandler = (adapter.on as ReturnType<typeof vi.fn>).mock.calls
        .find((call: unknown[]) => (call[0] as string) === 'sessionEnded')?.[1] as (id: string, reason: string, exit: number | null) => void
      sessionEndedHandler?.(sessionId, 'crash', 1)

      // Now issue terminate: should detect cleanupInProgress and return early
      await lifecycle.terminate(sessionId, 'user')
      // adapter.terminateSession must NOT be called twice
      expect((adapter.terminateSession as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1)
    })
  })

  describe('getSessionState / getSandbox / getSessionConfig / listActive', () => {
    it('returns undefined for unknown sessionId', () => {
      expect(lifecycle.getSessionState('nope')).toBeUndefined()
      expect(lifecycle.getSandbox('nope')).toBeUndefined()
      expect(lifecycle.getSessionConfig('nope')).toBeUndefined()
    })

    it('listActive returns registered sessions only', async () => {
      const a = makeAdapter('a')
      const b = makeAdapter('b')
      registry = makeRegistry([adapter, a, b])
      router = makeRouter({ 'sess-1': adapter, 'sess-2': a })
      lifecycle = new SessionLifecycleManager(registry, router, broadcaster, scopeGuard)
      lifecycle.initialize()

      await lifecycle.start({
        candidate: 'a',
        adapter: a,
        session: { id: 'sess-1', startTime: Date.now() },
        config: makeConfig(),
        isFallback: false,
        primaryAdapter: 'a',
      })
      await lifecycle.start({
        candidate: 'b',
        adapter: b,
        session: { id: 'sess-2', startTime: Date.now() },
        config: makeConfig(),
        isFallback: false,
        primaryAdapter: 'b',
      })

      const active = lifecycle.listActive()
      expect(active).toContain('sess-1')
      expect(active).toContain('sess-2')
      expect(active.length).toBe(2)
    })
  })

  describe('output listeners', () => {
    it('addOutputListener registers a handler, removeOutputListener unregisters', () => {
      const handler = vi.fn()
      lifecycle.addOutputListener(handler)
      lifecycle.broadcastToSession('sess-X', { type: 'stdout', data: 'hi', timestamp: 1 })
      // Without an active session the broadcast goes to global listeners via broadcaster
      // (broadcaster is a mock; we just verify no throw)
      expect(() => lifecycle.removeOutputListener(handler)).not.toThrow()
    })

    it('addSessionOutputListener returns true when session exists', async () => {
      const config = makeConfig()
      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: 'sess-O', startTime: Date.now() },
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      const handler = vi.fn()
      const registered = lifecycle.addSessionOutputListener('sess-O', handler)
      expect(registered).toBe(true)
    })

    it('addSessionOutputListener returns false when session missing', () => {
      const registered = lifecycle.addSessionOutputListener('missing', vi.fn())
      expect(registered).toBe(false)
    })
  })

  describe('status change hook', () => {
    it('fires setStatusChangeHook on scope commit during terminate', async () => {
      const hook = vi.fn()
      lifecycle.setStatusChangeHook(hook)

      const config = makeConfig({ nodeId: 'node-7', allowedFiles: ['src/foo.ts'] })
      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: 'sess-H', startTime: Date.now() },
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })
      router.bind('sess-H', 'claude-code')

      await lifecycle.terminate('sess-H', 'user')

      expect(hook).toHaveBeenCalledWith('sess-H', 'node-7')
    })
  })

  describe('activeSessionCount / cleanupInProgressCount', () => {
    it('counts active sessions correctly', async () => {
      const a = makeAdapter('a')
      registry = makeRegistry([adapter, a])
      router = makeRouter({ 'sess-X': adapter, 'sess-Y': a })
      lifecycle = new SessionLifecycleManager(registry, router, broadcaster, scopeGuard)
      lifecycle.initialize()

      expect(lifecycle.activeSessionCount).toBe(0)

      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: 'sess-X', startTime: Date.now() },
        config: makeConfig(),
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      expect(lifecycle.activeSessionCount).toBe(1)
    })

    it('cleanupInProgressCount tracks active cleanup operations', async () => {
      const config = makeConfig()
      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: 'sess-C', startTime: Date.now() },
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      expect(lifecycle.cleanupInProgressCount).toBe(0)
      expect(lifecycle.isCleanupInProgress('sess-C')).toBe(false)

      await lifecycle.terminate('sess-C', 'user')

      expect(lifecycle.cleanupInProgressCount).toBe(0) // released after terminate
    })
  })

  describe('terminateAll()', () => {
    it('terminates every active session', async () => {
      const a = makeAdapter('a')
      const b = makeAdapter('b')
      registry = makeRegistry([adapter, a, b])
      router = makeRouter({ 's1': adapter, 's2': a, 's3': b })
      lifecycle = new SessionLifecycleManager(registry, router, broadcaster, scopeGuard)
      lifecycle.initialize()

      for (const [name, sess, adp] of [['claude-code', 's1', adapter], ['a', 's2', a], ['b', 's3', b]] as const) {
        await lifecycle.start({
          candidate: name,
          adapter: adp,
          session: { id: sess, startTime: Date.now() },
          config: makeConfig(),
          isFallback: false,
          primaryAdapter: name,
        })
      }

      expect(lifecycle.activeSessionCount).toBe(3)

      await lifecycle.terminateAll('user')

      expect(lifecycle.activeSessionCount).toBe(0)
    })
  })

  describe('attachAdapter()', () => {
    it('binds output + sessionEnded handlers for the adapter', () => {
      const newAdapter = makeAdapter('codex')
      lifecycle.attachAdapter(newAdapter)

      expect(newAdapter.onOutput).toHaveBeenCalledTimes(1)
      expect(newAdapter.on).toHaveBeenCalledWith('sessionEnded', expect.any(Function))
    })

    it('detaches the previous handler when re-attached', () => {
      const newAdapter = makeAdapter('codex')
      lifecycle.attachAdapter(newAdapter)
      const firstCallCount = (newAdapter.onOutput as ReturnType<typeof vi.fn>).mock.calls.length
      lifecycle.attachAdapter(newAdapter)
      expect(newAdapter.offOutput).toHaveBeenCalledTimes(1)
      expect((newAdapter.onOutput as ReturnType<typeof vi.fn>).mock.calls.length).toBe(firstCallCount + 1)
    })
  })

  describe('recordLastCommand / recordPromptMetrics', () => {
    it('stores lastCommandType on state', async () => {
      const config = makeConfig()
      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: 'sess-M', startTime: Date.now() },
        config,
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      lifecycle.recordLastCommand('sess-M', { description: 'fix bug' } as AgentCommand, 'fix_bug')
      expect(lifecycle.getSessionState('sess-M')?.lastCommandType).toBe('fix_bug')
    })
  })

  describe('destroy()', () => {
    it('detaches all bound adapters and clears state', async () => {
      const newAdapter = makeAdapter('codex')
      // Register the new adapter in the registry so destroy() can find it
      registry.register(newAdapter)
      lifecycle.attachAdapter(newAdapter)

      await lifecycle.start({
        candidate: 'claude-code',
        adapter,
        session: { id: 'sess-D', startTime: Date.now() },
        config: makeConfig(),
        isFallback: false,
        primaryAdapter: 'claude-code',
      })

      lifecycle.destroy()

      expect(newAdapter.offOutput).toHaveBeenCalled()
      expect(lifecycle.activeSessionCount).toBe(0)
    })
  })
})