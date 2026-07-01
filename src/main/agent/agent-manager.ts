/**
 * Agent 管理器（组合式）
 * 将原有混合职责拆分为三个独立子组件：
 * - AdapterRegistry: 适配器注册中心
 * - SessionRouter: 会话路由
 * - OutputBroadcaster: 输出广播
 */

import type {
  AgentAdapter,
  AgentSessionConfig,
  AgentCommand,
  AgentCommandType,
  AgentOutput,
  ContextRef,
  ResolvedContext,
  GraphNode,
  AdapterFallbackAttempt,
  AdapterPreferences,
  ProjectMemory,
  Sandbox,
  NodeMetadata,
  TerminationReason,
} from '@shared/types'
import { type AdapterRegistry } from './adapter-registry'
import { type SessionRouter } from './session-router'
import { type OutputBroadcaster, type BroadcastPayload } from './output-broadcaster'
import { AdapterHealthMonitor, type AdapterHealthScore } from './adapter-health-monitor'
import { AdapterError, AgentError, SessionNotFoundError, ScopeGuardError, ErrorCode } from '../errors'
import { getClient } from '../database'
import { getSessionRecoveryManager } from './session-recovery'
import { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'
import { SmartContextResolver, type ResolvedCodeContext } from '../code-intelligence/smart-context-resolver'
import { readMemory } from '../mindmap-agent/memory'
import { MemoryStore } from '../memory'
import { PromptOrchestrator } from '../memory/prompt-orchestrator'
import { PipelineRunner } from '../memory/pipeline'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import type { ContextWaterline } from '../memory/context-waterline'
import type { CompactResult, CompactStrategy, CompactTrigger } from '@shared/types'
import type { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { ChatRepository } from '../repositories/chat-repository'
import type { SubagentManager } from './subagent-manager'
import { ADAPTER_REGISTRY } from '../adapters/registry'
import type { BaseAdapter } from '../adapters/base'
import { createLogger } from '../shared/logger'
import os from 'node:os'

const logger = createLogger('AgentManager')

/** 健康检查间隔：每 10 分钟输出一次诊断日志 */
const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000
/** 清理异步操作（adapter 终止、沙箱回滚）的超时时间（毫秒） */
const CLEANUP_ASYNC_TIMEOUT_MS = 30_000
/** RSS 内存警告阈值（MB）：自适应计算，基于系统总内存的 25%，范围 [1024, 8192] */
const RSS_WARNING_THRESHOLD_MB = Math.max(1024, Math.min(8192, Math.floor((os.totalmem() / 1024 / 1024) * 0.25)))
/** RSS 内存危险阈值（MB）：自适应计算，基于系统总内存的 40%，范围 [2048, 12288] */
const RSS_CRITICAL_THRESHOLD_MB = Math.max(2048, Math.min(12288, Math.floor((os.totalmem() / 1024 / 1024) * 0.4)))

/** 命令类型的上下文 Token 预算（根据任务复杂度自适应） */
const CONTEXT_COMPLEXITY_BUDGET: Record<string, number> = {
  fix_bug: 6000,
  add_test: 6000,
  refactor: 10000,
  implement: 12000,
}

type SessionEndedHandler = (sessionId: string, reason: 'success' | 'crash' | 'error' | 'timeout' | 'idle', exitCode: number | null) => void

interface SessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  startTime: number
  sandbox?: Sandbox
  /** 最后一次发送的指令类型（用于记忆提取的语义区分） */
  lastCommandType?: AgentCommandType
  /** Prompt Token 估算值（用于质量反馈环） */
  promptTokenEstimate?: number
  /** 注入的上下文数量（用于质量反馈环） */
  contextCount?: number
  /** Phase 3: thread bound to this session — used for waterline lookup & history persistence. */
  threadId?: string
  /** Phase 4: parent session if this is a subagent child session. */
  parentSessionId?: string
  /** Phase 4: subagent_invocations row id if this is a subagent child session. */
  swarmTaskId?: string
  /** Cumulative input tokens reported by the adapter for this session. */
  tokensUsed?: number
  /** Reason the adapter session ended (crash / error / timeout / user / success). */
  terminationReason?: 'success' | 'crash' | 'error' | 'timeout' | 'user' | 'idle'
  /** Last user command sent to this session; used for recovery re-send. */
  lastCommand?: AgentCommand
  /** Original sessionId for replacement sessions created by recovery, used to keep retry accounting across sessionIds. */
  originSessionId?: string
}

/** startSessionWithFallback 返回值 */
export interface StartSessionResult {
  sessionId: string
  fallback?: boolean
  adapterUsed: string
  fallbackHistory: AdapterFallbackAttempt[]
}

export class AgentManager {
  /** 最大并发会话数，防止会话无限创建导致资源泄漏 */
  private MAX_SESSIONS = this.calculateMaxSessions()
  private outputHandlers = new Map<string, (output: AgentOutput) => void>()
  private outputListeners = new Map<(output: AgentOutput) => void, (payload: BroadcastPayload) => void>()
  private contextResolver = new ContextResolver()
  private scopeGuard = new ScopeGuard()
  private smartContextResolver?: SmartContextResolver
  private sessionStates = new Map<string, SessionState>()
  /** sessionEnded 事件处理器（按适配器存储以便清理） */
  private sessionEndedHandlers = new Map<string, SessionEndedHandler>()
  private statusChangeCallback?: (sessionId: string, nodeId: string, status: string) => void
  private sessionStartedCallback?: (threadId: string, sessionId: string) => void
  private reservedSlots = new Set<string>()
  private nodeStatusChangeCallback?: (nodeId: string, oldStatus: string, newStatus: string) => void
  private onSessionComplete?: (sessionId: string, adapterName: string, nodeId: string, result: 'success' | 'failure' | 'cancelled', duration: number) => void
  /** 会话级输出监听器：按 broadcastName 过滤，防止跨会话输出污染 */
  private sessionOutputListeners = new Map<(output: AgentOutput) => void, (payload: BroadcastPayload) => void>()
  /** sessionId → broadcastName 映射（由 startSession 设置，与 broadcaster 的广播名一致） */
  private sessionBroadcastNames = new Map<string, string>()
  /** sessionId → 该会话注册的输出监听 handler 集合（用于 cleanupSessionResources 自动清理） */
  private sessionOutputListenerIndex = new Map<string, Set<(output: AgentOutput) => void>>()
  /** sandboxId → sessionId 反向索引（O(1) 查找越界会话，避免线性扫描） */
  private sandboxSessionIndex = new Map<string, string>()
  /** 清理互斥锁：防止 terminateSession 和 cleanupSessionResources 并发导致双重清理 */
  private cleanupInProgress = new Set<string>()
  /** 健康检查定时器（自适应间隔，定期输出诊断日志，监控内存与资源状态） */
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null
  /** 适配器偏好加载器（延迟注入，避免循环依赖） */
  private adapterPreferencesLoader?: () => Promise<AdapterPreferences>
  /** 适配器健康监控 */
  private healthMonitor = new AdapterHealthMonitor()
  /** 会话记忆系统（借鉴 claude-mem，Phase 1）—— 懒初始化以避免数据库未启动时报错 */
  private _memoryStore?: MemoryStore
  /** Prompt 质量反馈记录（轻量级：追踪命令类型+预算与结果的相关性） */
  private promptOutcomeLog: Array<{ commandType: string; promptTokenEstimate: number; contextCount: number; outcome: 'success' | 'failure'; duration: number }> = []
  private get memoryStore(): MemoryStore {
    if (!this._memoryStore) {
      // Verify DB is initialized before creating MemoryStore — operations will fail
      // if the database client is null, so we fail immediately with a clear message.
      getClient() // throws DatabaseError if DB not initialized
      this._memoryStore = new MemoryStore()
    }
    return this._memoryStore
  }
  /** 会话输出缓冲区：sessionId → AgentOutput[]（用于记忆提取） */
  private sessionOutputBuffers = new Map<string, AgentOutput[]>()
  /** SessionRecovery 实例 */
  private sessionRecovery = getSessionRecoveryManager()
  /** Fallback recovery check timers */
  private fallbackRecoveryTimers = new Map<string, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>()
  /** Per-adapter recovery check intervals — one per unhealthy adapter */
  private recoveryCheckIntervals = new Map<string, ReturnType<typeof setInterval>>()
  /** Consecutive timeout counter per adapter (health-driven auto-degradation) */
  private adapterTimeoutCounts: Map<string, number> = new Map()
  /** ContextWaterline 实例（注入式，Phase 2：仅占位，autoCompactEnabled 默认 false） */
  private waterline?: ContextWaterline
  /** Phase 3: compact history repo for persisting compaction results */
  private compactHistoryRepo?: CompactHistoryRepository
  /** Phase 3: chat repo for updating thread waterline metadata after compaction */
  private chatRepo?: ChatRepository
  /** Phase 3: dedup map for concurrent compactContext calls on the same session */
  private compactInflight = new Map<string, Promise<CompactResult>>()
  /** Phase 4: subagent dispatch manager (injected via setter to break cyclic dependency). */
  private subagentManager?: SubagentManager

  /**
   * 基于系统资源动态计算最大会话数
   * 公式：根据系统总内存计算，每会话预留约 20MB，最小 20，最大 200
   */
  private calculateMaxSessions(): number {
    try {
      const totalMemMB = os.totalmem() / 1024 / 1024
      // 每会话预留 20MB，预留 50% 内存给系统和其他进程
      const calculated = Math.floor((totalMemMB * 0.5) / 20)
      return Math.max(20, Math.min(200, calculated))
    } catch {
      return 100 // 回退默认值
    }
  }

  /** 全局子进程数硬上限：防止低配机同时跑大量子进程耗尽 fd/内存 */
  private readonly MAX_PROCESSES = Math.min(this.MAX_SESSIONS, Math.max(4, os.cpus().length * 2))

  /** 会话输出缓冲区上限：根据可用内存自适应 */
  private calculateOutputBufferCap(): number {
    try {
      const freeMemMB = os.freemem() / 1024 / 1024
      return Math.max(100, Math.min(2000, Math.floor(freeMemMB / 50)))
    } catch {
      return 500
    }
  }

  /** 统计所有适配器当前活跃子进程总数 */
  private countActiveProcesses(): number {
    let count = 0
    for (const adapter of this.registry.list()) {
      count += (adapter as BaseAdapter).getProcessCount?.() ?? 0
    }
    return count
  }

  constructor(
    private registry: AdapterRegistry,
    private router: SessionRouter,
    private broadcaster: OutputBroadcaster,
  ) {
    // 为每个已注册的适配器绑定输出监听
    for (const adapter of this.registry.list()) {
      this.attachAdapterOutput(adapter)
    }

    // 注册 TTL 过期回调：孤立会话超时时自动清理沙箱等资源
    this.router.onTtlExpired((sessionId) => {
      logger.warn(`Session ${sessionId} TTL expired, cleaning up resources`)
      this.cleanupSessionResources(sessionId)
    })

    // 注册 ScopeGuard 越界回调：通过反向索引 O(1) 定位对应 session 并自动终止
    this.bindScopeGuardViolationHandler()

    // 启动定期健康检查（每 10 分钟输出诊断日志）
    this.startHealthCheck()
  }

  /**
   * 绑定 ScopeGuard 越界事件处理器（抽取为独立方法，便于注入新实例时重新绑定）
   */
  private bindScopeGuardViolationHandler(): void {
    this.scopeGuard.onViolation(async (sandboxId, violations) => {
      logger.error('Scope violation detected:', violations)
      const sessionId = this.sandboxSessionIndex.get(sandboxId)
      if (!sessionId) {
        logger.warn(`No session found for sandbox ${sandboxId}, skipping termination`)
        return
      }
      try {
        await this.terminateSession(sessionId, 'error')
      } catch (err) {
        logger.warn('Failed to terminate session during scope violation cleanup:', err)
      }
    })
  }

  /**
   * 动态注册新适配器并自动绑定输出
   */
  registerAdapter(adapter: AgentAdapter): void {
    this.registry.register(adapter)
    this.attachAdapterOutput(adapter)
  }

  private attachAdapterOutput(adapter: AgentAdapter): void {
    const handler = (output: AgentOutput) => {
      const sessionId = adapter.resolveOutputSession?.(output)
      if (sessionId) {
        const broadcastName = this.sessionStates.get(sessionId)?.broadcastName ?? adapter.name
        this.broadcaster.broadcast(broadcastName, output, sessionId)

        // Finding 3 fix: reset the recovery-attempt counter when a turn completes successfully.
        // SDK multi-turn adapters (claude-code / codex / mcp) keep sessions alive across commands
        // and do NOT emit sessionEnded('success') per turn, so the only per-turn success signal
        // is the 'complete' output. Resetting here ensures an intermittent crash doesn't
        // permanently exhaust the lineage's retry budget even after many healthy subsequent turns.
        //
        // Guard: skip if cleanup is in progress — during replacement-recovery the old session's
        // teardown also emits 'complete', and resetting there would clobber the counter that the
        // recovery path uses to bound retries.
        if (
          output.type === 'complete' &&
          !this.cleanupInProgress.has(sessionId) &&
          this.sessionStates.has(sessionId)
        ) {
          const state = this.sessionStates.get(sessionId)
          if (state) {
            this.sessionRecovery.reset(state.originSessionId ?? sessionId)
          }
        }
        return
      }
      this.broadcaster.broadcast(adapter.name, output)
    }
    this.outputHandlers.set(adapter.name, handler)
    adapter.onOutput(handler)

    // 监听 session 结束事件，自动清理沙箱等资源
    const sessionEndedHandler: SessionEndedHandler = async (sessionId, reason, exitCode) => {
      try {
        if (reason === 'crash' || reason === 'error' || reason === 'timeout') {
          logger.warn(`Session ${sessionId} ended abnormally (${reason}, exit ${exitCode}), cleaning up...`)
          const state = this.sessionStates.get(sessionId)
          const outputs = this.sessionOutputBuffers.get(sessionId) ?? []
          if (state) {
            state.terminationReason = reason
          }

          if (state) {
            // Run recovery while the original session state/output buffer is still intact.
            const outcome = await this._handleSessionEnded(sessionId, exitCode, reason, state, outputs)
            if (outcome === 'native') {
              // Native resume keeps the same sessionId active. Clear only transient
              // crash artifacts and leave the session/router binding in place.
              this.sessionOutputBuffers.delete(sessionId)
              this.compactInflight.delete(sessionId)
              return
            }
          }

          // For replacement sessions or unrecoverable crashes, clean up the original session.
          await this.cleanupSessionResources(sessionId)
          return
        }

        if (reason === 'success') {
          // Normal completion: clean up resources without running recovery.
          logger.info(`Session ${sessionId} completed successfully (exit ${exitCode}), cleaning up...`)
          const state = this.sessionStates.get(sessionId)
          if (state) {
            state.terminationReason = 'success'
            // Reset recovery attempts for this lineage so future crashes can be recovered again.
            this.sessionRecovery.reset(state.originSessionId ?? sessionId)
          }
          await this.cleanupSessionResources(sessionId)
        }

        if (reason === 'idle') {
          // SDK adapter idle-reaper fired: session was alive but had no activity for
          // idleMs. Delegate to terminateSession(sessionId, 'idle') so the memory
          // pipeline (Phase B), scope-guard commit, onSessionComplete callback, and
          // sessionRecovery reset all run through the single canonical teardown path
          // instead of being duplicated here (see review finding: altitude/idle-branch).
          // terminateSession 内部的 cleanupInProgress 互斥已防止与并发清理冲突，
          // 因此即使此处异步执行完整记忆管线，也不会与同一会话的其它终止路径重入。
          logger.info(`Session ${sessionId} reclaimed by idle reaper, delegating to terminateSession`)
          try {
            await this.terminateSession(sessionId, 'idle')
          } catch (err) {
            logger.warn(`terminateSession('idle') failed for ${sessionId}:`, err)
          }
        }
      } catch (err) {
        logger.error(`Unhandled error in sessionEnded handler for ${sessionId}:`, err)
      }
    }
    this.sessionEndedHandlers.set(adapter.name, sessionEndedHandler)
    adapter.on('sessionEnded', sessionEndedHandler)

    // Phase 3 Task 3: forward 'usage' events to the waterline for the bound thread
    if (typeof adapter.onUsage === 'function') {
      adapter.onUsage(({ sessionId: sid, inputTokens, maxTokens }) => {
        const ss = this.sessionStates.get(sid)
        if (ss) {
          ss.tokensUsed = (ss.tokensUsed ?? 0) + inputTokens
          if (ss?.threadId && this.waterline) {
            this.waterline.onAdapterUsageReport(ss.threadId, inputTokens, maxTokens ?? 200_000)
          }
        }
      })
    } else {
      logger.warn(`Adapter ${adapter.name} does not support usage events (onUsage missing)`)
    }
  }

  /**
   * 清理指定 session 的所有资源（沙箱、路由、广播名、输出监听器等）
   * 通过 cleanupInProgress 互斥锁防止与 terminateSession 并发导致双重清理
   */
  private async cleanupSessionResources(sessionId: string): Promise<void> {
    // 互斥检查：若已在清理中，跳过
    if (this.cleanupInProgress.has(sessionId)) return
    this.cleanupInProgress.add(sessionId)

    try {
      await this._doCleanupSessionResources(sessionId)
    } finally {
      // 释放互斥锁：确保即使清理过程中抛异常也不会死锁
      this.cleanupInProgress.delete(sessionId)
    }
  }

  /**
   * 实际执行资源清理（不获取/释放 cleanupInProgress 锁）
   *
   * 抽取为独立方法以便调用方（如 terminateSession 的 SessionNotFoundError 分支）
   * 在已经持有锁的情况下直接调用，避免重入 cleanupSessionResources 时
   * 被锁检查 short-circuit 跳过而导致残留资源未被释放。
   *
   * 所有异步操作（adapter 终止、沙箱回滚）均被 await，
   * 确保资源在方法返回前已释放，防止与后续 terminateSession 重叠。
   */
  private async _doCleanupSessionResources(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId)

    // Collect async operations so we can await them before removing state
    const pendingOps: Promise<void>[] = []

    // 终止 adapter 会话（防止子进程泄漏）
    try {
      const adapterName = this.router.getAdapterName(sessionId)
      if (adapterName) {
        const adapter = this.registry.get(adapterName)
        if (adapter) {
          const cleanupReason: TerminationReason = (state?.terminationReason === 'user' || state?.terminationReason === 'timeout' || state?.terminationReason === 'crash' || state?.terminationReason === 'error')
            ? state.terminationReason
            : 'error'
          pendingOps.push(
            adapter.terminateSession(sessionId, cleanupReason).then(
              () => {},
              (err: unknown) => { logger.warn(`Failed to terminate adapter session ${sessionId}:`, err) },
            ),
          )
        }
      }
    } catch {
      // 路由条目可能已不存在，忽略
    }

    // ScopeGuard: 异常退出时回滚沙箱（带重试机制，防止临时文件系统错误导致资源泄漏）
    if (state?.sandbox) {
      const sandbox = state.sandbox
      this.sandboxSessionIndex.delete(sandbox.id)
      pendingOps.push(
        this.rollbackWithRetry(sessionId, sandbox, 2).catch((err: unknown) => {
          logger.error(`Failed to rollback sandbox for session ${sessionId} after retries:`, err)
        }),
      )
    }

    // Wait for all async operations (adapter terminate + sandbox rollback) to settle
    // before clearing state, so that resources are truly released before overlap is possible.
    // A hard timeout prevents a hanging operation from permanently blocking cleanup.
    const cleanupTimeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.error(`Session ${sessionId} cleanup exceeded ${CLEANUP_ASYNC_TIMEOUT_MS}ms; force-progressing state cleanup`)
        resolve()
      }, CLEANUP_ASYNC_TIMEOUT_MS)
    })
    await Promise.race([Promise.allSettled(pendingOps), cleanupTimeout])

    // 清理会话级输出监听器（sessionOutputListeners + sessionOutputListenerIndex）
    const listeners = this.sessionOutputListenerIndex.get(sessionId)
    if (listeners) {
      for (const handler of listeners) {
        const wrapped = this.sessionOutputListeners.get(handler)
        if (wrapped) {
          this.broadcaster.offBroadcast(wrapped)
          this.sessionOutputListeners.delete(handler)
        }
      }
      this.sessionOutputListenerIndex.delete(sessionId)
    }

    this.sessionStates.delete(sessionId)
    this.sessionBroadcastNames.delete(sessionId)
    this.sessionOutputBuffers.delete(sessionId)
    this.compactInflight.delete(sessionId)
    this.router.unbind(sessionId)

    // Trim promptOutcomeLog in crash/error path (normally trimmed in terminateSession,
    // but cleanupSessionResources can be invoked without terminateSession)
    if (this.promptOutcomeLog.length > 100) {
      this.promptOutcomeLog = this.promptOutcomeLog.slice(-100)
    }
  }

  /**
   * 带回滚重试的沙箱回滚操作
   * 当回滚因临时性文件系统错误失败时，按指数退避重试，
   * 防止因资源未释放导致的后续会话异常。
   */
  private async rollbackWithRetry(
    sessionId: string,
    sandbox: Sandbox,
    maxRetries: number,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.scopeGuard.rollback(sandbox)
        if (attempt > 0) {
          logger.info(`Sandbox rollback succeeded on retry ${attempt} for session ${sessionId}`)
        }
        return
      } catch (err: unknown) {
        lastError = err
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(`Sandbox rollback attempt ${attempt + 1}/${maxRetries + 1} failed for session ${sessionId}: ${errMsg}`)
        if (attempt < maxRetries) {
          // 指数退避 + 抖动：100ms * 2^attempt + 随机抖动，防止多会话同时失败时惊群
          const baseDelay = 100 * Math.pow(2, attempt)
          const jitter = Math.random() * baseDelay * 0.5
          await new Promise<void>((resolve) => setTimeout(resolve, baseDelay + jitter))
        }
      }
    }
    throw lastError
  }

  /**
   * 获取进程内存统计信息
   */
  getMemoryStats(): { rssMB: number; heapTotalMB: number; heapUsedMB: number; externalMB: number } {
    const usage = process.memoryUsage()
    return {
      rssMB: Math.round(usage.rss / 1024 / 1024),
      heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
    }
  }

  /**
   * 检查内存使用，超过阈值时触发警告和会话清理
   */
  private checkMemoryPressure(): void {
    const stats = this.getMemoryStats()
    if (stats.rssMB > RSS_CRITICAL_THRESHOLD_MB) {
      logger.error(`CRITICAL: RSS ${stats.rssMB}MB exceeds critical threshold (${RSS_CRITICAL_THRESHOLD_MB}MB), force cleaning oldest sessions`)
      this.cleanupOldestSessions(5)
    } else if (stats.rssMB > RSS_WARNING_THRESHOLD_MB) {
      logger.warn(`WARNING: RSS ${stats.rssMB}MB exceeds warning threshold (${RSS_WARNING_THRESHOLD_MB}MB), consider reducing active sessions`)
      this.cleanupOldestSessions(2)
    }
  }

  /**
   * 清理最老的 N 个会话（按开始时间排序）
   */
  private cleanupOldestSessions(count: number): void {
    const sorted = Array.from(this.sessionStates.entries())
      .sort((a, b) => a[1].startTime - b[1].startTime)
      .slice(0, count)
    for (const [sessionId] of sorted) {
      logger.info(`Memory pressure cleanup: terminating session ${sessionId}`)
      this.terminateSession(sessionId, 'error').catch((err) => {
        logger.warn(`Failed to terminate session ${sessionId} during memory cleanup:`, err)
      })
    }
  }

  /**
   * 输出诊断日志，用于监控内存使用情况
   * 可在 destroy() 前或定时调用
   */
  logDiagnostics(): void {
    const mem = this.getMemoryStats()
    logger.info('AgentManager diagnostics', {
      activeSessions: this.sessionStates.size,
      outputHandlers: this.outputHandlers.size,
      sessionBroadcastNames: this.sessionBroadcastNames.size,
      sessionOutputListenerIndex: this.sessionOutputListenerIndex.size,
      sandboxSessionIndex: this.sandboxSessionIndex.size,
      cleanupInProgress: this.cleanupInProgress.size,
      memory: mem,
    })
  }

  /**
   * 启动定期健康检查（自适应间隔：高负载时更频繁）
   * 用于长期运行时监控内存占用和资源泄漏
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) return
    this.scheduleNextHealthCheck()
  }

  /**
   * 计算自适应健康检查间隔
   * 高负载（内存压力大或会话多）时缩短间隔，正常情况保持默认
   */
  private adaptiveHealthCheckInterval(): number {
    const stats = this.getMemoryStats()
    const sessionCount = this.sessionStates.size
    // 内存超过80%阈值或会话超过70%上限 → 5分钟
    if (stats.rssMB > RSS_WARNING_THRESHOLD_MB * 0.8 || sessionCount > this.MAX_SESSIONS * 0.7) {
      return 5 * 60 * 1000
    }
    // 内存超过50%阈值或会话超过50%上限 → 7分钟
    if (stats.rssMB > RSS_WARNING_THRESHOLD_MB * 0.5 || sessionCount > this.MAX_SESSIONS * 0.5) {
      return 7 * 60 * 1000
    }
    return HEALTH_CHECK_INTERVAL_MS
  }

  /**
   * 调度下一次健康检查
   */
  private scheduleNextHealthCheck(): void {
    const interval = this.adaptiveHealthCheckInterval()
    this.healthCheckTimer = setTimeout(() => {
      this.logDiagnostics()
      this.checkMemoryPressure()
      // 定期清理过期低置信度记忆（借鉴 claude-mem 的自动清理策略）
      try {
        this.memoryStore.pruneStale(90)
      } catch (err) {
        logger.warn('Memory pruneStale failed:', err)
      }
      // 调度下一次检查（间隔可能根据系统状态变化）
      this.scheduleNextHealthCheck()
    }, interval)
    // 不阻止进程退出
    if (this.healthCheckTimer && typeof this.healthCheckTimer === 'object' && 'unref' in this.healthCheckTimer) {
      (this.healthCheckTimer as ReturnType<typeof setTimeout> & { unref(): void }).unref()
    }
  }

  /**
   * 停止健康检查定时器
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  /**
   * 清理所有适配器的输出监听器，防止内存泄漏
   */
  destroy(): void {
    for (const [name, handler] of this.outputHandlers) {
      const adapter = this.registry.get(name)
      if (adapter) {
        adapter.offOutput(handler)
      }
    }
    for (const [name, handler] of this.sessionEndedHandlers) {
      const adapter = this.registry.get(name)
      if (adapter) {
        adapter.off('sessionEnded', handler)
      }
    }
    this.outputHandlers.clear()
    this.sessionEndedHandlers.clear()
    this.sessionStates.clear()
    this.sessionBroadcastNames.clear()
    this.sandboxSessionIndex.clear()
    // 停止 SessionRouter 的 TTL 检查
    this.router.stopTtlCheck()
    // 清理所有会话级输出监听器
    for (const wrapped of this.sessionOutputListeners.values()) {
      this.broadcaster.offBroadcast(wrapped)
    }
    this.sessionOutputListeners.clear()
    this.sessionOutputListenerIndex.clear()
    this.cleanupInProgress.clear()
    // 停止健康检查定时器
    this.stopHealthCheck()
    // 清理所有 recovery check intervals
    for (const interval of this.recoveryCheckIntervals.values()) {
      clearInterval(interval)
    }
    this.recoveryCheckIntervals.clear()
    // 清理 ScopeGuard 所有定时器和 watcher
    this.scopeGuard.destroy()
    // 释放适配器级资源（如 MCP 连接池、池清理定时器）——避免应用退出时泄漏子进程/连接
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

  /**
   * 终止所有活跃会话并释放资源（进程退出时调用）
   */
  async terminateAllSessions(): Promise<void> {
    const sessionIds = this.router.getActiveSessionIds()
    await Promise.allSettled(
      sessionIds.map((id) => this.terminateSession(id, 'user')),
    )
    this.sessionStates.clear()
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

  setOnSessionComplete(handler: (sessionId: string, adapterName: string, nodeId: string, result: 'success' | 'failure' | 'cancelled', duration: number) => void): void {
    this.onSessionComplete = handler
  }

  /**
   * 注入 ScopeGuard 实例（替换默认实例，重新绑定越界处理器）
   */
  setScopeGuard(scopeGuard: ScopeGuard): void {
    // 销毁旧实例的定时器和 watcher
    this.scopeGuard.destroy()
    this.scopeGuard = scopeGuard
    this.bindScopeGuardViolationHandler()
  }

  /**
   * 注入 ContextResolver 实例（替换默认实例）
   */
  setContextResolver(contextResolver: ContextResolver): void {
    this.contextResolver = contextResolver
  }

  /**
   * 注入代码智能依赖
   */
  setSymbolIndex(symbolIndex: SymbolIndex): void {
    this.smartContextResolver = new SmartContextResolver(symbolIndex)
  }

  /**
   * 注入适配器偏好加载器（避免循环依赖：settings → ipc-handlers → AgentManager → settings）
   */
  setAdapterPreferencesLoader(loader: () => Promise<AdapterPreferences>): void {
    this.adapterPreferencesLoader = loader
  }

  /**
   * 注入 ContextWaterline 实例
   */
  setWaterline(wl: ContextWaterline): void {
    this.waterline = wl
  }

  /**
   * 注入 CompactHistoryRepository（Phase 3：用于持久化 compact_history）
   */
  setCompactHistoryRepo(repo: CompactHistoryRepository): void {
    this.compactHistoryRepo = repo
  }

  /**
   * 注入 ChatRepository（Phase 3：用于 compactContext 后更新 thread 的 waterline 元数据）
   */
  setChatRepo(repo: ChatRepository): void {
    this.chatRepo = repo
  }

  /**
   * Phase 4: 注入 SubagentManager（setter 模式打破循环依赖）
   */
  setSubagentManager(mgr: SubagentManager): void {
    this.subagentManager = mgr
  }

  getSubagentManager(): SubagentManager | undefined {
    return this.subagentManager
  }

  getSandbox(sessionId: string): Sandbox | undefined {
    return this.sessionStates.get(sessionId)?.sandbox
  }

  /** Phase 4: expose session config for subagent scope validation. */
  getSessionConfig(sessionId: string): AgentSessionConfig | undefined {
    return this.sessionStates.get(sessionId)?.config
  }

  /** Phase 4: expose session state for subagent parent linkage. */
  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessionStates.get(sessionId)
  }

  /** Phase 4: broadcast an output to a session's thread channel (used by SubagentManager). */
  broadcastToSession(sessionId: string, output: AgentOutput): void {
    const state = this.sessionStates.get(sessionId)
    if (state) {
      this.broadcaster.broadcast(state.broadcastName, output, sessionId)
    }
  }

  /**
   * 获取所有活跃会话 ID
   */
  getActiveSessionIds(): string[] {
    return this.router.getActiveSessionIds()
  }

  get scopeGuardInstance(): ScopeGuard {
    return this.scopeGuard
  }

  /**
   * 获取指定适配器的健康评分
   */
  getAdapterHealth(adapterName: string): AdapterHealthScore | undefined {
    return this.healthMonitor.getHealth(adapterName)
  }

  /**
   * 获取所有适配器的健康评分
   */
  getAllAdapterHealth(): AdapterHealthScore[] {
    return this.healthMonitor.getAllHealth()
  }

  getAdapter(name: string): AgentAdapter | undefined {
    return this.registry.get(name)
  }

  async checkInstalled(name: string): Promise<boolean> {
    const adapter = this.registry.get(name)
    if (!adapter) return false
    return adapter.checkInstalled()
  }

  async listAdapters(): Promise<{ name: string; version: string; installed: boolean }[]> {
    return this.registry.checkAllInstalled()
  }

  async startSession(
    adapterName: string | null,
    config: AgentSessionConfig,
  ): Promise<StartSessionResult> {
    // 确定回退链：首选适配器 + 回退顺序
    const preferences = await this.loadAdapterPreferences()
    const primary = adapterName ?? preferences.defaultAdapter
    const fallbackChain = [primary, ...preferences.fallbackOrder.filter((a: string) => a !== primary)]

    // 去重
    const seen = new Set<string>()
    let uniqueChain = fallbackChain.filter((a) => {
      if (seen.has(a)) return false
      seen.add(a)
      return true
    })

    // Dynamic fallback: reorder by adapter health (unless forceAdapter)
    if (!preferences.forceAdapter) {
      const healthiest = this.healthMonitor.getHealthiestAdapter(uniqueChain)
      if (healthiest && healthiest !== uniqueChain[0]) {
        uniqueChain = [healthiest, ...uniqueChain.filter(n => n !== healthiest)]
      }
    }

    const fallbackHistory: AdapterFallbackAttempt[] = []

    // 检查系统剩余内存，低配机接近耗尽时拒绝新建会话
    if (os.freemem() < 512 * 1024 * 1024) {
      logger.error('Insufficient free memory (<512MB), refusing to create new session')
      throw new AgentError('Insufficient free memory to start a new agent session', ErrorCode.AGENT_RESOURCE_EXHAUSTED)
    }

    // 检查会话上限，防止无限创建
    // reservedSlots tracks in-flight startSession calls to prevent TOCTOU races
    // on the capacity check; real sessions are in sessionStates.
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
    // Reserve a slot key to prevent TOCTOU race
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

      // Health-driven auto-degradation: skip unhealthy, shorten timeout for degraded
      const health = this.healthMonitor.getHealth(candidate)
      if (health && health.status === 'unhealthy') {
        fallbackHistory.push({ adapter: candidate, reason: `${candidate} is unhealthy (score: ${health.healthScore}), skipping`, success: false })
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
        const session = await adapter.startSession(config)

        // Reset consecutive timeout counter on success
        this.adapterTimeoutCounts.delete(candidate)

        let sandbox: Sandbox | undefined
        // Prepare a sandbox for normal write sessions and for read-only verification
        // sessions. When verifyOnly is true, allowedFiles is empty, so any write is
        // treated as an out-of-bounds violation.
        if (config.allowedFiles.length > 0 || config.verifyOnly) {
          sandbox = await this.scopeGuard.prepareSandbox(
            config.allowedFiles,
            config.workingDirectory,
          )
          // 维护 sandboxId → sessionId 反向索引
          this.sandboxSessionIndex.set(sandbox.id, session.id)
        }

        fallbackHistory.push({ adapter: candidate, reason: '', success: true })

        // 记录成功调用到健康监控
        this.healthMonitor.recordCall(candidate, true, Date.now() - startTime)

        const isFallback = candidate !== primary
        const broadcastName = isFallback ? `${primary}-fallback-${session.id.slice(-6)}` : candidate

        this.sessionStates.set(session.id, {
          config,
          broadcastName,
          adapterName: candidate,
          startTime: session.startTime,
          sandbox,
          threadId: config.threadId,
          parentSessionId: config.parentSessionId,
          swarmTaskId: config.swarmTaskId,
        })
        // Remove the reserved slot now that the real session is registered
        this.reservedSlots.delete(slotKey)
        this.sessionBroadcastNames.set(session.id, broadcastName)

        // fallback 时路由记录实际适配器名
        this.router.bind(session.id, candidate, isFallback ? primary : undefined)

        // 如果是 fallback，在 session 上记录 fallbackInfo（保持向后兼容）
        if (isFallback) {
          session.fallbackInfo = {
            originalAdapter: primary,
            fallbackReason: `${primary} not available, using ${candidate}`,
          }
          // Start periodic check to detect when preferred adapter recovers
          this._startFallbackRecoveryCheck(primary)
        }

        if (config.nodeId) {
          this.statusChangeCallback?.(session.id, config.nodeId, 'developing')
        }

        // placeholder→developing auto-trigger
        // NODE_STATUS_TRANSITIONS already allows placeholder→developing for feature nodes
        if (config.nodeId && config.commandType === 'implement') {
          try {
            const db = getClient()
            // Single atomic UPDATE — avoids partial state if second step fails
            const info = db.prepare(
              "UPDATE nodes SET status = 'developing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'placeholder'"
            ).run(config.nodeId)
            if (info.changes > 0) {
              this.nodeStatusChangeCallback?.(config.nodeId, 'placeholder', 'developing')
            }
          } catch (err) {
            logger.warn(`Failed to auto-advance placeholder node ${config.nodeId}:`, err)
          }
        }

        // MEM-01: 初始化会话输出缓冲（用于记忆提取）
        const sessionOutputs: AgentOutput[] = []
        this.sessionOutputBuffers.set(session.id, sessionOutputs)
        this.addSessionOutputListener(session.id, (output) => {
          // 只收集有实质内容的输出（保护内存）
          if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'file_change' || output.type === 'complete') {
            sessionOutputs.push(output)
            // 限制缓冲区大小，防止内存无限增长
            if (sessionOutputs.length > this.calculateOutputBufferCap()) {
              sessionOutputs.splice(0, sessionOutputs.length - this.calculateOutputBufferCap())
            }
          }
        })

        // Emit session started event for renderer IPC
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
        // 记录失败调用到健康监控
        this.healthMonitor.recordCall(candidate, false, Date.now() - startTime, reason)
        // Consecutive timeout tracking: after 2 consecutive failures, skip to next adapter
        const currentCount = this.adapterTimeoutCounts.get(candidate) ?? 0
        this.adapterTimeoutCounts.set(candidate, currentCount + 1)
        if (currentCount + 1 >= 2) {
          this.adapterTimeoutCounts.delete(candidate)
          logger.warn(`Adapter ${candidate} failed ${currentCount + 1} consecutive times, moving to next adapter`)
          continue
        }
        logger.warn(`Adapter ${candidate} startSession failed: ${reason}, trying next...`)
        continue
      }
    }

    // 所有适配器都失败 — 清理预留槽位
    this.reservedSlots.delete(slotKey)
    throw new AdapterError(
      `No adapter available. Tried: ${uniqueChain.join(', ')}. Details: ${fallbackHistory.map((f) => `${f.adapter} (${f.reason})`).join('; ')}`,
      primary,
    )
  }

  /**
   * 加载适配器偏好配置（通过注入的 loader，避免循环依赖）
   */
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

  async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
    const adapter = this.router.resolve(sessionId)
    if (!adapter) {
      throw new SessionNotFoundError(sessionId)
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
  }

  /**
   * 解析上下文并发送指令
   * 在发送前将 ContextRef[] 解析为 ResolvedContext[]，
   * 注入到 adapter 的 scope prompt 中。
   */
  async resolveAndSendCommand(
    sessionId: string,
    command: AgentCommand,
    contextRefs?: ContextRef[],
    nodes?: GraphNode[],
  ): Promise<void> {
    const sessionConfig = this.sessionStates.get(sessionId)?.config

    // 并行执行上下文解析、智能代码解析、项目记忆加载、会话历史记忆（四者互不依赖）
    const [resolvedContexts, codeContext, _memoryContext, _sessionHistoryContext] = await Promise.all([
      // 标准上下文解析（根据命令类型自适应 Token 预算）
      (contextRefs && contextRefs.length > 0)
        ? this.contextResolver.resolve(contextRefs, CONTEXT_COMPLEXITY_BUDGET[(command as AgentCommand).type] ?? 8000, {
            nodes: nodes ?? [],
            basePath: sessionConfig?.workingDirectory,
          })
        : Promise.resolve([] as ResolvedContext[]),
      // 智能代码上下文解析
      (this.smartContextResolver && sessionConfig?.workingDirectory)
        ? this.smartContextResolver.resolve({
            userQuery: typeof command === 'string' ? command : command.description,
            projectPath: sessionConfig.workingDirectory,
            nodes: nodes ?? [],
            maxSymbols: 15,
            maxFiles: 8,
            dependencyDepth: 2,
          }).then((ctx) => {
            if (ctx.primarySymbols.length > 0 || ctx.relatedFiles.length > 0) {
              return this.formatCodeContext(ctx)
            }
            return undefined
          }).catch((err) => {
            logger.warn('Smart context resolution failed:', err)
            return undefined
          })
        : Promise.resolve(undefined as string | undefined),
      // 项目记忆上下文（从 .bizgraph/memory.json 加载）
      sessionConfig?.workingDirectory
        ? readMemory(sessionConfig.workingDirectory).then((mem) => {
            return this.formatMemoryContext(mem)
          }).catch((err) => {
            logger.debug('Project memory load skipped:', err)
            return undefined
          })
        : Promise.resolve(undefined as string | undefined),
      // MEM-03: 会话历史记忆（从 MemoryStore 加载，借鉴 claude-mem 的渐进式上下文注入）
      sessionConfig?.workingDirectory
        ? this.formatSessionHistoryContext(
            sessionConfig.workingDirectory,
            sessionConfig.nodeId,
            sessionId,
          )
        : Promise.resolve(undefined as string | undefined),
    ])

    // Use PromptOrchestrator to assemble the full prompt from all context layers
    const sessionState = this.sessionStates.get(sessionId)
    const commandType = (command as AgentCommand).type
    const commandText = typeof command === 'string' ? command : command.description

    const orchestrator = new PromptOrchestrator()
    const assembled = await orchestrator.assemble({
      sessionId,
      adapterName: sessionState?.adapterName ?? '',
      projectId: sessionConfig?.workingDirectory,
      nodeId: sessionConfig?.nodeId,
      nodeTitle: sessionConfig?.nodeTitle,
      userCommand: commandText,
      totalBudget: this.getOptimalPromptBudget(commandType),
      sessionConfig,
      resolvedContexts,
      codeContext: codeContext,
    })

    // Store assembled prompt on the adapter so it can inject it into the session
    const adapter = this.router.resolve(sessionId)
    if (adapter) {
      if (resolvedContexts.length > 0) {
        adapter.setResolvedContexts(sessionId, resolvedContexts)
      }
      if (codeContext) {
        adapter.setCodeContext(sessionId, codeContext)
      }
      // Set the full assembled prompt as memory context for the adapter
      adapter.setMemoryContext(sessionId, assembled.text)
    }

    // Phase 3 Task 3: auto-compact actually triggers now.
    const sessionStateForCompact = this.sessionStates.get(sessionId)
    const threadId = sessionStateForCompact?.threadId
    if (threadId && this.waterline?.shouldAutoCompact(threadId)) {
      try {
        await this.compactContext(sessionId, undefined, { reason: 'auto-threshold' })
      } catch (err) {
        logger.warn(`[Waterline] Auto-compact failed for ${sessionId}: ${err}`)
        // Continue sending the original command despite compact failure
      }
    }

    await this.sendCommand(sessionId, command)

    // Record Prompt quality feedback metrics
    const state = this.sessionStates.get(sessionId)
    if (state) {
      state.promptTokenEstimate = assembled.totalTokens
      state.contextCount = resolvedContexts.length
    }
  }

  /**
   * 将项目记忆格式化为 prompt 字符串
   */
  private formatMemoryContext(memory: ProjectMemory): string | undefined {
    // 仅当记忆包含实质性内容时才注入
    const hasContent = memory.businessDomains.length > 0
      || memory.architecturePattern
      || memory.coreUserFlows.length > 0
      || memory.techConstraints.length > 0
    if (!hasContent) return undefined

    const lines: string[] = ['# 项目记忆']

    if (memory.businessDomains.length > 0) {
      lines.push(`## 业务域\n${memory.businessDomains.join(', ')}`)
    }
    if (memory.architecturePattern) {
      lines.push(`## 架构模式\n${memory.architecturePattern}`)
    }
    if (memory.coreUserFlows.length > 0) {
      lines.push(`## 核心用户流程\n${memory.coreUserFlows.map((f: string) => `- ${f}`).join('\n')}`)
    }
    if (memory.techConstraints.length > 0) {
      lines.push(`## 技术约束\n${memory.techConstraints.map((c: string) => `- ${c}`).join('\n')}`)
    }
    if (memory.preferences) {
      const prefs = memory.preferences
      lines.push(`## 用户偏好\n- 命名风格: ${prefs.namingStyle}\n- 粒度: ${prefs.granularity}\n- 最大模块数: ${prefs.maxModules}`)
      if (prefs.avoidPatterns.length > 0) {
        lines.push(`- 避免模式: ${prefs.avoidPatterns.join(', ')}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 将会话历史记忆格式化为 prompt 字符串（借鉴 claude-mem 的渐进式上下文注入）
   * 注入最近的调查/修复记录，帮助 Agent 了解项目历史和避免重复工作
   */
  private async formatSessionHistoryContext(
    workingDirectory: string,
    nodeId?: string,
    _currentSessionId?: string,
  ): Promise<string | undefined> {
    const recent = await this.memoryStore.getRecent({
      projectId: workingDirectory,
      nodeId,
      limit: 5,
    })
    if (recent.length === 0) return undefined

    const lines: string[] = ['# 会话历史记忆（自动注入）']
    for (const item of recent) {
      lines.push(this.memoryStore.toCompactSummary(item))
    }

    // 注入跨适配器记忆（让 Agent B 复用 Agent A 的发现）
    const crossAdapter = await this.memoryStore.getCrossAdapter(workingDirectory, '', 3)
    if (crossAdapter.length > 0) {
      lines.push('\n## 其他 Agent 的发现')
      for (const item of crossAdapter) {
        lines.push(`[${item.adapter_name}] ${this.memoryStore.toCompactSummary(item)}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 将 ResolvedCodeContext 格式化为 prompt 字符串
   */
  private formatCodeContext(ctx: ResolvedCodeContext): string {
    const lines: string[] = ['# 代码上下文']

    if (ctx.summary) {
      lines.push(`## 分析摘要\n${ctx.summary}`)
    }

    if (ctx.primarySymbols.length > 0) {
      lines.push('## 核心代码')
      for (const result of ctx.primarySymbols) {
        const { symbol, score, matchedBy } = result
        lines.push(`### ${symbol.name} (${symbol.kind}, 匹配度: ${(score * 100).toFixed(0)}%, ${matchedBy})`)
        if (symbol.signature) lines.push(`- 签名: ${symbol.signature}`)
        lines.push(`- 位置: ${symbol.filePath}:${symbol.line}`)
        if (symbol.sourceCode) {
          lines.push('```typescript')
          lines.push(symbol.sourceCode)
          lines.push('```')
        }
      }
    }

    if (ctx.relatedSymbols.length > 0) {
      lines.push('## 相关代码')
      for (const result of ctx.relatedSymbols.slice(0, 10)) {
        const { symbol, score } = result
        lines.push(`- ${symbol.name} (${symbol.kind}): ${symbol.filePath}:${symbol.line} (得分: ${(score * 100).toFixed(0)}%)`)
      }
    }

    if (ctx.relatedFiles.length > 0) {
      lines.push('## 相关文件')
      for (const file of ctx.relatedFiles) {
        lines.push(`### ${file.filePath} (${file.reason})`)
        lines.push('```typescript')
        lines.push(file.content.slice(0, 3000))
        lines.push('```')
      }
    }

    if (ctx.importGraph.length > 0) {
      lines.push('## 文件依赖关系')
      for (const edge of ctx.importGraph) {
        lines.push(`${edge.from} -> ${edge.to}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 根据历史 Prompt 质量反馈计算最优 Token 预算
   * 基于成功会话的平均 Token 消耗 × 1.2（20% 余量），数据不足时回退默认值
   */
  getOptimalPromptBudget(commandType: string): number {
    const relevant = this.promptOutcomeLog.filter(e => e.commandType === commandType)
    if (relevant.length < 5) return CONTEXT_COMPLEXITY_BUDGET[commandType] ?? 8000
    const successEntries = relevant.filter(e => e.outcome === 'success')
    if (successEntries.length === 0) return CONTEXT_COMPLEXITY_BUDGET[commandType] ?? 8000
    const avgTokens = successEntries.reduce((sum, e) => sum + e.promptTokenEstimate, 0) / successEntries.length
    return Math.max(4000, Math.min(16000, Math.round(avgTokens * 1.2)))
  }

  async terminateSession(sessionId: string, reason?: TerminationReason): Promise<void> {
    // 互斥检查：若 cleanupSessionResources 已在清理，直接返回
    if (this.cleanupInProgress.has(sessionId)) {
      logger.info(`Session ${sessionId} already being cleaned up, skipping terminateSession`)
      return
    }
    // 标记清理中，防止后续 sessionEnded 事件触发 cleanupSessionResources 并发清理
    this.cleanupInProgress.add(sessionId)

    // 阶段划分：
    //   阶段 A（持锁）—— adapter.terminate + Map 状态清理 + ScopeGuard 提交
    //     这些必须排他执行，避免 sessionEnded('crash') 事件重入 cleanupSessionResources
    //     与正在迭代 sessionStates/sandboxSessionIndex 的代码冲突。
    //   阶段 B（释放锁后）—— 记忆抽取/存储 + onSessionComplete 回调
    //     这些只依赖阶段 A 抓拍的局部变量，不再触碰共享 Map；
    //     不持锁可避免 LibSQL 慢写时把 crash 事件吞掉。
    let adapter: AgentAdapter | undefined
    let state: SessionState | undefined
    let nodeId: string | undefined
    let sandbox: SessionState['sandbox']
    let outputsForMemory: AgentOutput[] = []
    let scopeGuardError: Error | undefined

    try {
      try {
        adapter = this.router.resolve(sessionId)
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          // Session 已被清理（如进程异常退出时 cleanupSessionResources 已执行）
          // 我们已经持有 cleanupInProgress 锁，直接调用 _doCleanupSessionResources，
          // 避免 cleanupSessionResources 的锁检查 short-circuit 导致残留状态未被释放。
          await this._doCleanupSessionResources(sessionId)
          return
        }
        throw err
      }

      // 提前提取 nodeId 和 sandbox（在状态被清除前读取）
      state = this.sessionStates.get(sessionId)
      nodeId = state?.config.nodeId
      sandbox = state?.sandbox
      // 抓拍 outputs，后续阶段 B 不再访问 sessionOutputBuffers
      outputsForMemory = this.sessionOutputBuffers.get(sessionId) ?? []

      // Persist the termination reason into state *before* deletion so that
      // the `abnormal` check in phase B (after the lock is released) can see it.
      // Without this, a `timeout` reason passed by the caller would be lost.
      // Default to 'error' when no reason is given — internal callers (timers, cleanup)
      // that omit reason are typically abnormal paths, not user-initiated termination.
      const terminationReason: TerminationReason = (reason === 'user' || reason === 'timeout' || reason === 'crash' || reason === 'error' || reason === 'idle')
        ? reason
        : (state?.terminationReason === 'user' || state?.terminationReason === 'timeout' || state?.terminationReason === 'crash' || state?.terminationReason === 'error' || state?.terminationReason === 'idle')
          ? state.terminationReason
          : 'error'
      if (state && reason) {
        state.terminationReason = reason
      }

      try {
        await adapter.terminateSession(sessionId, terminationReason)
      } finally {
        // 无论 terminateSession 是否成功，都确保清理路由和状态
        this.router.unbind(sessionId)
        this.sessionStates.delete(sessionId)
        this.sessionBroadcastNames.delete(sessionId)
        this.sessionOutputBuffers.delete(sessionId)
        // 清理 sandboxId → sessionId 反向索引
        if (sandbox) {
          this.sandboxSessionIndex.delete(sandbox.id)
        }
      }

      // ScopeGuard: 执行后验证并清理沙箱（仍在锁内，避免与异常退出回滚冲突）
      if (sandbox) {
        try {
          await this.scopeGuard.commitChanges(sandbox)
          if (nodeId) {
            this.statusChangeCallback?.(sessionId, nodeId, 'testing')
          }
        } catch (err) {
          if (err instanceof ScopeGuardError) {
            logger.error(`ScopeGuard validation failed for session ${sessionId}:`, err.message)
            scopeGuardError = err
          } else if (err instanceof Error) {
            logger.error(`ScopeGuard cleanup failed for session ${sessionId}:`, err.message)
          }
        }
      }
    } finally {
      // 阶段 A 完成（共享 Map 已清理干净），尽早释放清理互斥锁，
      // 让随后到达的 sessionEnded('crash') 事件可以正常触发 cleanupSessionResources。
      // 阶段 B 的记忆抽取/持久化不再访问共享 Map，因此可安全脱锁执行。
      this.cleanupInProgress.delete(sessionId)
    }

    // 阶段 B：记忆管线处理（不持锁）
    // 通过 ContextPipeline 统一管线执行：normalize → compress → extract → verify → compile → waterline → persist
    if (state) {
      try {
        const pipeline = await PipelineRunner.createDefault()
        const result = await pipeline.run({
          outputs: outputsForMemory,
          sessionId,
          adapterName: state.adapterName,
          projectId: state.config.workingDirectory,
          nodeId: state.config.nodeId,
        })

        if (result.errors.length > 0) {
          logger.warn(`Pipeline completed with ${result.errors.length} errors`)
        }
      } catch (err) {
        logger.warn(`Memory pipeline failed for session ${sessionId}:`, err)
      }
    }

    const abnormal = state?.terminationReason === 'crash' || state?.terminationReason === 'error' || state?.terminationReason === 'timeout'

    // Agent 日志：记录会话完成（附 Token 经济学指标）
    if (this.onSessionComplete && state) {
      const result = scopeGuardError || abnormal ? 'failure' : 'success'
      this.onSessionComplete(sessionId, state.adapterName, state.config.nodeId ?? '', result, Date.now() - state.startTime)
    }

    // Prompt 质量反馈环：记录命令类型 + 预算与结果的相关性
    if (state) {
      this.promptOutcomeLog.push({
        commandType: state.lastCommandType ?? 'implement',
        promptTokenEstimate: state.promptTokenEstimate ?? 0,
        contextCount: state.contextCount ?? 0,
        outcome: scopeGuardError || abnormal ? 'failure' : 'success',
        duration: Date.now() - state.startTime,
      })
      // 保留最近 100 条记录
      if (this.promptOutcomeLog.length > 100) {
        this.promptOutcomeLog.shift()
      }

      // Reset recovery attempts for this lineage on a healthy termination so future
      // crashes can be recovered again.  'idle' is included: it means the adapter
      // was alive and healthy but hit the inactivity timeout, not a failure.
      const terminationReason = reason ?? state.terminationReason
      if (terminationReason === 'success' || terminationReason === 'user' || terminationReason === 'idle') {
        this.sessionRecovery.reset(state.originSessionId ?? sessionId)
      }
    }

    // Task 2.4.2: File change auto-association with nodes
    // After session ends, match changed files against node metadata.linkedFiles
    if (state && nodeId) {
      try {
        const fileChangeOutputs = outputsForMemory.filter((o) => o.type === 'file_change' && o.filePath)
        if (fileChangeOutputs.length > 0) {
          const db = getClient()
          const changedPaths = fileChangeOutputs.map((o) => o.filePath!)

          // Look up the session's node to read metadata.linkedFiles
          const row = db.prepare('SELECT id, metadata FROM nodes WHERE id = ?').get(nodeId) as Record<string, unknown> | undefined
          if (row) {
            try {
              const metadata: NodeMetadata & { linkedFiles?: string[]; lastModified?: number } = row.metadata ? JSON.parse(row.metadata as string) : {}
              const linkedFiles: string[] = metadata.linkedFiles ?? []
              // Check if any changed file matches a linked file
              const matchedFiles = changedPaths.filter((fp) =>
                linkedFiles.some((lf) => fp.endsWith(lf) || lf.endsWith(fp)),
              )
              if (matchedFiles.length > 0) {
                // Update metadata.lastModified
                metadata.lastModified = Date.now()
                const { NodeRepository } = await import('../repositories/node-repository')
                const nodeRepo = new NodeRepository(db)
                await nodeRepo.update(nodeId, { metadata })
              }
            } catch (e) {
              logger.warn('Failed to parse metadata for file-node association', { nodeId, error: String(e) })
            }
          }
        }
      } catch (e) {
        logger.warn('File-node association failed during session termination', { error: String(e) })
      }
    }

    if (scopeGuardError) {
      throw scopeGuardError
    }
  }

  /**
   * Phase 3 Task 3: Compact the context of a session.
   *
   * - Dedups concurrent calls on the same session
   * - Resolves strategy (explicit param or adapter's defaultCompactStrategy or 'summary')
   * - Broadcasts system messages before/after
   * - Falls back native/llm → summary on failure
   * - Persists to compact_history
   * - Updates chat_threads last_compacted_at + context_tokens_used
   * - Notifies waterline via onCompacted
   */
  async compactContext(
    sessionId: string,
    strategy?: CompactStrategy,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    const existing = this.compactInflight.get(sessionId)
    if (existing) return existing

    const promise = this._doCompactContext(sessionId, strategy, options)
    this.compactInflight.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.compactInflight.delete(sessionId)
    }
  }

  private async _doCompactContext(
    sessionId: string,
    strategy: CompactStrategy | undefined,
    options: { reason?: CompactTrigger } | undefined,
  ): Promise<CompactResult> {
    const state = this.sessionStates.get(sessionId)
    if (!state) {
      throw new AgentError(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    }
    const adapter = this.registry.get(state.adapterName) as BaseAdapter | undefined
    if (!adapter) {
      throw new AgentError(
        `Adapter ${state.adapterName} not found`,
        ErrorCode.AGENT_ADAPTER_NOT_FOUND,
      )
    }
    const VALID_STRATEGIES: readonly CompactStrategy[] = ['native', 'llm', 'summary']
    const descriptor = ADAPTER_REGISTRY.find((d) => d.name === state.adapterName)
    const rawStrategy = strategy
      ?? (descriptor as { defaultCompactStrategy?: CompactStrategy } | undefined)?.defaultCompactStrategy
      ?? 'summary'
    const finalStrategy: CompactStrategy = VALID_STRATEGIES.includes(rawStrategy) ? rawStrategy : 'summary'
    const threadId = state.threadId

    // Broadcast "compacting" notification
    this.broadcaster.broadcast(state.broadcastName, {
      type: 'system',
      data: `Compacting context (${finalStrategy})...`,
      timestamp: Date.now(),
    }, sessionId)

    let result: CompactResult
    try {
      result = await adapter.compactContext(sessionId, finalStrategy, options)
    } catch (err) {
      if (finalStrategy === 'native' || finalStrategy === 'llm') {
        logger.warn(`[Compact] ${finalStrategy} failed, falling back to summary: ${err}`)
        this.broadcaster.broadcast(state.broadcastName, {
          type: 'system',
          data: `${finalStrategy} compaction failed, falling back to summary rewrite.`,
          timestamp: Date.now(),
        }, sessionId)
        result = await adapter.compactContext(sessionId, 'summary', options)
      } else {
        throw err
      }
    }

    // Persist history (non-blocking on error)
    // Skip for deferred compactions — the real reduction hasn't happened yet.
    if (!result.deferred && this.compactHistoryRepo) {
      try {
        await this.compactHistoryRepo.insert({
          threadId: threadId ?? null,
          sessionId,
          strategy: result.strategy,
          trigger: result.trigger,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          summary: result.summary ?? null,
          startedAt: result.startedAt,
          durationMs: result.durationMs,
        })
      } catch (err) {
        logger.warn(`[Compact] Failed to insert history: ${err}`)
      }
    }

    // Update thread waterline metadata (non-blocking on error)
    // Skip for deferred compactions — tokensAfter is not yet accurate.
    if (!result.deferred && this.chatRepo && threadId) {
      try {
        await this.chatRepo.setLastCompactedAt(threadId, result.startedAt)
        await this.chatRepo.resetContextTokens(threadId, result.tokensAfter)
      } catch (err) {
        logger.warn(`[Compact] Failed to update thread waterline: ${err}`)
      }
    }

    // Update waterline in-memory state
    // Skip for deferred compactions — will be updated when SDK reports real usage.
    if (!result.deferred && this.waterline && threadId) {
      this.waterline.onCompacted(threadId, result.tokensAfter, result.startedAt)
    }

    // Broadcast completion
    if (result.deferred) {
      this.broadcaster.broadcast(state.broadcastName, {
        type: 'system',
        data: `Native compact enabled — SDK will compact on next turn`,
        timestamp: Date.now(),
      }, sessionId)
    } else {
      this.broadcaster.broadcast(state.broadcastName, {
        type: 'system',
        data: `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.durationMs}ms)`,
        timestamp: Date.now(),
      }, sessionId)
    }

    return result
  }

  /**
   * 添加全局输出监听器（用于 MindMapAgent 等内部组件收集输出）
   */
  addOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = (payload: BroadcastPayload) => handler(payload.output)
    // 存储包装后的 handler 以便移除
    this.outputListeners.set(handler, wrapped)
    this.broadcaster.onBroadcast(wrapped)
  }

  /**
   * 移除全局输出监听器
   */
  removeOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = this.outputListeners.get(handler)
    if (wrapped) {
      this.broadcaster.offBroadcast(wrapped)
      this.outputListeners.delete(handler)
    }
  }

  /**
   * 添加会话级输出监听器（仅接收指定 session 的输出）
   * 通过 broadcastName 过滤，防止跨会话输出污染
   */
  addSessionOutputListener(sessionId: string, handler: (output: AgentOutput) => void): void {
    const state = this.sessionStates.get(sessionId)
    if (!state) return
    const targetName = state.broadcastName

    const filteredHandler = (payload: BroadcastPayload) => {
      if (payload.adapterName === targetName) {
        handler(payload.output)
      }
    }
    this.sessionOutputListeners.set(handler, filteredHandler)
    // 记录 handler → sessionId 映射，以便 cleanupSessionResources 时自动清理
    let indexSet = this.sessionOutputListenerIndex.get(sessionId)
    if (!indexSet) {
      indexSet = new Set()
      this.sessionOutputListenerIndex.set(sessionId, indexSet)
    }
    indexSet.add(handler)
    this.broadcaster.onBroadcast(filteredHandler)
  }

  /**
   * 移除会话级输出监听器
   */
  removeSessionOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = this.sessionOutputListeners.get(handler)
    if (wrapped) {
      this.broadcaster.offBroadcast(wrapped)
      this.sessionOutputListeners.delete(handler)
      for (const [, handlers] of this.sessionOutputListenerIndex) {
        if (handlers.delete(handler) && handlers.size === 0) {
          // empty set retained for potential reuse
        }
      }
    }
  }

  private async _handleSessionEnded(
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

    // Build lastMessages from session output for context restoration
    const lastMessages = this._extractRecentMessages(outputs)

    // Look up threadId from the session's nodeId
    let threadId: string | undefined
    if (state.config.nodeId) {
      try {
        const db = getClient()
        const row = db.prepare('SELECT id FROM chat_threads WHERE node_id = ? ORDER BY created_at DESC LIMIT 1').get(state.config.nodeId) as { id: string } | undefined
        if (row) {
          threadId = row.id
        }
      } catch {
        // Non-critical: threadId is for notification only
      }
    }

    const originSessionId = state.originSessionId ?? sessionId
    const newSessionId = await this.sessionRecovery.attemptRecovery({
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
        // Native resume: keep the same sessionId active in the manager's maps.
        this.sessionStates.set(sessionId, state)
        this.sessionBroadcastNames.set(sessionId, state.broadcastName)
        // The third argument of SessionRouter.bind is originalAdapter (not broadcast name).
        // Native resume uses the same adapter, so no fallback metadata is needed.
        this.router.bind(sessionId, state.adapterName)
        return 'native'
      }

      // Replacement session created by the strategy itself.
      const newState = this.sessionStates.get(newSessionId)
      if (newState) {
        newState.originSessionId = originSessionId
      }
      if (state.lastCommand) {
        await this._resumeLastCommand(newSessionId, state.lastCommand)
      }
      return 'replacement'
    }

    // Check if MCP adapter recovery left a pending context injection
    const pendingContext = this.sessionRecovery.consumePendingContext(sessionId)
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

  /**
   * Safely resume the last user command on a recovered/replacement session.
   * Verifies the session exists and the target adapter is ready before sending.
   */
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

  /**
   * Extract recent messages from session output buffer for context restoration.
   * Returns up to 1 recent assistant message derived from output data
   * (stdout chunks are combined into a single message, last 2000 chars).
   */
  private _extractRecentMessages(outputs: AgentOutput[]): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []
    // Collect recent stdout output as "assistant" messages
    const stdoutChunks: string[] = []
    for (const output of outputs) {
      if (output.type === 'stdout') {
        stdoutChunks.push(output.data)
      }
    }
    // Combine recent stdout into a single assistant message (last 2000 chars)
    if (stdoutChunks.length > 0) {
      const combined = stdoutChunks.join('')
      messages.push({
        role: 'assistant',
        content: combined.slice(-2000),
      })
    }
    return messages
  }

  private _startFallbackRecoveryCheck(preferredAdapter: string, intervalMs = 60_000): void {
    if (this.fallbackRecoveryTimers.has(preferredAdapter)) return
    const interval = setInterval(async () => {
      const adapter = this.registry.get(preferredAdapter)
      if (!adapter) {
        clearInterval(interval)
        clearTimeout(this.fallbackRecoveryTimers.get(preferredAdapter)?.timeout)
        this.fallbackRecoveryTimers.delete(preferredAdapter)
        return
      }
      const installed = await adapter.checkInstalled()
      const health = this.healthMonitor.getHealth(preferredAdapter)
      if (installed && health && health.status === 'healthy') {
        logger.info(`Preferred adapter ${preferredAdapter} is healthy again`)
        const timers = this.fallbackRecoveryTimers.get(preferredAdapter)
        if (timers) { clearInterval(timers.interval); clearTimeout(timers.timeout) }
        this.fallbackRecoveryTimers.delete(preferredAdapter)
      }
    }, intervalMs)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      this.fallbackRecoveryTimers.delete(preferredAdapter)
    }, 5 * 60_000)
    timeout.unref()
    this.fallbackRecoveryTimers.set(preferredAdapter, { interval, timeout })
  }

  /**
   * Health-driven recovery check: periodically probes an unhealthy adapter
   * and records a successful check so the health monitor can promote it
   * back to degraded/healthy on the next session attempt.
   */
  private startRecoveryCheck(adapterName: string): void {
    if (this.recoveryCheckIntervals.has(adapterName)) return // already running for this adapter
    const interval = setInterval(async () => {
      const adapter = this.registry.get(adapterName)
      if (!adapter) {
        const activeInterval = this.recoveryCheckIntervals.get(adapterName)
        if (activeInterval) {
          clearInterval(activeInterval)
          this.recoveryCheckIntervals.delete(adapterName)
        }
        return
      }
      const installed = await adapter.checkInstalled()
      if (installed) {
        this.healthMonitor.recordCall(adapterName, true, 0, 'recovery-check')
        const activeInterval = this.recoveryCheckIntervals.get(adapterName)
        if (activeInterval) {
          clearInterval(activeInterval)
          this.recoveryCheckIntervals.delete(adapterName)
        }
      }
    }, 60_000)
    this.recoveryCheckIntervals.set(adapterName, interval)
  }
}
