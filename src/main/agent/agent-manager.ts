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
} from '@shared/types'
import { AdapterRegistry } from './adapter-registry'
import { SessionRouter } from './session-router'
import { OutputBroadcaster } from './output-broadcaster'
import { AdapterError, SessionNotFoundError, ScopeGuardError } from '../errors'
import { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'
import { SmartContextResolver } from '../code-intelligence/smart-context-resolver'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import { createLogger } from '../shared/logger'

const logger = createLogger('AgentManager')

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

    // 注册 ScopeGuard 越界回调：检测到越界写入时自动终止对应 session
    this.scopeGuard.onViolation(async (sandboxId, violations) => {
      logger.error('Scope violation detected:', violations)
      for (const [sessionId, state] of this.sessionStates) {
        if (state.sandbox?.id === sandboxId) {
          try {
            await this.terminateSession(sessionId)
          } catch (err) {
            logger.warn('Failed to terminate session during scope violation cleanup:', err)
          }
          break
        }
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
   * 清理指定 session 的所有资源（沙箱、路由、广播名等）
   */
  private cleanupSessionResources(sessionId: string): void {
    const state = this.sessionStates.get(sessionId)

    // ScopeGuard: 异常退出时回滚沙箱
    if (state?.sandbox) {
      this.scopeGuard.rollback(state.sandbox).catch((err) => {
        logger.error(`Failed to rollback sandbox for session ${sessionId}:`, err)
      })
    }

    this.sessionStates.delete(sessionId)
    this.sessionBroadcastNames.delete(sessionId)
    this.router.unbind(sessionId)
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
    // 停止 SessionRouter 的 TTL 检查
    this.router.stopTtlCheck()
    // 清理所有会话级输出监听器
    for (const wrapped of this.sessionOutputListeners.values()) {
      this.broadcaster.offBroadcast(wrapped)
    }
    this.sessionOutputListeners.clear()
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
    const fallbackChain = [primary, ...preferences.fallbackOrder.filter((a) => a !== primary)]

    // 去重
    const seen = new Set<string>()
    const uniqueChain = fallbackChain.filter((a) => {
      if (seen.has(a)) return false
      seen.add(a)
      return true
    })

    const fallbackHistory: AdapterFallbackAttempt[] = []

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
          fallback: isFallback,
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

    // 并行执行上下文解析和智能代码解析（两者互不依赖）
    const [resolvedContexts, codeContext] = await Promise.all([
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
    }

    await this.sendCommand(sessionId, command)
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
    }
  }
}
