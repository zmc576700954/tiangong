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
import { withSpan } from '../telemetry'
import { SpanKind, type Span } from '@opentelemetry/api'
import os from 'node:os'

import { SessionLifecycleManager } from './session-lifecycle-manager'
import { ContextAssembler } from './context-assembler'
import { ContextCompactor } from './context-compactor'
import { AgentHealthHousekeeper, type MemoryStats } from './health-monitor-helpers'
import { PhaseBHandler } from './phase-b-handler'
import { FallbackRouter, type ResolvedAdapterSession } from './fallback-router'
import { RecoveryOrchestrator } from './recovery-orchestrator'
import { PromptFormatter } from './prompt-formatter'
import type { SessionState } from './types'
import { MemoryStore } from '../memory'

const logger = createLogger('AgentManager')

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
  private promptFormatter: PromptFormatter
  private fallbackRouter: FallbackRouter
  private recoveryOrchestrator: RecoveryOrchestrator

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
  /** Adapter health monitor — kept on AgentManager; tests reference it directly. */
  private healthMonitor = new AdapterHealthMonitor()
  /** Prompt quality feedback ring (consumed by PromptFormatter + PhaseBHandler). */
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

    // 2) PromptFormatter — prompt 片段格式化 + 最优 token 预算
    //    惰性取 MemoryStore：AgentManager 在 DB 初始化前构造，不能提前取实例。
    this.promptFormatter = new PromptFormatter(() => this.memoryStore, this.promptOutcomeLog)

    // 3) ContextAssembler — context resolution + prompt assembly
    this.assembler = new ContextAssembler(this.promptFormatter)

    // 4) ContextCompactor — context compaction orchestration
    this.compactor = new ContextCompactor(registry, broadcaster, this.lifecycle)
    // Bridge: compactor needs to find sessions seeded into manager.sessionStates
    this.compactor.setSessionStateLookup((id) => this.sessionStates.get(id))

    // 5) PhaseBHandler — post-cleanup memory pipeline + completion callback
    this.phaseB = new PhaseBHandler({
      lifecycle: this.lifecycle,
      promptOutcomeLog: this.promptOutcomeLog,
      sessionRecovery: this.sessionRecoveryInstance,
    })

    // 6) RecoveryOrchestrator — 会话恢复决策 + 恢复探测定时器
    this.recoveryOrchestrator = new RecoveryOrchestrator(
      registry,
      this.healthMonitor,
      router,
      this.sessionStates,
      undefined,
      // 闭包注入 startSessionFn / sendCommandFn，避免循环依赖
      this.startSession.bind(this),
      this.sendCommand.bind(this),
      this.sessionRecoveryInstance,
    )

    // 7) FallbackRouter — 回退链路由（去重 / 健康度优先 / 连续超时计数）
    this.fallbackRouter = new FallbackRouter(
      registry,
      this.healthMonitor,
      // 命中 unhealthy 时启动周期性探测
      (adapterName) => this.recoveryOrchestrator.startRecoveryCheck(adapterName),
    )

    // 8) Housekeeper — periodic health check + memory pressure
    this.housekeeper = new AgentHealthHousekeeper({
      registry,
      healthMonitor: this.healthMonitor,
      lifecycle: this.lifecycle,
      getMemoryStore: () => this.memoryStore,
      maxSessions: this.MAX_SESSIONS,
      getMemoryStats: () => this.getMemoryStats(),
      terminateSession: (id, reason) => this.terminateSession(id, reason),
      startRecoveryCheck: (adapterName) => this.recoveryOrchestrator.startRecoveryCheck(adapterName),
      startFallbackRecoveryCheck: (preferredAdapter, intervalMs = 60_000) =>
        this.recoveryOrchestrator.startFallbackRecoveryCheck(preferredAdapter, { interval: intervalMs }),
    })

    // 9) Lifecycle callbacks: tie recovery / completion / turn-complete / status into lifecycle
    this.lifecycle.setCallbacks({
      onTurnComplete: (sessionId) => {
        const state = this.sessionStates.get(sessionId)
        if (!state) return
        this.sessionRecoveryInstance.reset(state.originSessionId ?? sessionId)
      },
      onSessionCleanedUp: (sessionId, outcome) => {
        // 清理完成 → 同步本层的镜像，并按结果决定是否清零恢复重试计数。
        // 正常收尾（success）说明这条 lineage 已经跑通，重试计数应当归零；
        // 异常退出必须保留计数，否则恢复会无限循环。
        const state = this.sessionStates.get(sessionId)
        this.mirrorEnd(sessionId)
        if (outcome === 'success') {
          this.sessionRecoveryInstance.reset(state?.originSessionId ?? sessionId)
        }
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
    return withSpan(
      'bizgraph.agent.start',
      async (span) => {
        span.setAttribute('adapter.requested', adapterName ?? 'default')
        if (config.nodeId) span.setAttribute('node.id', config.nodeId)
        if (config.threadId) span.setAttribute('thread.id', config.threadId)
        if (config.parentSessionId) span.setAttribute('parent.session.id', config.parentSessionId)
        span.setAttribute('session.allowed_files_count', config.allowedFiles?.length ?? 0)
        return this._startSessionInternal(adapterName, config, span)
      },
      { kind: SpanKind.INTERNAL },
    )
  }

  private async _startSessionInternal(
    adapterName: string | null,
    config: AgentSessionConfig,
    span?: Span,
  ): Promise<StartSessionResult> {
    // 确定回退链：首选适配器 + 回退顺序（去重 + 健康度优先重排）
    const preferences = await this.loadAdapterPreferences()
    const primary = adapterName ?? preferences.defaultAdapter
    const uniqueChain = this.fallbackRouter.buildChain(
      primary,
      preferences.fallbackOrder,
      preferences.forceAdapter,
    )

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
      logger.error(`Maximum concurrent agent processes exceeded, cannot create new session`)
      throw new AgentError('Maximum concurrent agent processes exceeded', ErrorCode.AGENT_RESOURCE_EXHAUSTED)
    }

    const slotKey = `__reserved_${Date.now()}_${Math.random().toString(36).slice(2)}`
    this.reservedSlots.add(slotKey)

    let resolved: ResolvedAdapterSession
    try {
      resolved = await this.fallbackRouter.resolveSession(primary, uniqueChain, config, {
        onSessionStarted: async (candidate, candidateConfig, session) => {
          const adapter = this.registry.get(candidate)
          if (!adapter) {
            throw new AdapterError(`Adapter ${candidate} disappeared during startup`, candidate)
          }
          const isFallback = candidate !== primary

          const { broadcastName } = await this.lifecycle.start({
            candidate,
            adapter,
            session: { id: session.id, startTime: session.startTime },
            config: candidateConfig,
            isFallback,
            primaryAdapter: primary,
          })

          // Mirror state into manager.sessionStates for backward compat with tests
          const mirroredState: SessionState = {
            config: candidateConfig,
            broadcastName,
            adapterName: candidate,
            startTime: session.startTime,
            sandbox: this.lifecycle.getSandbox(session.id),
            threadId: candidateConfig.threadId,
            parentSessionId: candidateConfig.parentSessionId,
            swarmTaskId: candidateConfig.swarmTaskId,
          }
          this.mirrorStart(session.id, mirroredState)

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

          if (candidateConfig.nodeId) {
            this.statusChangeCallback?.(session.id, candidateConfig.nodeId, 'developing')
          }

          // placeholder → developing auto-advance (per-node-type validated via NodeRepository)
          if (candidateConfig.nodeId && candidateConfig.commandType === 'implement') {
            try {
              const db = getClient()
              const { NodeRepository } = await import('../repositories/node-repository')
              const nodeRepo = new NodeRepository(db)
              const current = nodeRepo.findById(candidateConfig.nodeId)
              if (current && current.status === 'placeholder') {
                const updated = nodeRepo.update(candidateConfig.nodeId, { status: 'developing' })
                if (updated.status === 'developing') {
                  this.nodeStatusChangeCallback?.(candidateConfig.nodeId, 'placeholder', 'developing')
                }
              }
            } catch (err) {
              logger.warn(`Failed to auto-advance placeholder node ${candidateConfig.nodeId}:`, err)
            }
          }

          // Emit session-started event for renderer IPC
          if (this.sessionStartedCallback && candidateConfig.threadId) {
            this.sessionStartedCallback(candidateConfig.threadId, session.id)
          }
        },
      })
    } finally {
      // Release reserved slot — real session is registered (or every candidate failed)
      this.reservedSlots.delete(slotKey)
    }

    if (span) {
      span.setAttribute('adapter.used', resolved.adapterUsed)
      span.setAttribute('session.id', resolved.session.id)
      span.setAttribute('fallback.used', resolved.isFallback)
    }

    return {
      sessionId: resolved.session.id,
      fallback: resolved.isFallback || undefined,
      adapterUsed: resolved.adapterUsed,
      fallbackHistory: resolved.fallbackHistory,
    }
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
    return withSpan(
      'bizgraph.agent.command',
      async (span) => {
        span.setAttribute('session.id', sessionId)
        span.setAttribute('command.type', typeof command === 'string' ? 'text' : command.type)
        if (typeof command !== 'string' && command.type) {
          // 不写 prompt 内容（避免 token-cache 污染 + PII 泄漏）
          // 只记录元数据：type / id
          if ((command as { id?: string }).id) {
            span.setAttribute('command.id', (command as { id?: string }).id!)
          }
        }
        // 记录指令类型，供 terminateSession 中的记忆提取器使用
        // 注意：lastCommandType 仅反映"最后一次"send 的类型，对并发场景做不到精确归属；
        //       此处保持原语义但用 try/catch + CAS 回退：仅当 lastCommandType 仍等于
        //       本次设置的值时才回退到 prev，避免覆盖后续 send 已写入的新值。
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
          // 发送失败时回退到之前的 commandType，避免污染后续记忆归类。
          // CAS：仅当 lastCommandType 仍是本次写入的值时才回退；否则保留后续 send 的更新。
          if (state && state.lastCommandType === command.type) {
            state.lastCommandType = prevCommandType
          }
          throw err
        }
      },
      { kind: SpanKind.INTERNAL },
    )
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
    return this.promptFormatter.getOptimalPromptBudget(commandType)
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
    return this.recoveryOrchestrator.recoveryCheckMap
  }

  /** Backward-compat getter for tests: consecutive adapter timeout counters. */
  get adapterTimeoutCounts(): Map<string, number> {
    return this.fallbackRouter.getTimeoutCounts()
  }

  /** Backward-compat getter for tests: in-flight compact promises. */
  get compactInflight(): Map<string, Promise<CompactResult>> {
    return this.compactor.inflightMap
  }

  /** Backward-compat: delegate startRecoveryCheck to the recovery orchestrator. */
  startRecoveryCheck(adapterName: string): void {
    this.recoveryOrchestrator.startRecoveryCheck(adapterName)
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
    return this.recoveryOrchestrator.handleSessionExit(sessionId, exitCode, reason, state, outputs)
  }

  destroy(): void {
    // Stop health check + cleanup timers
    this.housekeeper.stop()

    // Stop recovery probe timers (owned by the recovery orchestrator)
    this.recoveryOrchestrator.destroy()

    // Detach lifecycle adapters + clear state
    this.lifecycle.destroy()

    // Stop TTL check
    this.router.stopTtlCheck()

    // Clear local mirrors
    this.sessionStates.clear()
    this.sessionOutputBuffers.clear()
    this.sessionOutputListenerIndex.clear()
    this.reservedSlots.clear()
    this.fallbackRouter.getTimeoutCounts().clear()

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