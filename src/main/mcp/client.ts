/**
 * Lightweight MCP (Model Context Protocol) stdio client
 * Uses JSON-RPC 2.0 over stdin/stdout without external SDK
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { buildSafeEnv } from '../shared/env'
import { AgentError, ErrorCode } from '../errors'

/** MCP 服务器允许执行的命令白名单 */
const ALLOWED_MCP_COMMANDS = new Set([
  'npx', 'node', 'python', 'python3', 'uvx', 'deno', 'bun',
  'pnpm', 'yarn', 'pip', 'pipx', 'uv',
])

function validateMcpCommand(command: string): void {
  const basename = path.basename(command)
  // 允许白名单中的命令名（不含路径分隔符，即系统 PATH 查找）
  if (ALLOWED_MCP_COMMANDS.has(basename) && !command.includes(path.sep)) return
  // 允许 node_modules/.bin/ 下的命令
  if (command.includes('node_modules')) return
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
    const connectStart = Date.now()
    return new Promise((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new AgentError('MCP connect timeout: process did not respond to initialize handshake within 10s', ErrorCode.AGENT_ADAPTER_ERROR))
      }, 10000)

      this.proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSafeEnv(),
      })

      this.proc.stdout?.on('data', (data: Buffer) => {
        this.handleData(data.toString('utf-8'))
      })

      this.proc.stderr?.on('data', (data: Buffer) => {
        this.emit('stderr', data.toString('utf-8'))
      })

      this.proc.on('error', (err) => {
        clearTimeout(connectTimeout)
        reject(new AgentError(`MCP process error: ${err.message}`, ErrorCode.AGENT_ADAPTER_ERROR))
      })

      this.proc.on('exit', (code) => {
        clearTimeout(connectTimeout)
        this.emit('exit', code)
        this.rejectAll(new AgentError(`MCP process exited with code ${code ?? 'unknown'}`, ErrorCode.AGENT_ADAPTER_ERROR))
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
          resolve()
        } catch (err) {
          clearTimeout(connectTimeout)
          reject(err)
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
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGKILL')
          }
          resolve()
        }, 3000)
        this.proc?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    this.proc = undefined
    this.initialized = false
  }

  getTools(): McpTool[] {
    return [...this.tools]
  }

  getResources(): McpResource[] {
    return [...this.resources]
  }

  isReady(): boolean {
    return this.initialized && !!this.proc && !this.proc.killed
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.call('tools/list', {}) as { tools?: McpTool[] }
    this.tools = result.tools ?? []
    return this.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call('tools/call', { name, arguments: args })
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
      if (!this.proc || this.proc.killed) {
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
      this.proc.stdin?.write(line)
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
