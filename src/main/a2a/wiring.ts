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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
 * A2A 入站会话在「没有任何项目」时的兜底工作目录。
 *
 * 绝不能用 process.cwd()：macOS 打包后它是 '/'，ScopeGuard 会把整个磁盘
 * 快照一遍（卡死 + 巨量内存）。这个目录是空的、专属的，Agent 在里面写什么
 * 都会被 verifyOnly 沙箱判为越界并回滚。
 */
const A2A_FALLBACK_WORKDIR = path.join(os.tmpdir(), 'bizgraph-a2a-sandbox')

function ensureFallbackWorkdir(): string {
  try {
    fs.mkdirSync(A2A_FALLBACK_WORKDIR, { recursive: true })
  } catch (err) {
    logger.warn('Failed to create A2A fallback working directory:', err)
  }
  return A2A_FALLBACK_WORKDIR
}

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
  resolveWorkingDirectory?: () => string | undefined,
): { messageSendSession: MessageSendSessionStarter; messageStreamSession: MessageStreamSessionStarter } {
  // Per-listener registry: maps listener → remove fn so unsubscribe() works.
  const listenerUnsubs = new WeakMap<(output: AgentOutput) => void, () => void>()

  const buildCommand = (text: string, targetNodeId: string): AgentCommand => ({
    type: 'implement',
    description: text,
    targetNodeId,
  })

  // 工作目录决定两件事：Agent CLI 在哪儿执行，以及 ScopeGuard 监控哪些目录。
  // 必须是受控目录 —— projectPath 优先（沙箱才能覆盖真实项目写入），
  // 没有项目时退到专属空目录。
  const resolveWorkdir = (): string => {
    const projectPath = resolveWorkingDirectory?.()
    if (projectPath) return projectPath
    return ensureFallbackWorkdir()
  }

  // Minimal AgentSessionConfig. 远程 A2A 任务**不允许**修改本地文件：
  // verifyOnly=true 会让 AgentManager 建一个空白名单的沙箱，任何写入都被
  // ScopeGuard 判为越界并回滚（CLAUDE.md「所有文件改动由 ScopeGuard 兜底」）。
  // 注意：allowedFiles=[] 且 verifyOnly 未开时，session-lifecycle-manager 根本
  // 不会建沙箱 —— 那等于给网络端点开了一个无限制的文件写入口。
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
    verifyOnly: true
    metadata?: Record<string, unknown>
  } => ({
    agentName: 'a2a-message',
    description: `A2A ${contextId}`,
    workingDirectory: resolveWorkdir(),
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: 'A2A Message',
    acceptanceCriteria: [],
    verifyOnly: true,
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
      const stdoutChunks: string[] = []
      let resolveFn: (() => void) | undefined
      let rejectFn: ((err: Error) => void) | undefined
      const donePromise = new Promise<void>((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
      const listener = (output: AgentOutput): void => {
        if (output.type === 'stdout' || output.type === 'stderr') {
          collectedArtifacts.push({ name: output.type, parts: [{ type: 'text', text: output.data }] })
          if (output.type === 'stdout') stdoutChunks.push(output.data)
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
      // history 必须是真实的对话记录：用户消息由路由写入 task-store，
      // 这里补上 agent 侧的回复消息（否则 task history 恒为空）。
      const history: A2AMessage[] = stdoutChunks.length > 0
        ? [{ role: 'agent', parts: [{ type: 'text', text: stdoutChunks.join('') }] }]
        : []
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
    const nextTaskStore = new A2ATaskStore()
    const instance = new A2AServer({
      config,
      messageSendSession,
      messageStreamSession,
      taskStore: nextTaskStore,
      logger: createLogger('A2AServer'),
      buildTask,
    })
    try {
      await instance.start()
    } catch (err) {
      // 启动失败（端口占用等）时**不要**把半初始化的实例挂到模块级变量上——
      // 否则 getA2AServerStatus 会报 running:true 但实际没绑上端口。
      nextTaskStore.destroy()
      try { await instance.destroy() } catch { /* 未监听的 server 关闭会报错，忽略 */ }
      throw err
    }
    taskStore = nextTaskStore
    server = instance
    setA2AServer(instance)
    logger.info(`A2A server listening on ${config.bindAddress}:${instance.boundPort()}`)
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

  /** 两个远端 agent 列表是否等价（顺序敏感）。 */
  function sameAgentList(a: readonly A2ARemoteAgent[], b: readonly A2ARemoteAgent[]): boolean {
    if (a.length !== b.length) return false
    return a.every((agent, i) => {
      const other = b[i]
      return other !== undefined &&
        other.name === agent.name &&
        other.endpoint === agent.endpoint &&
        other.apiKey === agent.apiKey &&
        other.enabled === agent.enabled &&
        other.timeoutMs === agent.timeoutMs &&
        other.tlsVerify === agent.tlsVerify &&
        other.devAllowLocalhost === agent.devAllowLocalhost
    })
  }

  async function applySettings(
    prevRemoteAgents: readonly A2ARemoteAgent[] | undefined,
    cfg: A2AServerConfig | undefined,
    remoteAgents: readonly A2ARemoteAgent[],
  ): Promise<void> {
    // Clients: only rebuild when the remote-agent list actually changed.
    // Otherwise any unrelated settings write (locale / writeback / API key)
    // would destroy every client socket and abort in-flight remote calls.
    if (prevRemoteAgents === undefined || !sameAgentList(prevRemoteAgents, remoteAgents)) {
      registerRemoteAgents(remoteAgents)
    }

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
      // prev = undefined → 首次必须注册 clients。
      await applySettings(undefined, settings.a2aServer, settings.a2a?.remoteAgents ?? [])
    } catch (err) {
      logger.warn(`Failed to wire A2A initial state: ${(err as Error).message}`)
    }
  })()

  // Hot-reload subscription.
  const offChange = onChange((prev, next) => {
    void applySettings(prev?.a2a?.remoteAgents, next.a2aServer, next.a2a?.remoteAgents ?? []).catch((err) => {
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