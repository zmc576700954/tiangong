/**
 * Yjs WebSocket 服务器（D10a）
 *
 * 端口与 host 从 settings.realtime 读取（默认 1234 / 127.0.0.1）。
 * 每个 WS 连接订阅一个 doc name（`graph:<id>`），使用 y-protocols/sync
 * 的二进制 sync protocol（step1 / step2 / update）交换 CRDT update。
 *
 * 当前阶段（D10a）：server 只暴露 doc sync；awareness / persistence 由
 * D10b / D10c 引入。本 server 不向 renderer 主动推送 awareness / 更新广播。
 */

import { WebSocketServer, WebSocket } from 'ws'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { YjsDocRegistry } from './yjs-doc'
import { graphIdFromDocName } from './yjs-doc'
import { createLogger } from '../shared/logger'

const logger = createLogger('YjsWs')

/** y-protocols/sync message types (来自 y-protocols/sync.js) */
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_AUTH = 2
const MESSAGE_QUERY_AWARENESS = 3

/** 单条 WS 连接的状态 */
interface ConnectionState {
  socket: WebSocket
  subscribedDocs: Set<string> // docName 集合
}

export interface YjsWsServerOptions {
  registry: YjsDocRegistry
  port: number
  host?: string
  /** 测试用：注入自定义 WebSocketServer 实例（仅当不想监听 TCP 时使用） */
  wssFactory?: () => WebSocketServer
}

export class YjsWsServer {
  private wss: WebSocketServer | null = null
  private connections = new Set<ConnectionState>()
  private unsubscribeByConnection = new WeakMap<ConnectionState, Array<() => void>>()
  private opts: Required<Pick<YjsWsServerOptions, 'registry' | 'port'>> & { host: string; wssFactory?: () => WebSocketServer }

  constructor(options: YjsWsServerOptions) {
    this.opts = {
      registry: options.registry,
      port: options.port,
      host: options.host ?? '127.0.0.1',
      wssFactory: options.wssFactory,
    }
  }

  /** 启动 WS server。重复调用幂等。 */
  async start(): Promise<{ host: string; port: number }> {
    if (this.wss) {
      return { host: this.opts.host, port: this.opts.port }
    }

    if (this.opts.wssFactory) {
      this.wss = this.opts.wssFactory()
    } else {
      this.wss = new WebSocketServer({ port: this.opts.port, host: this.opts.host, perMessageDeflate: false })
    }

    this.wss.on('connection', (socket) => this.handleConnection(socket))

    // TCP 模式等待 listening；factory 模式直接 resolve
    if (!this.opts.wssFactory) {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err)
        this.wss!.once('error', onError)
        this.wss!.once('listening', () => {
          this.wss!.off('error', onError)
          resolve()
        })
      })
    }

    logger.info(`Yjs WS server listening on ws://${this.opts.host}:${this.opts.port}`)
    return { host: this.opts.host, port: this.opts.port }
  }

  /** 关闭 server，释放所有连接 */
  async stop(): Promise<void> {
    if (!this.wss) return
    for (const conn of this.connections) {
      try {
        conn.socket.close()
      } catch {
        // ignore
      }
    }
    this.connections.clear()

    await new Promise<void>((resolve) => {
      this.wss!.close(() => resolve())
    })
    this.wss = null
    logger.info('Yjs WS server stopped')
  }

  /** 当前连接数（测试 / 健康检查用） */
  connectionCount(): number {
    return this.connections.size
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.wss !== null
  }

  // ============================================================
  // Connection lifecycle
  // ============================================================

  private handleConnection(socket: WebSocket): void {
    const state: ConnectionState = { socket, subscribedDocs: new Set() }
    this.connections.add(state)
    this.unsubscribeByConnection.set(state, [])

    socket.binaryType = 'arraybuffer'

    socket.on('message', (data) => {
      try {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as Buffer).buffer, (data as Buffer).byteOffset, (data as Buffer).byteLength)
        this.handleMessage(state, buf)
      } catch (err) {
        logger.error('Failed to handle WS message:', err)
      }
    })

    socket.on('close', () => {
      this.cleanupConnection(state)
    })
    socket.on('error', (err) => {
      logger.warn('WS socket error:', err)
      this.cleanupConnection(state)
    })
  }

  private cleanupConnection(state: ConnectionState): void {
    if (!this.connections.has(state)) return
    this.connections.delete(state)
    const unsubs = this.unsubscribeByConnection.get(state) ?? []
    for (const u of unsubs) {
      try { u() } catch { /* ignore */ }
    }
    this.unsubscribeByConnection.delete(state)
    for (const docName of state.subscribedDocs) {
      state.subscribedDocs.delete(docName)
    }
  }

  private handleMessage(state: ConnectionState, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message)
    const encoder = encoding.createEncoder()
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case MESSAGE_SYNC: {
        // 当前只支持单 doc 订阅，doc name 在 payload 之前由 client 通过 query header 传入。
        // 这里采用简化协议：每个 WS 连接先收到一个 "subscribe:<docName>" 文本 / 自定义字节序，
        // 但为避免协议膨胀，我们让 client 在第一个 sync message 前先发一个 MESSAGE_SYNC + 0x01
        // 子类型表示 doc name。
        // 简化策略：第一个 sync 消息被视为对最近声明 doc 的同步；若无声明则忽略。
        // 取折中方案：使用 messageType 之后剩余的 payload 第一段作为 docName 字符串。
        //
        // 实际上 y-protocols/sync 本身不携带 doc name，因此我们采用自定义 header：
        // 在每个 WS binary frame 开头用 1 byte 子类型 + 余下 payload：
        //   byte 0: messageType (0=SYNC, 1=AWARENESS, 2=AUTH, 3=QUERY_AWARENESS)
        //   byte 1: flags bit0=1 表示紧跟 null-terminated utf8 doc name
        //   然后 [doc name bytes][0x00][remaining sync payload]
        //
        // 但 D10a 的 sync 接口尚未与 renderer 联调，先采用最简协议：每个连接只能订阅一个 doc，
        // 该 doc name 通过 query string `?doc=graph:<id>` 在 URL 中传递。
        // 见 handleConnection 的 upgrade 路径。
        //
        // 由于 ws 库默认不支持自定义 path 参数提取，这里通过 connection 元信息保留。
        // 然而 ws 在 connection 事件里只能拿 url socket 信息。简化处理：取 socket.url。
        this.handleSyncMessage(state, decoder, encoder)
        if (encoding.length(encoder) > 1) {
          this.sendBinary(state, encoding.toUint8Array(encoder))
        }
        break
      }
      case MESSAGE_AWARENESS:
      case MESSAGE_AUTH:
      case MESSAGE_QUERY_AWARENESS:
        // D10a 暂不实现 awareness / auth 路径；忽略。
        break
      default:
        logger.warn(`Unknown WS message type: ${messageType}`)
    }
  }

  /**
   * 从 socket URL 提取 doc name。
   * 约定路径形如 `/graph:<id>` 或 `/graph%3A<id>`（url-encoded）。
   */
  private extractDocNameFromUrl(url: string | undefined): string | null {
    if (!url) return null
    try {
      // ws 库传入的 url 是 path + query 部分，例如 "/?doc=graph%3Aabc"
      const u = new URL(url, 'http://localhost')
      const docParam = u.searchParams.get('doc')
      if (docParam) return decodeURIComponent(docParam)
      // 兼容 path 形式
      const path = u.pathname.replace(/^\//, '')
      return path ? decodeURIComponent(path) : null
    } catch {
      return null
    }
  }

  /**
   * 处理 sync 消息。docName 通过 socket URL 在连接时一次性绑定（见 handleConnection）。
   */
  private handleSyncMessage(state: ConnectionState, decoder: decoding.Decoder, _encoder: encoding.Encoder): void {
    const docName = this.getDocNameForConnection(state)
    if (!docName) {
      logger.warn('Sync message received without subscribed doc (use ?doc=graph:<id>)')
      return
    }
    const graphId = graphIdFromDocName(docName)
    if (!graphId) {
      logger.warn(`Invalid doc name: ${docName}`)
      return
    }

    const doc = this.opts.registry.getOrCreateDoc(graphId, { hydrate: true })
    const subType = decoding.readVarUint(decoder)
    const handledReplyEncoder = encoding.createEncoder()

    switch (subType) {
      case syncProtocol.messageYjsSyncStep1: {
        // Client sends its state vector; we reply with sync step 2 (missing updates)
        const clientVector = decoding.readVarUint8Array(decoder)
        syncProtocol.writeSyncStep2(handledReplyEncoder, doc, clientVector)
        // 包装到 MESSAGE_SYNC envelope
        const inner = encoding.toUint8Array(handledReplyEncoder)
        const envelope = encoding.createEncoder()
        encoding.writeVarUint(envelope, MESSAGE_SYNC)
        encoding.writeVarUint8Array(envelope, inner)
        const payload = encoding.toUint8Array(envelope)
        this.sendBinary(state, payload)
        return
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        const update = decoding.readVarUint8Array(decoder)
        this.opts.registry.applyRemoteUpdate(graphId, update, { source: 'remote' })
        return
      }
      default:
        logger.warn(`Unknown sync subType: ${subType}`)
    }
  }

  private sendBinary(state: ConnectionState, payload: Uint8Array): void {
    if (state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(payload)
    }
  }

  /** 从 socket 取 docName 并在订阅集合里登记 */
  private getDocNameForConnection(state: ConnectionState): string | null {
    if (state.subscribedDocs.size > 0) {
      // 取第一个（单订阅）
      return state.subscribedDocs.values().next().value ?? null
    }
    // 懒订阅：首次 sync 时按 URL 绑定
    const fromUrl = this.extractDocNameFromUrl((state.socket as unknown as { url?: string }).url)
    if (fromUrl) {
      state.subscribedDocs.add(fromUrl)
      this.attachDocBroadcast(state, fromUrl)
      return fromUrl
    }
    return null
  }

  /** 把 doc 的 update 推送给该连接 */
  private attachDocBroadcast(state: ConnectionState, docName: string): void {
    const graphId = graphIdFromDocName(docName)
    if (!graphId) return
    const unsubscribe = this.opts.registry.onDocUpdate(graphId, (update, origin) => {
      // 来自本连接的远端写入不再回环发送（origin.source === 'remote'）
      if (origin && typeof origin === 'object' && (origin as { source?: string }).source === 'remote') {
        return
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      encoding.writeVarUint8Array(encoder, update)
      this.sendBinary(state, encoding.toUint8Array(encoder))
    })
    const arr = this.unsubscribeByConnection.get(state) ?? []
    arr.push(unsubscribe)
    this.unsubscribeByConnection.set(state, arr)
  }
}

/** 便捷构造：根据 settings.realtime 字段判断是否启动。 */
export async function maybeStartYjsWsServer(
  registry: YjsDocRegistry,
  settings: { realtime?: { enabled?: boolean; port?: number; host?: string } },
): Promise<YjsWsServer | null> {
  const enabled = settings.realtime?.enabled ?? false
  if (!enabled) return null
  const port = settings.realtime?.port ?? 1234
  const host = settings.realtime?.host ?? '127.0.0.1'
  const server = new YjsWsServer({ registry, port, host })
  try {
    await server.start()
    return server
  } catch (err) {
    logger.error(`Failed to start Yjs WS server on ${host}:${port}:`, err)
    return null
  }
}
