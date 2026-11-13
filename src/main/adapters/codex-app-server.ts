/**
 * Codex 常驻服务（`codex app-server`）客户端 —— G7-2 的「问了再放行」通道。
 *
 * 为什么必须换协议：v3.29 已用真实回合否掉「只差 CLI 入口」这个判断 ——
 * 随包 `codex-cli 0.135.0` 与 ChatGPT 内置 `0.162.0-alpha.17.2` 的
 * `codex exec` 都没有 `-a/--ask-for-approval`，唯一与审批有关的开关是
 * `--dangerously-bypass-approvals-and-sandbox`（只能关、不能开）；
 * `-c approval_policy="on-request"` 下真实回合仍报
 * `MCP tool call requires approval, but approval policy is never`。
 *
 * `app-server` 走的是另一套通道：JSON-RPC over stdio，**服务端反向请求客户端**
 * 要审批决定（v3.33 实机验证，0.162）：
 *
 *   → initialize {clientInfo}
 *   ← {userAgent, codexHome, platformFamily, platformOs}
 *   → thread/start {cwd, approvalPolicy:'on-request', sandbox:'workspace-write'}
 *   ← {thread:{id}, model, approvalPolicy, sandbox}
 *   → turn/start {threadId, input:[{type:'text', text}]}
 *   ← item/*, item/agentMessage/delta, thread/tokenUsage/updated, turn/completed
 *   ← item/commandExecution/requestApproval {id:0, command, cwd, reason,
 *                                            commandActions, availableDecisions}
 *   → {id:0, result:{decision:'accept'}}      ← 命令**真的执行**
 *   → {id:0, result:{decision:'cancel'}}      ← 命令不执行，模型如实说明
 *
 * 三个只有实机能发现的坑（都写进了实现）：
 * 1. **服务端请求 id 从 0 开始**，与客户端 id 是两个独立空间。判「请求还是响应」
 *    只能看有没有 `method`，不能看 id 大小；客户端 id 从 1 起，避免与 0 混淆。
 * 2. **`availableDecisions` 是按场景收窄的**。命令审批实测只给
 *    `[accept, {acceptWithExecpolicyAmendment}, cancel]` —— **没有 `decline`**。
 *    盲发 `decline` 等于把「拒绝」表达成服务端不认识的选项，只能按 `cancel` 回。
 * 3. **`thread/start` 会整份加载 `~/.codex/config.toml`**，任何版本不认识的字段
 *    都让整次调用失败：随包 0.135 遇到 `model_reasoning_effort = "max"`
 *    直接回 `-32600 failed to load configuration … unknown variant 'max'`，
 *    且 `-c` 覆盖**救不回来**（文件解析失败发生在覆盖之前）。所以错误必须原样
 *    抬给用户，不能吞成「回合没反应」。
 *
 * 两个刻意的设计：
 * 1. **事件方言对齐 `codex exec --json` / SDK 的 `item.completed`**：把 v2 的
 *    `item/completed{type:'commandExecution', aggregatedOutput}` 翻成
 *    `{type:'item.completed', item:{type:'command_execution', output}}`，
 *    于是 `CodexStreamNormalizer` 一行都不用改，两条路径的轨迹口径天然一致。
 * 2. **spawn 可注入**：CI 上没有 codex 二进制，协议胶水（握手顺序、审批决策收敛、
 *    token 差分、错误分类）必须能脱离真实 CLI 被验证。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { CodexStreamEvent } from '../agent/runtime/normalize/codex'
import type { McpServerConfig } from '@shared/types'

/** 服务端会反向请求的三种审批（v1 的 ExecCommand/ApplyPatch 不再使用）。 */
export type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'

/** 一次审批请求里宿主真正需要的字段（其余原样留给 UI 展示）。 */
export interface CodexApprovalRequest {
  /** JSON-RPC id，回执要原样带回 */
  requestId: string | number
  method: string
  threadId?: string
  turnId?: string
  itemId?: string
  /** 为什么要审批：实测是模型/执行器写的自然语言理由，直接可上屏 */
  reason?: string
  command?: string
  cwd?: string
  changes?: Array<{ path: string; kind?: string }>
  /** 服务端认可的决定项；拒绝时**只能**从这里挑 */
  availableDecisions?: unknown[]
  /**
   * MCP 工具审批（`mcpServer/elicitation/request` 且
   * `_meta.codex_approval_kind='mcp_tool_call'`）。
   *
   * 实测（0.162）：这条通道不是 `*requestApproval`，回执也不是 `decision`，
   * 而是 `{action:'accept'|'decline'|'cancel'}`；回空对象会被判成拒绝
   * （`"user rejected MCP tool call"`）。
   */
  mcp?: {
    server: string
    tool: string
    description?: string
    arguments?: Record<string, unknown>
    message?: string
  }
  /** 原始 params，避免为每个变体都建一套类型 */
  raw: Record<string, unknown>
}

export interface CodexAppServerPlan {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * spawn 的最小面（只用到这三点）。理由同 `opencode-serve`：不直接写
 * `typeof spawn`，单测注入假进程时不用 `as unknown as`。
 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess

export interface CodexAppServerOptions {
  plan: CodexAppServerPlan
  /** 单测注入点；默认 `child_process.spawn` */
  spawnImpl?: SpawnLike
  /** 单次请求（initialize / thread / turn 的受理）上限 */
  requestTimeoutMs?: number
  log?: (message: string) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** 归一化器那一侧 item 的类型（`CodexItem` 没导出，用事件字段反推）。 */
type CodexItemShape = NonNullable<CodexStreamEvent['item']>

/** JSON-RPC 一帧。字段全可选，靠 `method` / `result` / `error` 区分语义。 */
interface JsonRpcFrame {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/** 服务端通知里 `params` 的形状（只取用到的部分）。 */
interface ServerNotification {
  method: string
  params: Record<string, unknown>
}

/**
 * 把 v2 的 item 翻成 SDK 方言的 item。
 *
 * 字段名差异是实机比对出来的：v2 是 camelCase（`aggregatedOutput` / `exitCode`），
 * SDK 是 snake_case（`output`）。`status` 两边同名，归一化器的失败判定直接用。
 */
export function mapItem(raw: Record<string, unknown> | undefined): CodexStreamEvent['item'] {
  if (!raw) return undefined
  const id = typeof raw.id === 'string' ? raw.id : undefined
  switch (raw.type) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: raw.text as string | undefined }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: raw.command as string | undefined,
        output: raw.aggregatedOutput as string | undefined,
        status: raw.status as string | undefined,
      }
    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: raw.changes as CodexItemShape['changes'],
        status: raw.status as string | undefined,
      }
    case 'mcpToolCall':
      return {
        id,
        type: 'mcp_tool_call',
        server: raw.server as string | undefined,
        tool: raw.tool as string | undefined,
        arguments: raw.arguments,
        result: raw.result,
        status: raw.status as string | undefined,
        error: raw.error as { message?: string } | string | undefined,
      }
    default:
      // 未知 item 原样透传类型，归一化器按 C5 忽略
      return { id, type: String(raw.type) }
  }
}

/**
 * 把一条服务端通知翻成 `CodexStreamNormalizer` 认识的事件。
 *
 * `turn/completed` 的 `status` 有四种：`completed` / `interrupted` / `failed` /
 * `inProgress`。**只有 `completed` 能当成功**——把 `interrupted` 读成完成，
 * 界面会显示「已完成」而实际是被打断的回合。
 */
export function toCodexStreamEvent(
  notification: ServerNotification,
  usage?: { input_tokens: number; output_tokens: number },
): CodexStreamEvent | null {
  const params = notification.params ?? {}
  switch (notification.method) {
    case 'thread/started': {
      const thread = params.thread as { id?: string } | undefined
      return { type: 'thread.started', thread_id: thread?.id }
    }
    case 'turn/started':
      return { type: 'turn.started' }
    case 'item/started':
      return {
        type: 'item.started',
        item: mapItem(params.item as Record<string, unknown> | undefined),
      }
    case 'item/completed':
      return {
        type: 'item.completed',
        item: mapItem(params.item as Record<string, unknown> | undefined),
      }
    case 'turn/completed': {
      const turn = params.turn as { status?: string; error?: { message?: string } } | undefined
      if (turn?.status === 'failed' || turn?.status === 'interrupted') {
        const message =
          turn.error?.message ??
          (turn.status === 'interrupted' ? 'codex turn interrupted' : 'codex turn failed')
        return { type: 'turn.failed', error: { message } }
      }
      if (turn?.status !== 'completed') return null
      return { type: 'turn.completed', usage }
    }
    case 'error': {
      const error = params as { message?: string }
      return { type: 'error', message: error.message ?? 'codex app-server error' }
    }
    default:
      return null
  }
}

/**
 * 把审批请求翻成宿主审批钩子吃的 `(toolName, input)`。
 *
 * 命令执行**必须叫 `bash`**：宿主的只读白名单、危险命令判定、exec 面 literal
 * 收敛全都挂在 `bashPolicyForTool` 上，而它只认这个名字（MCP 那边同理，写类
 * 工具靠动词清单识别）。这里若起个「更准确」的名字（`command_execution`），
 * 审批卡片照样会弹，但**策略层整层失效** —— 只读会话里一条 `cat` 要问一遍，
 * `rm -rf` 也不会被策略判死，只剩「问一次」。轨迹里工具名仍是
 * `command_execution`（归一化器负责），两者是不同的关注点。
 */
export function approvalToToolCall(request: CodexApprovalRequest): {
  toolName: string
  input: Record<string, unknown>
} {
  if (request.mcp) {
    // 与 claude-code 的 MCP 工具名同形（`mcp__server__tool`），
    // 下游策略对非 bash 名字走交互审批，审批卡上也能看出是哪个 server 的哪个工具。
    return {
      toolName: `mcp__${request.mcp.server}__${request.mcp.tool}`,
      input: {
        server: request.mcp.server,
        tool: request.mcp.tool,
        arguments: request.mcp.arguments ?? {},
        description: request.mcp.description,
        message: request.mcp.message,
      },
    }
  }
  if (request.method === 'item/commandExecution/requestApproval') {
    return {
      toolName: 'bash',
      input: { command: request.command, cwd: request.cwd, reason: request.reason },
    }
  }
  if (request.method === 'item/fileChange/requestApproval') {
    return {
      toolName: 'file_change',
      input: { changes: request.changes ?? [], reason: request.reason },
    }
  }
  return { toolName: 'permissions', input: { reason: request.reason, ...request.raw } }
}

/** 服务端认可的决定项里，是否包含某一项（字符串或带键的对象都算）。 */
function hasDecision(available: unknown[] | undefined, option: string): boolean {
  if (!available) return false
  return available.some((entry) =>
    typeof entry === 'string' ? entry === option : typeof entry === 'object' && entry !== null && option in entry,
  )
}

/**
 * 把宿主的裁决翻成服务端的回执。
 *
 * 拒绝为什么可能是 `cancel` 而不是 `decline`：命令审批的 `availableDecisions`
 * 实测只有 `[accept, {acceptWithExecpolicyAmendment}, cancel]`（0.162 实机），
 * 没有 `decline`。`cancel` 的语义是「拒绝并中断本回合」，是这里唯一能表达
 * 「不许跑」的选项 —— 若硬发 `decline`，服务端不认，回合会一直等下去。
 * 文件变更审批四种都有，优先 `decline`（模型还能继续干别的）。
 *
 * 放行只用 `accept`：`acceptForSession` 是会话级放行，宿主的 approvals 已经
 * 记了这一层，这里再记一层会让「撤销授权」失效（与 opencode 侧同口径）。
 */
export function buildApprovalReply(
  behavior: 'allow' | 'deny',
  request: CodexApprovalRequest,
): Record<string, unknown> {
  // MCP 工具走 elicitation，回执是 MCP 的 action，不是 codex 的 decision
  if (request.mcp) {
    return { action: behavior === 'allow' ? 'accept' : 'decline', content: {} }
  }
  const available = request.availableDecisions
  if (request.method === 'item/permissions/requestApproval') {
    // 权限审批的回执不是 decision，而是「给多少权限」；拒绝给空集 + 本回合生效
    return behavior === 'allow'
      ? { permissions: {}, scope: 'turn' }
      : { permissions: { fileSystem: { read: [], write: [] }, network: { enabled: false } }, scope: 'turn' }
  }
  if (behavior === 'allow') {
    if (hasDecision(available, 'accept') || !available) return { decision: 'accept' }
    if (hasDecision(available, 'acceptWithExecpolicyAmendment')) {
      const amendment = request.raw.proposedExecpolicyAmendment
      return {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: Array.isArray(amendment) ? amendment : [],
          },
        },
      }
    }
    return { decision: 'accept' }
  }
  if (hasDecision(available, 'decline') || !available) return { decision: 'decline' }
  return { decision: 'cancel' }
}

/** TOML 基本字符串：JSON 的转义规则是它的子集（`\"`、`\\`、`\n`、`\uXXXX` 都合法）。 */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** 一组 server → `mcp_servers` 表的 TOML 值（名字一律加引号，带点/空格的也安全）。 */
function tomlMcpTable(servers: McpServerConfig[]): string {
  const entries = servers.map((server) => {
    const envPairs = Object.entries(server.env ?? {})
      .filter(([key]) => Boolean(key))
      .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    const parts = [
      `command=${tomlString(server.command)}`,
      ...(server.args?.length ? [`args=[${server.args.map(tomlString).join(', ')}]`] : []),
      ...(envPairs.length > 0 ? [`env={${envPairs.join(', ')}}`] : []),
    ]
    return `${tomlString(server.name)}={${parts.join(', ')}}`
  })
  return `{${entries.join(', ')}}`
}

/**
 * 把设置里的 MCP server 翻成 `codex app-server -c` 覆写参数（G7-1）。
 *
 * 为什么不写 `~/.codex/config.toml`：那是用户自己的东西，宿主改它等于偷偷改
 * 别人其它终端的配置；`-c` 是**进程级**覆盖，随进程消失。
 *
 * ⚠️ 已知边界：`codex app-server` 仍会整份加载用户的 `~/.codex/config.toml`，
 * 用户自己配的 MCP server 在 BizGraph 会话里**也可见**（它们的工具调用同样会被
 * elicitation 挡住，不会绕过审批）。要彻底隔离得换 `CODEX_HOME`，但那会连带
 * 丢掉用户的登录态，暂不做。
 */
export function mcpServerOverrideArgs(servers: McpServerConfig[] | undefined): string[] {
  const usable = (servers ?? []).filter((server) => server?.enabled && server.name && server.command)
  if (usable.length === 0) return []
  // 一次覆写整张表，而不是逐 server 拼点路径：`-c` 的 key 是**点路径不是 TOML 文本**，
  // `mcp_servers."my.server".command` 会把引号当成名字的一部分（v3.35 实测不注册）。
  // 整表作为 TOML 值再解析时，带引号的键才生效。
  return ['-c', `mcp_servers=${tomlMcpTable(usable)}`]
}

/**
 * `codex app-server` 客户端。一个客户端 = 一个常驻进程 = 一个会话。
 *
 * 与 `opencode serve` 的差别是传输：那边是 HTTP+SSE，这边是 stdio 上的
 * 逐行 JSON-RPC。共同点是「服务端主动提问、客户端作答」，这也正是 `exec`
 * 路径缺的那一半。
 */
export class CodexAppServerClient {
  private readonly child: ChildProcess | null
  private readonly pending = new Map<string | number, { resolve: (v: JsonRpcFrame) => void; reject: (e: Error) => void }>()
  private readonly listeners = new Set<(event: CodexStreamEvent) => void>()
  private readonly approvalHandler: (request: CodexApprovalRequest) => void
  private readonly log: (message: string) => void
  private nextId = 1
  private closed = false
  /** 线程累计 token 快照：回合用量 = 结束 - 开始（服务端只给 total/last） */
  private usageBaseline = { input: 0, output: 0 }
  private lastUsage = { input: 0, output: 0 }
  /** 最近一条 `item/started{mcpToolCall}`：MCP 审批请求里没有 tool 字段，要靠它反查 */
  private lastMcpToolCall: { server: string; tool: string } | null = null

  private constructor(
    child: ChildProcess | null,
    approvalHandler: (request: CodexApprovalRequest) => void,
    log: (message: string) => void,
  ) {
    this.child = child
    this.approvalHandler = approvalHandler
    this.log = log
  }

  static async start(
    options: CodexAppServerOptions & {
      onApproval: (request: CodexApprovalRequest) => void
    },
  ): Promise<CodexAppServerClient> {
    const spawnImpl = options.spawnImpl ?? spawn
    const log = options.log ?? (() => {})
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const { plan } = options

    const child = spawnImpl(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const client = new CodexAppServerClient(child, options.onApproval, log)
    client.attach()
    // 握手必须最先完成：没有 initialize 就 thread/start，服务端会直接拒
    await client.request('initialize', {
      clientInfo: { name: 'bizgraph', title: 'BizGraph', version: '1.0.0' },
    }, timeoutMs)
    return client
  }

  private attach(): void {
    const child = this.child
    if (!child?.stdout) return
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => this.onLine(line))
    child.stderr?.on('data', (chunk: Buffer) => {
      // stderr 是诊断通道（配置警告、rmcp 传输错误都只在这里），
      // 不并入事件流，但一定要留在日志里，否则「回合卡住」无从解释
      const text = chunk.toString('utf-8').trim()
      if (text) this.log(`[codex app-server] ${text.slice(0, 500)}`)
    })
    child.once('exit', (code) => {
      this.closed = true
      const error = new Error(`codex app-server 已退出（code ${code}）`)
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
    })
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame
    } catch {
      this.log(`[codex app-server] 非 JSON 输出：${trimmed.slice(0, 200)}`)
      return
    }

    // 服务端 → 客户端请求：有 method、有 id、没有 result/error
    if (frame.method && frame.id !== undefined && frame.result === undefined && frame.error === undefined) {
      this.handleServerRequest(frame)
      return
    }

    // 通知：有 method 无 id
    if (frame.method && frame.id === undefined) {
      this.handleNotification(frame)
      return
    }

    // 响应
    if (frame.id !== undefined) {
      const waiter = this.pending.get(frame.id)
      if (!waiter) return
      this.pending.delete(frame.id)
      if (frame.error) {
        waiter.reject(new Error(frame.error.message ?? `codex app-server error ${frame.error.code ?? ''}`.trim()))
      } else {
        waiter.resolve(frame)
      }
    }
  }

  private handleNotification(frame: JsonRpcFrame): void {
    const notification: ServerNotification = { method: frame.method as string, params: frame.params ?? {} }

    // MCP 审批请求里没有 tool 字段，靠 `item/started{mcpToolCall}` 反查 —— 记最近一条
    if (notification.method === 'item/started') {
      const item = (notification.params.item ?? {}) as Record<string, unknown>
      if (item.type === 'mcpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string') {
        this.lastMcpToolCall = { server: item.server, tool: item.tool }
      }
    }

    // token 用量是**线程累计值**，要拿它算回合用量，所以先记账、不往下发
    if (notification.method === 'thread/tokenUsage/updated') {
      const usage = notification.params.tokenUsage as
        | { total?: { inputTokens?: number; outputTokens?: number } }
        | undefined
      const total = usage?.total
      if (total) this.lastUsage = { input: total.inputTokens ?? 0, output: total.outputTokens ?? 0 }
      return
    }

    // 服务端只给累计值，回合用量靠差分。多轮工具调用会被合并成一个数，
    // 但至少是真实值而不是估算（`last` 只覆盖最后一次模型调用，会严重低估）。
    const usage =
      notification.method === 'turn/completed'
        ? {
            input_tokens: Math.max(0, this.lastUsage.input - this.usageBaseline.input),
            output_tokens: Math.max(0, this.lastUsage.output - this.usageBaseline.output),
          }
        : undefined

    const event = toCodexStreamEvent(notification, usage)
    if (!event) return
    for (const listener of this.listeners) listener(event)
  }

  private handleServerRequest(frame: JsonRpcFrame): void {
    const method = frame.method as string
    const params = frame.params ?? {}
    if (method === 'mcpServer/elicitation/request') {
      this.handleElicitation(frame.id as string | number, params)
      return
    }
    if (method.endsWith('requestApproval')) {
      const request: CodexApprovalRequest = {
        requestId: frame.id as string | number,
        method,
        threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
        turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
        itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
        reason: typeof params.reason === 'string' ? params.reason : undefined,
        command: typeof params.command === 'string' ? params.command : undefined,
        cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
        changes: Array.isArray(params.changes)
          ? (params.changes as Array<{ path: string; kind?: string }>)
          : undefined,
        availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined,
        raw: params,
      }
      this.approvalHandler(request)
      return
    }
    // 其余反向请求（动态工具、用户输入）本轮不接管：
    // 回一个空结果会让模型以为「问了但没人答」，比直接拒更危险。
    this.log(`[codex app-server] 未处理的服务器请求：${method}`)
    this.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `unsupported: ${method}` } })
  }

  /**
   * MCP 工具的审批通道：`mcpServer/elicitation/request`。
   *
   * 实测形状（0.162）：
   * ```
   * { serverName, mode:'form', message:'Allow the marker MCP server to run tool "write_marker"?',
   *   requestedSchema:{type:'object',properties:{}},
   *   _meta:{ codex_approval_kind:'mcp_tool_call', tool_description, tool_params,
   *           tool_params_display, persist:['session','always'] } }
   * ```
   * 回 `{action:'accept', content:{}}` 后工具**真的执行**；`{action:'decline'}`
   * 或任何非 accept 回执（含 `{}`、`-32601`）都会把这次调用判成失败。
   *
   * 不是 `mcp_tool_call` 的 elicitation 是真表单（MCP server 找用户要输入），
   * 我们不渲染表单，统一回 `cancel` —— 明确「没答」，而不是空对象冒充答案。
   */
  private handleElicitation(requestId: string | number, params: Record<string, unknown>): void {
    const meta = (params._meta ?? {}) as Record<string, unknown>
    const approvalKind = meta.codex_approval_kind
    if (approvalKind !== 'mcp_tool_call') {
      this.log(`[codex app-server] 非审批 elicitation（${String(approvalKind ?? '无 kind')}），回 cancel`)
      this.write({ jsonrpc: '2.0', id: requestId, result: { action: 'cancel' } })
      return
    }
    const serverName = typeof params.serverName === 'string' ? params.serverName : undefined
    const message = typeof params.message === 'string' ? params.message : undefined
    // 协议里**没有**独立 tool 字段：工具名只在 message 的引号里
    // （`Allow the marker MCP server to run tool "write_marker"?`），
    // 或可从紧挨着的 `item/started{mcpToolCall}` 反查。两路都保留，优先 message。
    const fromMessage = message?.match(/run tool\s+"([^"]+)"/)?.[1]
    const fromItem =
      this.lastMcpToolCall && (!serverName || this.lastMcpToolCall.server === serverName)
        ? this.lastMcpToolCall.tool
        : undefined
    const tool = fromMessage ?? fromItem
    if (!serverName || !tool) {
      // 缺字段等于「不知道在批什么」，不能猜一个放行
      this.log('[codex app-server] MCP 审批缺少 server/tool，按拒绝处理')
      this.write({ jsonrpc: '2.0', id: requestId, result: { action: 'decline' } })
      return
    }
    this.approvalHandler({
      requestId,
      method: 'mcpServer/elicitation/request',
      threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
      mcp: {
        server: serverName,
        tool,
        description: typeof meta.tool_description === 'string' ? meta.tool_description : undefined,
        arguments:
          typeof meta.tool_params === 'object' && meta.tool_params !== null
            ? (meta.tool_params as Record<string, unknown>)
            : undefined,
        message,
      },
      raw: params,
    })
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.child?.stdin || this.closed) return
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex app-server ${method} 在 ${timeoutMs}ms 内没有响应`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame.result ?? {})
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * 订阅**已翻译**的事件流（`CodexStreamNormalizer` 直接能吃）。
   *
   * 翻译放在客户端里而不是适配器里，是因为「哪种通知算回合事件」本身就是协议
   * 知识：`thread/tokenUsage/updated` 要记账、`item/completed` 要换字段名、
   * `turn/completed` 要先判 `status`。这些留在这里，适配器只负责转发。
   */
  onEvent(listener: (event: CodexStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 建线程。`approvalPolicy=on-request` 是「问了再放行」的开关。 */
  async startThread(input: {
    cwd: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-request' | 'never'
    ephemeral?: boolean
  }): Promise<{ threadId: string; model?: string; approvalPolicy?: string; sandbox?: unknown }> {
    const result = await this.request('thread/start', {
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      sandbox: input.sandbox ?? 'workspace-write',
      approvalPolicy: input.approvalPolicy ?? 'on-request',
      ephemeral: input.ephemeral ?? true,
    })
    const thread = result.thread as { id?: string } | undefined
    if (!thread?.id) throw new Error('codex app-server 没有返回 thread.id')
    // 新线程从 0 起算：服务端的 total 是线程累计
    this.usageBaseline = { input: 0, output: 0 }
    this.lastUsage = { input: 0, output: 0 }
    return {
      threadId: thread.id,
      model: typeof result.model === 'string' ? result.model : undefined,
      approvalPolicy: typeof result.approvalPolicy === 'string' ? result.approvalPolicy : undefined,
      sandbox: result.sandbox,
    }
  }

  /**
   * 续接已有线程（`resumeSessionId`）。
   *
   * 与 `thread/start` 的区别只有 id 与「恢复历史」：不续接的话多轮会各开一条
   * 新线程，模型看不到上一轮说过什么 —— 而适配器对外声明了 `supportsNativeResume`，
   * 那就必须真的续上。
   */
  async resumeThread(input: {
    threadId: string
    cwd: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-request' | 'never'
  }): Promise<{ threadId: string }> {
    const result = await this.request('thread/resume', {
      threadId: input.threadId,
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      sandbox: input.sandbox ?? 'workspace-write',
      approvalPolicy: input.approvalPolicy ?? 'on-request',
    })
    const thread = result.thread as { id?: string } | undefined
    return { threadId: thread?.id ?? input.threadId }
  }

  /** 发一轮。返回 turnId；完成与否靠 `turn/completed` 通知判定。 */
  async startTurn(input: { threadId: string; text: string; model?: string }): Promise<{ turnId: string }> {
    const result = await this.request('turn/start', {
      threadId: input.threadId,
      input: [{ type: 'text', text: input.text }],
      ...(input.model ? { model: input.model } : {}),
    })
    const turn = result.turn as { id?: string } | undefined
    if (!turn?.id) throw new Error('codex app-server 没有返回 turn.id')
    return { turnId: turn.id }
  }

  /** 打断当前回合。`turn/interrupt` 是唯一的取消通道。 */
  async interrupt(threadId: string, turnId?: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, ...(turnId ? { turnId } : {}) })
  }

  /** 回执审批。id 用服务端给的，不能自造。 */
  replyApproval(requestId: string | number, result: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id: requestId, result })
  }

  /** 子进程 id（宿主按它回收）。 */
  get pid(): number | undefined {
    return this.child?.pid
  }

  get childRef(): ChildProcess {
    if (!this.child) throw new Error('codex app-server 没有子进程句柄')
    return this.child
  }

  /** 结束进程。幂等。 */
  async dispose(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.closed = true
      return
    }
    this.closed = true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
