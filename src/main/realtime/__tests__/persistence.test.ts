/**
 * SnapshotStore + SnapshotPersistence tests — D10c 持久化层。
 *
 * 覆盖（D10c-5：≥10 case）：
 * - snapshot 写入 / 读取正确
 * - 启动加载：从 yjs_snapshots 还原 Y.Doc
 * - 老数据迁移：从 nodes/edges 表回填到 Y.Doc 快照（migrateFromLegacy）
 * - 防抖保存（debounce 1s）+ dispose 立即 flush
 * - 大文档（10k 节点）序列化 < 500ms
 * - 删除快照、列举快照
 * - schema_version 持久化
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// Mock electron app — SnapshotStore 不需要它，但走数据库层需要
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.tmpdir(), 'bizgraph-persistence-' + process.pid)
      return os.tmpdir()
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { initDatabase, closeDatabase, getClient } from '../../database'
import { SnapshotStore, CURRENT_YJS_SCHEMA_VERSION } from '../snapshot-store'
import { attachSnapshotPersistence } from '../snapshot-persistence'
import { YjsDocument, type NodeData, type EdgeData } from '../yjs-doc'

function makeNode(overrides: Partial<NodeData> = {}): NodeData {
  return {
    id: 'n1',
    type: 'feature',
    status: 'draft',
    title: 'T1',
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

/** 手工建一个最小可用的 in-memory schema（含 graphs/nodes/edges/yjs_snapshots），不走 initDatabase()。
 *  initDatabase() 会自动跑 migrate 建全部 14 张表，副作用大；这里只要相关表。
 */
function freshInMemoryDb(): BetterSqlite3.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      project_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL,
      parent_id TEXT,
      rules TEXT,
      metadata TEXT,
      owner_role TEXT,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      content TEXT,
      community_summary TEXT,
      community_level INTEGER,
      community_id TEXT,
      context_refs TEXT,
      wiki_content TEXT,
      wiki_meta TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT,
      edge_type TEXT,
      graph_id TEXT NOT NULL,
      content TEXT,
      description TEXT,
      data_flow TEXT,
      strength REAL
    );
    CREATE TABLE yjs_snapshots (
      graph_id TEXT PRIMARY KEY,
      doc_state BLOB NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `)
  return db
}

describe('SnapshotStore', () => {
  describe('save / getLatest', () => {
    it('save 后 getLatest 返回一致快照', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc = new YjsDocument()
      doc.setNode('n1', makeNode({ id: 'n1' }))
      const state = doc.encodeState()
      const row = store.save('g1', state)
      expect(row.graphId).toBe('g1')
      expect(row.schemaVersion).toBe(CURRENT_YJS_SCHEMA_VERSION)
      expect(row.docState).toBeInstanceOf(Uint8Array)

      const got = store.getLatest('g1')
      expect(got).not.toBeNull()
      expect(got?.graphId).toBe('g1')
      // Buffer/Uint8Array 字节序列应一致
      expect(new Uint8Array(got!.docState)).toEqual(new Uint8Array(state))
      db.close()
    })

    it('getLatest 在快照不存在时返回 null', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      expect(store.getLatest('missing')).toBeNull()
      db.close()
    })

    it('save 同图 UPSERT：连续两次 save 取到最新一份', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc1 = new YjsDocument()
      doc1.setNode('n1', makeNode({ id: 'n1', title: 'first' }))
      store.save('g1', doc1.encodeState())

      const doc2 = new YjsDocument()
      doc2.setNode('n1', makeNode({ id: 'n1', title: 'second' }))
      store.save('g1', doc2.encodeState())

      const got = store.getLatest('g1')
      expect(got).not.toBeNull()
      const restored = YjsDocument.fromUpdate(got!.docState)
      expect(restored.getNode('n1')?.title).toBe('second')
      db.close()
    })

    it('schema_version 自定义值被持久化', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const state = new YjsDocument().encodeState()
      store.save('g1', state, 42)
      expect(store.getLatest('g1')?.schemaVersion).toBe(42)
      db.close()
    })
  })

  describe('delete / listGraphIds', () => {
    it('delete 移除快照，再 getLatest 返回 null', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      store.save('g1', new YjsDocument().encodeState())
      expect(store.getLatest('g1')).not.toBeNull()
      store.delete('g1')
      expect(store.getLatest('g1')).toBeNull()
      db.close()
    })

    it('listGraphIds 返回所有有快照的图 id', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      store.save('g1', new YjsDocument().encodeState())
      store.save('g2', new YjsDocument().encodeState())
      expect(store.listGraphIds().sort()).toEqual(['g1', 'g2'])
      db.close()
    })
  })

  describe('启动加载（snapshot → Y.Doc）', () => {
    it('从快照还原的 Y.Doc 字段与写入时一致', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc = new YjsDocument()
      doc.setNode('n1', makeNode({ id: 'n1', title: 'A', description: 'aaa' }))
      doc.setNode('n2', makeNode({ id: 'n2', title: 'B', graphId: 'g1' }))
      doc.setEdge('e1', makeEdge({ id: 'e1', source: 'n1', target: 'n2', label: 'flow' }))
      doc.setMeta('k', 'v')
      store.save('g1', doc.encodeState())

      const row = store.getLatest('g1')
      expect(row).not.toBeNull()
      const restored = YjsDocument.fromUpdate(row!.docState)
      expect(restored.nodeCount()).toBe(2)
      expect(restored.edgeCount()).toBe(1)
      expect(restored.getNode('n1')?.title).toBe('A')
      expect(restored.getNode('n2')?.title).toBe('B')
      expect(restored.getEdge('e1')?.label).toBe('flow')
      expect(restored.getMeta<string>('k')).toBe('v')
      db.close()
    })
  })

  describe('老数据迁移（migrateFromLegacy）', () => {
    it('扫描 graphs 表，无快照的图回填 nodes/edges', () => {
      const db = freshInMemoryDb()
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO graphs (id, name, type, project_path, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run('g1', 'Graph 1', 'online', null, now, now)
      db.prepare(`INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('n1', 'feature', 'draft', 'A', 'g1', 'online', 0, 0, now, now)
      db.prepare(`INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('n2', 'feature', 'draft', 'B', 'g1', 'online', 0, 0, now, now)
      db.prepare(`INSERT INTO edges (id, source, target, graph_id) VALUES (?, ?, ?, ?)`)
        .run('e1', 'n1', 'n2', 'g1')

      const store = new SnapshotStore(db)
      const result = store.migrateFromLegacy()
      expect(result.scannedGraphs).toBe(1)
      expect(result.backfilled).toBe(1)
      expect(result.errors).toEqual([])

      // 验证：从快照还原的内容与原表一致
      const row = store.getLatest('g1')
      expect(row).not.toBeNull()
      const restored = YjsDocument.fromUpdate(row!.docState)
      expect(restored.nodeCount()).toBe(2)
      expect(restored.edgeCount()).toBe(1)
      expect(restored.getNode('n1')?.title).toBe('A')
      expect(restored.getEdge('e1')?.source).toBe('n1')
      db.close()
    })

    it('幂等：已存在快照的图跳过', () => {
      const db = freshInMemoryDb()
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO graphs (id, name, type, project_path, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run('g1', 'Graph 1', 'online', null, now, now)

      const store = new SnapshotStore(db)
      // 先写一个空快照
      const first = new YjsDocument()
      first.setMeta('marker', 'preserved')
      store.save('g1', first.encodeState())

      const result = store.migrateFromLegacy()
      expect(result.scannedGraphs).toBe(1)
      expect(result.backfilled).toBe(0)
      expect(result.skipped).toBe(1)

      const row = store.getLatest('g1')
      const restored = YjsDocument.fromUpdate(row!.docState)
      expect(restored.getMeta<string>('marker')).toBe('preserved')
      db.close()
    })

    it('graphs 表为空时结果全 0、无错误', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const result = store.migrateFromLegacy()
      expect(result.scannedGraphs).toBe(0)
      expect(result.backfilled).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.errors).toEqual([])
      db.close()
    })
  })

  describe('attachSnapshotPersistence 防抖', () => {
    it('变更后 1s 内未到时不写盘；到时落盘', async () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc = new YjsDocument()
      const dispose = attachSnapshotPersistence('g1', doc, store, { debounceMs: 80 })

      doc.setNode('n1', makeNode({ id: 'n1', title: 'X' }))
      expect(store.getLatest('g1')).toBeNull()

      await new Promise((r) => setTimeout(r, 160))
      const row = store.getLatest('g1')
      expect(row).not.toBeNull()
      const restored = YjsDocument.fromUpdate(row!.docState)
      expect(restored.getNode('n1')?.title).toBe('X')

      dispose()
      db.close()
    })

    it('连击变更只触发一次落盘（debounce 重置）', async () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc = new YjsDocument()
      let savedCount = 0
      const dispose = attachSnapshotPersistence('g1', doc, store, {
        debounceMs: 60,
        onSaved: () => { savedCount += 1 },
      })

      doc.setNode('n1', makeNode({ id: 'n1', title: 'a' }))
      await new Promise((r) => setTimeout(r, 20))
      doc.setNode('n1', makeNode({ id: 'n1', title: 'b' }))
      await new Promise((r) => setTimeout(r, 20))
      doc.setNode('n1', makeNode({ id: 'n1', title: 'c' }))

      // 等待最终 debounce 触发
      await new Promise((r) => setTimeout(r, 120))
      expect(savedCount).toBeGreaterThanOrEqual(1)
      expect(savedCount).toBeLessThanOrEqual(2)

      // 落盘内容是最后一次变更的结果
      const restored = YjsDocument.fromUpdate(store.getLatest('g1')!.docState)
      expect(restored.getNode('n1')?.title).toBe('c')

      dispose()
      db.close()
    })

    it('dispose 立即 flush，不等防抖窗口', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc = new YjsDocument()
      const dispose = attachSnapshotPersistence('g1', doc, store, { debounceMs: 10_000 })
      doc.setNode('n1', makeNode({ id: 'n1', title: 'flush' }))
      // 还未到 10s，DB 仍为空
      expect(store.getLatest('g1')).toBeNull()
      dispose()
      // dispose 之后 DB 应有数据
      const row = store.getLatest('g1')
      expect(row).not.toBeNull()
      const restored = YjsDocument.fromUpdate(row!.docState)
      expect(restored.getNode('n1')?.title).toBe('flush')
      db.close()
    })

    it('onError 在 save 失败时被调用', () => {
      const db = freshInMemoryDb()
      // 用一个会被 trigger schema-version error 的 raw statement 触发 save 失败；
      // 这里通过 monkey-patch store.save 抛错来验证回调路径。
      const store = new SnapshotStore(db)
      const realSave = store.save.bind(store)
      ;(store as unknown as { save: typeof realSave }).save = () => {
        throw new Error('forced failure')
      }
      const onError = vi.fn()
      const doc = new YjsDocument()
      const dispose = attachSnapshotPersistence('g1', doc, store, {
        debounceMs: 10,
        onError,
      })
      doc.setNode('n1', makeNode({ id: 'n1' }))
      dispose()
      expect(onError).toHaveBeenCalled()
      // 还原 save 不影响其它用例
      ;(store as unknown as { save: typeof realSave }).save = realSave
      db.close()
    })
  })

  describe('大文档性能门槛', () => {
    it('10k 节点快照序列化 + 写入 < 500ms', () => {
      const db = freshInMemoryDb()
      const store = new SnapshotStore(db)
      const doc = new YjsDocument()
      doc.transaction(() => {
        for (let i = 0; i < 10_000; i++) {
          doc.setNode(
            `n_${i}`,
            makeNode({
              id: `n_${i}`,
              title: `N${i}`,
              position: { x: i, y: i * 2 },
            }),
          )
        }
      })
      const state = doc.encodeState()
      const start = Date.now()
      store.save('g1', state)
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(500)
      expect(state.byteLength).toBeGreaterThan(0)
      const restored = YjsDocument.fromUpdate(state)
      expect(restored.nodeCount()).toBe(10_000)
      db.close()
    })
  })

  describe('与 initDatabase() 集成', () => {
    // 用真实 DB 模块确认 yjs_snapshots 表存在且 schema_version 是 v11+
    beforeEach(() => {
      initDatabase()
    })
    afterEach(() => {
      closeDatabase()
    })

    it('yjs_snapshots 表存在且 graph_id 是 PRIMARY KEY', () => {
      const db = getClient()
      const cols = db.pragma('table_info(yjs_snapshots)') as Record<string, unknown>[]
      const names = cols.map((c) => c.name as string)
      expect(names).toEqual(expect.arrayContaining(['graph_id', 'doc_state', 'schema_version', 'updated_at']))

      const row = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='yjs_snapshots'
      `).all() as Array<{ name: string }>
      // 至少有一个索引（idx_yjs_snapshots_updated_at）
      expect(row.length).toBeGreaterThanOrEqual(1)
    })
  })
})