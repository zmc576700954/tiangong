/**
 * P6 — Yjs 只读处置 / 快照 / SQLite 镜像一致性（session-map 蓝图 §8.11，G4-8）。
 *
 * 裁决前提：Yjs 保持**只读**、默认不启动（`987c226`/`cc749ce`），SQLite 是唯一权威。
 * 因此本脚本不要求 Yjs 可写，只验证：
 *   1. 默认（未设 BIZGRAPH_YJS_WS）不监听端口；
 *   2. SQLite → 镜像：doc 字段与权威列一致（entity_key 不在 Yjs 文档内，仍留在 SQLite）；
 *   3. repo 显式写入后，权威列变化、doc 保持旧值（单向只读）；
 *   4. doc 变更不写 nodes/edges，只落 yjs_snapshots；
 *   5. 快照恢复后 entity_key 不被重算/重置，权威行不变。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { createServer, connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type BetterSqlite3 from 'better-sqlite3'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? path.join(os.tmpdir(), 'bizgraph-p6-' + process.pid) : os.tmpdir()),
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
}))

import { YjsRealtime, YJS_WS_ENV } from '../../src/main/realtime/snapshot/yjs-realtime'

type Row = Record<string, unknown>

class MirrorDb {
  graphs: Row[] = []
  nodes: Row[] = []
  edges: Row[] = []
  snapshots = new Map<string, { graph_id: string; doc_state: Buffer; schema_version: number; updated_at: string }>()
  unexpectedSql: string[] = []

  prepare(sql: string) {
    const q = sql.replace(/\s+/g, ' ').trim()
    return {
      all: (...params: unknown[]) => this.all(q, params),
      get: (...params: unknown[]) => this.get(q, params),
      run: (...params: unknown[]) => this.run(q, params),
    }
  }

  private unexpected(q: string): never {
    this.unexpectedSql.push(q)
    throw new Error(`unexpected SQL (doc → SQLite write?): ${q}`)
  }

  private all(q: string, params: unknown[]): Row[] {
    if (q === 'SELECT id FROM graphs') return this.graphs.map((g) => ({ id: g.id }))
    if (q.startsWith('SELECT * FROM nodes WHERE graph_id = ?')) return this.nodes.filter((n) => n.graph_id === params[0])
    if (q.startsWith('SELECT * FROM edges WHERE graph_id = ?')) return this.edges.filter((e) => e.graph_id === params[0])
    return this.unexpected(q)
  }

  private get(q: string, params: unknown[]): Row | undefined {
    if (q.startsWith('SELECT graph_id, doc_state, schema_version, updated_at FROM yjs_snapshots WHERE graph_id = ?')) {
      return this.snapshots.get(String(params[0]))
    }
    if (q === 'SELECT 1 FROM graphs WHERE id = ?') {
      return this.graphs.find((g) => g.id === params[0]) ? { 1: 1 } : undefined
    }
    return this.unexpected(q)
  }

  private run(q: string, params: unknown[]): { changes: number } {
    if (q.startsWith('INSERT INTO yjs_snapshots')) {
      const [graphId, docState, schemaVersion, updatedAt] = params
      this.snapshots.set(String(graphId), {
        graph_id: String(graphId), doc_state: docState as Buffer,
        schema_version: Number(schemaVersion), updated_at: String(updatedAt),
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

const OLD = '2026-01-01T00:00:00.000Z'

function seed(db: MirrorDb): void {
  db.graphs.push({ id: 'g1', name: 'G1', type: 'online', project_path: null, created_at: OLD, updated_at: OLD })
  db.nodes.push({
    id: 'n1', type: 'feature', status: 'draft', title: 'AUTH', description: 'd',
    acceptance_criteria: null, graph_id: 'g1', graph_type: 'online', parent_id: null,
    rules: null, metadata: null, owner_role: null, position_x: 0, position_y: 0,
    content: null, community_summary: null, community_level: null, community_id: null,
    context_refs: null, wiki_content: null, wiki_meta: null,
    entity_key: 'key-auth', lifecycle_state: 'active', created_at: OLD, updated_at: OLD,
  })
  db.edges.push({
    id: 'e1', source: 'n1', target: 'n2', label: 'flow', edge_type: 'default',
    graph_id: 'g1', content: null, description: null, data_flow: null, strength: 1,
    updated_at: OLD,
  })
}

function readNode(db: MirrorDb, id: string): Row | undefined {
  return db.nodes.find((n) => n.id === id)
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
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

describe('P6 Yjs 只读与 SQLite 镜像一致性', () => {
  let db: MirrorDb
  let yjs: InstanceType<typeof YjsRealtime>
  const originalEnv = process.env[YJS_WS_ENV]

  beforeEach(() => {
    db = new MirrorDb()
    seed(db)
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, {
      disableWebSocket: true,
      snapshotDebounceMs: 10_000,
    })
  })

  afterEach(async () => {
    await yjs.shutdown()
    if (originalEnv === undefined) delete process.env[YJS_WS_ENV]
    else process.env[YJS_WS_ENV] = originalEnv
  })

  it('默认（未设 BIZGRAPH_YJS_WS）不监听端口', async () => {
    delete process.env[YJS_WS_ENV]
    const port = await getFreePort()
    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, { wsPort: port, snapshotDebounceMs: 10_000 })
    const result = await yjs.init()
    expect(result.wsStarted).toBe(false)
    expect(await probePort(port)).toBe(false)
  })

  it('SQLite → 镜像：doc 字段与权威列一致；entity_key 仍在 SQLite', async () => {
    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    const node = doc.getNode('n1')!
    const row = readNode(db, 'n1')!
    expect(node.title).toBe(row.title)
    expect(node.status).toBe(row.status)
    expect(node.description).toBe(row.description)
    expect(node.updatedAt).toBe(row.updated_at)
    // Yjs 文档不承载 entity_key（单向只读镜像只覆盖 NodeData 字段）
    expect(row.entity_key).toBe('key-auth')
  })

  it('repo 显式写入后权威列变化、doc 保持旧值（单向只读）', async () => {
    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    db.nodes[0] = { ...db.nodes[0], title: 'NEW-TITLE', entity_key: 'key-auth-v2', updated_at: '2026-03-03T00:00:00.000Z' }

    expect(doc.getNode('n1')!.title).toBe('AUTH')
    expect(doc.getNode('n1')!.updatedAt).toBe(OLD)
    expect(readNode(db, 'n1')!.title).toBe('NEW-TITLE')
    expect(db.unexpectedSql).toEqual([])
  })

  it('doc 变更不写 nodes/edges，只更新 yjs_snapshots', async () => {
    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    doc.patchNode('n1', { title: 'SNAPSHOT-ONLY' })
    await yjs.shutdown()

    expect(db.snapshots.get('g1')).toBeDefined()
    expect(readNode(db, 'n1')!.title).toBe('AUTH')
    expect(readNode(db, 'n1')!.entity_key).toBe('key-auth')
    expect(db.unexpectedSql).toEqual([])
  })

  it('快照恢复后 entity_key 不被重算/重置，权威行不变', async () => {
    await yjs.init()
    const doc = yjs.getOrLoadDoc('g1')!
    doc.patchNode('n1', { title: 'FROM-SNAPSHOT' })
    await yjs.shutdown()

    yjs = new YjsRealtime(db as unknown as BetterSqlite3.Database, { disableWebSocket: true, snapshotDebounceMs: 10_000 })
    await yjs.init()
    const restored = yjs.getOrLoadDoc('g1')!
    expect(restored.getNode('n1')!.title).toBe('FROM-SNAPSHOT')
    // 权威列未被快照恢复改写
    expect(readNode(db, 'n1')!.entity_key).toBe('key-auth')
    expect(readNode(db, 'n1')!.title).toBe('AUTH')
  })
})
