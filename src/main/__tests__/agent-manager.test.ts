/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { AgentManager } from '../agent/agent-manager'
import { AdapterRegistry } from '../agent/adapter-registry'
import { SessionRouter } from '../agent/session-router'
import { OutputBroadcaster } from '../agent/output-broadcaster'
import { BaseAdapter } from '../adapters/base'
import type { AgentSession, AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'
import { SessionNotFoundError, AdapterError } from '../errors'
import { SessionRecoveryManager, setForTesting } from '../agent/session-recovery'
import { generateId } from '../shared/env'

// Minimal test adapter — name configurable
class TestAdapter extends BaseAdapter {
  readonly name: string
  readonly version = '1.0.0'
  private mockProc = {
    kill: vi.fn(),
    killed: false,
    once: vi.fn((event: string, cb: (...args: any[]) => void) => {
      ;(this.mockProc as any)._callbacks = (this.mockProc as any)._callbacks || {}
      ;(this.mockProc as any)._callbacks[event] = cb
    }),
    on: vi.fn(),
    off: vi.fn(),
    stdout: { on: vi.fn(), off: vi.fn() },
    stderr: { on: vi.fn(), off: vi.fn() },
  } as any

  constructor(name = 'test-adapter') {
    super()
    this.name = name
  }

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session: AgentSession = {
      // 必须唯一：会话 id 是 router / 输出缓冲 / 恢复谱系的键。
      // 用 Date.now() 生成时，同一毫秒内创建的两个会话会撞 id ——
      // 新会话的 bind 覆盖旧条目，活动会话数不增长，恢复链路静默断掉。
      id: generateId(this.name),
      adapterName: this.name,
      // 真实适配器都 clone 配置（避免运行时写回调用方对象），
      // 适配器侧的状态（如压缩摘要 contextSummary）因此与 manager 快照相互独立。
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session, this.mockProc)
    return session
  }

  /** 每次投递实际构造出的 prompt —— 用于断言「投递给 Agent 的内容」而非内部构造器 */
  public lastPrompts: string[] = []

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    this.lastPrompts.push(this.buildFullPrompt(session, command))
    this.emitOutput({
      type: 'stdout',
      data: `${this.name} output`,
      timestamp: Date.now(),
    })
  }

  protected async doTerminate(): Promise<void> {
    const cb = this.mockProc._callbacks?.exit
    if (cb) cb()
    this.mockProc.killed = true
  }

  public simulateCrash(sessionId: string): void {
    this.emit('sessionEnded', sessionId, 'crash', 1)
  }

  public simulateTimeout(sessionId: string): void {
    this.emit('sessionEnded', sessionId, 'timeout', 137)
  }

  public simulateSuccess(sessionId: string): void {
    this.emit('sessionEnded', sessionId, 'success', 0)
  }

  public simulateExit(sessionId: string, reason: 'crash' | 'error' | 'timeout' | 'success', exitCode: number | null): void {
    this.emit('sessionEnded', sessionId, reason, exitCode)
  }
}

describe('AgentManager', () => {
  let registry: AdapterRegistry
  let router: SessionRouter
  let broadcaster: OutputBroadcaster
  let manager: AgentManager

  beforeEach(() => {
    // startSession 有一道「可用内存 < 512MB 就拒绝开新会话」的资源闸门。
    // 全量跑测试时机器内存会波动，闸门偶发触发 → 恢复流程拿不到替代会话 →
    // 「崩溃后应创建替代会话」这类断言随负载时好时坏。测试里把内存读数固定住。
    vi.spyOn(os, 'freemem').mockReturnValue(4 * 1024 * 1024 * 1024)
    setForTesting(new SessionRecoveryManager())
    registry = new AdapterRegistry()
    router = new SessionRouter(registry)
    broadcaster = new OutputBroadcaster()
    manager = new AgentManager(registry, router, broadcaster)
  })

  afterEach(() => {
    manager.destroy()
    setForTesting(null)
    vi.restoreAllMocks()
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
    it('should start a session successfully with specified adapter', async () => {
      const adapter = new TestAdapter('claude-code')
      manager.registerAdapter(adapter)

      const result = await manager.startSession('claude-code', mockConfig())

      expect(result.sessionId).toBeDefined()
      expect(result.fallback).toBeFalsy()
      expect(result.adapterUsed).toBe('claude-code')
      expect(result.fallbackHistory).toHaveLength(1)
      expect(result.fallbackHistory[0]).toEqual({ adapter: 'claude-code', reason: '', success: true })
      expect(router.getActiveSessionIds()).toContain(result.sessionId)
    })

    it('should throw when all adapters in the chain fail', async () => {
      const adapter = new TestAdapter('claude-code')
      vi.spyOn(adapter, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(adapter)

      await expect(manager.startSession('claude-code', mockConfig())).rejects.toThrow(AdapterError)
    })

    it('should fallback through the preference chain when primary not installed', async () => {
      const primary = new TestAdapter('claude-code')
      const secondary = new TestAdapter('codex')
      const tertiary = new TestAdapter('mcp')
      vi.spyOn(primary, 'checkInstalled').mockResolvedValue(false)
      // codex also not installed
      vi.spyOn(secondary, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(primary)
      manager.registerAdapter(secondary)
      manager.registerAdapter(tertiary)

      // Set preferences so fallback order includes codex and mcp
      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['codex', 'mcp'],
      }))

      const result = await manager.startSession('claude-code', mockConfig())

      expect(result.fallback).toBe(true)
      expect(result.adapterUsed).toBe('mcp')
      expect(result.fallbackHistory).toHaveLength(3)
      expect(result.fallbackHistory[0]).toEqual({ adapter: 'claude-code', reason: 'claude-code not installed', success: false })
      expect(result.fallbackHistory[1]).toEqual({ adapter: 'codex', reason: 'codex not installed', success: false })
      expect(result.fallbackHistory[2]).toEqual({ adapter: 'mcp', reason: '', success: true })
    })

    it('should fallback when adapter startSession throws', async () => {
      const primary = new TestAdapter('claude-code')
      const fallback = new TestAdapter('mcp')
      vi.spyOn(primary, 'startSession').mockRejectedValue(new Error('spawn ENOENT'))
      manager.registerAdapter(primary)
      manager.registerAdapter(fallback)

      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['mcp'],
      }))

      const result = await manager.startSession('claude-code', mockConfig())

      expect(result.fallback).toBe(true)
      expect(result.adapterUsed).toBe('mcp')
      expect(result.fallbackHistory.length).toBeGreaterThan(1)
    })

    it('should use default adapter when adapterName is null', async () => {
      const adapter = new TestAdapter('codex')
      manager.registerAdapter(adapter)

      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'codex',
        fallbackOrder: ['mcp'],
      }))

      const result = await manager.startSession(null, mockConfig())

      expect(result.sessionId).toBeDefined()
      expect(result.adapterUsed).toBe('codex')
      expect(result.fallback).toBeFalsy()
    })

    it('should fallback from default adapter when using null adapterName', async () => {
      const primary = new TestAdapter('claude-code')
      const fallback = new TestAdapter('mcp')
      vi.spyOn(primary, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(primary)
      manager.registerAdapter(fallback)

      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['mcp'],
      }))

      const result = await manager.startSession(null, mockConfig())

      expect(result.fallback).toBe(true)
      expect(result.adapterUsed).toBe('mcp')
    })

    it('should skip unregistered adapters in fallback chain', async () => {
      const mcp = new TestAdapter('mcp')
      manager.registerAdapter(mcp)

      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'claude-code',  // not registered
        fallbackOrder: ['codex', 'mcp'], // codex also not registered
      }))

      const result = await manager.startSession(null, mockConfig())

      expect(result.adapterUsed).toBe('mcp')
      expect(result.fallbackHistory).toHaveLength(3)
      expect(result.fallbackHistory[0].success).toBe(false)
      expect(result.fallbackHistory[1].success).toBe(false)
      expect(result.fallbackHistory[2].success).toBe(true)
    })

    it('should deduplicate adapters in the chain', async () => {
      const adapter = new TestAdapter('claude-code')
      manager.registerAdapter(adapter)

      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['claude-code', 'mcp'], // claude-code appears twice
      }))

      const result = await manager.startSession(null, mockConfig())

      // Should only try claude-code once
      expect(result.adapterUsed).toBe('claude-code')
      expect(result.fallbackHistory).toHaveLength(1)
    })
  })

  describe('sendCommand', () => {
    it('should send command to active session', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const command: AgentCommand = { type: 'implement', description: 'test', targetNodeId: 'n1' }
      await expect(manager.sendCommand(sessionId, command)).resolves.not.toThrow()
    })

    it('should throw for unknown session', async () => {
      await expect(manager.sendCommand('unknown', { type: 'implement', description: 'test', targetNodeId: 'n1' }))
        .rejects.toThrow(SessionNotFoundError)
    })

    it('直接 sendCommand 也投递 scope 约束（白名单 / 黑名单 / 业务不变量）', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession(
        'test-adapter',
        mockConfig({
          allowedFiles: ['src/index.ts'],
          forbiddenFiles: ['src/secret.ts'],
          invariantRules: ['INV-RULE-XYZ'],
        }),
      )

      // 会话历史记忆走 MemoryStore → 需要 DB；单测没有 DB，短路这一段。
      const historySpy = vi
        .spyOn((manager as any).promptFormatter, 'formatSessionHistoryContext')
        .mockResolvedValue(undefined)

      await manager.sendCommand(sessionId, {
        type: 'implement',
        description: 'cmd',
        targetNodeId: 'n1',
      })

      // 断言的是**投递给 Agent 的 prompt**，不是内部构造器 ——
      // scope 提示词整体消失正是投递路径上的回归。
      const prompt = adapter.lastPrompts.at(-1) ?? ''
      expect(prompt).toContain('## 允许修改的文件（白名单）')
      expect(prompt).toContain('src/index.ts')
      expect(prompt).toContain('## 禁止修改的文件（黑名单）')
      expect(prompt).toContain('src/secret.ts')
      expect(prompt).toContain('INV-RULE-XYZ')
      expect(prompt).toContain('Test Node')

      historySpy.mockRestore()
    })

    it('上一轮的 turn 段不会被下一轮复用（直接投递路径重新装配）', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const historySpy = vi
        .spyOn((manager as any).promptFormatter, 'formatSessionHistoryContext')
        .mockResolvedValueOnce('TURN-MARK-FIRST')
        .mockResolvedValue('TURN-MARK-SECOND')

      await manager.resolveAndSendCommand(sessionId, {
        type: 'implement',
        description: 'first',
        targetNodeId: 'n1',
      })
      await manager.sendCommand(sessionId, {
        type: 'implement',
        description: 'second',
        targetNodeId: 'n1',
      })

      const prompts = adapter.lastPrompts
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain('TURN-MARK-FIRST')
      // turn 是「本轮上下文」，跨命令复用会把上一轮的编译上下文带进下一轮。
      expect(prompts[1]).not.toContain('TURN-MARK-FIRST')
      expect(prompts[1]).toContain('TURN-MARK-SECOND')

      historySpy.mockRestore()
    })
  })

  describe('resolveAndSendCommand', () => {
    it('通过 setPromptContext 投递 stable/turn，用户请求不进任一段', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      // 会话历史记忆走 MemoryStore → 需要 DB；单测没有 DB，短路这一段。
      const historySpy = vi
        .spyOn((manager as any).promptFormatter, 'formatSessionHistoryContext')
        .mockResolvedValue(undefined)
      const setPromptContextSpy = vi.spyOn(adapter, 'setPromptContext')

      await manager.resolveAndSendCommand(sessionId, {
        type: 'implement',
        description: 'USER-REQ-UNIQUE',
        targetNodeId: 'n1',
      })

      expect(setPromptContextSpy).toHaveBeenCalledTimes(1)
      const ctx = setPromptContextSpy.mock.calls[0][1]
      expect(ctx.stable.length).toBeGreaterThan(0)
      expect(ctx.turn.length).toBeGreaterThan(0)
      // 用户请求只由适配器的 buildCommandPrompt 承载，不进 stable / turn。
      expect(ctx.stable).not.toContain('USER-REQ-UNIQUE')
      expect(ctx.turn).not.toContain('USER-REQ-UNIQUE')

      historySpy.mockRestore()
    })

    it('适配器实时配置里的压缩摘要进 turn 段（不进 stable）', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const historySpy = vi
        .spyOn((manager as any).promptFormatter, 'formatSessionHistoryContext')
        .mockResolvedValue(undefined)

      // 压缩后适配器把摘要写进自己的会话配置 —— manager 的启动快照看不到它。
      const liveSession = (adapter as any).sessions.get(sessionId)
      liveSession.config.contextSummary = 'SUMMARY-AAA'

      const setPromptContextSpy = vi.spyOn(adapter, 'setPromptContext')
      await manager.resolveAndSendCommand(sessionId, {
        type: 'implement',
        description: 'cmd',
        targetNodeId: 'n1',
      })

      // 压缩 / 恢复会重写摘要 —— 它进 turn 段，stable 前缀保持逐字节一致
      expect(setPromptContextSpy.mock.calls[0][1].turn).toContain('SUMMARY-AAA')
      expect(setPromptContextSpy.mock.calls[0][1].stable).not.toContain('SUMMARY-AAA')

      historySpy.mockRestore()
    })

    it('自动压缩产生的摘要当轮就进 turn 段', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig({ threadId: 't-1' }))

      const historySpy = vi
        .spyOn((manager as any).promptFormatter, 'formatSessionHistoryContext')
        .mockResolvedValue(undefined)

      ;(manager as any).contextWaterline = { shouldAutoCompact: () => true }
      vi.spyOn(manager, 'compactContext').mockImplementation(async (sid: string) => {
        ;(adapter as any).sessions.get(sid).config.contextSummary = 'COMPACT-SUMMARY'
        return {
          strategy: 'summary',
          trigger: 'auto-threshold',
          tokensBefore: 100,
          tokensAfter: 10,
          summary: 'COMPACT-SUMMARY',
          startedAt: Date.now(),
          durationMs: 1,
        } as any
      })

      const setPromptContextSpy = vi.spyOn(adapter, 'setPromptContext')
      await manager.resolveAndSendCommand(sessionId, {
        type: 'implement',
        description: 'cmd',
        targetNodeId: 'n1',
      })

      expect(setPromptContextSpy.mock.calls[0][1].turn).toContain('COMPACT-SUMMARY')
      expect(setPromptContextSpy.mock.calls[0][1].stable).not.toContain('COMPACT-SUMMARY')

      historySpy.mockRestore()
    })

    it('把项目记忆与会话历史记忆送进 prompt 上下文', async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bizgraph-mem-'))
      try {
        fs.mkdirSync(path.join(workDir, '.bizgraph'), { recursive: true })
        fs.writeFileSync(
          path.join(workDir, '.bizgraph', 'memory.json'),
          JSON.stringify({ architecturePattern: '项目记忆标记XYZ' }),
        )

        const adapter = new TestAdapter('test-adapter')
        manager.registerAdapter(adapter)
        const { sessionId } = await manager.startSession(
          'test-adapter',
          mockConfig({ workingDirectory: workDir }),
        )

        // 会话历史记忆走 MemoryStore → 需要 DB；单测没有 DB，短路这一段。
        const historySpy = vi
          .spyOn((manager as any).promptFormatter, 'formatSessionHistoryContext')
          .mockResolvedValue('会话历史标记ABC')

        const setPromptContextSpy = vi.spyOn(adapter, 'setPromptContext')
        await manager.resolveAndSendCommand(sessionId, {
          type: 'implement',
          description: 'cmd',
          targetNodeId: 'n1',
        })

        const ctx = setPromptContextSpy.mock.calls[0][1]
        // 项目记忆是项目级稳定内容 → stable；会话历史每轮检索 → turn。
        expect(ctx.stable).toContain('项目记忆标记XYZ')
        expect(ctx.turn).toContain('会话历史标记ABC')
        expect(ctx.stable).not.toContain('会话历史标记ABC')

        historySpy.mockRestore()
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true })
      }
    })
  })

  describe('terminateSession', () => {
    it('should terminate session and clean up resources', async () => {
      const adapter = new TestAdapter('test-adapter')
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
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      await manager.startSession('test-adapter', mockConfig())
      await manager.startSession('test-adapter', mockConfig({ nodeTitle: 'Node 2' }))

      await manager.terminateAllSessions()

      expect(router.getActiveSessionIds()).toHaveLength(0)
    })
  })

  describe('broadcast routing', () => {
    it('should broadcast output with correct broadcast name', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      const outputs: Array<{ name: string; output: AgentOutput }> = []
      broadcaster.onBroadcast((payload) => {
        outputs.push({ name: payload.adapterName, output: payload.output })
      })

      await manager.sendCommand(sessionId, { type: 'implement', description: 'test', targetNodeId: 'n1' })

      expect(outputs.length).toBeGreaterThan(0)
      expect(outputs[0].name).toBe('test-adapter')
    })

    it('should use original adapter name for fallback sessions', async () => {
      const primary = new TestAdapter('claude-code')
      const fallback = new TestAdapter('mcp')
      vi.spyOn(primary, 'checkInstalled').mockResolvedValue(false)
      manager.registerAdapter(primary)
      manager.registerAdapter(fallback)

      manager.setAdapterPreferencesLoader(async () => ({
        defaultAdapter: 'claude-code',
        fallbackOrder: ['mcp'],
      }))

      const { sessionId } = await manager.startSession('claude-code', mockConfig())

      const outputs: Array<{ name: string; output: AgentOutput }> = []
      broadcaster.onBroadcast((payload) => {
        outputs.push({ name: payload.adapterName, output: payload.output })
      })

      await manager.sendCommand(sessionId, { type: 'implement', description: 'test', targetNodeId: 'n1' })

      expect(outputs.length).toBeGreaterThan(0)
      expect(outputs[0].name).toContain('claude-code') // 包含原始适配器名（带 fallback 后缀）
    })
  })

  describe('sessionEnded event handling', () => {
    it('should clean up resources when session crashes', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      // Simulate crash
      adapter.simulateCrash(sessionId)

      // cleanupSessionResources is async and triggered via event — allow microtasks to flush
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Router and sandbox should be cleaned up
      expect(router.getActiveSessionIds()).not.toContain(sessionId)
    })

    it('should clean up resources when session completes successfully', async () => {
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('test-adapter', mockConfig())

      adapter.simulateSuccess(sessionId)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(router.getActiveSessionIds()).not.toContain(sessionId)
      expect((manager as any).sessionStates.has(sessionId)).toBe(false)
      expect((manager as any).sessionOutputBuffers.has(sessionId)).toBe(false)
    })

    it('should not trigger recovery for non-recoverable exit codes 126/127', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())

      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')
      adapter.simulateExit(sessionId, 'crash', 126)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(spy).not.toHaveBeenCalled()
      expect(router.getActiveSessionIds()).not.toContain(sessionId)

      spy.mockRestore()
    })

    it('should not trigger recovery for exit code 127', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())

      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')
      adapter.simulateExit(sessionId, 'crash', 127)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(spy).not.toHaveBeenCalled()
      expect(router.getActiveSessionIds()).not.toContain(sessionId)

      spy.mockRestore()
    })

    it('should not trigger recovery for non-recoverable success reason', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())

      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')
      adapter.simulateSuccess(sessionId)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(spy).not.toHaveBeenCalled()
      expect(router.getActiveSessionIds()).not.toContain(sessionId)

      spy.mockRestore()
    })

    it('should keep native-resumed session active without corrupting router fallback metadata', async () => {
      const adapter = new TestAdapter('claude-code')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('claude-code', mockConfig())

      adapter.simulateCrash(sessionId)

      await vi.waitFor(() => {
        expect(manager.getActiveSessionIds()).toContain(sessionId)
      })

      // Native resume must not set broadcastName as originalAdapter fallback metadata.
      expect(router.getFallbackInfo(sessionId)).toBeUndefined()
    })
  })

  describe('listAdapters', () => {
    it('should return adapter list with installation status', async () => {
      const adapter = new TestAdapter('test-adapter')
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
      const adapter = new TestAdapter('test-adapter')
      manager.registerAdapter(adapter)
      // No error should occur
    })
  })

  describe('recovery', () => {
    it('attempts recovery when a session crashes', async () => {
      const adapter = new TestAdapter('claude-code')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('claude-code', mockConfig())
      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')

      adapter.simulateCrash(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId, adapterName: 'claude-code' }))
    })

    it('attempts recovery for error and null exit codes', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())
      const state = (manager as any).sessionStates.get(sessionId)
      const outputs = (manager as any).sessionOutputBuffers.get(sessionId) ?? []
      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')

      await (manager as any)._handleSessionEnded(sessionId, null, 'error', state, outputs)

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId, adapterName: 'mcp' }))
    })

    it('attempts recovery for timeout reason', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())
      const state = (manager as any).sessionStates.get(sessionId)
      const outputs = (manager as any).sessionOutputBuffers.get(sessionId) ?? []
      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')

      await (manager as any)._handleSessionEnded(sessionId, 1, 'timeout', state, outputs)

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId, adapterName: 'mcp' }))
    })

    it('caps recovery retries at 3 attempts', async () => {
      const recovery = manager['sessionRecovery']
      recovery.registerStrategy({
        adapterName: 'failing-adapter',
        canResume: false,
        resume: async () => null,
      })
      const base = {
        sessionId: 's1',
        adapterName: 'failing-adapter',
        projectId: '/project',
        lastOutputs: [] as AgentOutput[],
        lastMessages: [] as Array<{ role: string; content: string }>,
      }

      await recovery.attemptRecovery(base)
      await recovery.attemptRecovery(base)
      await recovery.attemptRecovery(base)
      expect(recovery.getAttempts('s1')).toBe(3)

      // Further attempts should be short-circuited
      const result = await recovery.attemptRecovery(base)
      expect(result).toBeNull()
    })

    it('keeps independent recovery checks per adapter', async () => {
      const a = new TestAdapter('a')
      const b = new TestAdapter('b')
      vi.spyOn(a, 'checkInstalled').mockResolvedValue(true)
      vi.spyOn(b, 'checkInstalled').mockResolvedValue(true)
      manager.registerAdapter(a)
      manager.registerAdapter(b)

      const recordSpy = vi.spyOn((manager as any).healthMonitor, 'recordCall')

      vi.useFakeTimers()
      try {
        ;(manager as any).startRecoveryCheck('a')
        ;(manager as any).startRecoveryCheck('b')
        expect((manager as any).recoveryCheckIntervals.size).toBe(2)

        // Calling again must not create a duplicate interval
        ;(manager as any).startRecoveryCheck('a')
        expect((manager as any).recoveryCheckIntervals.size).toBe(2)

        await vi.advanceTimersByTimeAsync(60_000)
        expect(recordSpy).toHaveBeenCalledWith('a', true, 0, 'recovery-check')
        expect(recordSpy).toHaveBeenCalledWith('b', true, 0, 'recovery-check')
        expect((manager as any).recoveryCheckIntervals.size).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('resumes the last command after MCP context-injection recovery', async () => {
      const adapter = new TestAdapter('mcp')
      const sendSpy = vi.spyOn(adapter, 'sendCommand')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())
      const command: AgentCommand = { type: 'implement', description: 'continue', targetNodeId: 'n1' }
      await manager.sendCommand(sessionId, command)

      // Inject a pending context so the recovery path creates a replacement session
      manager['sessionRecovery'].setPendingContext(sessionId, '[context]')
      const state = (manager as any).sessionStates.get(sessionId)
      const outputs = (manager as any).sessionOutputBuffers.get(sessionId) ?? []

      await (manager as any)._handleSessionEnded(sessionId, null, 'error', state, outputs)

      // The replacement session should receive the last user command
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith(expect.any(String), command)
      })
    })

    it('attempts recovery for timeout even with signal exit codes (137/143)', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())
      const state = (manager as any).sessionStates.get(sessionId)
      const outputs = (manager as any).sessionOutputBuffers.get(sessionId) ?? []
      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')

      await (manager as any)._handleSessionEnded(sessionId, 137, 'timeout', state, outputs)

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sessionId, adapterName: 'mcp' }))
    })

    it('stops replacing MCP sessions after the global retry budget', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId: originalId } = await manager.startSession('mcp', mockConfig())
      const command: AgentCommand = { type: 'implement', description: 'keep going', targetNodeId: 'n1' }
      await manager.sendCommand(originalId, command)

      let currentId = originalId
      const initialCount = manager.getActiveSessionIds().length

      // maxRetries = 3: the first three crashes each create a replacement session.
      for (let i = 0; i < 3; i++) {
        const state = (manager as any).sessionStates.get(currentId)
        const outputs = (manager as any).sessionOutputBuffers.get(currentId) ?? []
        const before = new Set(manager.getActiveSessionIds())
        await (manager as any)._handleSessionEnded(currentId, null, 'error', state, outputs)
        const active = manager.getActiveSessionIds()
        expect(active.length).toBe(initialCount + i + 1)
        // 下一轮崩的必须是**刚创建**的替代会话。用「本次新增的 id」定位，
        // 而不是 find(id !== currentId) —— 后者命中的是最早那个还没崩过的
        // 旧会话，崩的序列变成 A→B→A→B，重试预算就不再对应
        // 「同一条恢复谱系连续崩三次」。
        const created = active.find((id) => !before.has(id))
        expect(created).toBeDefined()
        currentId = created!
      }

      // The fourth crash exhausts the budget: no replacement session is created.
      const state = (manager as any).sessionStates.get(currentId)
      const outputs = (manager as any).sessionOutputBuffers.get(currentId) ?? []
      await (manager as any)._handleSessionEnded(currentId, null, 'error', state, outputs)
      expect(manager.getActiveSessionIds().length).toBe(initialCount + 3)
    })

    it('keeps native-resumed sessions active in the manager', async () => {
      const adapter = new TestAdapter('claude-code')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('claude-code', mockConfig())

      adapter.simulateCrash(sessionId)

      await vi.waitFor(() => {
        expect(manager.getActiveSessionIds()).toContain(sessionId)
      })
    })

    it('preserves output context for MCP recovery from real session output', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const { sessionId } = await manager.startSession('mcp', mockConfig())
      await manager.sendCommand(sessionId, { type: 'implement', description: 'hello', targetNodeId: 'n1' })

      const spy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')
      adapter.simulateCrash(sessionId)

      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalled()
      })

      const context = spy.mock.calls[0][0]
      expect(context.lastOutputs.length).toBeGreaterThan(0)
      expect(context.lastMessages?.length).toBeGreaterThan(0)
    })

    it('resets recovery retry counter when a recovered session completes successfully', async () => {
      const adapter = new TestAdapter('mcp')
      manager.registerAdapter(adapter)
      const command: AgentCommand = { type: 'implement', description: 'keep going', targetNodeId: 'n1' }
      const { sessionId: originalId } = await manager.startSession('mcp', mockConfig())
      await manager.sendCommand(originalId, command)

      // First crash: MCP recovery creates a replacement session with context injection.
      manager['sessionRecovery'].setPendingContext(originalId, '[context]')
      const state1 = (manager as any).sessionStates.get(originalId)
      const outputs1 = (manager as any).sessionOutputBuffers.get(originalId) ?? []
      await (manager as any)._handleSessionEnded(originalId, null, 'error', state1, outputs1)

      await vi.waitFor(() => {
        expect(manager.getActiveSessionIds().length).toBe(2)
      })
      const replacementId = manager.getActiveSessionIds().find((id) => id !== originalId)
      expect(replacementId).toBeDefined()

      // The replacement session completes naturally with success.
      const recoverySpy = vi.spyOn(manager['sessionRecovery'], 'attemptRecovery')
      adapter.simulateSuccess(replacementId!)
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(manager.getActiveSessionIds()).not.toContain(replacementId)
      // Retry counter should have been reset on success.
      expect(manager['sessionRecovery'].getAttempts(originalId)).toBe(0)

      // Start a new session in the same lineage and crash it: recovery must be attempted again.
      const { sessionId: newId } = await manager.startSession('mcp', mockConfig())
      manager['sessionRecovery'].setPendingContext(newId, '[context]')
      // Simulate lineage by carrying over originSessionId.
      const newState = (manager as any).sessionStates.get(newId)
      newState.originSessionId = originalId
      const newOutputs = (manager as any).sessionOutputBuffers.get(newId) ?? []

      await (manager as any)._handleSessionEnded(newId, null, 'error', newState, newOutputs)

      expect(recoverySpy).toHaveBeenCalled()
      expect(manager['sessionRecovery'].getAttempts(originalId)).toBe(1)

      recoverySpy.mockRestore()
    })
  })
})
