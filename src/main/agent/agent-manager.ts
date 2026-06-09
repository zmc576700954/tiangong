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
import { AdapterError, AgentError, SessionNotFoundError, ScopeGuardError } from '../errors'
import { ErrorCode } from '../errors'
import { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'
import { SmartContextResolver } from '../code-intelligence/smart-context-resolver'
import { readMemory } from '../mindmap-agent/memory'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import { createLogger } from '../shared/logger'

const logger = createLogger('AgentManager')

/** 健康检查间隔：每 10 分钟输出一次诊断日志 */
const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000

type SessionEndedHandler = (sessionId: string, reason: 'success' | 'crash' | 'error') => void

interface SessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  startTime: number
  sandbox?: import('@shared/types').Sandbox
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
  private readonly MAX_SESSIONS = 100
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
  /** 健康检查定时器（定期输出诊断日志，监控内存与资源状态） */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  /** 适配器偏好加载器（延迟注入，避免循环依赖） */
  private adapterPreferencesLoader?: () => Promise<AdapterPreferences>

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
      const state = this.sessionStates.get(sessionId)

      // ScopeGuard: 异常退出时回滚沙箱
      if (state?.sandbox) {
        this.sandboxSessionIndex.delete(state.sandbox.id)
        this.scopeGuard.rollback(state.sandbox).catch((err) => {
          logger.error(`Failed to rollback sandbox for session ${sessionId}:`, err)
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
      this.router.unbind(sessionId)
    } finally {
      // 释放互斥锁：确保即使清理过程中抛异常也不会死锁
      this.cleanupInProgress.delete(sessionId)
    }
  }

  /**
   * 输出诊断日志，用于监控内存使用情况
   * 可在 destroy() 前或定时调用
   */
  logDiagnostics(): void {
    logger.info('AgentManager diagnostics', {
      activeSessions: this.sessionStates.size,
      outputHandlers: this.outputHandlers.size,
      sessionBroadcastNames: this.sessionBroadcastNames.size,
      sessionOutputListenerIndex: this.sessionOutputListenerIndex.size,
      sandboxSessionIndex: this.sandboxSessionIndex.size,
      cleanupInProgress: this.cleanupInProgress.size,
    })
  }

  /**
   * 启动定期健康检查（每 HEALTH_CHECK_INTERVAL_MS 输出诊断日志）
   * 用于长期运行时监控内存占用和资源泄漏
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) return
    this.healthCheckTimer = setInterval(() => {
      this.logDiagnostics()
    }, HEALTH_CHECK_INTERVAL_MS)
    // 不阻止进程退出
    if (this.healthCheckTimer && typeof this.healthCheckTimer === 'object' && 'unref' in this.healthCheckTimer) {
      (this.healthCheckTimer as ReturnType<typeof setInterval> & { unref(): void }).unref()
    }
  }

  /**
   * 停止健康检查定时器
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
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

        const isFallback = candidate !== primary
        const broadcastName = isFallback ? primary : candidate

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

        return {
          sessionId: session.id,
          fallback: isFallback || undefined,
          adapterUsed: candidate,
          fallbackHistory,
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        fallbackHistory.push({ adapter: candidate, reason: `startSession failed: ${reason}`, success: false })
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
    await adapter.sendCommand(sessionId, command)
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

    // 并行执行上下文解析、智能代码解析、项目记忆加载（三者互不依赖）
    const [resolvedContexts, codeContext, memoryContext] = await Promise.all([
      // 标准上下文解析
      (contextRefs && contextRefs.length > 0)
        ? this.contextResolver.resolve(contextRefs, 8000, {
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
    ])

    // Store resolved contexts on the session so adapter can access them
    const adapter = this.router.resolve(sessionId)
    if (adapter) {
      if (resolvedContexts.length > 0) {
        adapter.setResolvedContexts(sessionId, resolvedContexts)
      }
      if (codeContext) {
        adapter.setCodeContext(sessionId, codeContext)
      }
      if (memoryContext) {
        adapter.setCodeContext(sessionId, (adapter as any).sessions?.get(sessionId)?.codeContext
          ? (adapter as any).sessions.get(sessionId).codeContext + '\n\n' + memoryContext
          : memoryContext)
      }
    }

    await this.sendCommand(sessionId, command)
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

  async terminateSession(sessionId: string): Promise<void> {
    // 互斥检查：若 cleanupSessionResources 已在清理，直接返回
    if (this.cleanupInProgress.has(sessionId)) {
      logger.info(`Session ${sessionId} already being cleaned up, skipping terminateSession`)
      return
    }
    // 标记清理中，防止后续 sessionEnded 事件触发 cleanupSessionResources 并发清理
    this.cleanupInProgress.add(sessionId)

    let adapter: AgentAdapter | undefined
    try {
      adapter = this.router.resolve(sessionId)
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        // Session 已被清理（如进程异常退出时 cleanupSessionResources 已执行）
        // 确保残留资源也被清除
        this.cleanupSessionResources(sessionId)
        return
      }
      throw err
    }

    // 提前提取 nodeId 和 sandbox（在 finally 之前，避免 config 被清除后无法读取）
    const state = this.sessionStates.get(sessionId)
    const nodeId = state?.config.nodeId
    const sandbox = state?.sandbox

    let scopeGuardError: Error | undefined
    try {
      await adapter.terminateSession(sessionId)
    } finally {
      // 无论 terminateSession 是否成功，都确保清理路由和状态
      this.router.unbind(sessionId)
      this.sessionStates.delete(sessionId)
      this.sessionBroadcastNames.delete(sessionId)
      // 清理 sandboxId → sessionId 反向索引
      if (sandbox) {
        this.sandboxSessionIndex.delete(sandbox.id)
      }
      // 释放互斥锁
      this.cleanupInProgress.delete(sessionId)
    }

    // ScopeGuard: 执行后验证并清理沙箱
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
    // Agent 日志：记录会话完成
    if (this.onSessionComplete && state) {
      const result = scopeGuardError ? 'failure' : 'success'
      this.onSessionComplete(sessionId, state.adapterName, state.config.nodeId ?? '', result, Date.now() - state.startTime)
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
