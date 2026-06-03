import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentManager } from '../agent/agent-manager'
import { AdapterRegistry } from '../agent/adapter-registry'
import { SessionRouter } from '../agent/session-router'
import { OutputBroadcaster } from '../agent/output-broadcaster'
import { BaseAdapter } from '../adapters/base'
import type { AgentSession, AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'
import { SessionNotFoundError, AdapterError } from '../errors'

// Minimal test adapter
class TestAdapter extends BaseAdapter {
  readonly name = 'test-adapter'
  readonly version = '1.0.0'
  private mockProc = {
    kill: vi.fn(),
    killed: false,
    once: vi.fn((event: string, cb: (...args: any[]) => void) => {
      // Store callback so tests can trigger it
      ;(this.mockProc as any)._callbacks = (this.mockProc as any)._callbacks || {}
      ;(this.mockProc as any)._callbacks[event] = cb
    }),
    on: vi.fn(),
    off: vi.fn(),
    stdout: { on: vi.fn(), off: vi.fn() },
    stderr: { on: vi.fn(), off: vi.fn() },
  } as any

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session: AgentSession = {
      id: `test-${Date.now()}`,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }
    this.registerSession(session, this.mockProc)
    return session
  }

  protected async doSendCommand(): Promise<void> {
    // Simulate output
    this.emitOutput({
      type: 'stdout',
      data: 'test output',
      timestamp: Date.now(),
    })
  }

  protected async doTerminate(): Promise<void> {
    // Immediately resolve to avoid timeout in tests
    const cb = this.mockProc._callbacks?.exit
    if (cb) cb()
    this.mockProc.killed = true
  }

  public simulateCrash(sessionId: string): void {
    this.emit('sessionEnded', sessionId, 'crash')
  }
}

/** MCP fallback 适配器（AgentManager 硬编码查找名为 'mcp' 的适配器做 fallback） */
class FallbackAdapter extends BaseAdapter {
  readonly name = 'mcp'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session: AgentSession = {
      id: `mcp-${Date.now()}`,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(): Promise<void> {
    this.emitOutput({ type: 'stdout', data: 'mcp output', timestamp: Date.now() })
  }
}

describe('AgentManager', () => {
  let registry: AdapterRegistry
  let router: SessionRouter
  let broadcaster: OutputBroadcaster
  let manager: AgentManager

  beforeEach(() => {
    registry = new AdapterRegistry()
    router = new SessionRouter(registry)
    broadcaster = new OutputBroadcaster()
    manager = new AgentManager(registry, router, broadcaster)
  })

  afterEach(() => {
    manager.destroy()
  })

  const mockConfig = (overrides?: Partial<AgentSessionConfig>): AgentSessionConfig => ({
    workingDirectory: '/project',
    allowedFiles: ['src/index.ts'],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: 'Test Node',
    acceptanceCriteria: [],
    ...overrides,
  })

  describe('startSession', () => {
    it('should start a session successfully', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)

      const result = await manager.startSession('test-adapter', mockConfig())

      expect(result.sessionId).toBeDefined()
      expect(result.fallback).toBeUndefined()
      expect(router.getActiveSessionIds()).toContain(result.sessionId)
    })

    it('should throw when adapter not found', async () => {
      await expect(manager.startSession('nonexistent', mockConfig())).rejects.toThrow(AdapterError)
    })

    it('should fallback to mcp adapter when primary not installed', async () => {
      const primary = new TestAdapter()
      const fallback = new FallbackAdapter()
      vi.spyOn(primary, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(primary)
      manager.registerAdapter(fallback)

      const result = await manager.startSession('test-adapter', mockConfig())

      expect(result.fallback).toBe(true)
      expect(router.getActiveSessionIds()).toContain(result.sessionId)
    })

    it('should throw when adapter not installed and no fallback', async () => {
      const adapter = new TestAdapter()
      vi.spyOn(adapter, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(adapter)

      await expect(manager.startSession('test-adapter', mockConfig())).rejects.toThrow(AdapterError)
    })
  })

  describe('sendCommand', () => {
    it('should send command to active session', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const command: AgentCommand = { type: 'implement', description: 'test', targetNodeId: 'n1' }
      await expect(manager.sendCommand(sessionId, command)).resolves.not.toThrow()
    })

    it('should throw for unknown session', async () => {
      await expect(manager.sendCommand('unknown', { type: 'implement', description: 'test', targetNodeId: 'n1' }))
        .rejects.toThrow(SessionNotFoundError)
    })
  })

  describe('terminateSession', () => {
    it('should terminate session and clean up resources', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      await manager.terminateSession(sessionId)

      expect(router.getActiveSessionIds()).not.toContain(sessionId)
    })

    it('should be no-op for already cleaned up session', async () => {
      await expect(manager.terminateSession('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('terminateAllSessions', () => {
    it('should terminate all active sessions', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)
      await manager.startSession('test-adapter', mockConfig())
      await manager.startSession('test-adapter', mockConfig({ nodeTitle: 'Node 2' }))

      await manager.terminateAllSessions()

      expect(router.getActiveSessionIds()).toHaveLength(0)
    })
  })

  describe('broadcast routing', () => {
    it('should broadcast output with correct broadcast name', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const outputs: Array<{ name: string; output: AgentOutput }> = []
      broadcaster.onBroadcast((name, output) => {
        outputs.push({ name, output })
      })

      await manager.sendCommand(sessionId, { type: 'implement', description: 'test', targetNodeId: 'n1' })

      expect(outputs.length).toBeGreaterThan(0)
      expect(outputs[0].name).toBe('test-adapter')
    })

    it('should use original adapter name for fallback sessions', async () => {
      const primary = new TestAdapter()
      const fallback = new FallbackAdapter()
      vi.spyOn(primary, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(primary)
      manager.registerAdapter(fallback)

      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const outputs: Array<{ name: string; output: AgentOutput }> = []
      broadcaster.onBroadcast((name, output) => {
        outputs.push({ name, output })
      })

      await manager.sendCommand(sessionId, { type: 'implement', description: 'test', targetNodeId: 'n1' })

      expect(outputs.length).toBeGreaterThan(0)
      expect(outputs[0].name).toBe('test-adapter') // 显示原始适配器名而非 fallback
    })
  })

  describe('sessionEnded event handling', () => {
    it('should clean up resources when session crashes', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      // Simulate crash
      adapter.simulateCrash(sessionId)

      // Router and sandbox should be cleaned up
      expect(router.getActiveSessionIds()).not.toContain(sessionId)
    })
  })

  describe('listAdapters', () => {
    it('should return adapter list with installation status', async () => {
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)

      const adapters = await manager.listAdapters()

      expect(adapters).toHaveLength(1)
      expect(adapters[0].name).toBe('test-adapter')
      expect(adapters[0].installed).toBe(true)
    })
  })

  describe('output listener lifecycle', () => {
    it('should add and remove output listeners', () => {
      const handler = vi.fn()
      manager.addOutputListener(handler)
      manager.removeOutputListener(handler)

      // After removal, handler should not be called
      const adapter = new TestAdapter()
      manager.registerAdapter(adapter)
      // No error should occur
    })
  })
})
