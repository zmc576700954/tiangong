/**
 * Lightweight MCP (Model Context Protocol) stdio client
 * Uses JSON-RPC 2.0 over stdin/stdout without external SDK
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { SpanKind } from '@opentelemetry/api'
import { buildSafeEnv } from '../shared/env'
import { AgentError, ErrorCode } from '../errors'
import { withSpan } from '../telemetry'

/** MCP 服务器允许执行的命令白名单 */
const ALLOWED_MCP_COMMANDS = new Set([
  'npx', 'node', 'python', 'python3', 'uvx', 'deno', 'bun',
  'pnpm', 'yarn', 'pip', 'pipx', 'uv',
])

/** 项目自身 node_modules/.bin/ 的绝对路径前缀（以路径分隔符结尾） */
function getProjectNodeModulesBin(): string {
  return path.resolve(process.cwd(), 'node_modules', '.bin') + path.sep
}

const PATH_SEPARATOR_RE = /[\\/]/

export function validateMcpCommand(command: string): void {
  const basename = path.basename(command)
  // 允许白名单中的裸命令名（通过系统 PATH 查找，不含任何路径分隔符）
  if (ALLOWED_MCP_COMMANDS.has(basename) && !PATH_SEPARATOR_RE.test(command)) return
  // 仅允许项目自身 node_modules/.bin/ 下的绝对路径白名单命令
  if (path.isAbsolute(command)) {
    const resolved = path.resolve(command)
    if (resolved.startsWith(getProjectNodeModulesBin()) && ALLOWED_MCP_COMMANDS.has(basename)) return
  }
  throw new AgentError(
    `MCP command not allowed: "${command}". Only common package managers and runtimes are permitted: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`,
    ErrorCode.AGENT_ADAPTER_ERROR,
  )
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpResource {
  uri: string
  name?: string
  mimeType?: string
}

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class McpClient extends EventEmitter {
  private proc?: ChildProcess
  private requestId = 0
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private tools: McpTool[] = []
  private resources: McpResource[] = []
  private initialized = false
  /** 子进程是否已退出。proc.killed 只在 kill() 之后为 true，崩溃退出时仍是 false。 */
  private exited = false
  /** 连接建立耗时（毫秒），connect() 成功后可用 */
  connectTimeMs?: number

  constructor(
    private command: string,
    private args: string[],
    private readonly callTimeoutMs = 30_000,
  ) {
    super()
  }

  async connect(): Promise<void> {
    validateMcpCommand(this.command)
    return withSpan(
      'bizgraph.mcp.connect',
      async (span) => {
        span.setAttribute('mcp.command', this.command)
        span.setAttribute('mcp.args_count', this.args.length)
        await this._connectInternal()
      },
      { kind: SpanKind.CLIENT },
    )
  }

  private async _connectInternal(): Promise<void> {
    const connectStart = Date.now()
    return new Promise((resolve, reject) => {
      // settle 守卫：resolve/reject 只生效一次（exit / error / 握手成功可能竞态）
      let settled = false
      const settleResolve = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const settleReject = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }

      const connectTimeout = setTimeout(() => {
        // 握手超时：子进程必须被回收，否则每次失败连接都会留下一个孤儿进程。
        this.killProcess()
        settleReject(new AgentError('MCP connect timeout: process did not respond to initialize handshake within 10s', ErrorCode.AGENT_ADAPTER_ERROR))
      }, 10000)

      this.exited = false
      this.proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeEnv('mcp'),
      })

      // 对端关闭 stdin 后再次写入会抛 EPIPE；没有监听器时它是未捕获异常，
      // 会直接带走 Electron 主进程。
      this.proc.stdin?.on('error', (err) => {
        this.rejectAll(new AgentError(`MCP stdin error: ${err.message}`, ErrorCode.AGENT_ADAPTER_ERROR))
      })

      this.proc.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString('utf-8'))
      })

      this.proc.stderr?.on('data', (data: Buffer) => {
        this.emit('stderr', data.toString('utf-8'))
      })

      this.proc.on('error', (err) => {
        clearTimeout(connectTimeout)
        clearTimeout(fallbackTimer)
        this.exited = true
        this.initialized = false
        settleReject(new AgentError(`MCP process error: ${err.message}`, ErrorCode.AGENT_ADAPTER_ERROR))
      })

      this.proc.on('exit', (code) => {
        clearTimeout(connectTimeout)
        // 进程已经死了，握手不可能再成功 —— 立刻失败。
        // 否则要等 2 秒的 fallbackTimer 触发 startHandshake，call() 才因
        // exited 守卫拒绝；每个坏掉的 MCP server 都要多赔 2 秒启动时间，
        // 而且报出来的是「进程未运行」而不是真实的退出码。
        clearTimeout(fallbackTimer)
        this.exited = true
        this.initialized = false
        this.emit('exit', code)
        const err = new AgentError(`MCP process exited with code ${code ?? 'unknown'}`, ErrorCode.AGENT_ADAPTER_ERROR)
        this.rejectAll(err)
        settleReject(err)
      })

      // 基于响应的握手：等待进程 stdout 产生数据后再发送 initialize，
      // 而非硬编码延迟。若 2 秒内无输出则直接尝试（某些服务器不输出启动信息）。
      let handshakeStarted = false
      const startHandshake = async () => {
        if (handshakeStarted) return
        handshakeStarted = true
        try {
          await this.call('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'bizgraph-mcp-client', version: '1.0.0' },
          })
          this.initialized = true
          await this.listTools()
          await this.listResources()
          clearTimeout(connectTimeout)
          const connectTimeMs = Date.now() - connectStart
          this.connectTimeMs = connectTimeMs
          this.emit('connected', { connectTimeMs })
          settleResolve()
        } catch (err) {
          clearTimeout(connectTimeout)
          settleReject(err instanceof Error ? err : new Error(String(err)))
        }
      }

      // 策略1：等待进程首次输出数据（说明进程已就绪）
      const fallbackTimer = setTimeout(() => {
        this.proc?.stdout?.off('data', onDataOnce)
        startHandshake()
      }, 2000)
      const onDataOnce = () => {
        clearTimeout(fallbackTimer)
        this.proc?.stdout?.off('data', onDataOnce)
        startHandshake()
      }
      this.proc.stdout?.on('data', onDataOnce)
    })
  }

  async disconnect(): Promise<void> {
    const proc = this.proc
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // 升级判定必须看 exitCode/signalCode：proc.killed 在 kill() 调用后
          // 即为 true，用它判断会让 SIGKILL 永远走不到。
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 3000)
        proc.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    this.proc = undefined
    this.initialized = false
  }

  /**
   * 终止子进程并把客户端标记为不可用。
   *
   * 只发 SIGTERM 是不够的：npx / 包装脚本不一定把信号转发给真正的 server
   * 进程，握手超时后包装进程死了、server 还活着 —— 每失败一次就多留一个孤儿。
   * 因此 3 秒后若进程仍在，升级为 SIGKILL。
   */
  private killProcess(signal: NodeJS.Signals = 'SIGTERM'): void {
    const proc = this.proc
    if (!proc) return
    this.exited = true
    this.initialized = false
    if (proc.exitCode !== null || proc.signalCode !== null) return
    try {
      proc.kill(signal)
    } catch { /* ignore */ }
    const escalation = setTimeout(() => {
      // 升级判定必须看 exitCode/signalCode：proc.killed 在 kill() 调用后即为 true
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }
    }, 3000)
    escalation.unref()
  }

  getTools(): McpTool[] {
    return [...this.tools]
  }

  getResources(): McpResource[] {
    return [...this.resources]
  }

  isReady(): boolean {
    return this.initialized && !!this.proc && !this.proc.killed && !this.exited
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.call('tools/list', {}) as { tools?: McpTool[] }
    this.tools = result.tools ?? []
    return this.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return withSpan(
      'bizgraph.mcp.call',
      async (span) => {
        span.setAttribute('mcp.tool_name', name)
        // 不记录 args 内容（避免 PII 泄漏 + 大 payload 影响 OTLP cache）
        span.setAttribute('mcp.args_keys_count', Object.keys(args).length)
        return this.call('tools/call', { name, arguments: args })
      },
      { kind: SpanKind.CLIENT },
    )
  }

  async listResources(): Promise<McpResource[]> {
    try {
      const result = await this.call('resources/list', {}) as { resources?: McpResource[] }
      this.resources = result.resources ?? []
      return this.resources
    } catch {
      return []
    }
  }

  async readResource(uri: string): Promise<unknown> {
    return this.call('resources/read', { uri })
  }

  private call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed || this.exited) {
        reject(new AgentError('MCP process not running', ErrorCode.AGENT_ADAPTER_ERROR))
        return
      }

      const id = ++this.requestId
      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      // 先创建带超时清理的 handler，再一次性存入 pending，避免竞态
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new AgentError(`MCP call timeout: ${method}`, ErrorCode.AGENT_ADAPTER_ERROR))
        }
      }, this.callTimeoutMs)

      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timeout)
          resolve(v)
        },
        reject: (e: Error) => {
          clearTimeout(timeout)
          reject(e)
        },
      })

      const line = JSON.stringify(message) + '\n'
      try {
        this.proc.stdin?.write(line)
      } catch (err) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new AgentError(`MCP write failed: ${(err as Error).message}`, ErrorCode.AGENT_ADAPTER_ERROR))
      }
    })
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as JsonRpcMessage
        this.handleMessage(msg)
      } catch {
        // Ignore malformed lines
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) {
        reject(new AgentError(msg.error.message, ErrorCode.AGENT_ADAPTER_ERROR))
      } else {
        resolve(msg.result)
      }
    }

    if (msg.method === 'notifications/message') {
      this.emit('notification', msg.params)
    }
  }

  private rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(err)
    }
    this.pending.clear()
  }
}
