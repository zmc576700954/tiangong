/**
 * OpenCode 常驻服务（`opencode serve`）客户端 —— G7-3 的「问了再放行」通道。
 *
 * 为什么必须换协议：
 * 无头 `opencode run` **没有审批通道**。`permission.bash=ask` 时 CLI 走
 * `auto-rejecting`，直接拒掉工具调用（v3.30 实机结论），所以那条路径只能做到
 * 「默认拒绝」，做不到「先问用户、放行后真的执行」。`serve` 暴露了一套完整的
 * 权限往返（v3.31 实机验证）：
 *
 *   POST /session               建会话，可带 permission ruleset
 *   POST /session/{id}/message  发 prompt（阻塞到回合结束）
 *   GET  /event                 SSE：`permission.asked` / `permission.replied`
 *                               / `message.part.updated` / `session.idle`
 *   POST /permission/{id}/reply {"reply":"once"|"always"|"reject"}
 *
 * 实测链路：建一个 bash 全 ask 的会话 → 让模型跑 `echo …` → SSE 收到
 * `permission.asked{patterns,metadata.command,tool.callID}` → 回 `once` →
 * 工具真的执行（输出进 `message.part.updated` 的 `state.output`）→ `session.idle`。
 *
 * 两个刻意的设计：
 * 1. **事件方言对齐 `run --format json`**：把 SSE 事件翻译成 `tool_use` /
 *    `text` / `error` 这几种形状后交给下游，这样 `OpenCodeStreamNormalizer`
 *    与执行器一行都不用改，两条路径的轨迹口径天然一致。
 * 2. **spawn / fetch 可注入**：单测在 CI 上没有 opencode 二进制，协议胶水
 *    （权限决策、超时、错误分类）必须能脱离真实 CLI 被验证。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import type { OpenCodeEvent } from '../agent/runtime/normalize/opencode'

/** opencode 的权限动作（对齐 OpenAPI 的 `PermissionAction`）。 */
export type ServePermissionAction = 'allow' | 'ask' | 'deny'

export interface ServePermissionRule {
  permission: string
  pattern: string
  action: ServePermissionAction
}

/** `permission.asked` 事件里宿主真正需要的字段。 */
export interface ServePermissionAsked {
  /** `per_…`，回写时要用的 id */
  id: string
  sessionID: string
  /** 权限类别，实测就是工具名（`bash` / `edit` / `read` …） */
  permission: string
  /** 命中的具体模式，如 `echo permission-probe-ok` */
  patterns: string[]
  metadata: Record<string, unknown>
  tool?: { messageID?: string; callID?: string }
}

export interface ServeEvent {
  type: string
  properties?: Record<string, unknown>
}

/** SSE 与 HTTP 的统一注入面。 */
export interface ServeTransport {
  /** 相对路径 + 可选 body；返回解析后的 JSON（204 返回 null） */
  request: (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>
  /** 订阅事件流，返回取消函数 */
  subscribe: (handler: (event: ServeEvent) => void, signal: AbortSignal) => void
}

export interface ServeSpawnPlan {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * spawn 的最小面（只用到这三点）。
 *
 * 不直接写 `typeof spawn`：单测要注入假进程，`typeof spawn` 把 overload 与
 * 返回值细节都带进来，测试侧每次都得 `as unknown as`；收窄成这里实际用到的
 * 签名，真实 `spawn` 天然兼容，假进程也不用强转。
 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess

export interface OpencodeServeOptions {
  plan: ServeSpawnPlan
  /** 单测注入点；默认用全局 fetch */
  createTransport?: (baseUrl: string) => ServeTransport
  /** 单测注入点；默认 `child_process.spawn` */
  spawnImpl?: SpawnLike
  /** 单测注入点；默认向系统要一个空闲端口 */
  pickPort?: () => Promise<number>
  /** 等 server 打印监听地址的上限 */
  startupTimeoutMs?: number
  log?: (message: string) => void
}

/**
 * 向系统要一个空闲端口。
 *
 * 为什么不直接 `--port 0` 让 CLI 自己挑：**实测 1.19.5 的 `--port 0` 会退回默认
 * 4096**，第二个会话起 server 就会撞端口（要么直接失败，要么把请求发到别人的
 * 会话上）。自己先 listen(0) 拿一个再释放，虽有一瞬的竞争窗口，但比固定端口
 * 可靠得多。
 */
export async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('没有分配到空闲端口'))
      })
    })
  })
}

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000

/**
 * 权限规则集：读类放行，写类与执行类一律 ask。
 *
 * 不含 `*` 兜底 —— 未知工具默认走 opencode 自身的策略（多数是 ask），
 * 这里只显式表达我们**确定**的意图：读文件不该弹审批，跑命令必须过宿主。
 * 实测 `permission` 的取值就是工具名（`bash` / `edit` / `read` …）。
 */
const READ_ONLY_PERMISSIONS = ['read', 'glob', 'grep', 'list', 'ls', 'todoread']
const GATED_PERMISSIONS = ['bash', 'edit', 'write', 'patch', 'webfetch', 'task']

export function buildServePermissionRules(): ServePermissionRule[] {
  const rules: ServePermissionRule[] = GATED_PERMISSIONS.map((permission) => ({
    permission,
    pattern: '*',
    action: 'ask' as const,
  }))
  for (const permission of READ_ONLY_PERMISSIONS) {
    rules.push({ permission, pattern: '*', action: 'allow' })
  }
  return rules
}

/**
 * 把 `permission.asked` 翻译成宿主审批钩子能吃的 `(toolName, input)`。
 *
 * `metadata` 原样交给钩子：bash 策略要从里面读 `command`，审批卡片也要展示它。
 * 没带 metadata 时退化成 patterns 拼成的字符串 —— 宁可少信息，也不要空对象
 * 让策略误判成「没有命令」。
 */
export function permissionToToolCall(
  asked: ServePermissionAsked,
): { toolName: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = { ...(asked.metadata ?? {}) }
  if (Object.keys(input).length === 0 && asked.patterns.length > 0) {
    input.patterns = asked.patterns
  }
  return { toolName: asked.permission, input }
}

/** 把 SSE 事件翻译成 `run --format json` 的事件方言。 */
export function toStreamEvent(event: ServeEvent): OpenCodeEvent | null {
  const props = event.properties ?? {}
  switch (event.type) {
    case 'message.part.updated': {
      const part = props.part as OpenCodeEvent['part'] | undefined
      if (!part) return null
      if (part.type === 'tool') {
        // `pending` 必须丢掉：serve 的审批已经由 `permission.asked` → 宿主钩子
        // → `/permission/{id}/reply` 走完了，若再让归一化器把 pending 读成
        // 「需要审批」，审计里每条工具调用会有两条审批记录（一条真、一条假）。
        const status = (part.state as { status?: string } | undefined)?.status
        if (status === 'pending') return null
        // 其余状态两个方言里形状完全一致（实机比对过），直接透传
        return { type: 'tool_use', part }
      }
      if (part.type === 'text') {
        // 同一 part 会被反复更新：只有「写完了」的那次才算一句话，
        // 否则一条消息会被拆成十几条 message.completed
        const end = (part as { time?: { end?: number } }).time?.end
        return end ? { type: 'text', part } : null
      }
      return null
    }
    case 'session.error':
      return { type: 'error', error: props.error as OpenCodeEvent['error'] }
    default:
      return null
  }
}

export class OpencodeServeClient {
  private readonly transport: ServeTransport
  private readonly child: ChildProcess | null
  private readonly abort = new AbortController()

  private constructor(
    readonly baseUrl: string,
    private readonly directory: string,
    transport: ServeTransport,
    child: ChildProcess | null,
  ) {
    this.transport = transport
    this.child = child
  }

  /**
   * 每个请求都要带 `?directory=`。
   *
   * 不带的话服务端按**它自己的 cwd** 解析实例：建会话/发消息碰巧能对上
   * （我们就是用它当 cwd 起的进程），但 `GET /session/{id}` 会解析到另一个
   * 实例并把 token 读成 0 —— 实机上表现为「回合跑通了，用量全是 0」。
   */
  private path(p: string): string {
    const sep = p.includes('?') ? '&' : '?'
    return `${p}${sep}directory=${encodeURIComponent(this.directory)}`
  }

  /**
   * 起一个 server 并等它就绪。
   *
   * 只认 stdout 里的 `listening on http://…` 一行：`serve --port 0` 由系统分配
   * 端口，猜端口号（4096 之类）会在多会话并行时互相踩。
   */
  static async start(options: OpencodeServeOptions): Promise<OpencodeServeClient> {
    const log = options.log ?? (() => {})
    const spawnImpl = options.spawnImpl ?? spawn
    const startupTimeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    // `--port 0` 在 1.19.5 上会退回 4096（实测），这里换成真正的空闲端口
    const plan = { ...options.plan, args: [...options.plan.args] }
    const portIndex = plan.args.indexOf('--port')
    if (portIndex >= 0 && plan.args[portIndex + 1] === '0') {
      const port = await (options.pickPort ?? pickFreePort)()
      plan.args[portIndex + 1] = String(port)
    }

    const child = spawnImpl(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const baseUrl = await new Promise<string>((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`opencode serve 在 ${startupTimeout}ms 内没有就绪`))
      }, startupTimeout)
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString('utf-8')
        const match = /listening on (http:\/\/[^\s]+)/i.exec(buffered)
        if (match) {
          cleanup()
          resolve(match[1].replace(/\/$/, ''))
        }
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`opencode serve 启动即退出（code ${code}）：${buffered.slice(-500)}`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      child.stdout?.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })

    const transport = options.createTransport ? options.createTransport(baseUrl) : createHttpTransport(baseUrl)
    log(`serve ready at ${baseUrl}`)
    return new OpencodeServeClient(baseUrl, plan.cwd, transport, child)
  }

  /** server 进程 id（宿主按它精确回收；注入 spawn 的单测里可能没有） */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** 交给宿主登记的进程句柄。 */
  get childRef(): ChildProcess {
    if (!this.child) throw new Error('opencode serve 没有子进程句柄（测试注入的传输）')
    return this.child
  }

  async createSession(input: {
    title?: string
    directory: string
    model?: string
    rules?: ServePermissionRule[]
  }): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      title: input.title ?? 'bizgraph turn',
      permission: input.rules ?? buildServePermissionRules(),
    }
    // ⚠️ 建会话与发消息的 model 形状**不一样**（实机 + OpenAPI 双向确认）：
    // 建会话是 `{id, providerID}`，发消息是 `{providerID, modelID}`。
    // 发错形状不会报「字段名错」，只给一个 `{"_tag":"BadRequest"}`。
    const model = parseModel(input.model)
    if (model) body.model = { id: model.modelID, providerID: model.providerID }
    const created = (await this.transport.request('POST', this.path('/session'), body)) as { id?: string } | null
    if (!created?.id) throw new Error('opencode serve 没有返回会话 id')
    return { id: created.id }
  }

  /** 订阅事件流（SSE），返回取消函数。 */
  subscribe(handler: (event: ServeEvent) => void): () => void {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    this.abort.signal.addEventListener('abort', onAbort, { once: true })
    this.transport.subscribe(handler, controller.signal)
    return () => {
      controller.abort()
      this.abort.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 发一条消息并等回合结束。
   *
   * `POST /session/{id}/message` 本身就是阻塞语义（idle 才返回），所以这里
   * 不再另造轮询；只是把 abort 信号接上，取消能真的中断挂住的回合。
   */
  async prompt(sessionId: string, text: string, model?: string): Promise<void> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] }
    const parsed = parseModel(model)
    if (parsed) body.model = parsed
    await this.transport.request('POST', this.path(`/session/${sessionId}/message`), body, this.abort.signal)
  }

  async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await this.transport.request('POST', this.path(`/permission/${requestId}/reply`), {
      reply,
      ...(message ? { message } : {}),
    })
  }

  /** 会话终态里的 token / cost —— `step_finish` 在 serve 流里没有，用它对账。 */
  async readSessionUsage(sessionId: string): Promise<{ inputTokens: number; outputTokens: number }> {
    const info = (await this.transport.request('GET', this.path(`/session/${sessionId}`))) as
      | { tokens?: { input?: number; output?: number } }
      | null
    return {
      inputTokens: info?.tokens?.input ?? 0,
      outputTokens: info?.tokens?.output ?? 0,
    }
  }

  /** 取消进行中的请求并回收进程。幂等。 */
  async dispose(): Promise<void> {
    this.abort.abort()
    const child = this.child
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 服务端着不退出就强杀：它是我们自己 spawn 的，不存在「别人的进程」
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

/**
 * 把一次 `permission.asked` 变成给 serve 的回复。
 *
 * 三条约束都来自实机与安全语义：
 * - **没有钩子 = 拒绝**。宿主没装审批网关时（例如直连适配器的老路径），
 *   「问了再放行」没有决策人，替他放行等于绕过审批；fail-closed 才与
 *   `run` 模式的 auto-reject 行为一致。
 * - **钩子抛错 = 拒绝**。审批链路故障不能读成「用户同意」。
 * - `always` 不用：一次放行只对这一次生效，会话级授权由宿主的 approvals
 *   自己记（它已经处理了「本次会话一直允许」的语义），这里再记一层会让
 *   撤销授权后仍然放行。
 */
export async function bridgePermission(
  asked: ServePermissionAsked,
  decide:
    | ((
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID: string },
      ) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message?: string }>)
    | undefined,
  signal: AbortSignal,
): Promise<{ reply: 'once' | 'reject'; message?: string }> {
  if (!decide) {
    return { reply: 'reject', message: '宿主没有安装审批网关，按默认拒绝处理' }
  }
  const { toolName, input } = permissionToToolCall(asked)
  try {
    const outcome = await decide(toolName, input, { signal, toolUseID: asked.tool?.callID ?? asked.id })
    if (outcome.behavior === 'allow') return { reply: 'once' }
    return { reply: 'reject', message: outcome.message ?? '用户拒绝了这次调用' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { reply: 'reject', message: `审批链路异常，按拒绝处理：${message}` }
  }
}

/** `provider/model` → serve 的 `{providerID, modelID}`；不带前缀时返回 undefined。 */export function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const idx = model.indexOf('/')
  if (idx <= 0 || idx === model.length - 1) return undefined
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) }
}

/**
 * 真实 HTTP/SSE 传输。
 *
 * 只用 `fetch`：Electron 主进程（Node 20+）自带，不引入依赖。SSE 用 body 流
 * 手工拆 `data:` 行 —— EventSource 在 Node 里没有，装一个只为读几行不划算。
 */
export function createHttpTransport(baseUrl: string): ServeTransport {
  return {
    async request(method, path, body, signal) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`opencode serve ${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
      }
      if (response.status === 204) return null
      const raw = await response.text()
      return raw ? JSON.parse(raw) : null
    },
    subscribe(handler, signal) {
      void (async () => {
        try {
          const response = await fetch(`${baseUrl}/event`, {
            headers: { accept: 'text/event-stream' },
            signal,
          })
          if (!response.ok || !response.body) return
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              if (line.startsWith('data:')) {
                const payload = line.slice(5).trim()
                if (payload) {
                  try {
                    handler(JSON.parse(payload) as ServeEvent)
                  } catch {
                    // 半行/坏行：SSE 会重发完整事件，丢掉半行不影响结论
                  }
                }
              }
              newline = buffer.indexOf('\n')
            }
          }
        } catch {
          // abort 或服务端断开：调用方靠 idle/超时判定回合终态
        }
      })()
    },
  }
}
