/**
 * A2A subsystem wiring — 装配 AgentManager ↔ A2AServer adapter + SubagentManager ↔ A2AClient。
 *
 * Phase D9 C5. 设计要点：
 *   - sessionStarters（MessageSend/Stream）薄包装 AgentManager 的 startSession /
 *     sendCommand / addSessionOutputListener / terminateSession。AgentManager 是
 *     session 真实拥有者，A2A 仅暴露与 wire 层匹配的最小接口。
 *   - A2AServer + A2AClient 都在 wireA2ASubsystem 内实例化，并挂上 settings.onChange
 *     的 hot-reload handler：settings 写入 → 重建 server / 重建 clients。
 *   - settings 读路径：直接调 readSettings()（不持有缓存；hot-reload 由 onChange 触发）。
 *
 * **不**注入 BizGraph memory / scope 到下游 prompt：CLAUDE.md Boundaries §3。
 */

import { setA2AServer } from '../index'
import { createLogger } from '../shared/logger'
import { readSettings, onChange } from '../settings'
import type { A2ARemoteAgent, A2AServerConfig, A2AArtifact, A2AMessage, A2AAgentCard } from '@shared/types/a2a'
import type { AgentManager } from '../agent/agent-manager'
import type { SubagentManager } from '../agent/subagent-manager'
import { A2AClient } from './client'
import { A2AServer } from './server'
import { A2ATaskStore } from './task-store'
import type { MessageSendSessionStarter } from './routes/message-send'
import type { MessageStreamSessionStarter } from './routes/message-stream'
import type { AgentOutput, AgentCommand } from '@shared/types/agent'

const logger = createLogger('A2A')

/**
 * 将 BizGraph AgentManager 适配到 A2AServer 期望的 session-starter 接口。
 * 返回两个 starter（send + stream），共享底层 startSession/terminateSession。
 *
 * 简化：
 *   - 启动时使用 'claude-code' 适配器（与现有 chat-thread 创建路径一致）；
 *     后续 Phase D9.1 可允许用户在 a2aServer.agentCard 里指派专用 adapter。
 *   - subscribeOnSessionOutput 返回 unsubscribe function（AgentManager.addSessionOutputListener
 *     返回 void；这里手动注册 + 暴露 removeListener 反向引用）。
 *   - runToCompletion：注册 listener，等 ready-to-complete / ready-to-error 返回累积的
 *     artifacts + history。失败抛 Error 由 routes 的 try/catch 兜底。
 *
 * **不**注入 BizGraph 内部 memory / scope 到下游 prompt（CLAUDE.md Boundaries §3）：
 * 下游 prompt 仅为 message.text 原文。
 */
export function createA2ASessionStarters(
  agentManager: AgentManager,
): { messageSendSession: MessageSendSessionStarter; messageStreamSession: MessageStreamSessionStarter } {
  // Per-listener registry: maps listener → remove fn so unsubscribe() works.
  const listenerUnsubs = new WeakMap<(output: AgentOutput) => void, () => void>()

  const buildCommand = (text: string, targetNodeId: string): AgentCommand => ({
    type: 'implement',
    description: text,
    targetNodeId,
  })

  // Minimal AgentSessionConfig. 远程 A2A 任务不修改本地文件（远端 agent 负责执行），
  // 因此 allowedFiles = []（空白名单），scopeGuard 在 chat_threads metadata 表明为
  // 'a2a' 类型时跳过写检查（这是 chatThreadsRepo 的责任，非本文件）。
  const a2aSessionConfig = (contextId: string): {
    agentName: string
    description: string
    workingDirectory: string
    allowedFiles: string[]
    forbiddenFiles: string[]
    invariantRules: string[]
    upstreamContext: string
    downstreamContext: string
    nodeTitle: string
    acceptanceCriteria: string[]
    metadata?: Record<string, unknown>
  } => ({
    agentName: 'a2a-message',
    description: `A2A ${contextId}`,
    workingDirectory: process.cwd(),
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: 'A2A Message',
    acceptanceCriteria: [],
  })

  const sharedStartSession = async (
    message: { parts: Array<{ type: string; text?: string }> },
    contextId: string,
  ): Promise<string> => {
    // Routes call sendCommand after startSession to deliver the actual prompt text
    // (mirrors message-stream.ts pattern). startSession only establishes the
    // AgentManager session; the text payload is sent via AgentCommand.description.
    void message // referenced only for type narrowing; routes supply the text via sendCommand.
    const result = await agentManager.startSession('claude-code', a2aSessionConfig(contextId))
    return result.sessionId
  }

  const sharedSendCommand = async (sessionId: string, text: string): Promise<void> => {
    await agentManager.sendCommand(sessionId, buildCommand(text, 'a2a-message'))
  }

  const sharedTerminate = async (sessionId: string, reason: string): Promise<void> => {
    await agentManager.terminateSession(sessionId, reason as 'user' | 'error')
  }

  const subscribe = (
    sessionId: string,
    listener: (output: AgentOutput) => void,
  ): (() => void) => {
    agentManager.addSessionOutputListener(sessionId, listener)
    const unsub = () => {
      try { agentManager.removeSessionOutputListener(listener) } catch { /* best-effort */ }
    }
    listenerUnsubs.set(listener, unsub)
    return unsub
  }

  const messageStreamSession: MessageStreamSessionStarter = {
    startSession: sharedStartSession,
    sendCommand: sharedSendCommand,
    subscribeOnSessionOutput: subscribe,
    terminateSession: sharedTerminate,
  }

  const messageSendSession: MessageSendSessionStarter = {
    startSession: sharedStartSession,
    sendCommand: sharedSendCommand,
    runToCompletion: async (
      sessionId: string,
      _onOutput: (output: AgentOutput) => void,
    ): Promise<{ artifacts: A2AArtifact[]; history: A2AMessage[] }> => {
      const collectedArtifacts: A2AArtifact[] = []
      const history: A2AMessage[] = []
      let resolveFn: (() => void) | undefined
      let rejectFn: ((err: Error) => void) | undefined
      const donePromise = new Promise<void>((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
      const listener = (output: AgentOutput): void => {
        if (output.type === 'stdout' || output.type === 'stderr') {
          collectedArtifacts.push({ name: output.type, parts: [{ type: 'text', text: output.data }] })
        } else if (output.type === 'file_change') {
          collectedArtifacts.push({
            name: 'file_change',
            parts: [{ type: 'data', data: { filePath: output.filePath, changeType: output.changeType } }],
          })
        } else if (output.type === 'complete') {
          resolveFn?.()
        } else if (output.type === 'error') {
          rejectFn?.(new Error(output.data))
        }
      }
      subscribe(sessionId, listener)
      try {
        await donePromise
      } finally {
        const unsub = listenerUnsubs.get(listener)
        if (unsub) unsub()
      }
      return { artifacts: collectedArtifacts, history }
    },
    terminateSession: sharedTerminate,
  }

  return { messageSendSession, messageStreamSession }
}

export interface WireA2ADeps {
  subagentManager: SubagentManager
  messageSendSession: MessageSendSessionStarter
  messageStreamSession: MessageStreamSessionStarter
}

/**
 * 装配 A2AServer + 注入 SubagentManager 的 a2a:* 客户端，并订阅 settings.onChange 做热重载。
 *
 * Hot-reload 语义：
 *   - a2aServer 配置变更 → A2AServer.refreshConfig()（端口变 → full restart；apiKey 变 → no-op）
 *   - a2a.remoteAgents 列表变更 → clearA2AClients() + 重新 setA2AClient() 每个
 *   - a2aServer.enabled: false → destroy() server
 *
 * 返回 dispose() 关闭监听 + 销毁所有子系统。
 */
export function wireA2ASubsystem(deps: WireA2ADeps): A2AController {
  const { subagentManager, messageSendSession, messageStreamSession } = deps

  let taskStore: A2ATaskStore | null = null
  let server: A2AServer | null = null
  const clients = new Map<string, A2AClient>()

  const buildTask = async (taskId: string) => {
    const rec = taskStore?.get(taskId)
    if (!rec) return null
    return {
      id: taskId,
      contextId: rec.contextId,
      status: { state: rec.status },
      artifacts: rec.artifacts,
      history: rec.history,
    }
  }

  async function startServer(config: A2AServerConfig): Promise<void> {
    taskStore = new A2ATaskStore()
    server = new A2AServer({
      config,
      messageSendSession,
      messageStreamSession,
      taskStore,
      logger: createLogger('A2AServer'),
      buildTask,
    })
    await server.start()
    setA2AServer(server)
    logger.info(`A2A server listening on ${config.bindAddress}:${server.boundPort()}`)
  }

  async function stopServer(): Promise<void> {
    if (server) {
      await server.destroy()
      server = null
      taskStore?.destroy()
      taskStore = null
      setA2AServer(null)
    }
  }

  function destroyClients(): void {
    for (const client of clients.values()) {
      try { client.destroy() } catch { /* best-effort */ }
    }
    clients.clear()
  }

  function registerRemoteAgents(remoteAgents: readonly A2ARemoteAgent[]): void {
    subagentManager.clearA2AClients()
    clients.clear()
    for (const ra of remoteAgents) {
      if (ra.enabled === false) continue
      const client = new A2AClient(ra)
      clients.set(ra.name, client)
      subagentManager.setA2AClient(ra.name, client)
    }
  }

  async function applySettings(cfg: A2AServerConfig | undefined, remoteAgents: readonly A2ARemoteAgent[]): Promise<void> {
    // Clients first (cheap; no network call until invocation).
    registerRemoteAgents(remoteAgents)

    // Server next (may bind/unbind ports).
    if (cfg && cfg.enabled) {
      if (server) {
        await server.refreshConfig(cfg)
      } else {
        try {
          await startServer(cfg)
        } catch (err) {
          logger.warn(`Failed to start A2A server: ${(err as Error).message}`)
        }
      }
    } else if (server) {
      await stopServer()
    }
  }

  // Initial wiring (fire-and-forget — errors logged, don't block startup).
  void (async () => {
    try {
      const settings = await readSettings()
      await applySettings(settings.a2aServer, settings.a2a?.remoteAgents ?? [])
    } catch (err) {
      logger.warn(`Failed to wire A2A initial state: ${(err as Error).message}`)
    }
  })()

  // Hot-reload subscription.
  const offChange = onChange((_prev, next) => {
    void applySettings(next.a2aServer, next.a2a?.remoteAgents ?? []).catch((err) => {
      logger.warn(`A2A hot-reload failed: ${(err as Error).message}`)
    })
  })

  // dispose() declared as const first so controller can capture it; assigned below.
  // eslint-disable-next-line prefer-const
  let dispose!: () => void

  // Controller for IPC handlers + UI introspection.
  const controller: A2AController = {
    getServer: () => server,
    getTaskStore: () => taskStore,
    getClients: () => clients,
    testConnection: async (name: string) => {
      const client = clients.get(name)
      if (!client) return { ok: false, error: `Remote agent '${name}' not found`, latencyMs: 0 }
      return client.testConnection()
    },
    dispose: () => dispose(),
  }

  dispose = (): void => {
    offChange()
    void stopServer()
    destroyClients()
  }

  return controller
}

/**
 * A2AController — IPC handlers 通过这个接口查询 server 状态 / 触发 client 调用。
 */
export interface A2AController {
  getServer(): A2AServer | null
  getTaskStore(): A2ATaskStore | null
  getClients(): Map<string, A2AClient>
  testConnection(name: string): Promise<{ ok: boolean; card?: A2AAgentCard; error?: string; latencyMs: number }>
  dispose(): void
}