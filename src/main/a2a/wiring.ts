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
import type {
  A2ARemoteAgent,
  A2AServerConfig,
  A2AArtifact,
  A2AMessage,
  A2AAgentCard,
  A2ATerminationReason,
} from '@shared/types/a2a'
import { A2A_INBOUND_TASK_TIMEOUT_MS } from '@shared/types/a2a'
import type { AgentManager } from '../agent/agent-manager'
import type { SubagentManager } from '../agent/subagent-manager'
import { A2AClient } from './client'
import { A2AServer } from './server'
import { A2ATaskStore } from './task-store'
import { createTaskPersistence } from './task-persistence'
import type { MessageSendSessionStarter } from './routes/message-send'
import type { MessageStreamSessionStarter } from './routes/message-stream'
import type { AgentOutput, AgentCommand, TerminationReason } from '@shared/types/agent'

const logger = createLogger('A2A')

/**
 * A2A 入站会话的隔离工作目录。
 *
 * 绝不能用 process.cwd()：macOS 打包后它是 '/'，ScopeGuard 会把整个磁盘
 * 快照一遍（卡死 + 巨量内存）。也不能用用户项目目录：ScopeGuard 会把工作目录
 * 整棵树快照一次（每个 A2A 请求一次，成本随项目体积线性增长），而工作目录
 * 同时是 CLI 的 cwd —— 远端调用方不该借本机 CLI 够到项目文件。
 *
 * 这个目录是空的、专属的：透明转发会话没有文件 / shell 工具，工作目录没有
 * 业务含义，用它即可让快照成本≈0 且 CLI 够不到项目文件。
 */
const A2A_SANDBOX_WORKDIR = path.join(os.tmpdir(), 'bizgraph-a2a-sandbox')

function ensureSandboxWorkdir(): string {
  try {
    fs.mkdirSync(A2A_SANDBOX_WORKDIR, { recursive: true })
  } catch (err) {
    logger.warn('Failed to create A2A sandbox working directory:', err)
  }
  return A2A_SANDBOX_WORKDIR
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
 * 下游 prompt 仅为 message.text 原文 —— transparentForward 让适配器省略 scope
 * system prompt 与命令样板，同时关闭文件 / shell 工具与本地 subagent 派发。
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

  // 工作目录是**隔离的空目录**：既是 CLI 的 cwd，也是 ScopeGuard 的快照范围。
  // 用用户项目目录会让每个 A2A 请求都把整棵项目树快照一遍（成本随体积线性增长），
  // 而且远端调用方能借本机 CLI 够到项目文件。透明转发会话没有文件 / shell 工具，
  // 空目录足够。
  const resolveWorkdir = (): string => ensureSandboxWorkdir()

  // Minimal AgentSessionConfig. 远程 A2A 任务**不允许**修改本地文件：
  // verifyOnly=true 会让 AgentManager 建一个空白名单的沙箱，任何写入都被
  // ScopeGuard 判为越界并回滚（CLAUDE.md「所有文件改动由 ScopeGuard 兜底」）。
  // 注意：allowedFiles=[] 且 verifyOnly 未开时，session-lifecycle-manager 根本
  // 不会建沙箱 —— 那等于给网络端点开了一个无限制的文件写入口。
  //
  // transparentForward=true：不注入 BizGraph 内部 scope / memory / 项目上下文，
  // 适配器据此省略 system prompt 与命令样板，并关闭文件 / shell / subagent 工具
  // （CLAUDE.md Boundaries §3）。
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
    transparentForward: true
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
    transparentForward: true,
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

  /**
   * A2A 语义原因 → AgentManager 的 TerminationReason。
   *
   * 必须是显式映射：AgentManager 收到非法值时会落成 'error'，而
   * 'a2a-client-disconnect' 这种字符串此前被直接 cast 进去 —— 结果是
   * 正常断开被记成失败，Phase B 的 abnormal 判定与 agent_logs 全错。
   */
  const TERMINATION_REASONS: Record<A2ATerminationReason, TerminationReason> = {
    'client-disconnect': 'user',
    completed: 'user',
    failed: 'error',
    error: 'error',
  }

  const sharedTerminate = async (sessionId: string, reason: A2ATerminationReason): Promise<void> => {
    await agentManager.terminateSession(sessionId, TERMINATION_REASONS[reason] ?? 'error')
  }

  const subscribe = (
    sessionId: string,
    listener: (output: AgentOutput) => void,
  ): (() => void) => {
    // 注册失败必须抛：会话不存在时 AgentManager 返回 false，调用方却以为
    // 订阅成功 —— 结果永远收不到 complete / error，流一直挂着直到超时。
    const ok = agentManager.addSessionOutputListener(sessionId, listener)
    if (!ok) {
      throw new Error(`Cannot subscribe to A2A session output: session ${sessionId} not found`)
    }
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
      // 上限兜底：CLI 卡死 / 适配器不返回时，Promise 永远不 settle ——
      // HTTP 请求与 Agent 会话会一直挂着。
      const completionTimer = setTimeout(() => {
        rejectFn?.(
          new Error(
            `A2A session ${sessionId} did not complete within ${A2A_INBOUND_TASK_TIMEOUT_MS}ms`,
          ),
        )
      }, A2A_INBOUND_TASK_TIMEOUT_MS)
      try {
        await donePromise
      } finally {
        clearTimeout(completionTimer)
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
    // 任务持久化到 chat_threads（metadata.task_kind='a2a'）：重启后历史任务
    // 仍可查，重启前仍在 working 的任务会被收敛为 failed。
    const nextTaskStore = new A2ATaskStore(await createTaskPersistence())
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
        try {
          await server.refreshConfig(cfg)
        } catch (err) {
          // refreshConfig 失败（端口被占 / TLS 证书读不了）时，server 实例
          // 可能已经处于半重启状态。不把它拆掉的话，状态接口会继续报
          // running:true，而端口其实没绑上 —— 远端调用方全部连不上。
          logger.warn(
            `Failed to refresh A2A server config: ${(err as Error).message}; recreating server`,
          )
          await stopServer()
          try {
            await startServer(cfg)
          } catch (restartErr) {
            logger.warn(`Failed to restart A2A server: ${(restartErr as Error).message}`)
          }
        }
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