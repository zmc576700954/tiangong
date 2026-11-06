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
 *  - 仅编排、不替换 CLI 内部行为；任何 prompt 注入走 lifecycle 内的 setPromptContext
 *  - 不污染 KV-cache prefix；project memory / 智能代码上下文经 PromptOrchestrator 拼接
 *  - 写操作由 ScopeGuard 兜底，lifecycle.start() 中已对每个 session prepare sandbox
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentAdapter,
  AgentSessionConfig,
  AgentCommand,
  AgentCommandType,
  AgentOutput,
  ContextRef,
  GraphNode,
  AdapterFallbackAttempt,
  AdapterPreferences,
  AdapterUsageReport,
  Sandbox,
  TerminationReason,
} from '@shared/types'
import { isInternalAgentSessionId, isTrustedNativeSessionId } from '@shared/native-session-id'
import { type AdapterRegistry } from './adapter-registry'
import { type SessionRouter } from './session-router'
import type { AgentRuntime } from './runtime/runtime'
import type { AgentSessionRow } from './runtime/db/repository'
import { UsageLedger } from './runtime/cost/ledger'
import { SessionBusyError } from './runtime/errors'
import { ROOT_LOCK_CONTEXT, sessionLockKey } from './runtime/locks/session-lock'
import { getKernelBackendPolicy } from './runtime/feature-flags'
import { type OutputBroadcaster } from './output-broadcaster'
import { AdapterHealthMonitor, type AdapterHealthScore } from './adapter-health-monitor'
import { AdapterError, AgentError, SessionNotFoundError, SessionRestoreError, ErrorCode } from '../errors'
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
import type { SessionUsageView, GraphUsageView, UsageSummary } from '@shared/types/agent-runtime'
import { MemoryStore } from '../memory'

const logger = createLogger('AgentManager')

/** 空用量视图：totalRows=0 表示「无记录」，与真实 $0.00 行严格区分。 */
const EMPTY_USAGE_SUMMARY: UsageSummary = {
  totalRows: 0,
  knownCostMicros: 0,
  unknownCostRows: 0,
  unpricedRows: 0,
  providerRows: 0,
  estimatedRows: 0,
  unknownRows: 0,
  pricedRows: 0,
  missingPriceRows: 0,
  notReportedRows: 0,
  costStatusUnknownRows: 0,
  unknownTokenRows: 0,
  tokensReportedRows: 0,
  tokensNotReportedRows: 0,
  tokensReportedUnknownRows: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
}

/** 可恢复的会话状态：closed 表示会话已正常收尾，不能借恢复复活。 */
const RESTORABLE_SESSION_STATUSES: ReadonlySet<string> = new Set(['starting', 'active', 'idle', 'orphaned'])
/** turn 终态：这些 turn 只被读取，永不被恢复流程改写。 */
const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'orphaned'])

/** `agent_turns.input_json` 里恢复所需的字段（写入方见 AgentRuntime.runNode）。 */
interface RestoreTurnSnapshot {
  workingDirectory?: string
  nodeId?: string
  commandType?: string
}

/**
 * 新建会话前的内存判据。
 *
 * macOS 的 `os.freemem()` 只统计「完全空闲页」，不包含可回收的文件缓存，
 * 32GB 机器上常年只有几百 MB，绝对阈值会误伤真实用户。因此：
 *  - darwin：只保留 64MB 硬下限（低于此值才可能是真正的资源耗尽）；
 *  - 其他平台：按总内存 2% 计算，并以 128MB / 2GB 上下限 clamp。
 */
export function isMemoryInsufficientForNewSession(
  platform: NodeJS.Platform = process.platform,
  sample: { totalmem: number; freemem: number } = { totalmem: os.totalmem(), freemem: os.freemem() },
): boolean {
  const MB = 1024 * 1024
  if (platform === 'darwin') return sample.freemem < 64 * MB
  const threshold = Math.min(2048 * MB, Math.max(128 * MB, sample.totalmem * 0.02))
  return sample.freemem < threshold
}

function parseTurnSnapshot(raw: string): RestoreTurnSnapshot | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      workingDirectory: typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : undefined,
      nodeId: typeof parsed.nodeId === 'string' ? parsed.nodeId : undefined,
      commandType: typeof parsed.commandType === 'string' ? parsed.commandType : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * 用持久化行 + 最近 turn 快照重建 AgentSessionConfig。
 *
 * 注意：原始 `allowedFiles` / `forbiddenFiles` / 业务不变量没有落库，恢复时
 * 一律留空 —— 不伪造上一轮的写范围；写操作仍由审批通道逐次拦截。
 */
function buildRestoreConfig(
  row: AgentSessionRow,
  snapshot: RestoreTurnSnapshot | undefined,
  resumeSessionId: string,
): AgentSessionConfig {
  return {
    workingDirectory: snapshot?.workingDirectory ?? row.workspace_path ?? process.cwd(),
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: '',
    acceptanceCriteria: [],
    nodeId: row.node_id ?? snapshot?.nodeId ?? undefined,
    commandType: (snapshot?.commandType as AgentCommandType | undefined) ?? undefined,
    threadId: row.thread_id ?? undefined,
    resumeSessionId,
  }
}

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
  /** D2：可选的 M0 Runtime（未装配时旧路径行为不变） */
  private runtime: AgentRuntime | undefined

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
  /** 重启恢复：同一会话的重建任务去重（并发首写只重建一次）。 */
  private restoreInflight = new Map<string, Promise<AgentAdapter>>()
  /** 线程仓储：旧路径重启恢复时按 sessionId 反查后端绑定。 */
  private chatRepo: ChatRepository | undefined

  // ----- Lazy / injected state -----
  private _memoryStore?: MemoryStore
  private get memoryStore(): MemoryStore {
    if (!this._memoryStore) {
      getClient() // throws if DB not initialized
      this._memoryStore = new MemoryStore()
    }
    return this._memoryStore
  }

  /** M1 成本账本：DB 未初始化时降级为不记账（不崩会话）。 */
  private _usageLedger?: UsageLedger
  private get usageLedger(): UsageLedger | null {
    if (this._usageLedger) return this._usageLedger
    try {
      this._usageLedger = new UsageLedger(getClient())
    } catch {
      return null
    }
    return this._usageLedger
  }

  /**
   * M1：legacy 路径 usage 落库。
   * 归属：chat_threads.session_id → graph_id/node_id；归不上就如实标注
   * thread_not_bound，不瞎猜。记账失败只告警，不影响会话。
   */
  private recordAdapterUsage(adapterName: string, data: AdapterUsageReport): void {
    const ledger = this.usageLedger
    if (!ledger) return
    // 去重靠「单记账 owner」，不靠放宽 dedupe：kernel 正在为这个会话记账时，
    // 同一条适配器上报（以及 complete 时合成的 unknown）一律丢弃。
    // 触发条件：该会话由 kernel 派发（canUseKernelFor），适配器仍在 lifecycle 上
    // 透传 onUsage；key 分别是 kernel 的 `turn:<turnId>` 与 legacy 的
    // `legacy:<adapter>:<session>:<turnSeq>`，天然不会合并。
    if (this.runtime?.hasActiveTurn?.(data.sessionId)) {
      logger.debug(`[usage] legacy report ignored while kernel turn is accounting: ${adapterName} ${data.sessionId}`)
      return
    }
    // 归属查询是元数据补全，失败（DB 未就绪等）不应把整条用量丢掉；
    // 查不到就按 thread_not_bound 如实标注。
    const thread = this.lookupThread(data.sessionId)
    try {
      ledger.record({
        sessionId: data.sessionId,
        executor: adapterName,
        graphId: thread?.graphId ?? null,
        nodeId: thread?.nodeId ?? null,
        model: data.model ?? null,
        source: data.source ?? 'provider',
        inputTokens: data.source === 'unknown' ? null : data.inputTokens,
        outputTokens: data.outputTokens ?? null,
        cachedInputTokens: data.cachedInputTokens ?? null,
        cacheCreationInputTokens: data.cacheCreationInputTokens ?? null,
        attributionNote: thread
          ? data.source === 'unknown'
            ? 'backend_reports_no_usage'
            : null
          : 'thread_not_bound',
        dedupeKey: data.backendEventId
          ? `bev:${adapterName}:${data.backendEventId}`
          : data.turnKey
            ? `legacy:${data.turnKey}`
            : null,
      })
    } catch (err) {
      logger.warn('recordAdapterUsage failed (ledger write skipped):', err)
    }
  }

  /** chat_threads 归属查询：DB 未就绪时返回 null，由调用方决定降级方式（不抛）。 */
  private lookupThread(sessionId: string): { graphId: string | null; nodeId: string | null } | null {
    try {
      return (
        (getClient()
          .prepare('SELECT graph_id AS graphId, node_id AS nodeId FROM chat_threads WHERE session_id = ?')
          .get(sessionId) as { graphId: string | null; nodeId: string | null } | undefined) ?? null
      )
    } catch {
      return null
    }
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
      // 谱系根要落在 lifecycle 的 canonical state 上（崩溃回调从那里读），
      // 镜像表同步一份，供本层的恢复计数清理用。
      (sessionId, originSessionId) => this.setSessionOrigin(sessionId, originSessionId),
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
      onAdapterUsage: (adapterName, data) => {
        this.recordAdapterUsage(adapterName, data)
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

  /**
   * 记录恢复谱系的根 sessionId。
   *
   * 写入 lifecycle 的 canonical state（崩溃回调的唯一读取来源），
   * 并同步镜像表 —— 两处都要有，否则恢复重试计数要么永远不触发，
   * 要么永远不被清零。
   */
  private setSessionOrigin(sessionId: string, originSessionId: string): void {
    this.lifecycle.setOriginSessionId(sessionId, originSessionId)
    const mirrored = this.sessionStates.get(sessionId)
    if (mirrored) mirrored.originSessionId = originSessionId
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

  /** D2：装配 M0 Runtime 后，sendCommand 前置 per-session 串行锁。 */
  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime
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

    if (isMemoryInsufficientForNewSession()) {
      logger.error('Insufficient free memory for a new session (platform-aware threshold), refusing to create session')
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

  /**
   * Kernel 路径的 resolve：内存态 SessionRouter 是「本进程内启动过」的映射，
   * 进程重启后必然为空。此时从持久化状态（agent_sessions + 最近 turn 快照）
   * 重建会话句柄并重新绑定路由，而不是把 SessionNotFoundError 抛给 UI。
   */
  private async resolveKernelAdapter(sessionId: string): Promise<AgentAdapter> {
    const bound = this.tryResolveAdapter(sessionId)
    if (bound) return bound
    // 并发首写：同一个会话只允许一次重建，避免重复 lifecycle.start / 重复留痕。
    const inflight = this.restoreInflight.get(sessionId)
    if (inflight) return inflight
    const task = this.restorePersistedSession(sessionId)
    this.restoreInflight.set(sessionId, task)
    try {
      return await task
    } finally {
      this.restoreInflight.delete(sessionId)
    }
  }

  private tryResolveAdapter(sessionId: string): AgentAdapter | undefined {
    try {
      return this.router.resolve(sessionId)
    } catch (err) {
      if (err instanceof SessionNotFoundError) return undefined
      throw err
    }
  }

  /**
   * 旧路径的 resolve：`BIZGRAPH_AGENT_KERNEL=0` 重启后 SessionRouter 必然为空，
   * 这里从持久化数据恢复后端绑定，避免把整个回退变成「所有会话都打不开」。
   *
   * 恢复顺序：
   *  1. 同进程内仅路由条目丢失 → 用内存态重新绑定（可续接）；
   *  2. 有 `agent_sessions` 行 → 复用 kernel 的持久化重建（原生 id 可信则续接）；
   *  3. 只有 `chat_threads` 记录 → 旧路径从未持久化原生 id，明确告知不可续接；
   *  4. 完全没有持久化记录 → 真未知会话。
   */
  private async resolveLegacyAdapter(sessionId: string): Promise<AgentAdapter> {
    const bound = this.tryResolveAdapter(sessionId)
    if (bound) return bound
    const inflight = this.restoreInflight.get(sessionId)
    if (inflight) return inflight
    const task = this.restoreLegacySession(sessionId)
    this.restoreInflight.set(sessionId, task)
    try {
      return await task
    } finally {
      this.restoreInflight.delete(sessionId)
    }
  }

  private async restoreLegacySession(sessionId: string): Promise<AgentAdapter> {
    // 1) 同进程内路由条目被 TTL 清理：仍可沿用原适配器句柄，不重放、不新建。
    const state = this.sessionStates.get(sessionId)
    if (state?.adapterName) {
      const adapter = this.registry.get(state.adapterName)
      if (adapter) {
        this.router.bind(sessionId, state.adapterName)
        logger.info(`[legacy-restore] session=${sessionId} re-bound ${state.adapterName} from in-process state`)
        return adapter
      }
    }

    const repo = this.runtime?.repo
    if (!repo && !this.chatRepo) {
      // 没有任何持久化来源：保持旧语义（未知会话）。
      throw new SessionNotFoundError(sessionId)
    }

    // 2) 有 kernel 持久化行：复用同一套原生续接重建（旧路径不会因此产生 kernel 记录）。
    const row = repo?.getSession(sessionId)
    if (row) {
      logger.info(`[legacy-restore] session=${sessionId} found agent_sessions row (${row.executor}); trying native resume`)
      return this.restorePersistedSession(sessionId)
    }

    // 3) 只有 thread 记录：旧路径没有持久化原生会话 id，不能假装续上。
    const thread = this.chatRepo?.getThreadBySessionId(sessionId)
    if (!thread) {
      // 「这个会话 id 根本不存在」与「id 存在但续接条件不成立」是两种错误：
      // 前者报 AGENT_SESSION_NOT_FOUND（可读提示，不误导为适配器故障），
      // 后者才报 SessionRestoreError（原因 + 新建会话可继续）。
      throw new SessionNotFoundError(sessionId)
    }
    const adapter = this.registry.get(thread.adapter_name)
    const reason = !adapter
      ? `原会话使用的后端 ${thread.adapter_name} 当前不可用（线程记录仍在）`
      : `原会话不可续接：${thread.adapter_name} 的旧路径未持久化原生会话 ID，重启后无法恢复上下文`
    logger.warn(`[legacy-restore] session=${sessionId} unresumable: ${reason}`)
    throw new SessionRestoreError(sessionId, reason)
  }

  /** Kernel 恢复是否可用：需要 Runtime（持久化仓储），且该后端在 kernel 白名单内。 */
  private canUseKernelFor(adapterName: string): boolean {
    if (!this.runtime) return false
    return getKernelBackendPolicy(adapterName).kernel
  }

  /** 重启后用持久化表里的 executor 判断该会话是否应走 kernel。 */
  private persistedExecutorFor(sessionId: string): string | undefined {
    const repo = this.runtime?.repo
    if (!repo) return undefined
    return repo.getSession(sessionId)?.executor
  }

  /** 降级运行（UNSAFE 强制）时必须留痕，不能静默。 */
  private warnIfKernelDegraded(adapterName: string, sessionId: string): void {
    const policy = getKernelBackendPolicy(adapterName)
    if (!policy.degraded) return
    logger.warn(`[kernel-degraded] session=${sessionId} backend=${adapterName}: ${policy.reason}`)
  }

  /**
   * 从持久化状态重建会话句柄。数据来源：
   *  - `agent_sessions`：executor / thread_id / node_id / workspace_path / status
   *  - `agent_turns.input_json`（最近一条）：workingDirectory / nodeId / commandType
   *  - `agent_events` 最近 `run.started` 的 payload.backendSessionId：原生续接 id
   *
   * 边界：只 `UPDATE` 既有会话行（不 insert，不产生重复行）；只读 turn 快照
   * （永不改写 turn 状态，已终结 turn 不复活）；显式失效进程内会话级授权
   * （恢复后首次写重新弹窗）。
   */
  private async restorePersistedSession(sessionId: string): Promise<AgentAdapter> {
    const runtime = this.runtime
    const repo = runtime?.repo
    if (!runtime || !repo) {
      throw new SessionRestoreError(sessionId, 'Kernel Runtime 未装配，无法读取持久化会话状态')
    }
    const row = repo.getSession(sessionId)
    if (!row) {
      throw new SessionRestoreError(sessionId, '持久化表中没有该会话记录（可能已被清理）')
    }
    if (!RESTORABLE_SESSION_STATUSES.has(row.status)) {
      throw new SessionRestoreError(sessionId, `会话状态为 ${row.status}（已终结），不能继续使用`)
    }
    const adapter = this.registry.get(row.executor)
    if (!adapter) {
      throw new SessionRestoreError(sessionId, `原会话使用的适配器 ${row.executor} 当前不可用`)
    }
    if (typeof adapter.restoreSession !== 'function') {
      throw new SessionRestoreError(sessionId, `适配器 ${row.executor} 不支持从持久化状态重建会话`)
    }

    // 最近 turn 快照：只读取，用于重建工作目录 / 节点 / 指令类型。
    const turns = repo.listTurnsBySession(sessionId)
    const latestTurn = turns.length > 0 ? turns[turns.length - 1] : undefined
    const snapshot = latestTurn ? parseTurnSnapshot(latestTurn.input_json) : undefined

    // 上一轮尚未收口（崩溃残留在途 turn）：不自动重放，也不假装已续接。
    const pendingTurn = latestTurn && !TERMINAL_TURN_STATUSES.has(latestTurn.status) ? latestTurn : undefined
    if (pendingTurn) {
      this.recordRestoreNote(
        repo,
        sessionId,
        row,
        `restore blocked: turn ${pendingTurn.id} still ${pendingTurn.status} (crash residue, not replayed)`,
      )
      throw new SessionRestoreError(
        sessionId,
        `上一轮（${pendingTurn.id}）在崩溃前尚未结束，不能自动重放`,
      )
    }

    // 原生 resume id 只认可信来源：最近一次 `run.started` 的 payload.backendSessionId
    // （SDK 回报的 session_id / thread_id）。`agent_sessions.runtime_session_id` 是
    // 内部句柄 id（claude-<uuid>），绝不能当原生 id 用（P1-1）。
    const recordedNativeId = repo.getLatestBackendSessionId(sessionId)
    const internalOnlyId =
      !recordedNativeId && row.runtime_session_id ? row.runtime_session_id : undefined
    const rejectedInternalId =
      (typeof recordedNativeId === 'string' && !isTrustedNativeSessionId(recordedNativeId)) ||
      Boolean(internalOnlyId && isInternalAgentSessionId(internalOnlyId))
    const backendSessionId = isTrustedNativeSessionId(recordedNativeId) ? recordedNativeId : undefined
    const supportsNativeResume =
      typeof adapter.supportsNativeResume === 'function' && adapter.supportsNativeResume()
    if (!supportsNativeResume) {
      this.recordRestoreNote(
        repo,
        sessionId,
        row,
        `restore degraded: executor ${row.executor} has no native resume; conversation context cannot be continued (not pretending)`,
      )
      throw new SessionRestoreError(
        sessionId,
        `适配器 ${row.executor} 不支持原生续接，原对话上下文无法恢复`,
      )
    }
    if (!backendSessionId) {
      const shownId = recordedNativeId ?? internalOnlyId
      this.recordRestoreNote(
        repo,
        sessionId,
        row,
        rejectedInternalId
          ? `restore degraded: rejected internal session id "${shownId}" as native resume id (no run.started session_id)`
          : `restore degraded: no persisted backendSessionId for executor ${row.executor}; native resume impossible`,
      )
      throw new SessionRestoreError(
        sessionId,
        rejectedInternalId
          ? '记录到的是内部会话 id（不可作为原生 id），没有可续接的底层会话'
          : '没有找到可续接的底层会话 id（首轮可能未完成）',
      )
    }

    const config = buildRestoreConfig(row, snapshot, backendSessionId)
    adapter.restoreSession(sessionId, config)

    const startTime = row.created_at ?? Date.now()
    const { broadcastName } = await this.lifecycle.start({
      candidate: row.executor,
      adapter,
      session: { id: sessionId, startTime },
      config,
      isFallback: false,
      primaryAdapter: row.executor,
    })
    this.mirrorStart(sessionId, {
      config,
      broadcastName,
      adapterName: row.executor,
      startTime,
      sandbox: this.lifecycle.getSandbox(sessionId),
      threadId: row.thread_id ?? undefined,
    })
    this.router.bind(sessionId, row.executor)

    // 只对齐既有行：不新增 agent_sessions，重启重复恢复也不会产生重复行。
    repo.updateSessionRuntimeSessionId(sessionId, sessionId)
    repo.updateSessionStatus(sessionId, 'active')

    // 不继承会话级授权：即使是「同进程内路由条目被 TTL 清理」导致的恢复，
    // 旧 grant 也必须失效，下一次写操作重新弹窗。
    runtime.approvals.endSession(sessionId)

    this.recordRestoreNote(
      repo,
      sessionId,
      row,
      `restore: rebuilt handle from agent_sessions; resumeMode=native backendSessionId=${backendSessionId}; ` +
        'scope constraints are not persisted → every write still requires approval',
    )

    logger.info(`Restored persisted session ${sessionId} (${row.executor}) via native resume`)
    return adapter
  }

  /** 恢复过程的审计留痕；保留启动清扫原有 note，避免把上一段证据覆盖掉。 */
  private recordRestoreNote(
    repo: AgentRuntime['repo'],
    sessionId: string,
    row: { recovery_note: string | null },
    note: string,
  ): void {
    const merged = row.recovery_note ? `${row.recovery_note} | ${note}` : note
    repo.recordSessionRecovery(sessionId, { kills: 0, note: merged, clearProc: true, residualRisk: 'none' })
  }

  async sendCommand(
    sessionId: string,
    command: AgentCommand,
    options?: { contextAssembled?: boolean },
  ): Promise<void> {
    // 后端能力门控：只有白名单后端（当前 claude）默认走 kernel；
    // BIZGRAPH_AGENT_KERNEL=0 时全部回旧路径；UNSAFE 强制时打降级日志。
    if (this.runtime) {
      const bound = this.tryResolveAdapter(sessionId)
      const executorName = bound?.name ?? this.persistedExecutorFor(sessionId)
      if (executorName && this.canUseKernelFor(executorName)) {
        // 重启后 SessionRouter 为空 —— 先从持久化状态重建句柄，再走 Kernel。
        const adapter = bound ?? (await this.resolveKernelAdapter(sessionId))
        this.warnIfKernelDegraded(adapter.name, sessionId)
        if (this.runtime.getDriver(adapter.name)) {
          return this.sendCommandThroughKernel(sessionId, command, adapter, options)
        }
      }
    }

    // D2：M0 per-session 串行锁（fail-fast，不排队）。
    // 仅当 Runtime 已装配时生效；旧测试/旧路径不注入 runtime 时行为完全不变。
    if (!this.runtime) {
      return this.sendCommandInner(sessionId, command, options)
    }
    // P1-4：owner 必须是「一次派发」的唯一标识，不能是 sessionId。
    // 用 sessionId 会让同一会话的第二次 tryAcquire 被误判为可重入（实测 count=2）。
    const dispatchId = `dispatch:${randomUUID()}`
    const lock = this.runtime.locks.tryAcquire(sessionLockKey(sessionId), dispatchId, ROOT_LOCK_CONTEXT)
    if (!lock) throw new SessionBusyError(sessionId)
    try {
      return await this.sendCommandInner(sessionId, command, options)
    } finally {
      lock.release()
    }
  }

  private async sendCommandInner(
    sessionId: string,
    command: AgentCommand,
    options?: { contextAssembled?: boolean },
  ): Promise<void> {
    // 旧路径也要能扛住重启：Router 为空时从持久化数据恢复；不可续接则抛出
    // SessionRestoreError（UI 会显示「新建会话可继续」），而不是误导性的
    // 「适配器不可用」或直接崩溃。
    const adapter = await this.resolveLegacyAdapter(sessionId)
    if (!adapter) {
      throw new SessionNotFoundError(sessionId)
    }
    // 框架级不变量：任何投递给 Agent 的路径都必须携带 scope 约束与**当轮**上下文。
    // resolveAndSendCommand 已在调用前装配过 —— 标记跳过，避免重复装配覆盖它那份
    // 更完整的上下文（带 contextRefs 解析出的附加上下文）。
    if (!options?.contextAssembled) {
      await this.ensurePromptContext(sessionId, command, adapter)
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

  /**
   * A1：把「已装配上下文的一轮」交给 Kernel。RunNode 内部会重建 run/turn、
   * 分配事件序号、落库并按会话锁串行；AgentOutput 仍由适配器原样广播，
   * 因此渲染层的流式消息/工具时间线消费能力保持不变。
   */
  private async sendCommandThroughKernel(
    sessionId: string,
    command: AgentCommand,
    adapter: AgentAdapter,
    options?: { contextAssembled?: boolean },
  ): Promise<void> {
    if (!options?.contextAssembled) {
      await this.ensurePromptContext(sessionId, command, adapter)
    }
    return withSpan(
      'bizgraph.agent.command',
      async (span) => {
        span.setAttribute('session.id', sessionId)
        const commandType = command.type || 'implement'
        span.setAttribute('command.type', commandType)
        const commandId = (command as { id?: string }).id
        if (commandId) span.setAttribute('command.id', commandId)

        const state = this.sessionStates.get(sessionId)
        const prevCommandType = state?.lastCommandType
        if (state) {
          state.lastCommandType = commandType
          state.lastCommand = command
        }
        this.lifecycle.recordLastCommand(sessionId, command, commandType)

        try {
          const nodeId =
            command.targetNodeId ||
            state?.config.nodeId ||
            (state?.threadId ? `thread:${state.threadId}` : `session:${sessionId}`)
          // 幂等键：每次派发必须是新的 turn。此前缺 runId/graphId/attempt，
          // 键退化为 `new:<node>:<branch>:1:<promptHash>`，同会话同 prompt 的第二次
          // 发送会命中上一条已终态 turn 并被静默复用。
          // 现在用「会话 + 本次命令 id（无 id 则随机派发 id）」：同一 command 重试幂等，
          // 两次不同派发必产生两个 turn，且天然不会跨会话命中。
          const dispatchId = (command as { id?: string }).id ?? randomUUID()
          const thread = this.lookupThread(sessionId)
          await this.runtime!.runNode({
            agentSessionId: sessionId,
            adapterSessionId: sessionId,
            executor: adapter.name,
            prompt: command.description,
            commandType,
            workingDirectory: state?.config.workingDirectory ?? process.cwd(),
            graphId: thread?.graphId ?? '',
            nodeId,
            attempt: 1,
            idempotencyKey: `kernel:${sessionId}:${dispatchId}`,
            threadId: state?.threadId,
          })
        } catch (err) {
          if (state && state.lastCommandType === commandType) {
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
    // Kernel 路径下先重建（如需要）再读状态：恢复会填充 sessionStates，
    // 晚一步读就会拿到空配置，装配出的上下文整体丢失。
    // 同样受后端白名单门控：未具备写前审批的后端保持旧路径。
    const bound = this.tryResolveAdapter(sessionId)
    const executorName = bound?.name ?? this.persistedExecutorFor(sessionId)
    const useKernel = executorName ? this.canUseKernelFor(executorName) : false
    const adapter = useKernel
      ? bound ?? (await this.resolveKernelAdapter(sessionId))
      : await this.resolveLegacyAdapter(sessionId)
    if (useKernel) this.warnIfKernelDegraded(adapter.name, sessionId)
    const sessionState = this.sessionStates.get(sessionId)
    const sessionConfig = sessionState?.config
    const commandType = (command as AgentCommand).type

    // 先压缩再装配：压缩会把前序摘要写进适配器的实时会话配置，
    // 装配晚一步就会漏掉这段摘要（压缩后同会话的后续轮次会丢上下文）。
    const threadId = sessionState?.threadId
    if (threadId && this.contextWaterline?.shouldAutoCompact(threadId)) {
      try {
        await this.compactContext(sessionId, undefined, { reason: 'auto-threshold' })
      } catch (err) {
        logger.warn(`[Waterline] Auto-compact failed for ${sessionId}: ${err}`)
      }
    }

    // 适配器实时配置里可能有 manager 启动快照没有的 contextSummary（压缩摘要），
    // 装配 stable 前缀要用最新的那份。
    const liveConfig = adapter?.getSessionConfig?.(sessionId)
    const effectiveConfig =
      sessionConfig && liveConfig?.contextSummary
        ? { ...sessionConfig, contextSummary: liveConfig.contextSummary }
        : sessionConfig

    const { resolvedContexts, assembled } = await this.assembler.assemble({
      sessionId,
      command,
      adapterName: sessionState?.adapterName ?? '',
      sessionConfig: effectiveConfig,
      contextRefs,
      nodes,
      optimalBudget: this.getOptimalPromptBudget(commandType),
    })

    if (adapter) {
      // 分段投递：stable 进 system 通道（跨轮可复用），turn 进 user turn。
      // 用户请求不进任一段 —— 它由适配器的 buildCommandPrompt 单独承载。
      adapter.setPromptContext(sessionId, assembled.context)
    }

    await this.sendCommand(sessionId, command, { contextAssembled: true })

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

  /**
   * 兜底装配 prompt 上下文。
   *
   * 直接走 sendCommand 的路径（子代理派发 / 校验 / 替换会话恢复 / 无附加上下文的
   * 聊天）不经过 resolveAndSendCommand 的装配 —— 结果是 scope 约束（白名单 /
   * 黑名单 / 业务不变量 / 验收标准）整体不投递。而黑名单没有 OS 级兜底，
   * 提示词一丢这条安全约束就静默消失。
   *
   * 这里补上装配，把「任何投递路径都带 scope」从调用方的自觉变成框架的保证；
   * 同时每轮重新装配，turn 段（编译上下文 / 会话历史 / 水位线）不会跨轮复用。
   */
  private async ensurePromptContext(
    sessionId: string,
    command: AgentCommand,
    adapter: AgentAdapter,
  ): Promise<void> {
    const state = this.sessionStates.get(sessionId)
    // 适配器实时配置里可能有 manager 启动快照没有的 contextSummary（压缩摘要）。
    const liveConfig = adapter.getSessionConfig?.(sessionId)
    const sessionConfig = liveConfig ?? state?.config
    // A2A 透明转发：不注入任何 BizGraph 内部状态（CLAUDE.md Boundaries §3）
    if (!sessionConfig || sessionConfig.transparentForward) return
    try {
      const { resolvedContexts, assembled } = await this.assembler.assemble({
        sessionId,
        command,
        adapterName: state?.adapterName ?? adapter.name,
        sessionConfig,
        contextRefs: undefined,
        nodes: undefined,
        optimalBudget: this.getOptimalPromptBudget(command.type),
      })
      adapter.setPromptContext(sessionId, assembled.context)
      if (state) {
        state.promptTokenEstimate = assembled.totalTokens
        state.contextCount = resolvedContexts.length
      }
    } catch (err) {
      logger.warn(`[Prompt] fallback assembly failed for ${sessionId}: ${err}`)
      // 装配失败：清空可能过期的上下文，让适配器退回 session.config 自建的 scope。
      try {
        adapter.setPromptContext(sessionId, { stable: '', turn: '' })
      } catch {
        // 适配器里没有这个会话 —— 适配器层会用它自己的兜底
      }
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

  /**
   * 只读：会话用量（含 provider/estimated/unknown 与缺价行计数）。
   * DB 不可用时返回空视图 —— 「无记录」必须与「真实 0」区分，不伪造金额。
   */
  getUsageBySession(sessionId: string, limit = 200): SessionUsageView {
    const ledger = this.usageLedger
    if (!ledger) return { sessionId, summary: { ...EMPTY_USAGE_SUMMARY }, rows: [] }
    return {
      sessionId,
      summary: ledger.summarizeSession(sessionId),
      rows: ledger.listBySession(sessionId, limit),
    }
  }

  /**
   * 只读：图级按日用量。
   * day_key 由主进程 localDayKey()（Asia/Shanghai）生成，原样透出，渲染层不再二次切日。
   */
  getUsageByGraph(graphId: string, days = 30): GraphUsageView {
    const ledger = this.usageLedger
    if (!ledger) return { graphId, days: [] }
    return { graphId, days: ledger.listGraphDays(graphId, days) }
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
    this.chatRepo = repo
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