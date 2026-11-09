/**
 * W5-C1：ACP（Agent Client Protocol）执行器。
 *
 * 职责边界（与 adapter-driver.ts 的分工，禁止出现第二套执行路径）：
 * - `adapter-driver.ts` 适配仓库内既有 12 个 AgentAdapter，复用它们自己的输出与钩子；
 * - 本文件只实现 **ACP 协议**：直接 spawn 一个 ACP agent 子进程，走 JSON-RPC
 *   （`initialize` / `session/new` / `session/prompt` / `session/cancel`），
 *   把 `session/update` 映射成同一套 `agent_events`，把
 *   `session/request_permission` 交给同一个 ApprovalGateway（写前强制审批）。
 * - 两者都实现 `BackendDriver` 契约，Runtime 只认 driver；ACP 子进程同样通过
 *   `context.registerProcess` 登记真实 pid/pgid，取消与启动清扫走同一套分层回收。
 *
 * 协议要点：
 * - 传输为 stdio 上的逐行 JSON-RPC 2.0；
 * - agent → client 的 `session/request_permission` 必须在执行工具前响应；
 * - `session/update` 的 `tool_call*` 状态决定 step 的 approved_at/executing_at。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type {
  ApprovalOutcome,
  BackendDriver,
  DriverCapabilities,
  DriverExecuteContext,
  DriverExecuteRequest,
  DriverExecuteResult,
  Fidelity,
  NormalizedEventEnvelope,
  RiskLevel,
} from '@shared/types/agent-runtime'
import { createLogger } from '../../../shared/logger'
import { ACP_CAPABILITIES } from '../capabilities'
import { eventIdFor, hashArgs, newId } from '../util'

const logger = createLogger('AcpExecutor')

export const ACP_COMMAND_ENV = 'BIZGRAPH_ACP_COMMAND'
export const ACP_ARGS_ENV = 'BIZGRAPH_ACP_ARGS'

export interface AcpBackendDriverOptions {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  clientName?: string
  clientVersion?: string
  protocolVersion?: number
  /** initialize / session/new 的握手时限 */
  handshakeTimeoutMs?: number
  /** 0 = 由 Runtime 的 deadline / cancel 负责；>0 时 prompt 超时返回 failed */
  promptTimeoutMs?: number
}

interface RpcError {
  code: number
  message: string
  data?: unknown
}

interface RpcMessage {
  jsonrpc?: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcError
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown
type NotificationHandler = (params: unknown) => void

interface AcpSession {
  readonly agentSessionId: string
  readonly child: ChildProcess
  readonly connection: AcpConnection
  readonly toolRecords: Map<string, ToolRecord>
  acpSessionId: string | null
  activeTurn: ActiveTurn | null
}

interface ActiveTurn {
  readonly request: DriverExecuteRequest
  readonly context: DriverExecuteContext
  readonly stream: TurnStream
  cancelled: boolean
}

interface ToolRecord {
  readonly stepId: string
  readonly toolName: string
  requested: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textOfContent(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined
  if (typeof content.text === 'string') return content.text
  // ACP 也允许 content 是数组（多段）
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
    return parts.length > 0 ? parts.join('') : undefined
  }
  return undefined
}

/** TurnStream：driver 内部按产生顺序写归一化事件（Runtime 负责分配最终 seq）。 */
class TurnStream {
  private seq = 0
  finalText = ''

  constructor(
    private readonly runId: string,
    private readonly turnId: string,
    private readonly record: DriverExecuteContext['record'],
  ) {}

  emit(
    type: NormalizedEventEnvelope['type'],
    payload: Record<string, unknown>,
    options: { fidelity: Fidelity; stepId?: string; source?: NormalizedEventEnvelope['source'] },
  ): void {
    this.seq += 1
    this.record([
      {
        eventId: eventIdFor(this.turnId, this.seq),
        runId: this.runId,
        turnId: this.turnId,
        seq: this.seq,
        type,
        source: options.source ?? 'backend',
        fidelity: options.fidelity,
        payloadVersion: 1,
        payload,
        timestamp: Date.now(),
        ...(options.stepId ? { stepId: options.stepId } : {}),
      },
    ])
  }
}

/** 逐行 JSON-RPC 2.0 客户端；只服务于本执行器。 */
class AcpConnection {
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly notificationHandlers = new Map<string, NotificationHandler>()
  private nextId = 1
  private buffer = ''
  private closedError: Error | null = null

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => logger.debug(`[acp stderr] ${String(chunk).trim()}`))
    child.on('exit', (code, signal) => {
      this.close(new Error(`ACP process exited code=${code} signal=${signal ?? 'none'}`))
    })
    child.on('error', (error) => {
      this.close(error)
    })
  }

  get closed(): boolean {
    return this.closedError !== null
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`ACP ${method} timeout after ${timeoutMs}ms`))
            }, timeoutMs)
          : undefined
      timer?.unref?.()
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.closedError) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  close(error: Error): void {
    if (this.closedError) return
    this.closedError = error
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private send(message: RpcMessage): void {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed) {
      this.close(new Error('ACP stdin is closed'))
      return
    }
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: RpcMessage
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) return
      message = parsed as RpcMessage
    } catch (error) {
      logger.warn(`[acp] 非法 JSON-RPC 行: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    // agent → client 请求（带 id + method）
    if (typeof message.method === 'string' && message.id !== undefined) {
      const handler = this.requestHandlers.get(message.method)
      if (!handler) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not supported: ${message.method}` },
        })
        return
      }
      void Promise.resolve(handler(message.params))
        .then((result) => this.send({ jsonrpc: '2.0', id: message.id, result }))
        .catch((error: unknown) => {
          this.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          })
        })
      return
    }

    // agent → client 通知（只有 method）
    if (typeof message.method === 'string') {
      this.notificationHandlers.get(message.method)?.(message.params)
      return
    }

    // client 请求的响应
    if (message.id !== undefined) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id)
      const entry = Number.isFinite(id) ? this.pending.get(id) : undefined
      if (!entry) return
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(
          new Error(`ACP error ${message.error.code}: ${message.error.message}`),
        )
      } else {
        entry.resolve(message.result)
      }
    }
  }
}

function toolNameOf(toolCall: Record<string, unknown>): string {
  switch (toolCall.kind) {
    case 'execute':
      return 'Bash'
    case 'edit':
    case 'delete':
    case 'move':
      return 'Write'
    case 'read':
      return 'Read'
    case 'search':
      return 'Grep'
    case 'fetch':
      return 'Fetch'
    default:
      return typeof toolCall.title === 'string' && toolCall.title.trim()
        ? toolCall.title.trim()
        : 'ACP'
  }
}

function riskOf(toolName: string): RiskLevel {
  if (toolName === 'Bash') return 'critical'
  if (/write|edit|delete|move|patch|apply/i.test(toolName)) return 'high'
  if (/fetch|web|http|mcp/i.test(toolName)) return 'medium'
  return 'low'
}

function optionForDecision(
  options: Array<Record<string, unknown>>,
  decision: ApprovalOutcome['decision'],
  sessionGranted: boolean,
): string | undefined {
  const kinds = options.map((option) => (typeof option.kind === 'string' ? option.kind : ''))
  if (decision === 'allow') {
    const preferred = sessionGranted ? 'allow_always' : 'allow_once'
    if (kinds.includes(preferred)) return String(options[kinds.indexOf(preferred)].optionId)
    const fallback = kinds.find((kind) => kind.startsWith('allow'))
    return fallback === undefined ? undefined : String(options[kinds.indexOf(fallback)].optionId)
  }
  const preferredReject = 'reject_once'
  if (kinds.includes(preferredReject)) return String(options[kinds.indexOf(preferredReject)].optionId)
  const fallbackReject = kinds.find((kind) => kind.startsWith('reject'))
  return fallbackReject === undefined ? undefined : String(options[kinds.indexOf(fallbackReject)].optionId)
}

export class AcpBackendDriver implements BackendDriver {
  readonly name = 'acp'
  readonly capabilities: DriverCapabilities = ACP_CAPABILITIES

  private readonly options: Required<
    Pick<
      AcpBackendDriverOptions,
      | 'command'
      | 'args'
      | 'env'
      | 'clientName'
      | 'clientVersion'
      | 'protocolVersion'
      | 'handshakeTimeoutMs'
      | 'promptTimeoutMs'
    >
  >
  private readonly sessions = new Map<string, AcpSession>()
  private disposed = false

  constructor(options: AcpBackendDriverOptions) {
    this.options = {
      args: [],
      env: {},
      clientName: 'bizgraph',
      clientVersion: '0.1.0',
      protocolVersion: 1,
      handshakeTimeoutMs: 15_000,
      promptTimeoutMs: 0,
      ...options,
    }
  }

  async execute(
    request: DriverExecuteRequest,
    context: DriverExecuteContext,
  ): Promise<DriverExecuteResult> {
    if (this.disposed) {
      return this.failedResult('ACP_DRIVER_DISPOSED', 'ACP driver has been disposed')
    }
    let session: AcpSession
    try {
      session = await this.ensureSession(request, context)
    } catch (error) {
      return this.failedResult(
        'ACP_INIT_FAILED',
        `ACP initialize failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (session.activeTurn) {
      return this.failedResult('ACP_SESSION_BUSY', 'ACP session already has an active prompt')
    }

    const stream = new TurnStream(request.runId, request.turnId, context.record)
    const active: ActiveTurn = { request, context, stream, cancelled: false }
    session.activeTurn = active
    session.toolRecords.clear()

    try {
      const result = await session.connection.request<Record<string, unknown>>(
        'session/prompt',
        {
          sessionId: session.acpSessionId,
          prompt: [{ type: 'text', text: request.prompt }],
        },
        this.options.promptTimeoutMs,
      )
      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn'
      if (active.cancelled || stopReason === 'cancelled' || context.signal.aborted) {
        return {
          status: 'cancelled',
          finalText: stream.finalText,
          completionSignal: 'backend-turn-completed',
        }
      }
      if (stopReason === 'refusal') {
        return {
          status: 'failed',
          finalText: stream.finalText,
          errorCode: 'ACP_REFUSAL',
          errorMessage: 'ACP agent refused the prompt',
          completionSignal: 'backend-turn-completed',
        }
      }
      return {
        status: 'completed',
        finalText: stream.finalText,
        completionSignal: 'backend-turn-completed',
      }
    } catch (error) {
      if (active.cancelled || context.signal.aborted) {
        return {
          status: 'cancelled',
          finalText: stream.finalText,
          completionSignal: 'backend-turn-completed',
        }
      }
      return this.failedResult(
        'ACP_PROMPT_FAILED',
        error instanceof Error ? error.message : String(error),
        stream.finalText,
      )
    } finally {
      session.activeTurn = null
      if (session.connection.closed) this.dropSession(session, 'process-exited')
    }
  }

  async cancel(request: DriverExecuteRequest): Promise<void> {
    const session = this.sessions.get(request.agentSessionId)
    if (!session) return
    if (session.activeTurn) session.activeTurn.cancelled = true
    if (!session.acpSessionId) return
    try {
      // ACP 规范：session/cancel 是通知；agent 应以 stopReason=cancelled 结束当前 prompt。
      session.connection.notify('session/cancel', { sessionId: session.acpSessionId })
    } catch (error) {
      logger.warn(`[acp] cancel notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 进程终结由 Runtime/ProcessReaper 先行完成；这里只清理本地连接与句柄。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.sessions.values()) this.dropSession(session, 'disposed')
    this.sessions.clear()
  }

  private failedResult(errorCode: string, errorMessage: string, finalText?: string): DriverExecuteResult {
    return {
      status: 'failed',
      errorCode,
      errorMessage,
      finalText,
      completionSignal: 'backend-turn-completed',
    }
  }

  private async ensureSession(
    request: DriverExecuteRequest,
    context: DriverExecuteContext,
  ): Promise<AcpSession> {
    const existing = this.sessions.get(request.agentSessionId)
    if (existing && !existing.connection.closed) return existing
    if (existing) this.dropSession(existing, 'stale')

    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: request.workingDirectory,
      env: {
        ...process.env,
        ...this.options.env,
        // 与本轮其它后端一致的归属标记：取消/启动清扫只认带标记的登记句柄。
        BIZGRAPH_TURN_ID: request.turnId,
      },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (!child.pid) {
      child.kill('SIGKILL')
      throw new Error(`ACP process failed to start: ${this.options.command}`)
    }
    // detached: true ⇒ 子进程同时是进程组组长，pgid = pid；Runtime 据此按组回收。
    context.registerProcess({ pid: child.pid, pgid: child.pid, envMarker: context.envMarker })

    const connection = new AcpConnection(child)
    const session: AcpSession = {
      agentSessionId: request.agentSessionId,
      child,
      connection,
      toolRecords: new Map(),
      acpSessionId: null,
      activeTurn: null,
    }
    this.sessions.set(request.agentSessionId, session)

    try {
      await connection.request(
        'initialize',
        {
          protocolVersion: this.options.protocolVersion,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: this.options.clientName,
            version: this.options.clientVersion,
          },
        },
        this.options.handshakeTimeoutMs,
      )
      const created = await connection.request<Record<string, unknown>>(
        'session/new',
        { cwd: request.workingDirectory, mcpServers: [] },
        this.options.handshakeTimeoutMs,
      )
      if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
        throw new Error('ACP session/new did not return a sessionId')
      }
      session.acpSessionId = created.sessionId
      connection.onNotification('session/update', (params) => this.onSessionUpdate(session, params))
      connection.onRequest('session/request_permission', (params) =>
        this.onPermissionRequest(session, params),
      )
      return session
    } catch (error) {
      this.dropSession(session, 'init-failed')
      throw error
    }
  }

  private dropSession(session: AcpSession, reason: string): void {
    this.sessions.delete(session.agentSessionId)
    session.connection.close(new Error(`ACP session dropped: ${reason}`))
    const child = session.child
    try {
      // 组内一次收掉（detached ⇒ pgid == pid）；已被 Runtime 回收时 ENOENT/ESRCH 忽略。
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }

  private onSessionUpdate(session: AcpSession, params: unknown): void {
    const active = session.activeTurn
    if (!active || !isRecord(params) || !isRecord(params.update)) return
    const update = params.update
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''

    switch (kind) {
      case 'agent_message_chunk': {
        const text = textOfContent(update.content)
        if (!text) return
        active.stream.finalText += text
        active.stream.emit(
          'message.delta',
          { role: 'assistant', text, mode: 'block' },
          { fidelity: 'token' },
        )
        return
      }
      case 'agent_thought_chunk': {
        const text = textOfContent(update.content)
        if (!text) return
        active.stream.emit('reasoning.delta', { text }, { fidelity: 'token' })
        return
      }
      case 'tool_call':
      case 'tool_call_update':
        this.onToolUpdate(session, update)
        return
      default:
        return
    }
  }

  private onToolUpdate(session: AcpSession, update: Record<string, unknown>): void {
    const active = session.activeTurn
    if (!active) return
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
    if (!toolCallId) return
    const status = typeof update.status === 'string' ? update.status : 'in_progress'
    const toolName = toolNameOf(update)
    const args = isRecord(update.rawInput) ? update.rawInput : {}
    const stepId = `step-${toolCallId}`
    const existing = session.toolRecords.get(toolCallId)

    if (!existing) {
      session.toolRecords.set(toolCallId, { stepId, toolName, requested: false })
      active.context.step.ensure(stepId, {
        kind: 'tool',
        toolName,
        argsHash: hashArgs(toolName, args),
        fidelity: 'token',
        status: status === 'in_progress' ? 'running' : 'requested',
      })
    }

    const record = session.toolRecords.get(toolCallId)!
    if (!record.requested) {
      record.requested = true
      active.stream.emit(
        'tool.requested',
        { toolCallId, toolName, input: args, risk: riskOf(toolName) },
        { fidelity: 'token', stepId },
      )
    }

    if (status === 'pending') {
      active.context.step.update(stepId, 'requested')
      return
    }
    // ACP 的 in_progress 才是「工具真正开始执行」：三阶段 executing_at 只写在这里。
    // completed/failed 不补写 executing_at —— 未收到 in_progress 就终态的工具，
    // 说明后端没告诉我们真实开始时间，宁可缺这一列也不伪造。
    if (status === 'in_progress') {
      active.context.step.update(stepId, 'running', { executingAt: Date.now() })
      return
    }
    if (status === 'completed' || status === 'failed') {
      const output = typeof update.rawOutput === 'string' ? update.rawOutput : update.content
      const ok = status === 'completed'
      active.stream.emit(
        ok ? 'tool.result' : 'tool.failed',
        {
          toolCallId,
          toolName,
          ok,
          ...(output === undefined ? {} : { output }),
        },
        { fidelity: 'token', stepId },
      )
      active.context.step.update(stepId, ok ? 'done' : 'failed', { resultRef: `acp:${toolCallId}` })
    }
  }

  private async onPermissionRequest(session: AcpSession, params: unknown): Promise<unknown> {
    const active = session.activeTurn
    if (!active || !isRecord(params)) {
      return { outcome: { outcome: 'cancelled' } }
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
    const options = Array.isArray(params.options)
      ? params.options.filter(isRecord)
      : []
    const toolCallId =
      typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : newId('acptool')
    const toolName = toolNameOf(toolCall)
    const args = isRecord(toolCall.rawInput)
      ? toolCall.rawInput
      : { title: typeof toolCall.title === 'string' ? toolCall.title : toolName }
    const stepId = `step-${toolCallId}`
    const risk = riskOf(toolName)
    const request = active.request
    const context = active.context

    context.step.ensure(stepId, {
      kind: 'tool',
      toolName,
      argsHash: hashArgs(toolName, args),
      fidelity: 'token',
      status: 'awaiting_approval',
    })
    const peeked = context.approvals.peek?.({
      toolName,
      args,
      stepId,
      cwd: request.workingDirectory,
    })
    if (!peeked) {
      active.stream.emit(
        'approval.required',
        { toolName, input: args, risk },
        { fidelity: 'token', stepId, source: 'kernel' },
      )
    }

    let outcome: ApprovalOutcome
    try {
      outcome = await context.approvals.request({
        toolName,
        args,
        stepId,
        cwd: request.workingDirectory,
      })
    } catch (error) {
      logger.warn(
        `[acp] approval request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      context.step.update(stepId, 'denied')
      return { outcome: { outcome: 'selected', optionId: optionForDecision(options, 'deny', false) } }
    }

    active.stream.emit(
      'approval.resolved',
      {
        approvalId: outcome.approvalId,
        decision: outcome.decision,
        decidedBy: outcome.decidedBy,
        ...(outcome.sessionGranted ? { scope: 'session' } : {}),
      },
      { fidelity: 'token', stepId, source: 'kernel' },
    )

    if (outcome.decision !== 'allow') {
      context.step.update(stepId, 'denied')
    } else {
      context.step.update(stepId, 'approved', { approvedAt: Date.now() })
    }

    const optionId = optionForDecision(options, outcome.decision, outcome.sessionGranted === true)
    if (!optionId) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return { outcome: { outcome: 'selected', optionId } }
  }
}

/** 从 env 构建 ACP driver；未配置 command 时返回 undefined（不注册、不改变默认路径）。 */
export function createAcpDriverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AcpBackendDriver | undefined {
  const command = env[ACP_COMMAND_ENV]?.trim()
  if (!command) return undefined
  return new AcpBackendDriver({
    command,
    args: parseArgs(env[ACP_ARGS_ENV] ?? ''),
  })
}

/** 极简参数解析：支持单/双引号，够 ACP 启动命令使用，不做 shell 展开。 */
function parseArgs(raw: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3])
  }
  return args
}
