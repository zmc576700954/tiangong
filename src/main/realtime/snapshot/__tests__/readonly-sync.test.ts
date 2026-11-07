/**
 * Read-only sync tests — 验证「Y.Doc → SQLite 写回」路径已被切断。
 *
 * 覆盖：
 * - YjsRealtime 初始化后，doc 内增删改节点/边不会改动 nodes/edges 行及 updated_at
 * - doc 变更仍会落 yjs_snapshots（快照持久化保留）
 * - 启动仍从 yjs_snapshots 恢复文档（恢复链保留）
 * - WS 端点拒绝 sync update / sync step 2（1008），且服务端 doc 与 SQLite 均不变
 * - WS 端点仍允许 sync step 1 读请求
 *
 * 说明：本地 better-sqlite3 是按 Electron ABI（NODE_MODULE_VERSION=130）编译的，
 * 直接用 Node 20 跑会报 ABI 不匹配（属于既有基线失败）。这里用只读的 FakeDb 桩
 * 驱动 YjsRealtime / SnapshotStore 的 SQL 面；任何未预期的写 SQL 会直接抛错，
 * 因此“写回路径被切断”的断言不依赖本机 sqlite ABI。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { createServer, type Server as HttpServer } from 'node:http'
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type AddressInfo,
} from 'node:net'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import type BetterSqlite3 from 'better-sqlite3'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.tmpdir(), 'bizgraph-readonly-' + process.pid)
      return os.tmpdir()
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import { YjsRealtime, YJS_WS_ENV } from '../yjs-realtime'
import { YjsDocument, type NodeData, type EdgeData } from '../yjs-document'
import { _attachToExistingServer } from '../ws-server'

const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z'

type Row = Record<string, unknown>

interface SnapshotRow {
  graph_id: string
  doc_state: Buffer
  schema_version: number
  updated_at: string
  [key: string]: unknown
}

/**
 * 只读 FakeDb：实现 YjsRealtime/SnapshotStore 实际用到的 SQL 面。
 * 未识别的 SQL（例如 NodeRepository.update 的 UPDATE nodes ...）一律抛错并记录，
 * 用来兜底证明没有任何 doc → nodes/edges 的写调用发生。
 */
class FakeDb {
  graphs: Row[] = []
  nodes: Row[] = []
  edges: Row[] = []
  snapshots = new Map<string, SnapshotRow>()
  unexpectedSql: string[] = []

  prepare(sql: string): {
    all: (...params: unknown[]) => Row[]
    get: (...params: unknown[]) => Row | undefined
    run: (...params: unknown[]) => { changes: number }
  } {
    const q = sql.replace(/\s+/g, ' ').trim()
    return {
      all: (...params) => this.all(q, params),
      get: (...params) => this.get(q, params),
      run: (...params) => this.run(q, params),
    }
  }

  private unexpected(q: string): never {
    this.unexpectedSql.push(q)
    throw new Error(`unexpected SQL (possible doc → SQLite write path): ${q}`)
  }

  private all(q: string, params: unknown[]): Row[] {
    if (q === 'SELECT id FROM graphs') return this.graphs.map((g) => ({ id: g.id }))
    if (q.startsWith('SELECT * FROM nodes WHERE graph_id = ?')) {
      return this.nodes.filter((n) => n.graph_id === params[0])
    }
    if (q.startsWith('SELECT * FROM edges WHERE graph_id = ?')) {
      return this.edges.filter((e) => e.graph_id === params[0])
    }
    return this.unexpected(q)
  }

  private get(q: string, params: unknown[]): Row | undefined {
    if (q.startsWith('SELECT graph_id, doc_state, schema_version, updated_at FROM yjs_snapshots WHERE graph_id = ?')) {
      return this.snapshots.get(String(params[0]))
    }
    if (q.startsWith('SELECT * FROM nodes WHERE id = ?')) {
      return this.nodes.find((n) => n.id === params[0])
    }
    if (q.startsWith('SELECT * FROM edges WHERE id = ?')) {
      return this.edges.find((e) => e.id === params[0])
    }
    if (q === 'SELECT COUNT(*) AS c FROM nodes') return { c: this.nodes.length }
    if (q === 'SELECT COUNT(*) AS c FROM edges') return { c: this.edges.length }
    return this.unexpected(q)
  }

  private run(q: string, params: unknown[]): { changes: number } {
    if (q.startsWith('INSERT INTO yjs_snapshots')) {
      const [graphId, docState, schemaVersion, updatedAt] = params
      this.snapshots.set(String(graphId), {
        graph_id: String(graphId),
        doc_state: docState as Buffer,
        schema_version: Number(schemaVersion),
        updated_at: String(updatedAt),
      })
      return { changes: 1 }
    }
    if (q.startsWith('DELETE FROM yjs_snapshots WHERE graph_id = ?')) {
      this.snapshots.delete(String(params[0]))
      return { changes: 1 }
    }
    return this.unexpected(q)
  }
}

function makeNode(overrides: Partial<NodeData> = {}): NodeData {
  return {
    id: 'n1',
    type: 'feature',
    status: 'draft',
    title: 'T1',
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: OLD_UPDATED_AT,
    updatedAt: OLD_UPDATED_AT,
    ...overrides,
  }
}

function makeEdge(overrides: Partial<EdgeData> = {}): EdgeData {
  return {
    id: 'e1',
    source: 'n1',
    target: 'n2',
    graphId: 'g1',
    ...overrides,
  }
}

/** 一张图 + 两个节点 + 一条边，updated_at 固定为旧值。 */
function seedDb(db: FakeDb): void {
  db.graphs.push({
    id: 'g1',
    name: 'Graph 1',
    type: 'online',
    project_path: null,
    created_at: OLD_UPDATED_AT,
    updated_at: OLD_UPDATED_AT,
  })
  db.nodes.push({
    id: 'n1',
    type: 'feature',
    status: 'draft',
    title: 'A',
    description: 'keep-me',
    acceptance_criteria: null,
    graph_id: 'g1',
    graph_type: 'online',
    parent_id: null,
    rules: null,
    metadata: null,
    owner_role: null,
    position_x: 0,
    position_y: 0,
    content: null,
    community_summary: null,
    community_level: null,
    community_id: null,
    context_refs: null,
    wiki_content: null,
    wiki_meta: null,
    created_at: OLD_UPDATED_AT,
    updated_at: OLD_UPDATED_AT,
  })
  db.nodes.push({
    id: 'n2',
    type: 'feature',
    status: 'draft',
    title: 'B',
    description: null,
    acceptance_criteria: null,
    graph_id: 'g1',
    graph_type: 'online',
    parent_id: 'n1',
    rules: null,
    metadata: null,
    owner_role: null,
    position_x: 0,
    position_y: 0,
    content: null,
    community_summary: null,
    community_level: null,
    community_id: null,
    context_refs: null,
    wiki_content: null,
    wiki_meta: null,
    created_at: OLD_UPDATED_AT,
    updated_at: OLD_UPDATED_AT,
  })
  db.edges.push({
    id: 'e1',
    source: 'n1',
    target: 'n2',
    label: 'flow',
    edge_type: 'depends',
    graph_id: 'g1',
    content: null,
    description: null,
    data_flow: null,
    strength: null,
    updated_at: OLD_UPDATED_AT,
  })
}

function readNode(db: FakeDb, id: string): Row | undefined {
  return db.nodes.find((n) => n.id === id)
}

function readEdge(db: FakeDb, id: string): Row | undefined {
  return db.edges.find((e) => e.id === id)
}

function binaryToU8(data: unknown): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[])
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const buf = data as Buffer
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** 连接 WS 并缓存服务端下发消息；支持按需等待下一条。 */
function connectClient(url: string): {
  ws: WebSocket
  nextMessage: () => Promise<Uint8Array>
  nextClose: () => Promise<{ code: number; reason: string }>
} {
  const ws = new WebSocket(url)
  const queue: Uint8Array[] = []
  const waiters: Array<(v: Uint8Array) => void> = []
  ws.on('message', (data: Buffer) => {
    const u8 = binaryToU8(data)
    const waiter = waiters.shift()
    if (waiter) waiter(u8)
    else queue.push(u8)
  })
  return {
    ws,
    nextMessage: () =>
      new Promise((resolve, reject) => {
        if (queue.length > 0) {
          resolve(queue.shift()!)
          return
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), 3000)
        waiters.push((v) => {
          clearTimeout(timer)
          resolve(v)
        })
      }),
    nextClose: () =>
      new Promise((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      }),
  }
}

/** 取一个当前空闲端口，避免与 1236 或本机其它服务冲突。 */
async function getFreePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** 端口是否有监听：TCP 能连上即有；连接被拒/超时即无。 */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, '127.0.0.1')
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function encodeSyncMessage(subType: number, payload?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // MESSAGE_SYNC
  encoding.writeVarUint(encoder, subType)
  if (payload) encoding.writeVarUint8Array(encoder, payload)
  return encoding.toUint8Array(encoder)
}

function buildAttackUpdate(): Uint8Array {
  const doc = new Y.Doc()
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  doc.transact(() => {
    const attack = new Y.Map<unknown>()
    attack.set('id', 'n_hacked')
    attack.set('title', 'HACKED')
    nodes.set('n_hacked', attack)
  })
  return Y.encodeStateAsUpdate(doc)
}

describe('Read-only Yjs — 不写回 SQLite', () => {
  let db: FakeDb
  let yjs: InstanceType<typeof YjsRealtime>

  beforeEach(() => {
    db = new FakeDb()
    seedDb(db)
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, {
      disableWebSocket: true,
      snapshotDebounceMs: 10_000,
    })
  })

  afterEach(async () => {
    await yjs.shutdown()
  })

  it('doc 内增删改节点/边后，nodes/edges 对应行与 updated_at 均不变', async () => {
    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    expect(doc).toBeDefined()

    const beforeNode = { ...readNode(db, 'n1')! }
    const beforeEdge = { ...readEdge(db, 'e1')! }
    const beforeNodeCount = db.nodes.length
    const beforeEdgeCount = db.edges.length

    doc.setNode('n3', makeNode({ id: 'n3', title: 'new' }))
    doc.patchNode('n1', { title: 'HACKED', updatedAt: '2030-01-01T00:00:00.000Z' })
    doc.setEdge('e2', makeEdge({ id: 'e2', source: 'n1', target: 'n3', label: 'new-edge' }))
    doc.patchEdge('e1', { label: 'HACKED' })
    doc.deleteNode('n2')

    await Promise.resolve()

    expect(readNode(db, 'n1')).toEqual(beforeNode)
    expect(readEdge(db, 'e1')).toEqual(beforeEdge)
    expect(readNode(db, 'n1')?.updated_at).toBe(OLD_UPDATED_AT)
    expect(readEdge(db, 'e1')?.updated_at).toBe(OLD_UPDATED_AT)
    expect(readNode(db, 'n2')).toBeDefined()
    expect(readNode(db, 'n3')).toBeUndefined()
    expect(readEdge(db, 'e2')).toBeUndefined()
    expect(db.nodes.length).toBe(beforeNodeCount)
    expect(db.edges.length).toBe(beforeEdgeCount)
    expect(db.unexpectedSql).toEqual([])
  })

  it('doc 变更仍写入 yjs_snapshots（快照持久化保留）', async () => {
    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    doc.patchNode('n1', { title: 'snapshot-only' })

    // shutdown 会 dispose → flush 快照
    await yjs.shutdown()
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, {
      disableWebSocket: true,
      snapshotDebounceMs: 10_000,
    })

    const row = db.snapshots.get('g1')
    expect(row).toBeDefined()
    const restored = YjsDocument.fromUpdate(new Uint8Array(row!.doc_state))
    expect(restored.getNode('n1')?.title).toBe('snapshot-only')
    // 快照变了，但权威表仍是旧值
    expect(readNode(db, 'n1')?.title).toBe('A')
    expect(db.unexpectedSql).toEqual([])
  })

  it('启动仍从 yjs_snapshots 恢复文档（恢复链保留）', async () => {
    const seed = new YjsDocument()
    seed.setNode('n1', makeNode({ id: 'n1', title: 'FROM_SNAPSHOT' }))
    db.snapshots.set('g1', {
      graph_id: 'g1',
      doc_state: Buffer.from(seed.encodeState()),
      schema_version: 1,
      updated_at: OLD_UPDATED_AT,
    })

    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    expect(doc.getNode('n1')?.title).toBe('FROM_SNAPSHOT')
  })
})

describe('Read-only Yjs — WS 拒绝写消息', () => {
  let db: FakeDb
  let yjs: InstanceType<typeof YjsRealtime>
  let httpServer: HttpServer
  let port: number
  let attached: ReturnType<typeof _attachToExistingServer>
  const clients: WebSocket[] = []

  beforeEach(async () => {
    db = new FakeDb()
    seedDb(db)
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, {
      disableWebSocket: true,
      snapshotDebounceMs: 10_000,
    })
    await yjs.init()

    httpServer = createServer()
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    port = (httpServer.address() as AddressInfo).port
    attached = _attachToExistingServer(httpServer, {
      getDoc: (graphId: string) => yjs.getOrLoadDoc(graphId)?.getYDoc(),
    })
  })

  afterEach(async () => {
    for (const c of clients) {
      try {
        c.close()
      } catch {
        // ignore
      }
    }
    clients.length = 0
    await attached.stop()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await yjs.shutdown()
  })

  it('sync update 被 1008 拒绝，服务端 doc 与 SQLite 均不变', async () => {
    const { ws, nextMessage, nextClose } = connectClient(`ws://127.0.0.1:${port}/graph/g1`)
    clients.push(ws)
    // 首条消息是服务端下发的完整状态（sync step 2）
    const hello = await nextMessage()
    const dec = decoding.createDecoder(hello)
    expect(decoding.readVarUint(dec)).toBe(0)
    expect(decoding.readVarUint(dec)).toBe(syncProtocol.messageYjsSyncStep2)

    const beforeNode = { ...readNode(db, 'n1')! }
    const closePromise = nextClose()
    ws.send(encodeSyncMessage(syncProtocol.messageYjsUpdate, buildAttackUpdate()), { binary: true })
    const closed = await closePromise

    expect(closed.code).toBe(1008)
    expect(closed.reason).toContain('read-only')
    const doc = yjs.getOrLoadDoc('g1')!
    expect(doc.getNode('n_hacked')).toBeUndefined()
    expect(readNode(db, 'n1')).toEqual(beforeNode)
    expect(readNode(db, 'n_hacked')).toBeUndefined()
    expect(db.unexpectedSql).toEqual([])
  })

  it('sync step 2 被 1008 拒绝', async () => {
    const { ws, nextMessage, nextClose } = connectClient(`ws://127.0.0.1:${port}/graph/g1`)
    clients.push(ws)
    await nextMessage()

    const closePromise = nextClose()
    ws.send(encodeSyncMessage(syncProtocol.messageYjsSyncStep2, buildAttackUpdate()), { binary: true })
    const closed = await closePromise
    expect(closed.code).toBe(1008)
    expect(closed.reason).toContain('read-only')
    expect(yjs.getOrLoadDoc('g1')!.getNode('n_hacked')).toBeUndefined()
  })

  it('sync step 1 读请求仍被响应（只读路径保留）', async () => {
    const { ws, nextMessage } = connectClient(`ws://127.0.0.1:${port}/graph/g1`)
    clients.push(ws)
    await nextMessage()

    const emptyVector = Y.encodeStateVector(new Y.Doc())
    ws.send(encodeSyncMessage(syncProtocol.messageYjsSyncStep1, emptyVector), { binary: true })
    const reply = await nextMessage()
    const dec = decoding.createDecoder(reply)
    expect(decoding.readVarUint(dec)).toBe(0)
    expect(decoding.readVarUint(dec)).toBe(syncProtocol.messageYjsSyncStep2)
    // 连接未被关闭（还能再发一次读请求）
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })
})

describe('Yjs WS — 默认不监听，显式开关才启动', () => {
  let yjs: InstanceType<typeof YjsRealtime> | undefined
  const originalEnv = process.env[YJS_WS_ENV]

  afterEach(async () => {
    await yjs?.shutdown()
    yjs = undefined
    if (originalEnv === undefined) delete process.env[YJS_WS_ENV]
    else process.env[YJS_WS_ENV] = originalEnv
  })

  it('默认（未设置 BIZGRAPH_YJS_WS）不启动 WS：init 报告 false 且端口无监听', async () => {
    delete process.env[YJS_WS_ENV]
    const db = new FakeDb()
    seedDb(db)
    const port = await getFreePort()
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, {
      wsPort: port,
      snapshotDebounceMs: 10_000,
    })

    const result = await yjs.init()

    expect(result.wsStarted).toBe(false)
    expect(await probePort(port)).toBe(false)
  })

  it('显式 BIZGRAPH_YJS_WS=1 才启动 WS：端口可连接并下发 sync step 2', async () => {
    process.env[YJS_WS_ENV] = '1'
    const db = new FakeDb()
    seedDb(db)
    const port = await getFreePort()
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, {
      wsPort: port,
      snapshotDebounceMs: 10_000,
    })

    const result = await yjs.init()
    expect(result.wsStarted).toBe(true)
    expect(await probePort(port)).toBe(true)

    const { ws, nextMessage } = connectClient(`ws://127.0.0.1:${port}/graph/g1`)
    try {
      const hello = await nextMessage()
      const dec = decoding.createDecoder(hello)
      expect(decoding.readVarUint(dec)).toBe(0)
      expect(decoding.readVarUint(dec)).toBe(syncProtocol.messageYjsSyncStep2)
    } finally {
      ws.close()
    }
  })
})
