/**
 * D10a: Yjs 文档模型与同步 — 单元测试
 *
 * 覆盖以下场景（≥ 8 个 case）：
 * 1. 首次 getOrCreateDoc 创建 Y.Doc，含三个顶层 Y.Map
 * 2. 重复 getOrCreateDoc 返回同一实例
 * 3. 每个 graphId 独立持有 Y.Doc
 * 4. SQLite → Y.Doc：节点 / 边 / meta hydrate
 * 5. SQLite → Y.Doc：节点 insert 镜像到 Y.Doc
 * 6. SQLite → Y.Doc：节点 update 镜像字段
 * 7. SQLite → Y.Doc：节点 delete 镜像删除
 * 8. SQLite → Y.Doc：批量位置更新
 * 9. 远端 update → SQLite：applyRemoteUpdate 触发 deltas → manager 写库
 * 10. 远端 update → SQLite：状态机校验失败时拒绝
 * 11. 远端 update → SQLite：wiki-link 边被拒绝
 * 12. CRDT 收敛：并发 update 后两份 doc 状态相同
 * 13. disposeDoc 清理
 * 14. onDocUpdate 监听器收到二进制 update
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import BetterSqlite3 from 'better-sqlite3'
import { YjsDocRegistry, docNameForGraph, graphIdFromDocName, yMapToObject } from '../yjs-doc'
import { YjsManager, createYjsManager } from '../yjs-manager'
import { NodeRepository } from '../../repositories/node-repository'
import { EdgeRepository } from '../../repositories/edge-repository'
import { generateId } from '../../shared/env'

// 内存 SQLite，避免文件系统依赖
function createInMemoryDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:')
  // 启用外键约束
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

function applySchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('online', 'dev')),
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
  `)
}

function createGraph(db: BetterSqlite3.Database, type: 'online' | 'dev' = 'online'): string {
  const id = generateId('graph')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO graphs (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'test-graph', type, now, now)
  return id
}

function makeNodeInput(graphId: string, graphType: 'online' | 'dev' = 'online', overrides: Partial<{
  title: string; type: 'project' | 'module' | 'process' | 'feature' | 'bug' | 'wiki-page'; status: 'draft' | 'confirmed' | 'developing' | 'testing' | 'review' | 'published' | 'placeholder'; x: number; y: number;
}> = {}) {
  return {
    type: (overrides.type ?? 'module') as 'module',
    status: (overrides.status ?? 'draft') as 'draft',
    title: overrides.title ?? 'node-title',
    description: undefined,
    acceptanceCriteria: [],
    graphId,
    graphType,
    parentId: undefined,
    rules: undefined,
    metadata: undefined,
    ownerRole: undefined,
    position: { x: overrides.x ?? 0, y: overrides.y ?? 0 },
    content: undefined,
    communitySummary: undefined,
    communityLevel: undefined,
    communityId: undefined,
    contextRefs: undefined,
    wikiContent: undefined,
    wikiMeta: undefined,
  }
}

describe('YjsDocRegistry', () => {
  let db: BetterSqlite3.Database
  let registry: YjsDocRegistry

  beforeEach(() => {
    db = createInMemoryDb()
    registry = new YjsDocRegistry(db)
  })

  it('首次 getOrCreateDoc 创建 Y.Doc 并包含 nodes/edges/meta 三个顶层 Map', () => {
    const doc = registry.getOrCreateDoc('g1')
    expect(doc).toBeInstanceOf(Y.Doc)
    expect(doc.getMap('nodes').size).toBe(0)
    expect(doc.getMap('edges').size).toBe(0)
    expect(doc.getMap('meta').size).toBe(0)
    expect(registry.size()).toBe(1)
  })

  it('重复 getOrCreateDoc 返回同一 Y.Doc 实例', () => {
    const a = registry.getOrCreateDoc('g1')
    const b = registry.getOrCreateDoc('g1')
    expect(a).toBe(b)
    expect(registry.size()).toBe(1)
  })

  it('不同 graphId 持有独立 Y.Doc', () => {
    const a = registry.getOrCreateDoc('g1')
    const b = registry.getOrCreateDoc('g2')
    expect(a).not.toBe(b)

    const nodesA = a.getMap('nodes') as Y.Map<Y.Map<unknown>>
    const inner = new Y.Map<unknown>()
    inner.set('title', 'A')
    nodesA.set('n1', inner)

    expect(b.getMap('nodes').size).toBe(0)
  })

  it('disposeDoc 清理 doc、listeners、订阅者', () => {
    registry.getOrCreateDoc('g1')
    registry.onDocUpdate('g1', () => {})
    registry.onRemoteChange('g1', () => {})
    expect(registry.hasDoc('g1')).toBe(true)
    registry.disposeDoc('g1')
    expect(registry.hasDoc('g1')).toBe(false)
    expect(registry.size()).toBe(0)
  })

  it('docNameForGraph 与 graphIdFromDocName 互逆', () => {
    expect(docNameForGraph('abc')).toBe('graph:abc')
    expect(graphIdFromDocName('graph:abc')).toBe('abc')
    expect(graphIdFromDocName('not-prefix')).toBeNull()
  })
})

describe('YjsDocRegistry — hydrateFromSqlite', () => {
  let db: BetterSqlite3.Database
  let nodeRepo: NodeRepository
  let edgeRepo: EdgeRepository
  let registry: YjsDocRegistry

  beforeEach(() => {
    db = createInMemoryDb()
    nodeRepo = new NodeRepository(db)
    edgeRepo = new EdgeRepository(db)
    registry = new YjsDocRegistry(db)
  })

  it('从 SQLite hydrate 节点 / 边 / graph 元数据到 Y.Doc', () => {
    const graphId = createGraph(db)
    const n1 = nodeRepo.create(makeNodeInput(graphId, 'online', { title: 'n1', x: 1, y: 2 }))
    const n2 = nodeRepo.create(makeNodeInput(graphId, 'online', { title: 'n2' }))
    edgeRepo.create({ source: n1.id, target: n2.id, graphId, label: 'e1' })

    const doc = registry.getOrCreateDoc(graphId, { hydrate: true })
    const nodesY = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>
    const edgesY = doc.getMap('edges') as Y.Map<Y.Map<unknown>>
    const metaY = doc.getMap('meta') as Y.Map<unknown>

    expect(nodesY.size).toBe(2)
    expect(nodesY.get(n1.id)?.get('title')).toBe('n1')
    expect(nodesY.get(n1.id)?.get('position')).toEqual({ x: 1, y: 2 })
    expect(edgesY.size).toBe(1)
    const edges = edgeRepo.listByGraph(graphId)
    expect(edgesY.get(edges[0].id)?.get('label')).toBe('e1')
    expect(metaY.get('id')).toBe(graphId)
    expect(metaY.get('type')).toBe('online')
  })
})

describe('YjsDocRegistry — SQLite → Y.Doc mirror', () => {
  let db: BetterSqlite3.Database
  let nodeRepo: NodeRepository
  let edgeRepo: EdgeRepository
  let registry: YjsDocRegistry

  beforeEach(() => {
    db = createInMemoryDb()
    nodeRepo = new NodeRepository(db)
    edgeRepo = new EdgeRepository(db)
    registry = new YjsDocRegistry(db)
  })

  it('节点 insert 镜像到 Y.Doc', () => {
    const graphId = createGraph(db)
    const node = nodeRepo.create(makeNodeInput(graphId, 'online', { title: 'hello' }))
    registry.mirrorNodeUpsert(node)

    const doc = registry.getOrCreateDoc(graphId)
    const inner = (doc.getMap('nodes') as Y.Map<Y.Map<unknown>>).get(node.id)
    expect(inner?.get('title')).toBe('hello')
    expect(inner?.get('status')).toBe('draft')
  })

  it('节点 update 镜像新字段', () => {
    const graphId = createGraph(db)
    const node = nodeRepo.create(makeNodeInput(graphId, 'online', { title: 'old' }))
    registry.mirrorNodeUpsert(node)

    const updated = nodeRepo.update(node.id, { title: 'new', status: 'confirmed' })
    registry.mirrorNodeUpsert(updated)

    const doc = registry.getOrCreateDoc(graphId)
    const inner = (doc.getMap('nodes') as Y.Map<Y.Map<unknown>>).get(node.id)
    expect(inner?.get('title')).toBe('new')
    expect(inner?.get('status')).toBe('confirmed')
  })

  it('节点 delete 镜像删除', () => {
    const graphId = createGraph(db)
    const node = nodeRepo.create(makeNodeInput(graphId))
    registry.mirrorNodeUpsert(node)
    nodeRepo.delete(node.id)
    registry.mirrorNodeDelete(graphId, node.id)

    const doc = registry.getOrCreateDoc(graphId)
    expect((doc.getMap('nodes') as Y.Map<Y.Map<unknown>>).has(node.id)).toBe(false)
  })

  it('批量位置更新在同一事务内更新多节点', () => {
    const graphId = createGraph(db)
    const a = nodeRepo.create(makeNodeInput(graphId, 'online', { x: 0, y: 0 }))
    const b = nodeRepo.create(makeNodeInput(graphId, 'online', { x: 0, y: 0 }))
    registry.mirrorNodeUpsert(a)
    registry.mirrorNodeUpsert(b)

    const updates = [
      { id: a.id, x: 10, y: 20, graphId },
      { id: b.id, x: 30, y: 40, graphId },
    ]
    nodeRepo.batchUpdatePositions(updates.map(({ id, x, y }) => ({ id, x, y })))
    registry.mirrorNodePositions(updates)

    const doc = registry.getOrCreateDoc(graphId)
    const nodesY = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>
    expect(nodesY.get(a.id)?.get('position')).toEqual({ x: 10, y: 20 })
    expect(nodesY.get(b.id)?.get('position')).toEqual({ x: 30, y: 40 })
  })

  it('边 insert / delete 镜像', () => {
    const graphId = createGraph(db)
    const src = nodeRepo.create(makeNodeInput(graphId))
    const tgt = nodeRepo.create(makeNodeInput(graphId))
    const edge = edgeRepo.create({ source: src.id, target: tgt.id, graphId, label: 'flow' })
    registry.mirrorEdgeUpsert(edge)
    expect((registry.getOrCreateDoc(graphId).getMap('edges') as Y.Map<Y.Map<unknown>>).get(edge.id)?.get('label')).toBe('flow')

    edgeRepo.delete(edge.id)
    registry.mirrorEdgeDelete(graphId, edge.id)
    expect((registry.getOrCreateDoc(graphId).getMap('edges') as Y.Map<Y.Map<unknown>>).has(edge.id)).toBe(false)
  })
})

describe('YjsDocRegistry — Y.Doc → SQLite (applyRemoteUpdate)', () => {
  let db: BetterSqlite3.Database
  let nodeRepo: NodeRepository
  let edgeRepo: EdgeRepository
  let registry: YjsDocRegistry
  let manager: YjsManager

  beforeEach(() => {
    db = createInMemoryDb()
    nodeRepo = new NodeRepository(db)
    edgeRepo = new EdgeRepository(db)
    registry = new YjsDocRegistry(db)
    manager = new YjsManager({ db, nodeRepo, edgeRepo })
    manager.bindRegistry(registry)
  })

  it('远端 update → deltas → manager 落库（节点 create）', () => {
    const graphId = createGraph(db)
    manager.attachGraphRemoteListener(graphId)

    // 模拟远端 client：构造一个临时 Y.Doc，写入节点，生成 update，应用到主 doc
    const remoteDoc = new Y.Doc()
    const remoteNodes = remoteDoc.getMap('nodes') as Y.Map<Y.Map<unknown>>
    const inner = new Y.Map<unknown>()
    const nodeInput = makeNodeInput(graphId, 'online', { title: 'remote-node' })
    Object.entries({
      id: 'remote-id-1',
      type: nodeInput.type,
      status: nodeInput.status,
      title: nodeInput.title,
      graphId,
      graphType: 'online',
      position: { x: 0, y: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).forEach(([k, v]) => inner.set(k, v))
    remoteNodes.set('remote-id-1', inner)
    const update = Y.encodeStateAsUpdate(remoteDoc)

    const result = manager.applyRemoteUpdate(graphId, update, { source: 'remote' })
    expect(result.changed).toBe(true)

    const persisted = nodeRepo.findById('remote-id-1')
    expect(persisted).not.toBeNull()
    expect(persisted?.title).toBe('remote-node')
  })

  it('远端 update 包含 wiki-link edge → 拒绝落库', () => {
    const graphId = createGraph(db)
    const src = nodeRepo.create(makeNodeInput(graphId))
    const tgt = nodeRepo.create(makeNodeInput(graphId))
    manager.attachGraphRemoteListener(graphId)

    const remoteDoc = new Y.Doc()
    const remoteEdges = remoteDoc.getMap('edges') as Y.Map<Y.Map<unknown>>
    const inner = new Y.Map<unknown>()
    inner.set('id', 'remote-edge-1')
    inner.set('source', src.id)
    inner.set('target', tgt.id)
    inner.set('graphId', graphId)
    inner.set('edgeType', 'wiki-link')
    remoteEdges.set('remote-edge-1', inner)
    const update = Y.encodeStateAsUpdate(remoteDoc)

    manager.applyRemoteUpdate(graphId, update, { source: 'remote' })
    expect(edgeRepo.listByGraph(graphId)).toHaveLength(0)
  })

  it('状态机非法转换（draft → published）→ 拒绝', () => {
    const graphId = createGraph(db)
    const n = nodeRepo.create(makeNodeInput(graphId, 'online', { status: 'draft' }))
    manager.attachGraphRemoteListener(graphId)

    const remoteDoc = new Y.Doc()
    const remoteNodes = remoteDoc.getMap('nodes') as Y.Map<Y.Map<unknown>>
    const inner = new Y.Map<unknown>()
    inner.set('id', n.id)
    inner.set('type', 'module')
    inner.set('status', 'published') // 非法：draft 不能直接到 published
    inner.set('title', 'updated')
    inner.set('graphId', graphId)
    inner.set('graphType', 'online')
    inner.set('position', { x: 0, y: 0 })
    inner.set('createdAt', n.createdAt)
    inner.set('updatedAt', new Date().toISOString())
    remoteNodes.set(n.id, inner)
    const update = Y.encodeStateAsUpdate(remoteDoc)

    manager.applyRemoteUpdate(graphId, update, { source: 'remote' })
    const after = nodeRepo.findById(n.id)
    expect(after?.status).toBe('draft') // 未被远端覆盖
  })

  it('远端 update → deltas 事件总线通知', () => {
    const graphId = createGraph(db)
    manager.attachGraphRemoteListener(graphId)
    const events: Array<{ kind: string; action: string; id: string }> = []
    manager.onSync((e) => events.push({ kind: e.kind, action: e.action, id: e.id }))

    const remoteDoc = new Y.Doc()
    const inner = new Y.Map<unknown>()
    inner.set('id', 'evt-1')
    inner.set('type', 'module')
    inner.set('status', 'draft')
    inner.set('title', 'eventbus')
    inner.set('graphId', graphId)
    inner.set('graphType', 'online')
    inner.set('position', { x: 0, y: 0 })
    inner.set('createdAt', new Date().toISOString())
    inner.set('updatedAt', new Date().toISOString())
    ;(remoteDoc.getMap('nodes') as Y.Map<Y.Map<unknown>>).set('evt-1', inner)
    manager.applyRemoteUpdate(graphId, Y.encodeStateAsUpdate(remoteDoc), { source: 'remote' })

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.id === 'evt-1')).toBe(true)
  })
})

describe('YjsDocRegistry — CRDT convergence', () => {
  it('两个独立 Y.Doc 互相交换 update 后状态相同', () => {
    const db = createInMemoryDb()
    const registryA = new YjsDocRegistry(db)
    const registryB = new YjsDocRegistry(db)

    const docA = registryA.getOrCreateDoc('g1')
    const docB = registryB.getOrCreateDoc('g1')

    const nodesA = docA.getMap('nodes') as Y.Map<Y.Map<unknown>>
    const nodesB = docB.getMap('nodes') as Y.Map<Y.Map<unknown>>

    // A 写入 n1
    const innerA = new Y.Map<unknown>()
    innerA.set('title', 'from-A')
    nodesA.set('n1', innerA)

    // B 写入 n2（不同 key，互不冲突）
    const innerB = new Y.Map<unknown>()
    innerB.set('title', 'from-B')
    nodesB.set('n2', innerB)

    // 互相交换 update
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))

    // 双方都应同时看到 n1 和 n2
    expect(nodesA.size).toBe(2)
    expect(nodesB.size).toBe(2)
    expect(nodesA.get('n1')?.get('title')).toBe('from-A')
    expect(nodesA.get('n2')?.get('title')).toBe('from-B')
    expect(nodesB.get('n1')?.get('title')).toBe('from-A')
    expect(nodesB.get('n2')?.get('title')).toBe('from-B')
  })

  it('onDocUpdate 监听器收到二进制 update', () => {
    const db = createInMemoryDb()
    const registry = new YjsDocRegistry(db)
    const received: Uint8Array[] = []
    registry.onDocUpdate('g1', (update) => {
      received.push(update)
    })

    const doc = registry.getOrCreateDoc('g1')
    const inner = new Y.Map<unknown>()
    inner.set('title', 'trigger')
    ;(doc.getMap('nodes') as Y.Map<Y.Map<unknown>>).set('n1', inner)

    expect(received.length).toBeGreaterThan(0)
    expect(received[0]).toBeInstanceOf(Uint8Array)
    expect(received[0].length).toBeGreaterThan(0)
  })
})

describe('yMapToObject', () => {
  it('把 Y.Map 转为普通对象', () => {
    // Y.Map 必须挂到 Y.Doc 才能读到值
    const doc = new Y.Doc()
    const m = doc.getMap('test') as Y.Map<unknown>
    m.set('a', 1)
    m.set('b', 'two')
    const obj = yMapToObject(m)
    expect(obj).toEqual({ a: 1, b: 'two' })
  })
})

describe('createYjsManager 工厂', () => {
  it('返回已绑定的 registry 和 manager', () => {
    const db = createInMemoryDb()
    const nodeRepo = new NodeRepository(db)
    const edgeRepo = new EdgeRepository(db)
    const { registry, manager } = createYjsManager({ db, nodeRepo, edgeRepo })

    expect(registry).toBeInstanceOf(YjsDocRegistry)
    expect(manager).toBeInstanceOf(YjsManager)
    // 验证绑定：manager.mirrorNodeUpsert 应可用（不抛错）
    const graphId = createGraph(db)
    const n = nodeRepo.create(makeNodeInput(graphId))
    expect(() => manager.onAfterNodeUpsert(n)).not.toThrow()
  })
})
