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
} from '@shared/types'
import { AdapterRegistry } from './adapter-registry'
import { SessionRouter } from './session-router'
import { OutputBroadcaster } from './output-broadcaster'
import { AdapterHealthMonitor, type AdapterHealthScore } from './adapter-health-monitor'
import { AdapterError, AgentError, SessionNotFoundError, ScopeGuardError } from '../errors'
import { ErrorCode } from '../errors'
import { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'
import { SmartContextResolver } from '../code-intelligence/smart-context-resolver'
import { readMemory } from '../mindmap-agent/memory'
import { MemoryStore } from '../memory'
import { PromptOrchestrator } from '../memory/prompt-orchestrator'
import { PipelineRunner } from '../memory/pipeline'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import { createLogger } from '../shared/logger'
import os from 'node:os'

const logger = createLogger('AgentManager')

/** 健康检查间隔：每 10 分钟输出一次诊断日志 */
const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000
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

type SessionEndedHandler = (sessionId: string, reason: 'success' | 'crash' | 'error') => void

interface SessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  startTime: number
  sandbox?: import('@shared/types').Sandbox
  /** 最后一次发送的指令类型（用于记忆提取的语义区分） */
  lastCommandType?: AgentCommandType
  /** Prompt Token 估算值（用于质量反馈环） */
  promptTokenEstimate?: number
  /** 注入的上下文数量（用于质量反馈环） */
  contextCount?: number
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
  private outputListeners = new Map<(output: AgentOutput) => void, (adapterName: string, output: AgentOutput) => void>()
  private contextResolver = new ContextResolver()
  private scopeGuard = new ScopeGuard()
  private smartContextResolver?: SmartContextResolver
  private sessionStates = new Map<string, SessionState>()
  /** sessionEnded 事件处理器（按适配器存储以便清理） */
  private sessionEndedHandlers = new Map<string, SessionEndedHandler>()
  private statusChangeCallback?: (sessionId: string, nodeId: string, status: string) => void
  private onSessionComplete?: (sessionId: string, adapterName: string, nodeId: string, result: 'success' | 'failure' | 'cancelled', duration: number) => void
  /** 会话级输出监听器：按 broadcastName 过滤，防止跨会话输出污染 */
  private sessionOutputListeners = new Map<(output: AgentOutput) => void, (adapterName: string, output: AgentOutput) => void>()
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
    if (!this._memoryStore) this._memoryStore = new MemoryStore()
    return this._memoryStore
  }
  /** 会话输出缓冲区：sessionId → AgentOutput[]（用于记忆提取） */
  private sessionOutputBuffers = new Map<string, AgentOutput[]>()

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
        await this.terminateSession(sessionId)
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
        this.broadcaster.broadcast(broadcastName, output)
        return
      }
      this.broadcaster.broadcast(adapter.name, output)
    }
    this.outputHandlers.set(adapter.name, handler)
    adapter.onOutput(handler)

    // 监听 session 异常结束事件，自动清理沙箱等资源
    const sessionEndedHandler: SessionEndedHandler = (sessionId, reason) => {
      if (reason === 'crash' || reason === 'error') {
        logger.warn(`Session ${sessionId} ended abnormally (${reason}), cleaning up...`)
        this.cleanupSessionResources(sessionId)
      }
    }
    this.sessionEndedHandlers.set(adapter.name, sessionEndedHandler)
    adapter.on('sessionEnded', sessionEndedHandler)
  }

  /**
   * 清理指定 session 的所有资源（沙箱、路由、广播名、输出监听器等）
   * 通过 cleanupInProgress 互斥锁防止与 terminateSession 并发导致双重清理
   */
  private cleanupSessionResources(sessionId: string): void {
    // 互斥检查：若已在清理中，跳过
    if (this.cleanupInProgress.has(sessionId)) return
    this.cleanupInProgress.add(sessionId)

    try {
      this._doCleanupSessionResources(sessionId)
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
   */
  private _doCleanupSessionResources(sessionId: string): void {
    const state = this.sessionStates.get(sessionId)

    // 终止 adapter 会话（防止子进程泄漏）
    try {
      const adapterName = this.router.getAdapterName(sessionId)
      if (adapterName) {
        const adapter = this.registry.get(adapterName)
        if (adapter) {
          adapter.terminateSession(sessionId).catch((err: unknown) => {
            logger.warn(`Failed to terminate adapter session ${sessionId}:`, err)
          })
        }
      }
    } catch {
      // 路由条目可能已不存在，忽略
    }

    // ScopeGuard: 异常退出时回滚沙箱（带重试机制，防止临时文件系统错误导致资源泄漏）
    if (state?.sandbox) {
      const sandbox = state.sandbox
      this.sandboxSessionIndex.delete(sandbox.id)
      this.rollbackWithRetry(sessionId, sandbox, 2).catch((err: unknown) => {
        logger.error(`Failed to rollback sandbox for session ${sessionId} after retries:`, err)
      })
    }

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
    this.router.unbind(sessionId)
  }

  /**
   * 带回滚重试的沙箱回滚操作
   * 当回滚因临时性文件系统错误失败时，按指数退避重试，
   * 防止因资源未释放导致的后续会话异常。
   */
  private async rollbackWithRetry(
    sessionId: string,
    sandbox: import('@shared/types').Sandbox,
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
      this.terminateSession(sessionId).catch((err) => {
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
      this.memoryStore.pruneStale(90).catch((err) => {
        logger.warn('Memory pruneStale failed:', err)
      })
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
    // 清理 ScopeGuard 所有定时器和 watcher
    this.scopeGuard.destroy()
  }

  /**
   * 终止所有活跃会话并释放资源（进程退出时调用）
   */
  async terminateAllSessions(): Promise<void> {
    const sessionIds = this.router.getActiveSessionIds()
    await Promise.allSettled(
      sessionIds.map((id) => this.terminateSession(id)),
    )
    this.sessionStates.clear()
  }

  setStatusChangeCallback(cb: (sessionId: string, nodeId: string, status: string) => void): void {
    this.statusChangeCallback = cb
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

  getSandbox(sessionId: string): import('@shared/types').Sandbox | undefined {
    return this.sessionStates.get(sessionId)?.sandbox
  }

  /**
   * 获取所有活跃会话 ID
   */
  getActiveSessionIds(): string[] {
    return this.router.getActiveSessionIds()
  }

  get scopeGuardInstance(): import('../scope-guard').ScopeGuard {
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
    const uniqueChain = fallbackChain.filter((a) => {
      if (seen.has(a)) return false
      seen.add(a)
      return true
    })

    const fallbackHistory: AdapterFallbackAttempt[] = []

    // 检查会话上限，防止无限创建
    if (this.sessionStates.size >= this.MAX_SESSIONS) {
      logger.error(`Maximum session limit (${this.MAX_SESSIONS}) reached, cannot create new session`)
      throw new AgentError('Maximum concurrent sessions exceeded', ErrorCode.AGENT_SESSION_LIMIT)
    }

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

      const startTime = Date.now()
      try {
        const session = await adapter.startSession(config)

        let sandbox: import('@shared/types').Sandbox | undefined
        if (config.allowedFiles.length > 0) {
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
        })
        this.sessionBroadcastNames.set(session.id, broadcastName)

        // fallback 时路由记录实际适配器名
        this.router.bind(session.id, candidate, isFallback ? primary : undefined)

        // 如果是 fallback，在 session 上记录 fallbackInfo（保持向后兼容）
        if (isFallback) {
          session.fallbackInfo = {
            originalAdapter: primary,
            fallbackReason: `${primary} not available, using ${candidate}`,
          }
        }

        if (config.nodeId) {
          this.statusChangeCallback?.(session.id, config.nodeId, 'developing')
        }

        // MEM-01: 初始化会话输出缓冲（用于记忆提取）
        const sessionOutputs: AgentOutput[] = []
        this.sessionOutputBuffers.set(session.id, sessionOutputs)
        this.addSessionOutputListener(session.id, (output) => {
          // 只收集有实质内容的输出（保护内存）
          if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'file_change' || output.type === 'complete') {
            sessionOutputs.push(output)
            // 限制缓冲区大小，防止内存无限增长
            if (sessionOutputs.length > 500) {
              sessionOutputs.splice(0, sessionOutputs.length - 500)
            }
          }
        })

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
        logger.warn(`Adapter ${candidate} startSession failed: ${reason}, trying next...`)
        continue
      }
    }

    // 所有适配器都失败
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
        logger.warn('Failed to load adapter preferences, using defaults:', err)
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
  private formatCodeContext(ctx: import('../code-intelligence/smart-context-resolver').ResolvedCodeContext): string {
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

  async terminateSession(sessionId: string): Promise<void> {
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
          this._doCleanupSessionResources(sessionId)
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

      try {
        await adapter.terminateSession(sessionId)
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

    // Agent 日志：记录会话完成（附 Token 经济学指标）
    if (this.onSessionComplete && state) {
      const result = scopeGuardError ? 'failure' : 'success'
      this.onSessionComplete(sessionId, state.adapterName, state.config.nodeId ?? '', result, Date.now() - state.startTime)
    }

    // Prompt 质量反馈环：记录命令类型 + 预算与结果的相关性
    if (state) {
      this.promptOutcomeLog.push({
        commandType: state.lastCommandType ?? 'implement',
        promptTokenEstimate: state.promptTokenEstimate ?? 0,
        contextCount: state.contextCount ?? 0,
        outcome: scopeGuardError ? 'failure' : 'success',
        duration: Date.now() - state.startTime,
      })
      // 保留最近 100 条记录
      if (this.promptOutcomeLog.length > 100) {
        this.promptOutcomeLog.shift()
      }
    }

    if (scopeGuardError) {
      throw scopeGuardError
    }
  }

  /**
   * 添加全局输出监听器（用于 MindMapAgent 等内部组件收集输出）
   */
  addOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = (_adapterName: string, output: AgentOutput) => handler(output)
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
    const broadcastName = this.sessionBroadcastNames.get(sessionId)
    if (!broadcastName) {
      logger.warn(`addSessionOutputListener: no broadcast name for session ${sessionId}`)
      return
    }
    const wrapped = (name: string, output: AgentOutput) => {
      if (name === broadcastName) {
        handler(output)
      }
    }
    this.sessionOutputListeners.set(handler, wrapped)
    // 记录 handler → sessionId 映射，以便 cleanupSessionResources 时自动清理
    let indexSet = this.sessionOutputListenerIndex.get(sessionId)
    if (!indexSet) {
      indexSet = new Set()
      this.sessionOutputListenerIndex.set(sessionId, indexSet)
    }
    indexSet.add(handler)
    this.broadcaster.onBroadcast(wrapped)
  }

  /**
   * 移除会话级输出监听器
   */
  removeSessionOutputListener(handler: (output: AgentOutput) => void): void {
    const wrapped = this.sessionOutputListeners.get(handler)
    if (wrapped) {
      this.broadcaster.offBroadcast(wrapped)
      this.sessionOutputListeners.delete(handler)
      // 同步清理 sessionOutputListenerIndex 中的引用
      for (const [, handlers] of this.sessionOutputListenerIndex) {
        if (handlers.delete(handler) && handlers.size === 0) {
          // Set 为空时保留条目无意义，但 sessionId 可能后续还会 addSessionOutputListener，
          // 因此不主动 delete 整个 Set，避免频繁创建/销毁
        }
      }
    }
  }
}
