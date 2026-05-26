/**
 * Lightweight MCP (Model Context Protocol) stdio client
 * Uses JSON-RPC 2.0 over stdin/stdout without external SDK
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

/** 清理环境变量，防止敏感信息泄露给子进程 */
function buildSafeEnv(): NodeJS.ProcessEnv {
  const blockedPrefixes = ['BIZGRAPH_', 'ELECTRON_', 'NODE_', 'npm_']
  const allowedKeys = new Set([
    'PATH', 'Path', 'PATHEXT',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'TMPDIR', 'TMP', 'TEMP',
    'SHELL', 'COMSPEC', 'TERM',
    'LANG', 'LC_ALL', 'LC_CTYPE',
    'USER', 'USERNAME', 'LOGNAME',
    'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'SSH_AUTH_SOCK', 'GNOME_KEYRING_CONTROL',
    'DISPLAY', 'WAYLAND_DISPLAY',
    'CLICOLOR', 'FORCE_COLOR', 'NO_COLOR',
  ])

  const safeEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (blockedPrefixes.some((p) => key.startsWith(p))) continue
    if (allowedKeys.has(key) || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      safeEnv[key] = value
    }
  }
  return safeEnv
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

  constructor(
    private command: string,
    private args: string[],
  ) {
    super()
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
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
        reject(new Error(`MCP process error: ${err.message}`))
      })

      this.proc.on('exit', (code) => {
        this.emit('exit', code)
        this.rejectAll(new Error(`MCP process exited with code ${code ?? 'unknown'}`))
      })

      // Send initialize handshake after a short delay to ensure process is ready
      setTimeout(async () => {
        try {
          await this.call('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'bizgraph-mcp-client', version: '1.0.0' },
          })
          this.initialized = true
          await this.listTools()
          await this.listResources()
          resolve()
        } catch (err) {
          reject(err)
        }
      }, 500)
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
        reject(new Error('MCP process not running'))
        return
      }

      const id = ++this.requestId
      const message: JsonRpcMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      this.pending.set(id, { resolve, reject })

      const line = JSON.stringify(message) + '\n'
      this.proc.stdin?.write(line)

      // 30 秒超时防护
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP call timeout: ${method}`))
        }
      }, 30000)

      // 包装 resolve/reject 以清除超时
      const original = this.pending.get(id)!
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timeout)
          original.resolve(v)
        },
        reject: (e: Error) => {
          clearTimeout(timeout)
          original.reject(e)
        },
      })
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
        reject(new Error(msg.error.message))
      } else {
        resolve(msg.result)
      }
    }

    if (msg.method === 'notifications/message') {
      this.emit('notification', msg.params)
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, { reject }] of this.pending) {
      reject(err)
      this.pending.delete(id)
    }
  }
}
