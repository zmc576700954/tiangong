/**
 * Codex 适配器（SDK 模式）
 *
 * 使用 @openai/codex-sdk 替代 spawn('codex') 子进程调用。
 * SDK 提供线程模型（startThread/resumeThread）和结构化结果。
 *
 * P1-B / D-08：双路径
 * - 默认走 `thread.runStreamed()`，以 `turn.completed` 判完成，raw 事件供 Driver 归一化；
 * - 兼容回退：`BIZGRAPH_CODEX_STREAMING=0`（或 false/no/off）时回到阻塞 `thread.run()`，
 *   保留旧 `finalResponse` 语义。Runtime/Kernel 路径仍显式开启流式。
 */

import { BaseAdapter } from './base'
import { resolveModelForAdapter } from './model-selection'
import {
  CodexAppServerClient,
  approvalToToolCall,
  buildApprovalReply,
  mcpServerOverrideArgs,
} from './codex-app-server'
import { generateId } from '../shared/env'
import { isTrustedNativeSessionId } from '@shared/native-session-id'
import { humanizeAgentErrorText } from '@shared/agent-error-text'
import type { AgentSession, AgentSessionConfig, AgentCommand, McpServerConfig } from '@shared/types'
import { AdapterError } from '../errors'
import type { Codex, ThreadOptions } from '@openai/codex-sdk'
import type { ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { createLogger } from '../shared/logger'
import {
  ensureCodexSandboxWrapperScript,
  ensureCodexSupervisorScript,
  getProcRegistryDir,
  getRegistrySecret,
  PROC_REGISTRY_DIR_ENV,
  REAL_CODEX_ENV,
  REGISTRY_SECRET_ENV,
  resolveRealCodexPath,
  SANDBOX_NODE_ENV,
  SANDBOX_PROFILE_ENV,
  SUPERVISOR_NONCE_ENV,
} from '../shared/process-supervisor'
import { sandboxProfileText } from '../shared/sandbox'

type CodexConstructor = typeof Codex

export const CODEX_STREAMING_ENV = 'BIZGRAPH_CODEX_STREAMING'
const STREAMING_FALSY = new Set(['0', 'false', 'no', 'off'])

/** D-08：Codex 默认流式；显式关闭值回退阻塞 `thread.run()`。 */
export function isCodexStreamingDefaultEnabled(raw = process.env[CODEX_STREAMING_ENV]): boolean {
  if (raw === undefined || raw.trim() === '') return true
  return !STREAMING_FALSY.has(raw.trim().toLowerCase())
}

/**
 * 执行器装进来的审批钩子，与 claude-code / opencode 的 `setTurnApprovalHooks`
 * 同形 —— `adapter-driver` 只认方法名，不认适配器类型。
 *
 * 它同时是 G7-2 的**开关**：装上 → 走 `app-server`（工具调用先问宿主）；
 * 没有 → 回到 SDK 的 `exec` 路径（工具由 CLI 自己按策略拒/放，宿主拦不住）。
 */
export interface CodexApprovalHooks {
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message?: string }>
}

/** 显式指定 app-server 用的 CLI；不设时用 SDK 随包的那份（与 exec 同一份）。 */
export const CODEX_APP_SERVER_BIN_ENV = 'BIZGRAPH_CODEX_APP_SERVER_BIN'

/** 一轮 app-server 回合的上限：服务端不会自己超时，宿主必须兜住。 */
const CODEX_APP_SERVER_TURN_TIMEOUT_MS = 30 * 60_000

/** runStreamed 事件的最小结构（SDK 的联合类型在运行时才有完整形状）。 */
interface CodexStreamedEvent {
  type: string
  item?: {
    id?: string
    type: string
    text?: string
    changes?: Array<{ path: string; kind: 'add' | 'modify' | 'delete' }>
  }
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
  error?: { message?: string }
}

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex'
  readonly version = '2.0.0'

  protected override logger = createLogger('CodexAdapter')

  /**
   * SDK 多轮适配器：BaseAdapter 自动托管空闲回收定时器。
   * registerSession / sendCommand 处基类自动 arm / re-arm，无需手动。
   */
  protected get autoManageIdleReaper(): boolean {
    return true
  }

  /** D-08：未显式指定时默认流式；`BIZGRAPH_CODEX_STREAMING=0` 回退阻塞。 */
  protected override defaultRawStreamMode(): boolean {
    return isCodexStreamingDefaultEnabled()
  }

  private CodexClass: CodexConstructor | null = null
  private sdkLoadAttempted = false
  private threads = new Map<string, ReturnType<InstanceType<CodexConstructor>['startThread']>>()
  private threadIds = new Map<string, string>()
  /** Session-level Codex instances: reuse across doSendCommand calls within the same session */
  private codexInstances = new Map<string, InstanceType<CodexConstructor>>()
  /** D-C：可取消的流式轮次（terminateSession 会 abort） */
  private abortControllers = new Map<string, AbortController>()
  /** G7-2：宿主安装的审批钩子（按会话）。存在即走 `app-server`。 */
  private readonly approvalHooks = new Map<string, CodexApprovalHooks>()

  /**
   * 装/卸本回合的审批钩子。执行器按会话调用，回合结束传 `null`。
   *
   * 存在性本身就是开关：装上 → `app-server`（服务端反向请求审批）；
   * 卸掉 → 回 SDK 的 `exec` 路径。**不做静默降级**：装了钩子却起不来
   * app-server 时回合直接失败，绝不悄悄退回「没人看」的那条路。
   */
  setTurnApprovalHooks(sessionId: string, hooks: CodexApprovalHooks | null): void {
    if (hooks?.canUseTool) this.approvalHooks.set(sessionId, hooks)
    else this.approvalHooks.delete(sessionId)
  }

  private async loadSdk(): Promise<CodexConstructor | null> {
    if (this.sdkLoadAttempted) return this.CodexClass
    this.sdkLoadAttempted = true

    try {
      const mod = await import('@openai/codex-sdk')
      this.CodexClass = mod.Codex
      return this.CodexClass
    } catch {
      this.logger.warn('@openai/codex-sdk not installed')
      return null
    }
  }

  async checkInstalled(): Promise<boolean> {
    const cls = await this.loadSdk()
    return cls !== null
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('codex')
    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session)
    // Idle reaper 由 BaseAdapter.registerSession 自动 arm（autoManageIdleReaper=true）。
    return session
  }

  /** Codex 支持 `resumeThread(threadId)`，重启后可用原生续接。 */
  supportsNativeResume(): boolean {
    return true
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const sessionId = session.id
    const CodexClass = await this.loadSdk()
    if (!CodexClass) {
      throw new AdapterError('Codex SDK not installed. Run: npm install @openai/codex-sdk', this.name)
    }

    const fullPrompt = this.buildFullPrompt(session, command)

    try {
      // G7-2：有审批钩子就走 app-server —— `exec` 路径没有审批通道
      // （v3.29 实机：唯一开关是 --dangerously-bypass-approvals-and-sandbox，
      // 只能关不能开），所以「问了再放行」只能在这条路径上成立。
      const hooks = this.approvalHooks.get(session.id)
      if (hooks?.canUseTool) {
        const { readSettings } = await import('../settings')
        const settings = await readSettings()
        const appServerModel = session.config.model ?? resolveModelForAdapter(settings, 'codex')
        await this.runAppServerTurn(session, fullPrompt, appServerModel, hooks.canUseTool, settings.mcpServers)
        return
      }

      // D5：受控 spawn 模式每轮重建 Codex 实例/线程，保证 marker 与 shim 路径都是本轮的；
      // 旧 AgentOutput 路径仍沿用会话级缓存，行为不变。
      const supervised = this.isProcessSupervised(sessionId) && process.platform !== 'win32'
      let codex = supervised ? null : this.codexInstances.get(session.id)
      if (!codex) {
        const safeEnv = this.buildSessionEnv(session.id)
        const env = Object.fromEntries(
          Object.entries(safeEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        if (supervised) {
          const realCodex = resolveRealCodexPath()
          if (!realCodex) {
            throw new AdapterError(
              'Cannot resolve @openai/codex/bin/codex.js for supervised spawn',
              this.name,
            )
          }
          env[PROC_REGISTRY_DIR_ENV] = getProcRegistryDir()
          env[REAL_CODEX_ENV] = realCodex
          // C12：每次 spawn 的 nonce + 安装级签名密钥（仅经 env 注入，ps 不可见）
          env[SUPERVISOR_NONCE_ENV] = crypto.randomBytes(16).toString('hex')
          env[REGISTRY_SECRET_ENV] = getRegistrySecret()
          // C3：profile 经 env 交给 shim，由 shim 在 spawn 真实 CLI 时套 sandbox-exec。
          // 不可用时为空，shim 原样 exec（策略层同时把 allow 集退回 ask）。
          const sandboxProfile = sandboxProfileText('codex', {
            workspaceDir: session.config.workingDirectory,
            extraExecutables: [process.execPath],
          })
          if (sandboxProfile) env[SANDBOX_PROFILE_ENV] = sandboxProfile
          codex = new CodexClass({ env, codexPathOverride: ensureCodexSupervisorScript() })
        } else {
          // C3：legacy 路径不走监督 shim，但仍要把真实 CLI 裹进 profile；
          // 决策稿 §1.3 明确要求旧路径与内核路径同点覆盖。SDK 只接受一个可执行路径，
          // 因此用最小 shell wrapper 做 exec 套壳（pid/pgid 不变）。
          const sandboxProfile = sandboxProfileText('codex', {
            workspaceDir: session.config.workingDirectory,
            extraExecutables: [process.execPath],
          })
          const realCodex = sandboxProfile ? resolveRealCodexPath() : undefined
          if (sandboxProfile && realCodex) {
            env[REAL_CODEX_ENV] = realCodex
            env[SANDBOX_NODE_ENV] = process.execPath
            env[SANDBOX_PROFILE_ENV] = sandboxProfile
            codex = new CodexClass({ env, codexPathOverride: ensureCodexSandboxWrapperScript() })
          } else {
            if (sandboxProfile && !realCodex) {
              this.logger.warn('无法解析真实 Codex CLI，legacy spawn 未能进入沙箱')
            }
            codex = new CodexClass({ env })
          }
          this.codexInstances.set(session.id, codex)
        }
      }

      const isResume = session.config.resumeSessionId != null
      let thread = supervised ? null : this.threads.get(session.id)

      if (!thread) {
        // codex 档位为空时传 undefined —— SDK 用它自己的默认模型。
        const { readSettings } = await import('../settings')
        const settings = await readSettings()
        const model = session.config.model ?? resolveModelForAdapter(settings, 'codex')
        const threadOptions: ThreadOptions = {
          workingDirectory: session.config.workingDirectory,
          // 只读会话 → SDK 的 'read-only' 档位（'read-only' | 'workspace-write' | 'danger-full-access'）
          sandboxMode: session.config.readOnly ? 'read-only' : 'workspace-write',
          model,
        }
        if (isResume && isTrustedNativeSessionId(session.config.resumeSessionId)) {
          thread = codex.resumeThread(session.config.resumeSessionId, threadOptions)
        } else {
          thread = codex.startThread(threadOptions)
        }
        if (!supervised) this.threads.set(session.id, thread)
      }

      // 双路径：旧 AgentOutput 路径保持阻塞 run()；仅 Runtime/Kernel 路径走 runStreamed()。
      if (!this.isRawStreamMode(sessionId)) {
        await this.runBlocking(session, thread, fullPrompt)
        return
      }
      await this.runStreaming(session, thread, fullPrompt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: humanizeAgentErrorText(`Codex SDK error: ${msg}`),
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
      // 错误仍需通知 AgentManager 以触发会话恢复/清理流程
      this.emit('sessionEnded', session.id, 'error', null)
    }
  }

  /** 旧 `AgentOutput` 路径：阻塞 `thread.run()`，行为与 M0 改造前一致。 */
  private async runBlocking(
    session: AgentSession,
    thread: ReturnType<InstanceType<CodexConstructor>['startThread']>,
    fullPrompt: string,
  ): Promise<void> {
    const sessionId = session.id
    const result = await thread.run(fullPrompt)

    // 上报 token 使用量（M1：全量真实用量分列，供 UsageLedger 计价落库）
    if (result.usage) {
      const inputTokens = result.usage.input_tokens ?? 0
      if (inputTokens > 0) {
        this.reportUsage(session.id, inputTokens, 128_000, {
          outputTokens: result.usage.output_tokens ?? 0,
          cachedInputTokens: result.usage.cached_input_tokens ?? 0,
          source: 'provider',
        })
      }
    }

    // 保存 thread ID 用于后续续接
    const threadId = thread.id
    if (threadId) {
      this.threadIds.set(session.id, threadId)
      session.config.resumeSessionId = threadId
    }

    // 输出 agent 消息
    for (const item of result.items) {
      if (item.type === 'agent_message' && item.text) {
        this.emitOutputForSession(sessionId, {
          type: 'stdout',
          data: item.text,
          timestamp: Date.now(),
        })
      }
      if (item.type === 'file_change') {
        for (const change of item.changes) {
          this.emitOutputForSession(sessionId, {
            type: 'file_change',
            data: `${change.kind}: ${change.path}`,
            timestamp: Date.now(),
            filePath: change.path,
            changeType: change.kind === 'add' ? 'add' : change.kind === 'delete' ? 'delete' : 'modify',
          })
        }
      }
    }

    if (result.finalResponse) {
      this.emitOutputForSession(sessionId, {
        type: 'stdout',
        data: result.finalResponse,
        timestamp: Date.now(),
      })
    }

    this.emitOutputForSession(sessionId, {
      type: 'complete',
      data: 'Codex session completed',
      timestamp: Date.now(),
    })
    // codex 缓存 thread/instance 以支持多轮续接，单命令成功不应销毁会话（参考 claude-code）。
    // 资源清理由显式 terminateSession 或空闲回收定时器（BaseAdapter 自动 re-arm）负责，
    // 后者在无活动窗口后通过 sessionEnded('idle') 让 AgentManager 执行完整清理，包括记忆管线。
  }

  /** 新 Runtime/Kernel 路径：`runStreamed()`，以后端 `turn.completed` 判完成。 */
  private async runStreaming(
    session: AgentSession,
    thread: ReturnType<InstanceType<CodexConstructor>['startThread']>,
    fullPrompt: string,
  ): Promise<void> {
    const sessionId = session.id
    const controller = new AbortController()
    this.abortControllers.set(session.id, controller)
    const stream = await thread.runStreamed(fullPrompt, { signal: controller.signal })
    let completed = false

    try {
      for await (const rawEvent of stream.events) {
        const event = rawEvent as unknown as CodexStreamedEvent
        // D3：原始事件只读旁路（Driver 归一化用；旧路径不订阅）
        this.emitRawEvent(sessionId, 'codex', event)

        if (event.type === 'item.completed' && event.item) {
          const item = event.item
          if (item.type === 'agent_message' && item.text) {
            this.emitOutputForSession(sessionId, {
              type: 'stdout',
              data: item.text,
              timestamp: Date.now(),
            })
          }
          if (item.type === 'file_change') {
            for (const change of item.changes ?? []) {
              this.emitOutputForSession(sessionId, {
                type: 'file_change',
                data: `${change.kind}: ${change.path}`,
                timestamp: Date.now(),
                filePath: change.path,
                changeType: change.kind === 'add' ? 'add' : change.kind === 'delete' ? 'delete' : 'modify',
              })
            }
          }
          continue
        }

        if (event.type === 'turn.completed') {
          // C1：turn.completed 即完成判定；不等待迭代器/进程退出（后者约 10s）
          // M1：Codex 的真实 usage 只在 turn.completed 出现，全量上报
          if (event.usage) {
            const inputTokens = event.usage.input_tokens ?? 0
            if (inputTokens > 0) {
              this.reportUsage(session.id, inputTokens, 128_000, {
                outputTokens: event.usage.output_tokens ?? 0,
                cachedInputTokens: event.usage.cached_input_tokens ?? 0,
                source: 'provider',
              })
            }
          }
          completed = true
          this.emitOutputForSession(sessionId, {
            type: 'complete',
            data: 'Codex session completed',
            timestamp: Date.now(),
          })
          break
        }

        if (event.type === 'turn.failed') {
          const message = event.error?.message ?? 'Codex turn failed'
          this.emitOutputForSession(sessionId, {
            type: 'error',
            data: humanizeAgentErrorText(`Codex SDK error: ${message}`),
            timestamp: Date.now(),
            errorCode: 'AGENT_CRASH',
          })
          this.emit('sessionEnded', session.id, 'error', null)
          return
        }
        // C5：未知事件类型直接忽略
      }
    } finally {
      if (this.abortControllers.get(session.id) === controller) {
        this.abortControllers.delete(session.id)
      }
    }

    if (!completed) {
      // C1 的反面：没有 turn.completed 不能宣称成功
      const message = controller.signal.aborted ? 'Codex turn aborted' : 'Codex stream ended without turn.completed'
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: humanizeAgentErrorText(`Codex SDK error: ${message}`),
        timestamp: Date.now(),
        errorCode: controller.signal.aborted ? 'AGENT_ABORTED' : 'AGENT_CRASH',
      })
      if (!controller.signal.aborted) this.emit('sessionEnded', session.id, 'error', null)
      return
    }

    // 保存 thread ID 用于后续续接
    const threadId = thread.id
    if (threadId) {
      this.threadIds.set(session.id, threadId)
      session.config.resumeSessionId = threadId
    }
    // codex 缓存 thread/instance 以支持多轮续接，单命令成功不应销毁会话（参考 claude-code）。
  }

  /**
   * G7-2：`app-server` 回合 —— 唯一能「问了再放行」的 Codex 路径。
   *
   * 与 `exec` 的差别不是实现细节，而是能力：`exec` 把审批策略写死成 never，
   * 宿主既看不到「要跑什么」，也无处回答；`app-server` 会**反向请求**客户端
   * （`item/commandExecution/requestApproval`），回 `accept` 后命令真的执行
   * （v3.33 实机：`echo` 的 marker 进了 `aggregatedOutput`，exit 0）。
   *
   * 三个刻意的选择：
   * - **事件照 SDK 方言发**：客户端已把 v2 通知翻成 `item.completed` 那一套，
   *   所以 `emitRawEvent` 出去的东西和 `runStreamed` 完全同形，归一化器零改动。
   * - **审批失败一律按拒绝**：钩子抛错、回合被取消、没有决策人，都不能读成
   *   「用户同意」。
   * - **不重试、不降级**：app-server 起不来就直接让回合失败。退回 `exec`
   *   等于把「有审批」悄悄换成「没审批」。
   */
  private async runAppServerTurn(
    session: AgentSession,
    prompt: string,
    model: string | undefined,
    decide: NonNullable<CodexApprovalHooks['canUseTool']>,
    mcpServers?: McpServerConfig[],
  ): Promise<void> {
    const sessionId = session.id
    const cwd = session.config.workingDirectory
    const controller = new AbortController()
    this.abortControllers.set(sessionId, controller)

    const env = Object.fromEntries(
      Object.entries(this.buildSessionEnv(sessionId)).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    const plan = resolveAppServerPlan()
    // G7-1：把设置的 MCP server 以 `-c` 覆写注入（不改用户的 config.toml）；
    // 它们的工具调用走 elicitation，与本会话的其它审批同一条网关。
    const planArgs = [...plan.args, ...mcpServerOverrideArgs(mcpServers)]

    const pendingDecisions: Promise<void>[] = []
    let client: CodexAppServerClient | null = null
    let unsubscribe: () => void = () => {}
    /** 本轮是否被宿主明确拒过 —— 拒绝会让服务端把回合判成 failed，得区分于真崩 */
    let deniedByHost = false

    try {
      client = await CodexAppServerClient.start({
        plan: { command: plan.command, args: planArgs, cwd, env },
        log: (message) => this.logger.info(message),
        onApproval: (request) => {
          const { toolName, input } = approvalToToolCall(request)
          this.emitOutputForSession(sessionId, {
            type: 'stderr',
            data: `[codex] 请求审批：${request.command ?? toolName}${request.reason ? ` —— ${request.reason}` : ''}`,
            timestamp: Date.now(),
          })
          // 决策不能阻塞事件读取：钩子内部要等用户点按钮，可能几十秒
          pendingDecisions.push(
            (async () => {
              let reply: Record<string, unknown>
              try {
                const outcome = await decide(toolName, input, {
                  signal: controller.signal,
                  toolUseID: request.itemId ?? String(request.requestId),
                })
                reply = buildApprovalReply(outcome.behavior === 'allow' ? 'allow' : 'deny', request)
                if (outcome.behavior === 'deny') {
                  deniedByHost = true
                  if (outcome.message) this.logger.info(`[codex] 用户拒绝：${outcome.message}`)
                }
              } catch (error) {
                // 审批链路故障不能读成「同意」
                this.logger.warn(`approval hook failed: ${(error as Error).message}`)
                reply = buildApprovalReply('deny', request)
              }
              client?.replyApproval(request.requestId, reply)
            })(),
          )
        },
      })
      if (client.pid) {
        this.processes.set(sessionId, client.childRef)
        this.emitProcessSpawn(sessionId, { pid: client.pid })
      }

      const resumeId = session.config.resumeSessionId
      const threadOptions = {
        cwd,
        model,
        sandbox: session.config.readOnly ? ('read-only' as const) : ('workspace-write' as const),
        approvalPolicy: 'on-request' as const,
      }
      // 原生续接：不可信的 id（可能被塞了奇怪字符）一律当新线程，不拿去拼请求
      const thread =
        resumeId && isTrustedNativeSessionId(resumeId)
          ? await client.resumeThread({ threadId: resumeId, ...threadOptions })
          : await client.startThread(threadOptions)
      // thread id 就是 Codex 的会话 id
      session.config.resumeSessionId = thread.threadId

      let settle: (outcome: { ok: boolean; message?: string }) => void = () => {}
      const finished = new Promise<{ ok: boolean; message?: string }>((resolve) => {
        settle = resolve
      })

      unsubscribe = client.onEvent((event) => {
        // 与 runStreamed 同一条出口：归一化器与执行器不需要第二套实现
        this.emitRawEvent(sessionId, 'codex', event)

        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          this.emitOutputForSession(sessionId, {
            type: 'stdout',
            data: event.item.text,
            timestamp: Date.now(),
          })
          return
        }
        if (event.type === 'turn.completed') {
          if (event.usage) {
            const inputTokens = event.usage.input_tokens ?? 0
            if (inputTokens > 0) {
              this.reportUsage(sessionId, inputTokens, 128_000, {
                outputTokens: event.usage.output_tokens ?? 0,
                source: 'provider',
              })
            }
          }
          settle({ ok: true })
          return
        }
        if (event.type === 'turn.failed') {
          settle({ ok: false, message: errorMessageOf(event) })
        }
      })

      const timer = setTimeout(
        () => settle({ ok: false, message: `codex app-server 回合超过 ${CODEX_APP_SERVER_TURN_TIMEOUT_MS / 60_000} 分钟仍未结束` }),
        CODEX_APP_SERVER_TURN_TIMEOUT_MS,
      )
      const onAbort = () => settle({ ok: false, message: 'Codex turn aborted' })
      controller.signal.addEventListener('abort', onAbort, { once: true })

      try {
        await client.startTurn({ threadId: thread.threadId, text: prompt })
        const outcome = await finished
        if (!outcome.ok) {
          // 拒绝在本协议里只能回 cancel，服务端因此把回合判成 failed。
          // 那不是崩溃，也不该记成 AGENT_CRASH —— 界面上要能看出「是被拒了」。
          const errorCode = controller.signal.aborted
            ? 'AGENT_ABORTED'
            : deniedByHost
              ? 'AGENT_DENIED'
              : 'AGENT_CRASH'
          this.emitOutputForSession(sessionId, {
            type: 'error',
            data: humanizeAgentErrorText(`Codex error: ${outcome.message ?? 'turn failed'}`),
            timestamp: Date.now(),
            errorCode,
          })
          // 被拒时模型没有出错，只是这一轮没继续；仍报 error 以触发会话恢复/清理
          if (!controller.signal.aborted) this.emit('sessionEnded', session.id, 'error', null)
          return
        }
        this.emitOutputForSession(sessionId, {
          type: 'complete',
          data: 'Codex session completed',
          timestamp: Date.now(),
        })
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        unsubscribe()
        // 收尾还没回完的审批：宁可多等一会儿，也不要留下「问了但没答」的悬挂请求
        await Promise.allSettled(pendingDecisions)
      }
    } catch (error) {
      // fail-closed：不换路径重试，把原因原样抬给用户
      const message = error instanceof Error ? error.message : String(error)
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: humanizeAgentErrorText(`Codex app-server 启动失败：${message}`),
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
      this.emit('sessionEnded', session.id, 'error', null)
    } finally {
      this.abortControllers.delete(sessionId)
      this.processes.delete(sessionId)
      await client?.dispose()
    }
  }

  protected doCloseQuery(sessionId: string): void {
    this.abortControllers.get(sessionId)?.abort()
    this.abortControllers.delete(sessionId)
    this.threads.delete(sessionId)
    this.threadIds.delete(sessionId)
    this.codexInstances.delete(sessionId)
  }

  protected override async doTerminate(_session: AgentSession, _proc?: ChildProcess): Promise<void> {
    this.doCloseQuery(_session.id)
    await super.doTerminate(_session, _proc)
  }
}

/**
 * app-server 用哪个 CLI。
 *
 * 默认用 SDK 随包的 `@openai/codex/bin/codex.js`（与 `exec` 是同一个二进制，
 * 行为与版本一致）；`BIZGRAPH_CODEX_APP_SERVER_BIN` 可覆盖 —— 实机发现
 * 0.135 遇到 `model_reasoning_effort = "max"` 会整份配置加载失败（用户全局
 * config 是给 0.162 写的），此时需要一个更新的 CLI 才能起来。
 *
 * 不猜 PATH：Electron 打包后 PATH 里通常没有 codex，猜了只会变成
 * 「有时能跑、有时 ENOENT」。
 */
function resolveAppServerPlan(): { command: string; args: string[] } {
  const override = process.env[CODEX_APP_SERVER_BIN_ENV]?.trim()
  if (override) return { command: override, args: ['app-server'] }

  const realCodex = resolveRealCodexPath()
  if (!realCodex) {
    throw new AdapterError(
      `找不到 Codex CLI（@openai/codex/bin/codex.js）。审批路径需要它，可用 ${CODEX_APP_SERVER_BIN_ENV} 指定`,
      'codex',
    )
  }
  // codex.js 是 node 脚本，直接 spawn 在 Windows 上不可靠，统一用当前 node 起
  return { command: process.execPath, args: [realCodex, 'app-server'] }
}

/** `turn.failed` 事件里的人类可读原因。 */
function errorMessageOf(event: { error?: { message?: string } | string; message?: string }): string {
  if (typeof event.error === 'string') return event.error
  if (event.error?.message) return event.error.message
  return event.message ?? 'codex turn failed'
}
