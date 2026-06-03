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
import { AdapterError, SessionNotFoundError } from '../errors'
import { ContextResolver } from '../context-resolver'
import { ScopeGuard } from '../scope-guard'

export class AgentManager {
  private outputHandlers = new Map<string, (output: AgentOutput) => void>()
  private outputListeners = new Map<(output: AgentOutput) => void, (adapterName: string, output: AgentOutput) => void>()
  private contextResolver = new ContextResolver()
  private scopeGuard = new ScopeGuard()
  private sandboxes = new Map<string, { id: string }>()
  /** sessionId → broadcastName（用户请求的原始适配器名，用于 fallback 时显示） */
  private broadcastNames = new Map<string, string>()

  constructor(
    private registry: AdapterRegistry,
    private router: SessionRouter,
    private broadcaster: OutputBroadcaster,
  ) {
    // 为每个已注册的适配器绑定输出监听
    for (const adapter of this.registry.list()) {
      this.attachAdapterOutput(adapter)
    }
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
      // 从输出中解析关联的 sessionId（BaseAdapter 通过 WeakMap 关联）
      const sessionId = adapter.resolveOutputSession?.(output)
      if (sessionId) {
        const broadcastName = this.broadcastNames.get(sessionId) ?? adapter.name
        this.broadcaster.broadcast(broadcastName, output)
        return
      }
      // 无 sessionId 关联的输出（如旧代码或内部组件输出），使用适配器本名广播
      this.broadcaster.broadcast(adapter.name, output)
    }
    this.outputHandlers.set(adapter.name, handler)
    adapter.onOutput(handler)
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
    this.outputHandlers.clear()
    this.broadcastNames.clear()
    // 注意：registry/router/broadcaster 的生命周期由调用方管理
  }

  /**
   * 终止所有活跃会话并释放资源（进程退出时调用）
   */
  async terminateAllSessions(): Promise<void> {
    const sessionIds = this.router.getActiveSessionIds()
    await Promise.allSettled(
      sessionIds.map((id) => this.terminateSession(id)),
    )
    this.broadcastNames.clear()
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
        this.router.bind(session.id, mcp.name, adapterName)
        return { sessionId: session.id, fallback: true }
      }
      throw new AdapterError(
        `Adapter ${adapterName} is not installed and MCP fallback is not available`,
        adapterName,
      )
    }

    const session = await adapter.startSession(config)

    // 保存用户请求的原始适配器名，用于输出广播（支持 fallback 显示）
    this.broadcastNames.set(session.id, adapterName)

    // ScopeGuard: 启动文件变更边界保护
    if (config.allowedFiles.length > 0) {
      const scopeSandbox = await this.scopeGuard.prepareSandbox(
        config.allowedFiles,
        config.workingDirectory,
      )
      this.sandboxes.set(session.id, scopeSandbox)
    }

    this.router.bind(session.id, adapterName)
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
      resolvedContexts = await this.contextResolver.resolve(contextRefs, 8000, {
        nodes: nodes ?? [],
        basePath: config.workingDirectory,
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
    const adapter = this.router.resolve(sessionId)
    if (!adapter) return
    await adapter.terminateSession(sessionId)
    this.router.unbind(sessionId)

    // 清理 broadcastName 映射
    this.broadcastNames.delete(sessionId)

    // ScopeGuard: 执行后验证并清理沙箱
    const sandbox = this.sandboxes.get(sessionId)
    if (sandbox) {
      try {
        await this.scopeGuard.commitChanges(sandbox)
      } catch (err) {
        if (err instanceof Error && err.name === 'ScopeGuardError') {
          // 验证失败（越界写入），错误已包含在 commitChanges 的日志中
          // 向上传播，让调用者知道回滚已执行
          console.error(`[AgentManager] ScopeGuard validation failed for session ${sessionId}:`, err.message)
        }
        // 其他错误（如沙箱已被自动回滚清理）忽略
      }
      this.sandboxes.delete(sessionId)
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
