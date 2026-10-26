/**
 * A2AServer — Node 原生 HTTP server，提供 5 个 endpoint
 *
 * Phase D9 C4. 路由：
 *   GET  /.well-known/agent-card.json     — agent-card.ts (无需鉴权)
 *   POST /v1/message:send                 — message-send.ts (鉴权)
 *   POST /v1/message:stream               — message-stream.ts (鉴权, SSE)
 *   GET  /v1/tasks/:id                    — tasks.ts (鉴权)
 *   GET  /v1/tasks                        — tasks.ts (鉴权)
 *
 * **不**引入 Express — 路由表用 prefix-match 实现，body 解析由各路由自管。
 *   理由见 docs/tasks/2026-10-01-d9.md 关键决策 §1。
 *
 * 生命周期：
 *   start({config, agentManager, taskStore, logger}) → instance
 *   refreshConfig(newConfig) → 在端口变化时 full restart；key 变化时 hot
 *   destroy() → 关 listener + 终止所有 active session + 清 task-store
 *   boundPort() → 实际监听端口（动态分配时为 >0）
 *
 * 错误：EADDRINUSE → BizGraphError(A2A_PORT_IN_USE)
 */

import http, { type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import https, { type Server as HttpsServer } from 'node:https'
import fs from 'node:fs'
import { BizGraphError, ErrorCode } from '../errors'
import { verifyBearer } from './auth'
import { handleAgentCard } from './routes/agent-card'
import { handleMessageSend, type MessageSendSessionStarter } from './routes/message-send'
import { handleMessageStream, type MessageStreamSessionStarter } from './routes/message-stream'
import { handleGetTask, handleListTasks, type TasksRouteDeps } from './routes/tasks'
import type { A2ATaskStore } from './task-store'
import type { A2AServerConfig, A2AAgentCard, A2ATask } from '@shared/types/a2a'

/** Minimal Logger interface — createLogger 返回值的形状（避免耦合到非导出 class）。 */
export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface A2AServerDeps {
  config: A2AServerConfig
  /** 同步 message:send 路由的会话启动器。 */
  messageSendSession: MessageSendSessionStarter
  /** 流式 message:stream 路由的会话启动器。 */
  messageStreamSession: MessageStreamSessionStarter
  taskStore: A2ATaskStore
  logger: Logger
  /** taskId → A2ATask（含累积 artifacts/history）。 */
  buildTask: (taskId: string) => Promise<A2ATask | null>
}

export class A2AServer {
  private server: Server | HttpsServer | null = null
  private activeConfig: A2AServerConfig | null = null
  private bound: { port: number; bindAddress: string } | null = null

  constructor(private readonly deps: A2AServerDeps) {}

  /** 启动 HTTP(S) listener。已 running 则 no-op。 */
  async start(): Promise<void> {
    if (this.server !== null) return
    const cfg = this.deps.config
    if (!cfg.enabled) {
      throw new BizGraphError('A2A server is disabled in config', ErrorCode.A2A_SERVER_DISABLED)
    }
    this.activeConfig = cfg
    const handler = this.makeHandler()
    if (cfg.tlsCertPath !== undefined && cfg.tlsKeyPath !== undefined) {
      const tlsOpts = this.loadTlsOptions(cfg.tlsCertPath, cfg.tlsKeyPath)
      this.server = https.createServer(tlsOpts, handler)
    } else {
      this.server = http.createServer(handler)
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.server?.removeListener('error', onError)
        if (err.code === 'EADDRINUSE') {
          reject(new BizGraphError(`Port ${cfg.port} already in use`, ErrorCode.A2A_PORT_IN_USE))
        } else {
          reject(new BizGraphError(`Failed to start A2A server: ${err.message}`, ErrorCode.UNKNOWN))
        }
      }
      this.server!.once('error', onError)
      this.server!.listen(cfg.port, cfg.bindAddress, () => {
        this.server!.removeListener('error', onError)
        const addr = this.server!.address()
        if (typeof addr === 'object' && addr !== null) {
          this.bound = { port: addr.port, bindAddress: cfg.bindAddress }
        } else {
          this.bound = { port: cfg.port, bindAddress: cfg.bindAddress }
        }
        this.deps.logger.info(`A2A server listening on ${cfg.bindAddress}:${this.bound.port}`)
        resolve()
      })
    })
  }

  /** 关闭 listener + 终止所有 active session。幂等。 */
  async destroy(): Promise<void> {
    if (this.server === null) return
    const srv = this.server
    this.server = null
    this.bound = null
    await new Promise<void>((resolve) => {
      srv.close(() => resolve())
      // Force-close any keep-alive sockets.
      srv.closeAllConnections?.()
    })
  }

  /** 重启以应用新配置。端口变化 → full restart；apiKey 变化 → no-op（key 仅在请求时校验）。 */
  async refreshConfig(newConfig: A2AServerConfig): Promise<void> {
    if (this.activeConfig === null) {
      this.deps.config = newConfig
      return
    }
    const portChanged = newConfig.port !== this.activeConfig.port
    const bindChanged = newConfig.bindAddress !== this.activeConfig.bindAddress
    const tlsChanged =
      newConfig.tlsCertPath !== this.activeConfig.tlsCertPath ||
      newConfig.tlsKeyPath !== this.activeConfig.tlsKeyPath
    if (portChanged || bindChanged || tlsChanged) {
      await this.destroy()
      this.deps.config = newConfig
      await this.start()
    } else {
      this.activeConfig = newConfig
      this.deps.config = newConfig
    }
  }

  /** 实际监听端口（用于 IPC 状态显示）。未启动返回 undefined。 */
  boundPort(): number | undefined {
    return this.bound?.port
  }

  /** 当前绑定地址。未启动返回 undefined。 */
  boundAddress(): string | undefined {
    return this.bound?.bindAddress
  }

  /** 当前是否在用 TLS。 */
  usingTls(): boolean {
    return this.activeConfig?.tlsCertPath !== undefined && this.activeConfig?.tlsKeyPath !== undefined
  }

  private loadTlsOptions(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } {
    try {
      return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      }
    } catch (err) {
      throw new BizGraphError(
        `Failed to load TLS cert/key (${certPath}, ${keyPath}): ${(err as Error).message}`,
        ErrorCode.UNKNOWN,
      )
    }
  }

  private makeHandler(): (req: IncomingMessage, res: ServerResponse) => void {
    return async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname
        const method = req.method ?? 'GET'

        // 路由表
        if (path === '/.well-known/agent-card.json' && method === 'GET') {
          handleAgentCard(req, res, this.deps.config.agentCard)
          return
        }
        if (path === '/v1/message:send' && method === 'POST') {
          verifyBearer(req, this.deps.config.apiKey)
          await handleMessageSend(req, res, {
            session: this.deps.messageSendSession,
            taskStore: this.deps.taskStore,
          })
          return
        }
        if (path === '/v1/message:stream' && method === 'POST') {
          verifyBearer(req, this.deps.config.apiKey)
          await handleMessageStream(req, res, {
            session: this.deps.messageStreamSession,
            taskStore: this.deps.taskStore,
          })
          return
        }
        if (path.startsWith('/v1/tasks/') && method === 'GET') {
          verifyBearer(req, this.deps.config.apiKey)
          const taskId = decodeURIComponent(path.slice('/v1/tasks/'.length))
          const tasksDeps: TasksRouteDeps = {
            taskStore: this.deps.taskStore,
            buildTask: this.deps.buildTask,
          }
          await handleGetTask(req, res, taskId, tasksDeps)
          return
        }
        if (path === '/v1/tasks' && method === 'GET') {
          verifyBearer(req, this.deps.config.apiKey)
          const tasksDeps: TasksRouteDeps = {
            taskStore: this.deps.taskStore,
            buildTask: this.deps.buildTask,
          }
          handleListTasks(req, res, tasksDeps)
          return
        }

        // 405 for matched path with wrong method, 404 otherwise
        const knownPaths = new Set([
          '/.well-known/agent-card.json',
          '/v1/message:send',
          '/v1/message:stream',
          '/v1/tasks',
        ])
        const taskPrefix = path.startsWith('/v1/tasks/')
        if (knownPaths.has(path) || taskPrefix) {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, POST' })
          res.end(JSON.stringify({ error: 'method not allowed', method }))
          return
        }
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'not found', path }))
      } catch (err) {
        const code = (err as BizGraphError).code
        const message = (err as Error).message
        if (code === ErrorCode.A2A_UNAUTHORIZED) {
          res.writeHead(401, {
            'Content-Type': 'application/json; charset=utf-8',
            'WWW-Authenticate': 'Bearer realm="a2a"',
          })
          res.end(JSON.stringify({ error: 'unauthorized', message }))
          return
        }
        if (code === ErrorCode.A2A_BAD_REQUEST) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'bad request', message }))
          return
        }
        this.deps.logger.warn(`A2A server handler error: ${message}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal', message }))
        } else {
          // SSE stream may already be open; best-effort: emit status failed and end.
          try {
            res.write(`event: status\ndata: ${JSON.stringify({ state: 'failed', message: { role: 'agent', parts: [{ type: 'text', text: message }] } })}\n\n`)
            res.end()
          } catch { /* socket gone */ }
        }
      }
    }
  }
}

/** 给上层 `a2a:getServerStatus` IPC 用的快照读取器。 */
export function getA2AServerStatus(server: A2AServer | null, taskStore: A2ATaskStore | null): {
  running: boolean
  port?: number
  bindAddress?: string
  tls?: boolean
  activeTasks: number
  completedTasks: number
  failedTasks: number
} {
  const stats = taskStore?.stats() ?? { activeTasks: 0, completedTasks: 0, failedTasks: 0 }
  if (server === null || taskStore === null) {
    return { running: false, ...stats }
  }
  return {
    running: true,
    port: server.boundPort(),
    bindAddress: server.boundAddress(),
    tls: server.usingTls(),
    ...stats,
  }
}

/** Re-export agent card type for convenience (avoids extra imports). */
export type { A2AAgentCard }
