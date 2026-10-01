/**
 * D10b: Awareness WebSocket server
 *
 * 单进程 WebSocket 服务器，负责：
 * 1. 监听 WebSocket 连接
 * 2. 为每个连接分配 server-side clientId
 * 3. 接收 AWARENESS_MSG_UPDATE 消息，更新内存中的 awareness 状态
 * 4. 把状态变更广播给其它所有连接
 * 5. 处理客户端断开，清理状态
 *
 * 设计边界（CLAUDE.md Boundaries）：
 * - 不进入 Y.Doc 持久化链：awareness 状态只活在内存里
 * - 不接受任意命令 / 文件路径写入：消息 schema 在收到时严格校验
 * - 不污染依赖管理：与 D10a 的 y-protocols sync 通道物理隔离
 *   （awareness 用单独端口 / 单独协议；D10a 上线后两边可共用主选端口或独立端口）
 *
 * 设计参考：y-protocols/awareness 的 Awareness 类语义（clientID + state map），
 * 实现自行管理（避免主进程引入 y-protocols 的 node-only ESM 模块）：
 * - 每个客户端有唯一 server-assigned clientId（字符串 base64）
 * - 服务器持有 Map<clientId, RemoteAwarenessState>
 * - 客户端首次连接后立刻 broadcast QUERY_AWARENESS 拿到现有 states
 * - 服务器在 state 变更时把 AWARENESS_MSG_UPDATE 发给其它客户端
 * - 客户端在收到 UPDATE 时按 clientId 维护本地 awareness map
 */

import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { createLogger } from '../shared/logger'
import {
  AWARENESS_MSG_QUERY_AWARENESS,
  AWARENESS_MSG_REMOVE,
  AWARENESS_MSG_UPDATE,
  type AwarenessChangeListener,
  type AwarenessMessage,
  type RemoteAwarenessState,
} from './types'

const logger = createLogger('AwarenessServer')

/** 最大客户端数（防 OOM，单机协作场景下基本不会达到） */
const MAX_CLIENTS = 100

/** 单条消息大小上限（awareness 单条 < 1KB，4KB 充裕） */
const MAX_MESSAGE_BYTES = 4 * 1024

/** 解析后的服务器配置 */
export interface AwarenessServerOptions {
  /** 监听端口；默认 1235 */
  port?: number
  /** 监听 host；默认 127.0.0.1（仅本机协作） */
  host?: string
  /** 自动启动；默认 false（需要显式 start()） */
  autoStart?: boolean
}

/** 单个连接的内部状态 */
interface ConnectionState {
  ws: WebSocket
  clientId: string
  remoteAddress: string
  /** 最近一次收到的 RemoteAwarenessState（用于检测 stale 事件） */
  lastReceived: RemoteAwarenessState | null
}

/**
 * AwarenessServer —— 协作 awareness WebSocket 服务器
 *
 * 生命周期：
 * 1. new AwarenessServer({ port: 1235 })
 * 2. await server.start() → 启动监听
 * 3. 客户端连接 + 收到 QUERY_AWARENESS → server 自动回复所有已知 states
 * 4. await server.stop() → 关闭所有连接
 */
export class AwarenessServer {
  private wss: WebSocketServer | null = null
  private connections = new Map<string, ConnectionState>()
  private listeners = new Set<AwarenessChangeListener>()
  private readonly port: number
  private readonly host: string
  private started = false
  private starting: Promise<void> | null = null
  /** 已启动（port resolved + bound）的可观察状态 */
  private _boundPort: number | null = null

  constructor(options: AwarenessServerOptions = {}) {
    this.port = options.port ?? 1235
    this.host = options.host ?? '127.0.0.1'
  }

  /** 当前服务器是否已绑定并监听 */
  isStarted(): boolean {
    return this.started
  }

  /** 获取实际绑定端口（可能与配置不同，e.g. 端口被占用时 OS 自动分配） */
  getBoundPort(): number {
    return this._boundPort ?? this.port
  }

  /** 获取 host */
  getHost(): string {
    return this.host
  }

  /** 当前已连接客户端 ID 列表（不可变快照） */
  getClientIds(): string[] {
    return Array.from(this.connections.keys())
  }

  /** 当前已注册 awareness states 数量 */
  size(): number {
    let count = 0
    for (const c of this.connections.values()) {
      if (c.lastReceived !== null) count++
    }
    return count
  }

  /** 添加 awareness 变更订阅（在收到新消息或断开时触发） */
  addListener(listener: AwarenessChangeListener): void {
    this.listeners.add(listener)
  }

  /** 移除订阅 */
  removeListener(listener: AwarenessChangeListener): void {
    this.listeners.delete(listener)
  }

  /**
   * 启动服务器。
   * 幂等：重复调用返回首次的 promise。
   * 失败（端口占用等）抛错。
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      try {
        const wss = new WebSocketServer({
          port: this.port,
          host: this.host,
          maxPayload: MAX_MESSAGE_BYTES,
          // 仅允许 JSON 文本帧；awareness 通道不传二进制
        })

        wss.on('listening', () => {
          this.wss = wss
          this.started = true
          const addr = wss.address()
          if (addr && typeof addr === 'object') {
            this._boundPort = addr.port
          } else {
            this._boundPort = this.port
          }
          logger.info(`Awareness server listening on ws://${this.host}:${this._boundPort}`)
          resolve()
        })

        wss.on('error', (err: Error) => {
          logger.error('Awareness server error:', err)
          if (!this.started) {
            this.starting = null
            reject(err)
          }
        })

        wss.on('connection', (ws: WebSocket, req: { socket: { remoteAddress?: string | null } }) => {
          this.handleConnection(ws, req.socket.remoteAddress ?? 'unknown')
        })
      } catch (err) {
        this.starting = null
        reject(err)
      }
    })
    return this.starting
  }

  /**
   * 关闭服务器。
   * 等待所有连接干净关闭后返回。
   */
  async stop(): Promise<void> {
    if (!this.started || !this.wss) return
    const wss = this.wss
    this.started = false
    this._boundPort = null
    this.starting = null

    const closePromises: Promise<void>[] = []
    for (const conn of this.connections.values()) {
      closePromises.push(this.closeConnection(conn, 'server stopping'))
    }
    await Promise.allSettled(closePromises)
    this.connections.clear()
    this.listeners.clear()

    await new Promise<void>((resolve) => {
      wss.close(() => resolve())
    })
    this.wss = null
    logger.info('Awareness server stopped')
  }

  private handleConnection(ws: WebSocket, remoteAddress: string): void {
    if (this.connections.size >= MAX_CLIENTS) {
      logger.warn(`Rejecting connection from ${remoteAddress}: max clients reached (${MAX_CLIENTS})`)
      try {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'SERVER_FULL',
          message: `Awareness server at max clients (${MAX_CLIENTS})`,
        }))
        ws.close(1013, 'SERVER_FULL')
      } catch {
        // ignore send failures on a closing socket
      }
      return
    }

    const clientId = randomUUID()
    const conn: ConnectionState = {
      ws,
      clientId,
      remoteAddress,
      lastReceived: null,
    }
    this.connections.set(clientId, conn)
    logger.info(`Client connected: ${clientId} from ${remoteAddress} (total=${this.connections.size})`)

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      this.handleMessage(conn, raw).catch((err: Error) => {
        logger.warn(`Message handling failed for ${clientId}:`, err)
      })
    })

    ws.on('close', (code: number, reason: Buffer) => {
      logger.info(`Client disconnected: ${clientId} code=${code} reason=${reason.toString()}`)
      this.removeConnection(clientId)
    })

    ws.on('error', (err: Error) => {
      logger.warn(`Client ${clientId} socket error:`, err.message)
    })
  }

  private async handleMessage(conn: ConnectionState, raw: unknown): Promise<void> {
    // Buffer limit guard
    if (typeof raw === 'object' && raw !== null) {
      // ws2_ data is Buffer for binary frames. Our server only accepts text.
      const buf = raw as { length?: number }
      if (typeof buf.length === 'number' && buf.length > MAX_MESSAGE_BYTES) {
        logger.warn(`Message from ${conn.clientId} exceeds ${MAX_MESSAGE_BYTES} bytes, dropping`)
        this.closeConnection(conn, 'message too large')
        return
      }
    }

    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : ''
    if (!text) return

    let msg: AwarenessMessage
    try {
      msg = JSON.parse(text) as AwarenessMessage
    } catch {
      logger.warn(`Invalid JSON from ${conn.clientId}`)
      return
    }

    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'number') {
      logger.warn(`Invalid message shape from ${conn.clientId}`)
      return
    }

    if (msg.type === AWARENESS_MSG_QUERY_AWARENESS) {
      // 客户端上线后回拉所有现有 awareness states
      // 安全：conn.clientId 是 server-assigned，不是客户端可控的
      this.respondWithAllStates(conn)
      return
    }

    if (msg.type === AWARENESS_MSG_UPDATE) {
      if (!validateAwarenessState(msg.state)) {
        logger.warn(`Invalid state payload from ${conn.clientId}`)
        return
      }
      // 校验客户端 ID 是否匹配连接（防 HMAC）：客户端不能伪造别人的 ID
      if (msg.clientId !== conn.clientId) {
        logger.warn(`Client ${conn.clientId} tried to spoof ${msg.clientId}; closing`)
        this.closeConnection(conn, 'spoofed clientId')
        return
      }
      // 标记时间戳
      const next: RemoteAwarenessState = {
        ...msg.state,
        lastUpdated: Date.now(),
      }
      conn.lastReceived = next
      // 广播给其它客户端
      this.broadcastUpdate(conn.clientId, next)
      // 通知本地订阅者
      this.emitChange(conn.clientId, next)
      return
    }

    logger.warn(`Unknown message type ${(msg as { type: number }).type} from ${conn.clientId}`)
  }

  private respondWithAllStates(conn: ConnectionState): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return
    for (const other of this.connections.values()) {
      if (other.clientId === conn.clientId) continue
      if (other.lastReceived === null) continue
      const reply: AwarenessMessage = {
        type: AWARENESS_MSG_UPDATE,
        clientId: other.clientId,
        state: other.lastReceived,
      }
      try {
        conn.ws.send(JSON.stringify(reply))
      } catch (err) {
        logger.warn(`Failed to send reply to ${conn.clientId}:`, err)
      }
    }
  }

  private broadcastUpdate(senderClientId: string, state: RemoteAwarenessState): void {
    const msg: AwarenessMessage = {
      type: AWARENESS_MSG_UPDATE,
      clientId: senderClientId,
      state,
    }
    const payload = JSON.stringify(msg)
    for (const other of this.connections.values()) {
      if (other.clientId === senderClientId) continue
      if (other.ws.readyState !== other.ws.OPEN) continue
      try {
        other.ws.send(payload)
      } catch (err) {
        logger.warn(`Failed to broadcast to ${other.clientId}:`, err)
      }
    }
  }

  private removeConnection(clientId: string): void {
    const conn = this.connections.get(clientId)
    if (!conn) return
    this.connections.delete(clientId)
    // 通知其它客户端：该客户端已离开（专用 REMOVE 消息，干净区分 UPDATE）
    const payload = JSON.stringify({
      type: AWARENESS_MSG_REMOVE,
      clientId,
    } satisfies AwarenessMessage)
    for (const other of this.connections.values()) {
      if (other.ws.readyState !== other.ws.OPEN) continue
      try {
        other.ws.send(payload)
      } catch (err) {
        logger.warn(`Failed to notify leave of ${clientId}:`, err)
      }
    }
    // 通知本地订阅者
    this.emitChange(clientId, null)
  }

  private closeConnection(conn: ConnectionState, reason: string): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING) {
          // ws.close() 不带 callback；通过 'close' 事件 + terminate() 双保险避免 hang
          const onClosed = (): void => {
            conn.ws.off('close', onClosed)
            resolve()
          }
          conn.ws.once('close', onClosed)
          conn.ws.close(1000, reason)
          // 兜底：200ms 内仍未 close → terminate 强切
          setTimeout(() => {
            try {
              if (conn.ws.readyState !== conn.ws.CLOSED) conn.ws.terminate()
            } catch {
              // ignore
            }
            resolve()
          }, 200).unref()
        } else {
          resolve()
        }
      } catch {
        resolve()
      }
    })
  }

  private emitChange(clientId: string, state: RemoteAwarenessState | null): void {
    for (const listener of this.listeners) {
      try {
        listener(clientId, state)
      } catch (err) {
        logger.warn('Awareness change listener threw:', err)
      }
    }
  }
}

/**
 * 校验 AWARENESS_MSG_UPDATE.state 的合法性，防止状态枚举、客户端注入、
 * 类型混淆等。所有字段强制类型检查（不信任客户端）。
 */
function validateAwarenessState(value: unknown): value is RemoteAwarenessState {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const user = v.user
  if (!user || typeof user !== 'object') return false
  const u = user as Record<string, unknown>
  if (typeof u.userId !== 'string' || u.userId.length === 0 || u.userId.length > 128) return false
  if (typeof u.userName !== 'string' || u.userName.length === 0 || u.userName.length > 64) return false
  if (typeof u.colorIndex !== 'number' || !Number.isInteger(u.colorIndex) || u.colorIndex < 0) return false

  const cursor = v.cursor
  if (cursor !== null) {
    if (typeof cursor !== 'object') return false
    const c = cursor as Record<string, unknown>
    if (typeof c.x !== 'number' || !Number.isFinite(c.x)) return false
    if (typeof c.y !== 'number' || !Number.isFinite(c.y)) return false
  }

  const selected = v.selectedNodeIds
  if (!Array.isArray(selected)) return false
  if (selected.length > 1000) return false // 防 DoS 大数组
  for (const id of selected) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) return false
  }

  // lastUpdated 由服务器覆盖；忽略客户端传入
  return true
}