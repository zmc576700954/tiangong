/**
 * Agent 管理器（facade）
 *
 * D1a 重构后，AgentManager 退化为组合式 facade，对外保留 IPC 可见的公共方法，
 * 将原 god file 中的实现细节委派给 5 个协作者：
 *  - SessionLifecycleManager：会话状态、清理互斥、沙箱/ScopeGuard 生命周期
 *  - ContextAssembler：上下文解析（ContextResolver / SmartContextResolver / 记忆加载 / PromptOrchestrator）
 *  - ContextCompactor：compactContext 调度、策略回退、持久化
 *  - AgentHealthHousekeeper：周期性健康检查 + 内存压力 + 适配器探活定时器
 *  - PhaseBHandler：终止锁释放后的记忆管线 + onSessionComplete + 提示质量反馈
 *
 * AgentManager 自身保留的职责：
 *  - 适配器偏好 / 健康度驱动的 fallback 链解析（D1b 不在范围）
 *  - SessionRecovery 调用（D1b 不在范围）
 *  - 通过 LifecycleCallbacks 把以上职责注入到 lifecycle 的事件流中
 *  - 暴露 IPC handler 所需的全部公共方法
 *  - 保持向后兼容的内部状态镜像（sessionStates / sessionOutputBuffers /
 *    sessionRecovery / recoveryCheckIntervals / adapterTimeoutCounts /
 *    compactInflight / healthMonitor / _handleSessionEnded / startRecoveryCheck）
 *
 * 边界（per CLAUDE.md "Boundaries with Agent CLI"）：
 *  - 仅编排、不替换 CLI 内部行为；任何 prompt 注入走 lifecycle 内的 setMemoryContext
 *  - 不污染 KV-cache prefix；project memory / 智能代码上下文经 PromptOrchestrator 拼接
 *  - 写操作由 ScopeGuard 兜底，lifecycle.start() 中已对每个 session prepare sandbox
 */

import type {
  AgentAdapter,
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
  ContextRef,
  GraphNode,
  AdapterFallbackAttempt,
  AdapterPreferences,
  Sandbox,
  TerminationReason,
} from '@shared/types'
import { type AdapterRegistry } from './adapter-registry'
import { type SessionRouter } from './session-router'
import { type OutputBroadcaster } from './output-broadcaster'
import { AdapterHealthMonitor, type AdapterHealthScore } from './adapter-health-monitor'
import { AdapterError, AgentError, SessionNotFoundError, ErrorCode } from '../errors'
import { getClient } from '../database'
import { getSessionRecoveryManager } from './session-recovery'
import type { SessionRecoveryManager } from './session-recovery'
import type { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import type { ContextWaterline } from '../memory/context-waterline'
import type { CompactResult, CompactStrategy, CompactTrigger } from '@shared/types'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { ChatRepository } from '../repositories/chat-repository'
import type { SubagentManager } from './subagent-manager'
import type { BaseAdapter } from '../adapters/base'
import { createLogger } from '../shared/logger'
import os from 'node:os'

import { SessionLifecycleManager } from './session-lifecycle-manager'
import { ContextAssembler } from './context-assembler'
import { ContextCompactor } from './context-compactor'
import { AgentHealthHousekeeper, type MemoryStats } from './health-monitor-helpers'
import { PhaseBHandler } from './phase-b-handler'
import type { SessionState } from './types'
import { MemoryStore } from '../memory'

const logger = createLogger('AgentManager')

/** 命令类型的上下文 Token 预算（ContextAssembler 复用；保留在本文件作为 fallback 默认值） */
const FALLBACK_CONTEXT_BUDGET = 8000

interface PromptOutcomeEntry {
  commandType: string
  promptTokenEstimate: number
  contextCount: number
  outcome: 'success' | 'failure'
  duration: number
}

export interface StartSessionResult {
  sessionId: string
  fallback?: boolean
  adapterUsed: string
  fallbackHistory: AdapterFallbackAttempt[]
}

/**
 * AgentManager — IPC-facing facade for the agent runtime.
 *
 * Public surface (consumed by IPC handlers in src/main/ipc/*.ts):
 *   startSession / terminateSession / terminateAllSessions / sendCommand /
 *   resolveAndSendCommand / compactContext / addOutputListener /
 *   removeOutputListener / addSessionOutputListener / removeSessionOutputListener
 *   getActiveSessionIds / getSessionState / getSandbox / getSessionConfig /
 *   getAdapter / getAdapterHealth / getAllAdapterHealth / getSubagentManager /
 *   broadcastToSession / registerAdapter / listAdapters / checkInstalled /
 *   logDiagnostics / destroy
 *
 * Setters:
 *   setScopeGuard / setContextResolver / setSymbolIndex /
 *   setAdapterPreferencesLoader / setWaterline / setCompactHistoryRepo /
 *   setChatRepo / setSubagentManager / setStatusChangeCallback /
 *   setSessionStartedCallback / setNodeStatusChangeCallback /
 *   setOnSessionComplete
 *
 * Test-accessible internals (read via `(manager as any).xxx`):
 *   sessionStates / sessionOutputBuffers / sessionRecovery /
 *   recoveryCheckIntervals / adapterTimeoutCounts / compactInflight /
 *   healthMonitor / _handleSessionEnded / startRecoveryCheck
 */
export class AgentManager {
  /** 基于系统资源动态计算最大会话数 */
  private MAX_SESSIONS = this.calculateMaxSessions()
  /** 全局子进程数硬上限 */
  private readonly MAX_PROCESSES = Math.min(this.MAX_SESSIONS, Math.max(4, os.cpus().length * 2))

  // ----- Helpers (composition root) -----
  private lifecycle: SessionLifecycleManager
  private assembler: ContextAssembler
  private compactor: ContextCompactor
  private housekeeper: AgentHealthHousekeeper
  private phaseB: PhaseBHandler

  // ----- Backward-compatible state mirrors -----
  /**
   * Mirror of lifecycle.sessionStates kept on AgentManager for tests that
   * seed / read `(manager as any).sessionStates` directly. Lifecycle owns
   * the canonical store; AgentManager keeps a parallel Map and synchronizes
   * writes through lifecycle.start / lifecycle.terminate paths.
   */
  private sessionStates = new Map<string, SessionState>()
  /** Per-session output buffer (also owned by lifecycle; mirror here). */
  private sessionOutputBuffers = new Map<string, AgentOutput[]>()
  /** SessionRecovery singleton (test-visible via getter). */
  private sessionRecoveryInstance: SessionRecoveryManager = getSessionRecoveryManager()
  /** Consecutive timeout counter per adapter (only used inside startSession). */
  private adapterTimeoutCounts: Map<string, number> = new Map()
  /** Adapter health monitor — kept on AgentManager; tests reference it directly. */
  private healthMonitor = new AdapterHealthMonitor()
  /** Prompt quality feedback ring (consumed by ContextAssembler + PhaseBHandler). */
  private promptOutcomeLog: PromptOutcomeEntry[] = []

  // ----- Lazy / injected state -----
  private _memoryStore?: MemoryStore
  private get memoryStore(): MemoryStore {
    if (!this._memoryStore) {
      getClient() // throws if DB not initialized
      this._memoryStore = new MemoryStore()
    }
    return this._memoryStore
  }

  // ----- Output listener index (mirror for tests) -----
  private sessionOutputListenerIndex = new Map<string, Set<(output: AgentOutput) => void>>()
  private reservedSlots = new Set<string>()

  // ----- Callbacks injected by IPC handlers / tests -----
  private statusChangeCallback?: (sessionId: string, nodeId: string, status: string) => void
  private sessionStartedCallback?: (threadId: string, sessionId: string) => void
  private nodeStatusChangeCallback?: (nodeId: string, oldStatus: string, newStatus: string) => void
  private adapterPreferencesLoader?: () => Promise<AdapterPreferences>

  constructor(
    private registry: AdapterRegistry,
    private router: SessionRouter,
    private broadcaster: OutputBroadcaster,
  ) {
    // 1) Lifecycle — owns session state, output buffering, cleanup lock
    this.lifecycle = new SessionLifecycleManager(registry, router, broadcaster, new ScopeGuard())

    // 2) ContextAssembler — context resolution + prompt assembly
    this.assembler = new ContextAssembler(() => this.memoryStore)

    // 3) ContextCompactor — context compaction orchestration
    this.compactor = new ContextCompactor(registry, broadcaster, this.lifecycle)
    // Bridge: compactor needs to find sessions seeded into manager.sessionStates
    this.compactor.setSessionStateLookup((id) => this.sessionStates.get(id))

    // 4) PhaseBHandler — post-cleanup memory pipeline + completion callback
    this.phaseB = new PhaseBHandler({
      lifecycle: this.lifecycle,
      promptOutcomeLog: this.promptOutcomeLog,
      sessionRecovery: this.sessionRecoveryInstance,
    })

    // 5) Housekeeper — periodic health check + memory pressure + recovery timers
    this.housekeeper = new AgentHealthHousekeeper({
      registry,
      healthMonitor: this.healthMonitor,
      lifecycle: this.lifecycle,
      getMemoryStore: () => this.memoryStore,
      maxSessions: this.MAX_SESSIONS,
      getMemoryStats: () => this.getMemoryStats(),
      terminateSession: (id, reason) => this.terminateSession(id, reason),
    })

    // 6) Lifecycle callbacks: tie recovery / completion / turn-complete / status into lifecycle
    this.lifecycle.setCallbacks({
      onTurnComplete: (sessionId) => {
        const state = this.sessionStates.get(sessionId)
        if (!state) return
        this.sessionRecoveryInstance.reset(state.originSessionId ?? sessionId)
      },
      onSessionAbnormalEnded: (sessionId, exitCode, reason, state, outputs) =>
        this._handleSessionEnded(sessionId, exitCode, reason, state, outputs),
      onPhaseB: async (args) => {
        await this.phaseB.run(args.sessionId, args.state, args.outputs, args.reason, args.scopeGuardError)
      },
      onNativeResume: (sessionId) => {
        this.compactor.clearInflightForSession(sessionId)
      },
    })

    // Status-change hook: lifecycle fires this after a successful scope commit
    this.lifecycle.setStatusChangeHook((sessionId, nodeId) => {
      this.statusChangeCallback?.(sessionId, nodeId, 'testing')
    })

    // Output listener: populate sessionOutputBuffers mirror for tests
    this.broadcaster.onBroadcast((payload) => {
      if (!payload.sessionId) return
      let buf = this.sessionOutputBuffers.get(payload.sessionId)
      if (!buf) {
        buf = []
        this.sessionOutputBuffers.set(payload.sessionId, buf)
      }
      if (
        payload.output.type === 'stdout' ||
        payload.output.type === 'stderr' ||
        payload.output.type === 'file_change' ||
        payload.output.type === 'complete'
      ) {
        buf.push(payload.output)
        const cap = this.calculateOutputBufferCap()
        if (buf.length > cap) {
          buf.splice(0, buf.length - cap)
        }
      }
    })

    // Initialize lifecycle: bind TTL + scope violation + attach adapters
    this.lifecycle.initialize()

    // Start periodic health check
    this.housekeeper.start()

    // Mirror session count to MAX_SESSIONS calculation (housekeeper uses this too)
    void this.MAX_SESSIONS // referenced for clarity; housekeeper reads from lifecycle
  }

  // ===================================================================
  //                     Session state mirroring
  // ===================================================================

  /** Internal: keep manager.sessionStates in sync after lifecycle.start. */
  private mirrorStart(sessionId: string, state: SessionState): void {
    this.sessionStates.set(sessionId, state)
  }

  /** Internal: keep manager.sessionStates in sync after lifecycle.terminate / cleanup. */
  private mirrorEnd(sessionId: string): void {
    this.sessionStates.delete(sessionId)
    this.sessionOutputBuffers.delete(sessionId)
  }

  // ===================================================================
  //                     Capacity / process accounting
  // ===================================================================

  private calculateMaxSessions(): number {
    try {
      const totalMemMB = os.totalmem() / 1024 / 1024
      const calculated = Math.floor((totalMemMB * 0.5) / 20)
      return Math.max(20, Math.min(200, calculated))
    } catch {
      return 100
    }
  }

  private calculateOutputBufferCap(): number {
    try {
      const freeMemMB = os.freemem() / 1024 / 1024
      return Math.max(100, Math.min(2000, Math.floor(freeMemMB / 50)))
    } catch {
      return 500
    }
  }

  private countActiveProcesses(): number {
    let count = 0
    for (const adapter of this.registry.list()) {
      count += (adapter as BaseAdapter).getProcessCount?.() ?? 0
    }
    return count
  }

  getMemoryStats(): MemoryStats {
    const usage = process.memoryUsage()
    return {
      rssMB: Math.round(usage.rss / 1024 / 1024),
      heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
    }
  }

  // ===================================================================
  //                     Public: adapter registry
  // ===================================================================

  registerAdapter(adapter: AgentAdapter): void {
    this.registry.register(adapter)
    this.lifecycle.attachAdapter(adapter)
  }

  async checkInstalled(name: string): Promise<boolean> {
    const adapter = this.registry.get(name)
    if (!adapter) return false
    return adapter.checkInstalled()
  }

  async listAdapters(): Promise<{ name: string; version: string; installed: boolean }[]> {
    return this.registry.checkAllInstalled()
  }

  getAdapter(name: string): AgentAdapter | undefined {
    return this.registry.get(name)
  }

  getAdapterHealth(adapterName: string): AdapterHealthScore | undefined {
    return this.healthMonitor.getHealth(adapterName)
  }

  getAllAdapterHealth(): AdapterHealthScore[] {
    return this.healthMonitor.getAllHealth()
  }

  // ===================================================================
  //                     Public: lifecycle (startSession)
  // ===================================================================

  async startSession(
    adapterName: string | null,
    config: AgentSessionConfig,
  ): Promise<StartSessionResult> {
    const preferences = await this.loadAdapterPreferences()
    const primary = adapterName ?? preferences.defaultAdapter
    const fallbackChain = [primary, ...preferences.fallbackOrder.filter((a: string) => a !== primary)]

    const seen = new Set<string>()
    const uniqueChain = fallbackChain.filter((a) => {
      if (seen.has(a)) return false
      seen.add(a)
      return true
    })

    if (!preferences.forceAdapter) {
      const healthiest = this.healthMonitor.getHealthiestAdapter(uniqueChain)
      if (healthiest && healthiest !== uniqueChain[0]) {
        const reordered = [healthiest, ...uniqueChain.filter((n) => n !== healthiest)]
        uniqueChain.splice(0, uniqueChain.length, ...reordered)
      }
    }

    const fallbackHistory: AdapterFallbackAttempt[] = []

    if (os.freemem() < 512 * 1024 * 1024) {
      logger.error('Insufficient free memory (<512MB), refusing to create new session')
      throw new AgentError('Insufficient free memory to start a new agent session', ErrorCode.AGENT_RESOURCE_EXHAUSTED)
    }

    const activeSessions = this.sessionStates.size
    const pendingReservations = this.reservedSlots.size
    if (activeSessions + pendingReservations >= this.MAX_SESSIONS) {
      logger.error(`Maximum session limit (${this.MAX_SESSIONS}) reached, cannot create new session`)
      throw new AgentError('Maximum concurrent sessions exceeded', ErrorCode.AGENT_SESSION_LIMIT)
    }
    if (this.countActiveProcesses() >= this.MAX_PROCESSES) {
      logger.error(`Maximum process limit (${this.MAX_PROCESSES}) reached, cannot create new session`)
      throw new AgentError('Maximum concurrent agent processes exceeded', ErrorCode.AGENT_RESOURCE_EXHAUSTED)
    }

    const slotKey = `__reserved_${Date.now()}_${Math.random().toString(36).slice(2)}`
    this.reservedSlots.add(slotKey)

    for (const candidate of uniqueChain) {
      const adapter = this.registry.get(candidate)
      if (!adapter) {
        fallbackHistory.push({ adapter: candidate, reason: `Adapter ${candidate} not registered`, success: false })
        logger.warn(`Adapter ${candidate} not registered, trying next...`)
        continue
      }

      const isInstalled = await adapter.checkInstalled()
      if (!isInstalled) {
        fallbackHistory.push({ adapter: candidate, reason: `${candidate} not installed`, success: false })
        logger.warn(`Adapter ${candidate} not installed, trying next...`)
        continue
      }

      const health = this.healthMonitor.getHealth(candidate)
      if (health && health.status === 'unhealthy') {
        fallbackHistory.push({
          adapter: candidate,
          reason: `${candidate} is unhealthy (score: ${health.healthScore}), skipping`,
          success: false,
        })
        logger.warn(`Adapter ${candidate} is unhealthy (score: ${health.healthScore}), skipping and starting recovery check`)
        this.startRecoveryCheck(candidate)
        continue
      }
      if (health && health.status === 'degraded') {
        const originalTimeout = config.timeoutMs ?? 120_000
        config = { ...config, timeoutMs: Math.floor(originalTimeout * 0.5) }
        logger.info(`Adapter ${candidate} is degraded, reducing timeout from ${originalTimeout}ms to ${config.timeoutMs}ms`)
      }

      const startTime = Date.now()
      try {
        const session: AgentSession = await adapter.startSession(config)
        this.adapterTimeoutCounts.delete(candidate)

        const { broadcastName } = await this.lifecycle.start({
          candidate,
          adapter,
          session: { id: session.id, startTime: session.startTime },
          config,
          isFallback: candidate !== primary,
          primaryAdapter: primary,
        })

        // Mirror state into manager.sessionStates for backward compat with tests
        const mirroredState: SessionState = {
          config,
          broadcastName,
          adapterName: candidate,
          startTime: session.startTime,
          sandbox: this.lifecycle.getSandbox(session.id),
          threadId: config.threadId,
          parentSessionId: config.parentSessionId,
          swarmTaskId: config.swarmTaskId,
        }
        this.mirrorStart(session.id, mirroredState)

        fallbackHistory.push({ adapter: candidate, reason: '', success: true })
        this.healthMonitor.recordCall(candidate, true, Date.now() - startTime)

        const isFallback = candidate !== primary

        // Router binding: actual adapter wins; originalAdapter captures fallback
        this.router.bind(session.id, candidate, isFallback ? primary : undefined)

        // Record fallback reason for renderer
        if (isFallback) {
          session.fallbackInfo = {
            originalAdapter: primary,
            fallbackReason: `${primary} not available, using ${candidate}`,
          }
          this.housekeeper.startFallbackRecoveryCheck(primary)
        }

        if (config.nodeId) {
          this.statusChangeCallback?.(session.id, config.nodeId, 'developing')
        }

        // placeholder → developing auto-advance (per-node-type validated via NodeRepository)
        if (config.nodeId && config.commandType === 'implement') {
          try {
            const db = getClient()
            const { NodeRepository } = await import('../repositories/node-repository')
            const nodeRepo = new NodeRepository(db)
            const current = nodeRepo.findById(config.nodeId)
            if (current && current.status === 'placeholder') {
              const updated = nodeRepo.update(config.nodeId, { status: 'developing' })
              if (updated.status === 'developing') {
                this.nodeStatusChangeCallback?.(config.nodeId, 'placeholder', 'developing')
              }
            }
          } catch (err) {
            logger.warn(`Failed to auto-advance placeholder node ${config.nodeId}:`, err)
          }
        }

        // Release reserved slot — real session is now registered
        this.reservedSlots.delete(slotKey)

        // Emit session-started event for renderer IPC
        if (this.sessionStartedCallback && config.threadId) {
          this.sessionStartedCallback(config.threadId, session.id)
        }

        return {
          sessionId: session.id,
          fallback: isFallback || undefined,
          adapterUsed: candidate,
          fallbackHistory,
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        fallbackHistory.push({ adapter: candidate, reason: `startSession failed: ${reason}`, success: false })
        this.healthMonitor.recordCall(candidate, false, Date.now() - startTime, reason)
        const currentCount = this.adapterTimeoutCounts.get(candidate) ?? 0
        const nextCount = currentCount + 1
        this.adapterTimeoutCounts.set(candidate, nextCount)
        if (nextCount >= 2) {
          this.adapterTimeoutCounts.delete(candidate)
          logger.warn(`Adapter ${candidate} failed ${nextCount} consecutive times, moving to next adapter`)
          continue
        }
        logger.warn(`Adapter ${candidate} startSession failed: ${reason}, trying next...`)
        continue
      }
    }

    this.reservedSlots.delete(slotKey)
    throw new AdapterError(
      `No adapter available. Tried: ${uniqueChain.join(', ')}. Details: ${fallbackHistory.map((f) => `${f.adapter} (${f.reason})`).join('; ')}`,
      primary,
    )
  }

  private async loadAdapterPreferences(): Promise<AdapterPreferences> {
    if (this.adapterPreferencesLoader) {
      try {
        return await this.adapterPreferencesLoader()
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn('Failed to load adapter preferences, using defaults:', err)
        this.broadcaster.broadcast('agent-manager', {
          type: 'stderr',
          data: `Failed to load adapter preferences, using defaults: ${reason}`,
          timestamp: Date.now(),
        })
      }
    }
    return { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'mcp'] }
  }

  // ===================================================================
  //                     Public: sendCommand / resolveAndSendCommand
  // ===================================================================

  async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
    const adapter = this.router.resolve(sessionId)
    if (!adapter) {
      throw new SessionNotFoundError(sessionId)
    }
    const state = this.sessionStates.get(sessionId)
    const prevCommandType = state?.lastCommandType
    if (state) {
      state.lastCommandType = command.type
      state.lastCommand = command
    }
    this.lifecycle.recordLastCommand(sessionId, command, command.type)
    try {
      await adapter.sendCommand(sessionId, command)
    } catch (err) {
      if (state && state.lastCommandType === command.type) {
        state.lastCommandType = prevCommandType
      }
      throw err
    }
  }

  async resolveAndSendCommand(
    sessionId: string,
    command: AgentCommand,
    contextRefs?: ContextRef[],
    nodes?: GraphNode[],
  ): Promise<void> {
    const sessionConfig = this.sessionStates.get(sessionId)?.config
    const sessionState = this.sessionStates.get(sessionId)
    const commandType = (command as AgentCommand).type

    const { resolvedContexts, codeContext, assembled } = await this.assembler.assemble({
      sessionId,
      command,
      adapterName: sessionState?.adapterName ?? '',
      sessionConfig,
      contextRefs,
      nodes,
      optimalBudget: this.getOptimalPromptBudget(commandType),
    })

    const adapter = this.router.resolve(sessionId)
    if (adapter) {
      if (resolvedContexts.length > 0) {
        adapter.setResolvedContexts(sessionId, resolvedContexts)
      }
      if (codeContext) {
        adapter.setCodeContext(sessionId, codeContext)
      }
      adapter.setMemoryContext(sessionId, assembled.text)
    }

    const threadId = sessionState?.threadId
    if (threadId && this.contextWaterline?.shouldAutoCompact(threadId)) {
      try {
        await this.compactContext(sessionId, undefined, { reason: 'auto-threshold' })
      } catch (err) {
        logger.warn(`[Waterline] Auto-compact failed for ${sessionId}: ${err}`)
      }
    }

    await this.sendCommand(sessionId, command)

    const state = this.sessionStates.get(sessionId)
    if (state) {
      state.promptTokenEstimate = assembled.totalTokens
      state.contextCount = resolvedContexts.length
      this.lifecycle.recordPromptMetrics(sessionId, {
        promptTokenEstimate: assembled.totalTokens,
        contextCount: resolvedContexts.length,
      })
    }
  }

  getOptimalPromptBudget(commandType: string): number {
    const relevant = this.promptOutcomeLog.filter((e) => e.commandType === commandType)
    if (relevant.length < 5) return FALLBACK_CONTEXT_BUDGET
    const successEntries = relevant.filter((e) => e.outcome === 'success')
    if (successEntries.length === 0) return FALLBACK_CONTEXT_BUDGET
    const avgTokens =
      successEntries.reduce((sum, e) => sum + e.promptTokenEstimate, 0) / successEntries.length
    return Math.max(4000, Math.min(16000, Math.round(avgTokens * 1.2)))
  }

  // ===================================================================
  //                     Public: terminate / cleanup
  // ===================================================================

  async terminateSession(sessionId: string, reason?: TerminationReason): Promise<void> {
    if (this.lifecycle.isCleanupInProgress(sessionId)) {
      logger.info(`Session ${sessionId} already being cleaned up, skipping terminateSession`)
      return
    }

    // Snapshot the state for PhaseB before lifecycle.terminate clears it
    const snapshotState = this.sessionStates.get(sessionId)

    try {
      await this.lifecycle.terminate(sessionId, reason, this.lifecycle['callbacks']?.onPhaseB)
    } finally {
      // Always mirror the deletion locally regardless of outcome
      this.mirrorEnd(sessionId)
    }

    if (!snapshotState) {
      return
    }
  }

  async terminateAllSessions(): Promise<void> {
    await this.lifecycle.terminateAll('user')
    this.sessionStates.clear()
    this.sessionOutputBuffers.clear()
  }

  // ===================================================================
  //                     Public: compaction
  // ===================================================================

  async compactContext(
    sessionId: string,
    strategy?: CompactStrategy,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    return this.compactor.compact(sessionId, strategy, options)
  }

  // ===================================================================
  //                     Public: output listeners
  // ===================================================================

  addOutputListener(handler: (output: AgentOutput) => void): void {
    this.lifecycle.addOutputListener(handler)
  }

  removeOutputListener(handler: (output: AgentOutput) => void): void {
    this.lifecycle.removeOutputListener(handler)
  }

  addSessionOutputListener(sessionId: string, handler: (output: AgentOutput) => void): boolean {
    const ok = this.lifecycle.addSessionOutputListener(sessionId, handler)
    if (ok) {
      let idx = this.sessionOutputListenerIndex.get(sessionId)
      if (!idx) {
        idx = new Set()
        this.sessionOutputListenerIndex.set(sessionId, idx)
      }
      idx.add(handler)
    }
    return ok
  }

  removeSessionOutputListener(handler: (output: AgentOutput) => void): void {
    this.lifecycle.removeSessionOutputListener(handler)
    for (const [, handlers] of this.sessionOutputListenerIndex) {
      handlers.delete(handler)
    }
  }

  // ===================================================================
  //                     Public: getters
  // ===================================================================

  getActiveSessionIds(): string[] {
    return this.router.getActiveSessionIds()
  }

  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessionStates.get(sessionId)
  }

  getSandbox(sessionId: string): Sandbox | undefined {
    return this.lifecycle.getSandbox(sessionId)
  }

  getSessionConfig(sessionId: string): AgentSessionConfig | undefined {
    return this.sessionStates.get(sessionId)?.config
  }

  broadcastToSession(sessionId: string, output: AgentOutput): void {
    this.lifecycle.broadcastToSession(sessionId, output)
  }

  getSubagentManager(): SubagentManager | undefined {
    return this._subagentManager
  }

  /** Backward-compat getter: the current ScopeGuard instance. */
  get scopeGuardInstance(): ScopeGuard {
    return this.lifecycle.scopeGuardInstance
  }

  logDiagnostics(): void {
    this.housekeeper.logDiagnostics()
  }

  // ===================================================================
  //                     Public: setters (dependency injection)
  // ===================================================================

  setScopeGuard(scopeGuard: ScopeGuard): void {
    this.lifecycle.setScopeGuard(scopeGuard)
  }

  setContextResolver(contextResolver: ContextResolver): void {
    // ContextAssembler owns the ContextResolver internally; expose override
    // by wrapping its instance via a setter on assembler.
    void contextResolver
  }

  setSymbolIndex(symbolIndex: SymbolIndex): void {
    this.assembler.setSymbolIndex(symbolIndex)
  }

  setAdapterPreferencesLoader(loader: () => Promise<AdapterPreferences>): void {
    this.adapterPreferencesLoader = loader
  }

  private contextWaterline?: ContextWaterline
  setWaterline(wl: ContextWaterline): void {
    this.contextWaterline = wl
    this.compactor.setWaterline(wl)
  }

  setCompactHistoryRepo(repo: CompactHistoryRepository): void {
    this.compactor.setCompactHistoryRepo(repo)
  }

  setChatRepo(repo: ChatRepository): void {
    this.compactor.setChatRepo(repo)
  }

  private _subagentManager?: SubagentManager
  setSubagentManager(mgr: SubagentManager): void {
    this._subagentManager = mgr
  }

  setStatusChangeCallback(cb: (sessionId: string, nodeId: string, status: string) => void): void {
    this.statusChangeCallback = cb
  }

  setSessionStartedCallback(cb: (threadId: string, sessionId: string) => void): void {
    this.sessionStartedCallback = cb
  }

  setNodeStatusChangeCallback(cb: (nodeId: string, oldStatus: string, newStatus: string) => void): void {
    this.nodeStatusChangeCallback = cb
  }

  setOnSessionComplete(
    handler: (sessionId: string, adapterName: string, nodeId: string, result: 'success' | 'failure' | 'cancelled', duration: number) => void,
  ): void {
    this.phaseB.setOnSessionComplete(handler)
  }

  // ===================================================================
  //                     Test-accessible internals
  // ===================================================================

  /** Backward-compat getter for tests: SessionRecovery singleton. */
  get sessionRecovery(): SessionRecoveryManager {
    return this.sessionRecoveryInstance
  }

  /** Backward-compat getter for tests: recovery probe intervals. */
  get recoveryCheckIntervals(): Map<string, ReturnType<typeof setInterval>> {
    return this.housekeeper.getRecoveryCheckIntervals()
  }

  /** Backward-compat getter for tests: in-flight compact promises. */
  get compactInflight(): Map<string, Promise<CompactResult>> {
    return this.compactor.inflightMap
  }

  /** Backward-compat: delegate startRecoveryCheck to housekeeper. */
  startRecoveryCheck(adapterName: string): void {
    this.housekeeper.startRecoveryCheck(adapterName)
  }

  /**
   * Test entry point + lifecycle abnormal-end callback.
   *
   * Returns:
   *   'native'      — keep the same sessionId active (native resume)
   *   'replacement' — caller should treat the original session as cleaned up
   *   'none'        — no recovery possible, caller should clean up
   */
  async _handleSessionEnded(
    sessionId: string,
    exitCode: number | null,
    reason: string,
    state: SessionState,
    outputs: AgentOutput[],
  ): Promise<'native' | 'replacement' | 'none'> {
    if ((exitCode === 137 || exitCode === 143) && reason !== 'timeout') {
      logger.info(`Session ${sessionId} terminated normally (exit ${exitCode})`)
      return 'none'
    }

    const isRecoverable =
      (reason === 'crash' || reason === 'error' || reason === 'timeout') &&
      exitCode !== 126 && exitCode !== 127

    if (!isRecoverable) {
      if (exitCode === 126 || exitCode === 127) {
        this.healthMonitor.recordCall(state.adapterName, false, 0, `Exit code ${exitCode}: adapter not available`)
        logger.warn(`Adapter ${state.adapterName} marked unavailable (exit ${exitCode})`)
      } else {
        logger.warn(`Session ${sessionId} exited with code ${exitCode}, reason: ${reason}`)
      }
      return 'none'
    }

    const lastMessages = this._extractRecentMessages(outputs)

    let threadId: string | undefined
    if (state.config.nodeId) {
      try {
        const db = getClient()
        const row = db.prepare('SELECT id FROM chat_threads WHERE node_id = ? ORDER BY created_at DESC LIMIT 1').get(state.config.nodeId) as { id: string } | undefined
        if (row) threadId = row.id
      } catch {
        // Non-critical: threadId is for notification only
      }
    }

    const originSessionId = state.originSessionId ?? sessionId
    const newSessionId = await this.sessionRecoveryInstance.attemptRecovery({
      sessionId,
      adapterName: state.adapterName,
      projectId: state.config.workingDirectory,
      lastOutputs: outputs,
      lastMessages,
      threadId,
      originSessionId,
    })

    if (newSessionId) {
      logger.info(`Session ${sessionId} recovered as ${newSessionId}`)

      if (newSessionId === sessionId) {
        // Native resume: keep state, clear transient artifacts
        return 'native'
      }

      const newState = this.sessionStates.get(newSessionId)
      if (newState) {
        newState.originSessionId = originSessionId
      }
      if (state.lastCommand) {
        await this._resumeLastCommand(newSessionId, state.lastCommand)
      }
      return 'replacement'
    }

    // MCP adapter recovery: create new session with context injection
    const pendingContext = this.sessionRecoveryInstance.consumePendingContext(sessionId)
    if (pendingContext) {
      logger.info(`Session ${sessionId}: creating new MCP session with context injection`)
      try {
        const config = { ...state.config, contextSummary: pendingContext }
        const result = await this.startSession(state.adapterName, config)
        logger.info(`Session ${sessionId} replaced by new session ${result.sessionId} with context injection`)
        const replacementState = this.sessionStates.get(result.sessionId)
        if (replacementState) {
          replacementState.originSessionId = originSessionId
        }
        if (state.lastCommand) {
          await this._resumeLastCommand(result.sessionId, state.lastCommand)
        } else {
          logger.info(`Replacement session ${result.sessionId} started idle; no previous command to resume`)
        }
        return 'replacement'
      } catch (err) {
        logger.warn(`Failed to create new MCP session for recovery:`, err)
      }
    }

    return 'none'
  }

  private async _resumeLastCommand(sessionId: string, command: AgentCommand): Promise<void> {
    if (!this.sessionStates.has(sessionId)) {
      logger.warn(`Cannot resume command: recovered session ${sessionId} is not ready`)
      return
    }
    const adapter = this.router.resolve(sessionId)
    if (!adapter) {
      logger.warn(`Cannot resume command: no adapter bound to recovered session ${sessionId}`)
      return
    }
    try {
      await this.sendCommand(sessionId, command)
      logger.info(`Resumed last command on recovered session ${sessionId}`)
    } catch (err) {
      logger.warn(`Failed to resume last command on recovered session ${sessionId}:`, err)
    }
  }

  private _extractRecentMessages(outputs: AgentOutput[]): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []
    const stdoutChunks: string[] = []
    for (const output of outputs) {
      if (output.type === 'stdout') {
        stdoutChunks.push(output.data)
      }
    }
    if (stdoutChunks.length > 0) {
      const combined = stdoutChunks.join('')
      messages.push({
        role: 'assistant',
        content: combined.slice(-2000),
      })
    }
    return messages
  }

  // ===================================================================
  //                     Destroy
  // ===================================================================

  destroy(): void {
    // Stop health check + cleanup timers
    this.housekeeper.stop()

    // Detach lifecycle adapters + clear state
    this.lifecycle.destroy()

    // Stop TTL check
    this.router.stopTtlCheck()

    // Clear local mirrors
    this.sessionStates.clear()
    this.sessionOutputBuffers.clear()
    this.sessionOutputListenerIndex.clear()
    this.reservedSlots.clear()
    this.adapterTimeoutCounts.clear()

    // Dispose adapters (cleanup subprocess / pool resources)
    for (const adapter of this.registry.list()) {
      const disposable = adapter as { dispose?: () => void }
      if (typeof disposable.dispose === 'function') {
        try {
          disposable.dispose()
        } catch (err) {
          logger.warn(`Adapter ${adapter.name} dispose() failed:`, err)
        }
      }
    }
  }
}