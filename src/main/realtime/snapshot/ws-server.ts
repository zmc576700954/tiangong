/**
 * YjsWsServer — Y.Doc 同步的 WebSocket 端点（D10a 主进程 sync provider）。
 *
 * URL 形式：`ws://host:port/graph/<graphId>`。
 *
 * 协议基于 y-protocols/sync，但本端点**只读**：
 *  - 客户端连上后，服务端直接下发完整状态（sync step 2）
 *  - 客户端发 sync step 1（state vector）→ 服务端回 sync step 2（缺失增量）
 *  - 客户端发 sync step 2 / sync update（写消息）→ 以 1008 关闭，且不应用到 Y.Doc
 *  - 服务端不主动向客户端索取本地差异（不发 step 1），避免诱发写消息
 *
 * 数据方向固定为 SQLite/yjs_snapshots → Y.Doc → 客户端；
 * 客户端的任何数据都不会进入 Y.Doc，更不会进入 SQLite。
 *
 * Awareness（D10b）走不同消息类型 MESSAwareness；当前 D10a 暂不实现 awareness 通道，
 * 仅保留 MESSAGE_SYNC。
 *
 * 注意：ws-server 启动是 best-effort，主进程启动失败不应阻塞 BizGraph 主工作流；
 * 失败时静默记录，仍可走 IPC 路径同步。
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import type * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { createLogger } from '../../shared/logger'

const logger = createLogger('YjsWsServer')

/** y-protocols message type tags */
const MESSAGE_SYNC = 0
/** Reserved for D10b awareness；D10a 暂不实现 awareness 通道，但保留常量以备未来扩展。 */
const MESSAGE_AWARENESS = 1
void MESSAGE_AWARENESS

export type DocLookup = (graphId: string) => Y.Doc | undefined

export interface YjsWsServerOptions {
  port: number
  host?: string
  getDoc: DocLookup
}

export class YjsWsServer {
  private wss: WebSocketServer | null = null
  /** graphId -> 已连入的 client 集合（不参与 thread 内部状态，便于以后 cleanup） */
  private readonly connections = new Map<string, Set<WebSocket>>()
  private opts: YjsWsServerOptions
  private started = false

  constructor(opts: YjsWsServerOptions) {
    this.opts = opts
  }

  /** 启动 WebSocket 端点；如端口已被占用则 throw。 */
  start(): Promise<void> {
    if (this.started) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.opts.port,
        host: this.opts.host ?? '127.0.0.1',
      })
      const onError = (err: Error) => {
        wss.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        wss.removeListener('error', onError)
        this.started = true
        logger.info(`YjsWsServer listening on ws://${this.opts.host ?? '127.0.0.1'}:${this.opts.port}`)
        resolve()
      }
      wss.once('listening', onListening)
      wss.once('error', onError)
      wss.on('connection', (ws, req) => {
        this.handleConnection(ws, req.url ?? '/')
      })
      this.wss = wss
    })
  }

  /** 关闭 WebSocket 服务；等待 close callback。 */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve()
        return
      }
      // close all active connections
      for (const set of this.connections.values()) {
        for (const ws of set) {
          try { ws.close() } catch { /* ignore */ }
        }
      }
      this.connections.clear()
      this.wss.close(() => {
        this.started = false
        this.wss = null
        resolve()
      })
    })
  }

  /** 测试 / 调试用 — 当前已连接 client 数 */
  totalConnections(): number {
    let n = 0
    for (const set of this.connections.values()) n += set.size
    return n
  }

  private handleConnection(ws: WebSocket, url: string): void {
    // URL 解析：/graph/<graphId>
    const match = url.match(/^\/graph\/([a-zA-Z0-9_-]{1,64})(?:\?|$)/)
    if (!match) {
      logger.warn(`rejecting ws: invalid URL ${url}`)
      ws.close(1008, 'invalid url')
      return
    }
    const graphId = match[1]
    const doc = this.opts.getDoc(graphId)
    if (!doc) {
      logger.warn(`rejecting ws for graph ${graphId}: no doc in pool`)
      ws.close(1008, 'graph not found')
      return
    }

    let set = this.connections.get(graphId)
    if (!set) {
      set = new Set()
      this.connections.set(graphId, set)
    }
    set.add(ws)

    // 服务端 → 客户端：直接下发完整状态（sync step 2）。
    // 不发 step 1：那等于向客户端索取本地差异，会让写客户端回 step 2 后被关闭。
    {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeSyncStep2(encoder, doc)
      safeSend(ws, encoding.toUint8Array(encoder))
    }

    // doc 端 update → 转发到 ws client（跳过 origin === ws 的回声）
    const updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === ws) return
      try {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeUpdate(encoder, update)
        safeSend(ws, encoding.toUint8Array(encoder))
      } catch (err) {
        logger.warn('ws broadcast failed:', err)
      }
    }
    doc.on('update', updateHandler)

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const u8 = toUint8Array(data)
        const decoder = decoding.createDecoder(u8)
        const messageType = decoding.readVarUint(decoder)
        if (messageType !== MESSAGE_SYNC) {
          logger.warn(`rejecting non-sync ws message (type ${messageType}) for graph ${graphId}`)
          ws.close(1008, 'read-only: only sync messages are accepted')
          return
        }

        const syncSubType = decoding.readVarUint(decoder)

        // 读请求：客户端发 state vector，服务端回它缺的增量。不触碰 doc。
        if (syncSubType === syncProtocol.messageYjsSyncStep1) {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_SYNC)
          syncProtocol.writeSyncStep2(encoder, doc, decoding.readVarUint8Array(decoder))
          safeSend(ws, encoding.toUint8Array(encoder))
          return
        }

        // 写消息：step 2 / update 都会修改 Y.Doc，一律拒绝且不应用。
        if (
          syncSubType === syncProtocol.messageYjsSyncStep2 ||
          syncSubType === syncProtocol.messageYjsUpdate
        ) {
          logger.warn(`rejecting write sync message (subtype ${syncSubType}) for graph ${graphId}`)
          ws.close(1008, 'read-only: doc updates are not accepted')
          return
        }

        ws.close(1008, `read-only: unsupported sync subtype ${syncSubType}`)
      } catch (err) {
        logger.warn('ws message handler failed:', err)
        ws.close(1011, 'failed to process message')
      }
    })

    const cleanup = () => {
      doc.off('update', updateHandler)
      const s = this.connections.get(graphId)
      if (s) {
        s.delete(ws)
        if (s.size === 0) this.connections.delete(graphId)
      }
    }
    ws.on('close', cleanup)
    ws.on('error', (err) => {
      logger.debug(`ws error for ${graphId}:`, err)
      cleanup()
    })
  }
}

/** 安全发送，吞掉 EPIPE / not open 错误。 */
function safeSend(ws: WebSocket, data: Uint8Array): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data, { binary: true })
    }
  } catch (err) {
    logger.debug('ws send swallowed error:', err)
  }
}

/** 把 ws 的 message 数据统一归一为 Uint8Array。 */
function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) {
    // 多帧 — concat
    const total = data.reduce((n, b) => n + b.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const b of data) {
      out.set(b, offset)
      offset += b.length
    }
    return out
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * 暴露给外层的工厂函数。如果 ws 安装失败（D10a 兼容旧平台），
 * 调用方可以选择继续走纯 IPC 同步路径。
 */
export function createYjsWsServer(opts: YjsWsServerOptions): YjsWsServer {
  return new YjsWsServer(opts)
}

/** 测试用：构造 mock http server 时不创建新端口。 */
export function _attachToExistingServer(httpServer: HttpServer, opts: Omit<YjsWsServerOptions, 'port'>): YjsWsServer {
  const server = new YjsWsServer({ ...opts, port: 0 })
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, req) => {
    server['handleConnection'](ws, req.url ?? '/')
  })
  server['wss'] = wss
  server['started'] = true
  return server
}