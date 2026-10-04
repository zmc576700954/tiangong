/**
 * RecoveryOrchestrator 单元测试
 *
 * 覆盖：
 * - handleSessionExit: 137/143 正常退出、126/127 不恢复、crash/error/timeout 走 SessionRecovery、
 *                     MCP context injection 路径、native resume 路径、replacement 路径
 * - startFallbackRecoveryCheck: 探测到 healthy 时清理 timer、timeout 后清理
 * - startRecoveryCheck: 健康度恢复时清理、防止重复 timer
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RecoveryOrchestrator } from '../recovery-orchestrator'
import { SessionRecoveryManager, setForTesting } from '../session-recovery'
import { AdapterHealthMonitor } from '../adapter-health-monitor'
import type { AdapterRegistry } from '../adapter-registry'
import type { SessionRouter } from '../session-router'
import type { AgentSessionConfig } from '@shared/types'

function makeAdapter(name: string, opts: { installed?: boolean } = {}): any {
  return {
    name,
    checkInstalled: vi.fn(async () => opts.installed ?? true),
    startSession: vi.fn(),
    sendCommand: vi.fn(),
    terminateSession: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    onOutput: vi.fn(),
    getProcessCount: () => 0,
  }
}

function makeRegistry(adapters: any[]): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.name, a]))
  return {
    get: vi.fn((name: string) => map.get(name)),
    list: vi.fn(() => Array.from(map.values())),
    register: vi.fn(),
    checkAllInstalled: vi.fn(),
  } as unknown as AdapterRegistry
}

const sampleSessionConfig = (overrides?: Partial<AgentSessionConfig>): AgentSessionConfig => ({
  workingDirectory: '/project',
  allowedFiles: [],
  forbiddenFiles: [],
  invariantRules: [],
  upstreamContext: '',
  downstreamContext: '',
  nodeTitle: 'Test',
  acceptanceCriteria: [],
  ...overrides,
})

const baseSessionState = (overrides?: Partial<any>): any => ({
  config: sampleSessionConfig(),
  broadcastName: 'claude-code',
  adapterName: 'claude-code',
  startTime: Date.now(),
  lastCommandType: 'implement',
  ...overrides,
})

describe('RecoveryOrchestrator', () => {
  let healthMonitor: AdapterHealthMonitor
  let sessionRouter: SessionRouter
  let sessionStates: Map<string, any>
  let sessionBroadcastNames: Map<string, string>
  let startSessionFn: ReturnType<typeof vi.fn>
  let sendCommandFn: ReturnType<typeof vi.fn>
  let recovery: SessionRecoveryManager

  beforeEach(() => {
    setForTesting(new SessionRecoveryManager())
    healthMonitor = new AdapterHealthMonitor()
    sessionRouter = {
      bind: vi.fn(),
      unbind: vi.fn(),
      resolve: vi.fn(() => undefined),
      getActiveSessionIds: vi.fn(() => []),
    } as unknown as SessionRouter
    sessionStates = new Map()
    sessionBroadcastNames = new Map()
    startSessionFn = vi.fn()
    sendCommandFn = vi.fn()
    recovery = new SessionRecoveryManager()
  })

  afterEach(() => {
    setForTesting(null)
  })

  function makeOrchestrator(adapterList: any[] = [], sessionRecovery: SessionRecoveryManager = recovery): RecoveryOrchestrator {
    return new RecoveryOrchestrator(
      makeRegistry(adapterList),
      healthMonitor,
      sessionRouter,
      sessionStates,
      sessionBroadcastNames,
      startSessionFn as any,
      sendCommandFn as any,
      sessionRecovery,
    )
  }

  describe('handleSessionExit', () => {
    it('returns "none" for normal exits 137/143 (when reason is not timeout)', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState()
      const result = await orch.handleSessionExit('s1', 137, 'crash', state, [])
      expect(result).toBe('none')
    })

    it('returns "none" for exit code 126 (mark adapter unavailable)', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState()
      const result = await orch.handleSessionExit('s1', 126, 'crash', state, [])
      expect(result).toBe('none')
    })

    it('returns "none" for exit code 127 (mark adapter unavailable)', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState()
      const result = await orch.handleSessionExit('s1', 127, 'crash', state, [])
      expect(result).toBe('none')
    })

    it('returns "none" for non-recoverable reason (success)', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState()
      const result = await orch.handleSessionExit('s1', 0, 'success', state, [])
      expect(result).toBe('none')
    })

    it('attempts recovery when reason is crash and exit code is normal', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState({ adapterName: 'claude-code' })
      const spy = vi.spyOn(recovery, 'attemptRecovery')
      await orch.handleSessionExit('s1', 1, 'crash', state, [])
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1',
        adapterName: 'claude-code',
      }))
    })

    it('attempts recovery for timeout reason even with exit code 137', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState({ adapterName: 'mcp' })
      const spy = vi.spyOn(recovery, 'attemptRecovery')
      await orch.handleSessionExit('s1', 137, 'timeout', state, [])
      expect(spy).toHaveBeenCalled()
    })

    it('returns "native" when strategy returns the same sessionId', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState({ adapterName: 'claude-code' })
      // claude-code strategy returns ctx.sessionId
      sessionStates.set('s1', state)
      sessionBroadcastNames.set('s1', 'claude-code')
      const result = await orch.handleSessionExit('s1', 1, 'crash', state, [])
      expect(result).toBe('native')
      expect(sessionRouter.bind).toHaveBeenCalledWith('s1', 'claude-code')
    })

    it('returns "replacement" when MCP recovery injects context and creates a new session', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState({ adapterName: 'mcp', lastCommand: { type: 'implement', description: 'go', targetNodeId: 'n1' } })
      // Inject pending context so attemptRecovery returns null but orchestrator hits the MCP path
      const orchestrator = orch as any
      orchestrator.sessionRecovery.setPendingContext('s1', '[prev context]')
      // startSessionFn returns a new session id
      startSessionFn.mockResolvedValueOnce({
        sessionId: 's2',
        adapterUsed: 'mcp',
        fallbackHistory: [],
      })
      sessionStates.set('s2', baseSessionState({ adapterName: 'mcp' }))
      // But first we need attemptRecovery to return null. The default mcp strategy returns null
      // when there is no lastMessages. Use a fake strategy that returns null.
      recovery.registerStrategy({
        adapterName: 'mcp',
        canResume: false,
        resume: async () => null,
      })
      const result = await orch.handleSessionExit('s1', 1, 'crash', state, [])
      expect(result).toBe('replacement')
      expect(startSessionFn).toHaveBeenCalledWith('mcp', expect.objectContaining({ contextSummary: '[prev context]' }))
    })

    it('returns "none" if MCP context injection recovery also fails (startSessionFn throws)', async () => {
      const orch = makeOrchestrator()
      const state = baseSessionState({ adapterName: 'mcp' })
      const orchestrator = orch as any
      orchestrator.sessionRecovery.setPendingContext('s1', '[prev context]')
      recovery.registerStrategy({
        adapterName: 'mcp',
        canResume: false,
        resume: async () => null,
      })
      startSessionFn.mockRejectedValueOnce(new Error('spawn failed'))
      const result = await orch.handleSessionExit('s1', 1, 'crash', state, [])
      expect(result).toBe('none')
    })
  })

  describe('startFallbackRecoveryCheck', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('clears the timer when the preferred adapter becomes healthy', async () => {
      const adapter = makeAdapter('claude-code')
      const orch = makeOrchestrator([adapter])
      // Pre-record the adapter as healthy (single success + good response time)
      healthMonitor.recordCall('claude-code', true, 100, undefined)
      expect(healthMonitor.getHealth('claude-code')?.status).toBe('healthy')
      orch.startFallbackRecoveryCheck('claude-code', { interval: 1000, timeoutMs: 60_000 })
      expect(orch.fallbackRecoveryTimerMap.size).toBe(1)
      // First tick: probe and find adapter healthy → cleanup
      await vi.advanceTimersByTimeAsync(1000)
      expect(orch.fallbackRecoveryTimerMap.size).toBe(0)
    })

    it('does not create a duplicate timer if called twice for the same adapter', () => {
      const orch = makeOrchestrator([])
      orch.startFallbackRecoveryCheck('claude-code', { interval: 1000, timeoutMs: 60_000 })
      orch.startFallbackRecoveryCheck('claude-code', { interval: 1000, timeoutMs: 60_000 })
      expect(orch.fallbackRecoveryTimerMap.size).toBe(1)
    })

    it('clears the timer after the timeout fires', async () => {
      const orch = makeOrchestrator([])
      orch.startFallbackRecoveryCheck('claude-code', { interval: 1000, timeoutMs: 5000 })
      await vi.advanceTimersByTimeAsync(5500)
      expect(orch.fallbackRecoveryTimerMap.size).toBe(0)
    })
  })

  describe('startRecoveryCheck', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('records a successful check and clears the interval when the adapter is installed', async () => {
      const adapter = makeAdapter('claude-code')
      const orch = makeOrchestrator([adapter])
      orch.startRecoveryCheck('claude-code')
      expect(orch.recoveryCheckMap.size).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(orch.recoveryCheckMap.size).toBe(0)
      // Health monitor should have a recordCall(adapter, true, 0, 'recovery-check')
      const health = healthMonitor.getHealth('claude-code')
      expect(health).toBeDefined()
      expect(health!.metrics.successCalls).toBe(1)
    })

    it('does not create a duplicate interval for the same adapter', () => {
      const orch = makeOrchestrator([])
      orch.startRecoveryCheck('claude-code')
      orch.startRecoveryCheck('claude-code')
      expect(orch.recoveryCheckMap.size).toBe(1)
    })
  })

  describe('destroy', () => {
    it('clears all timers on destroy', () => {
      vi.useFakeTimers()
      const orch = makeOrchestrator([])
      orch.startFallbackRecoveryCheck('claude-code', { interval: 1000, timeoutMs: 60_000 })
      orch.startRecoveryCheck('claude-code')
      expect(orch.fallbackRecoveryTimerMap.size).toBe(1)
      expect(orch.recoveryCheckMap.size).toBe(1)
      orch.destroy()
      expect(orch.fallbackRecoveryTimerMap.size).toBe(0)
      expect(orch.recoveryCheckMap.size).toBe(0)
      vi.useRealTimers()
    })
  })

  describe('sessionRecoveryManager getter', () => {
    it('exposes the session recovery manager for direct test access', () => {
      const orch = makeOrchestrator()
      expect(orch.sessionRecoveryManager).toBe(recovery)
    })
  })
})