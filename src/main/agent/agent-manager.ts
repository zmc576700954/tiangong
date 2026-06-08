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
} from '@shared/types'
import { AdapterRegistry } from './adapter-registry'
import { SessionRouter } from './session-router'
import { OutputBroadcaster } from './output-broadcaster'
import { AdapterError, SessionNotFoundError, ScopeGuardError } from '../errors'
import { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'

type SessionEndedHandler = (sessionId: string, reason: 'success' | 'crash' | 'error') => void

interface SessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  sandbox?: import('@shared/types').Sandbox
}

export class AgentManager {
  private outputHandlers = new Map<string, (output: AgentOutput) => void>()
  private outputListeners = new Map<(output: AgentOutput) => void, (adapterName: string, output: AgentOutput) => void>()
  private contextResolver = new ContextResolver()
  private scopeGuard = new ScopeGuard()
  private sessionStates = new Map<string, SessionState>()
  /** sessionEnded 事件处理器（按适配器存储以便清理） */
  private sessionEndedHandlers = new Map<string, SessionEndedHandler>()
  private statusChangeCallback?: (sessionId: string, nodeId: string, status: string) => void

  constructor(
    private registry: AdapterRegistry,
    private router: SessionRouter,
    private broadcaster: OutputBroadcaster,
  ) {
    // 为每个已注册的适配器绑定输出监听
    for (const adapter of this.registry.list()) {
      this.attachAdapterOutput(adapter)
    }

    // 注册 ScopeGuard 越界回调：检测到越界写入时自动终止对应 session
    this.scopeGuard.onViolation(async (sandboxId, violations) => {
      console.error(`[AgentManager] Scope violation detected:`, violations)
      for (const [sessionId, state] of this.sessionStates) {
        if (state.sandbox?.id === sandboxId) {
          try {
            await this.terminateSession(sessionId)
          } catch {
            // 已终止或终止失败，忽略
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
        console.warn(`[AgentManager] Session ${sessionId} ended abnormally (${reason}), cleaning up...`)
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
        console.error(`[AgentManager] Failed to rollback sandbox for session ${sessionId}:`, err)
      })
    }

    this.sessionStates.delete(sessionId)
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
    adapterName: string,
    config: AgentSessionConfig,
  ): Promise<{ sessionId: string; fallback?: boolean }> {
    const adapter = this.registry.get(adapterName)
    if (!adapter) {
      throw new AdapterError(`Adapter ${adapterName} not found`, adapterName)
    }

    const isInstalled = await adapter.checkInstalled()
    if (!isInstalled) {
      const mcp = this.registry.get('mcp')
      if (mcp && (await mcp.checkInstalled())) {
        console.warn(`[AgentManager] Adapter ${adapterName} not installed, falling back to MCP`)
        const session = await mcp.startSession(config)
        session.fallbackInfo = {
          originalAdapter: adapterName,
          fallbackReason: `${adapterName} not installed`,
        }
        this.sessionStates.set(session.id, {
          config,
          broadcastName: adapterName,
          adapterName,
        })
        this.router.bind(session.id, mcp.name, adapterName)
        return { sessionId: session.id, fallback: true }
      }
      throw new AdapterError(
        `Adapter ${adapterName} is not installed and MCP fallback is not available`,
        adapterName,
      )
    }

    const session = await adapter.startSession(config)

    let sandbox: import('@shared/types').Sandbox | undefined
    if (config.allowedFiles.length > 0) {
      sandbox = await this.scopeGuard.prepareSandbox(
        config.allowedFiles,
        config.workingDirectory,
      )
    }

    this.sessionStates.set(session.id, {
      config,
      broadcastName: adapterName,
      adapterName,
      sandbox,
    })

    this.router.bind(session.id, adapterName)
    // Emit status change: node → developing
    if (config.nodeId) {
      this.statusChangeCallback?.(session.id, config.nodeId, 'developing')
    }
    return { sessionId: session.id }
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
    let resolvedContexts: ResolvedContext[] = []

    if (contextRefs && contextRefs.length > 0) {
      const sessionConfig = this.sessionStates.get(sessionId)?.config
      resolvedContexts = await this.contextResolver.resolve(contextRefs, 8000, {
        nodes: nodes ?? [],
        basePath: sessionConfig?.workingDirectory,
      })
    }

    // Store resolved contexts on the session so adapter can access them
    const adapter = this.router.resolve(sessionId)
    if (adapter && resolvedContexts.length > 0) {
      adapter.setResolvedContexts(sessionId, resolvedContexts)
    }

    await this.sendCommand(sessionId, command)
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

    await adapter.terminateSession(sessionId)
    this.router.unbind(sessionId)

    // 保存 nodeId 用于后续状态变更（delete 前提取，避免 config 被清除后无法读取）
    const state = this.sessionStates.get(sessionId)
    const nodeId = state?.config.nodeId
    const sandbox = state?.sandbox

    this.sessionStates.delete(sessionId)

    // ScopeGuard: 执行后验证并清理沙箱
    let scopeGuardError: Error | undefined
    if (sandbox) {
      try {
        await this.scopeGuard.commitChanges(sandbox)
        if (nodeId) {
          this.statusChangeCallback?.(sessionId, nodeId, 'testing')
        }
      } catch (err) {
        if (err instanceof ScopeGuardError) {
          console.error(`[AgentManager] ScopeGuard validation failed for session ${sessionId}:`, err.message)
          scopeGuardError = err
        } else if (err instanceof Error) {
          console.error(`[AgentManager] ScopeGuard cleanup failed for session ${sessionId}:`, err.message)
        }
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
}
