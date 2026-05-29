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

export class AgentManager {
  private outputHandlers = new Map<string, (output: AgentOutput) => void>()
  private contextResolver = new ContextResolver()

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
    // 注意：registry/router/broadcaster 的生命周期由调用方管理
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
        const session = await mcp.startSession(config)
        this.router.bind(session.id, mcp.name)
        return { sessionId: session.id, fallback: true }
      }
    }

    const session = await adapter.startSession(config)
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
  }
}
