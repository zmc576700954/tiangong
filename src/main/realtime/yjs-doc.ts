/**
 * Y.Doc 模型与同步层（D10a）
 *
 * 核心职责：
 * 1. 每张图（graph）一个 Y.Doc，键名 `graph:<graphId>`
 * 2. 子结构：
 *    - `nodes: Y.Map<NodeId, Y.Map<key, value>>`
 *    - `edges: Y.Map<EdgeId, Y.Map<key, value>>`
 *    - `meta:  Y.Map<key, value>`  (graph 元数据)
 * 3. 双向同步：
 *    - SQLite → Y.Doc：通过 `mirrorNode*` / `mirrorEdge*` 在 repository 写入后回放
 *    - Y.Doc  → SQLite：通过 `applyRemoteUpdate` 把远端 binary update 解码后落库
 *
 * 设计要点：
 * - SQLite 仍是 source of truth，Y.Doc 是镜像。任何现有 IPC 写入路径无需修改。
 * - Y.Doc 在首次访问时 lazy 创建；`disposeAll` 在应用退出时清理。
 * - 写入 Y.Doc 时包在 `doc.transact()` 内，确保一组操作对外部订阅者表现为原子事件。
 * - `Y.Map<key, value>` 的 value 用 plain JS object（不是嵌套 Y.Map），简化 IPC 序列化与 SQLite round-trip。
 */

import * as Y from 'yjs'
import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode, GraphEdge, GraphType } from '@shared/types'
import { NodeRepository } from '../repositories/node-repository'
import { EdgeRepository } from '../repositories/edge-repository'
import { assertGraphType } from '@shared/type-guards'
import { createLogger } from '../shared/logger'

const logger = createLogger('YjsDoc')

/** Y.Doc 顶层 Y.Map 的命名（doc 内） */
const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'
const META_KEY = 'meta'

/** doc 名称前缀；远端 WS client 寻址时使用 `graph:<graphId>` */
export function docNameForGraph(graphId: string): string {
  return `graph:${graphId}`
}

/** 从 doc 名解析 graph id；非 `graph:` 前缀返回 null */
export function graphIdFromDocName(name: string): string | null {
  if (!name.startsWith('graph:')) return null
  return name.slice('graph:'.length)
}

/** Y.Doc 注册表（按 graphId 索引 Y.Doc 实例） */
interface DocEntry {
  doc: Y.Doc
  /** 用于在收到 update 后抑制 mirror 回写导致的双向循环 */
  isApplyingRemote: boolean
}

export class YjsDocRegistry {
  private docs = new Map<string, DocEntry>()
  /** 监听器：graphId → 订阅者列表（Y.Doc 的二进制 update 流） */
  private listeners = new Map<string, Set<(update: Uint8Array, origin: unknown) => void>>()
  /** 远端 update → SQLite 的订阅；用于把 WS client 的写落库 */
  private remoteSubscribers = new Map<string, Set<(kind: 'node' | 'edge', action: 'create' | 'update' | 'delete', payload: Record<string, unknown>) => void>>()

  constructor(private db: BetterSqlite3.Database) {
    // 仓库持有 db 句柄；不在构造时实例化，按需延迟创建
  }

  /** 获取或创建某图的 Y.Doc。可选 hydrate：从 SQLite 灌入初始数据。 */
  getOrCreateDoc(graphId: string, options?: { hydrate?: boolean }): Y.Doc {
    let entry = this.docs.get(graphId)
    if (entry) return entry.doc

    entry = this.createDocEntry(graphId)

    if (options?.hydrate) {
      try {
        this.hydrateFromSqlite(graphId)
      } catch (err) {
        logger.error('Failed to hydrate Y.Doc for graph', graphId, err)
      }
    }

    return entry.doc
  }

  /** 内部：创建 DocEntry 并挂监听器（不做 hydrate）。 */
  private createDocEntry(graphId: string): DocEntry {
    const doc = new Y.Doc()
    // 确保顶层三个 Y.Map 存在（getMap 触发 lazy 创建）
    doc.getMap(NODES_KEY)
    doc.getMap(EDGES_KEY)
    doc.getMap(META_KEY)

    const entry: DocEntry = { doc, isApplyingRemote: false }

    // 每次本地/远端修改后，把 binary update 转发给监听者
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const subs = this.listeners.get(graphId)
      if (!subs || subs.size === 0) return
      for (const cb of subs) {
        try {
          cb(update, origin)
        } catch (err) {
          logger.error('Doc listener threw for graph', graphId, err)
        }
      }
    })

    this.docs.set(graphId, entry)
    return entry
  }

  /** 检查 graphId 是否已存在 Y.Doc */
  hasDoc(graphId: string): boolean {
    return this.docs.has(graphId)
  }

  /** 释放某图 Y.Doc（应用关闭或 graph 删除时调用） */
  disposeDoc(graphId: string): void {
    const entry = this.docs.get(graphId)
    if (!entry) return
    try {
      entry.doc.destroy()
    } catch (err) {
      logger.warn('Failed to destroy Y.Doc for graph', graphId, err)
    }
    this.docs.delete(graphId)
    this.listeners.delete(graphId)
    this.remoteSubscribers.delete(graphId)
  }

  /** 释放所有 Y.Doc */
  disposeAll(): void {
    for (const graphId of [...this.docs.keys()]) {
      this.disposeDoc(graphId)
    }
  }

  /** 当前缓存的 doc 数量（测试 / 健康检查用） */
  size(): number {
    return this.docs.size
  }

  /** 从 SQLite 把节点 + 边 + graph 元数据灌入 Y.Doc。
   *  在同一 transact 内一次性写入，避免外部监听者看到中间态。 */
  hydrateFromSqlite(graphId: string): void {
    const entry = this.docs.get(graphId)
    if (!entry) {
      throw new Error(`Y.Doc not found for graph ${graphId}; call getOrCreateDoc first`)
    }
    const { doc } = entry

    const nodeRepo = new NodeRepository(this.db)
    const edgeRepo = new EdgeRepository(this.db)

    const nodes = nodeRepo.listByGraph(graphId)
    const edges = edgeRepo.listByGraph(graphId)
    // 直接读 graphs 表，避免 GraphRepository.get() 触发的关联查询（bug_nodes 等）
    const graphRow = this.db
      .prepare('SELECT id, name, type, project_path, created_at, updated_at FROM graphs WHERE id = ?')
      .get(graphId) as Record<string, unknown> | undefined

    doc.transact(() => {
      const nodesMap = doc.getMap(NODES_KEY) as Y.Map<Y.Map<unknown>>
      const edgesMap = doc.getMap(EDGES_KEY) as Y.Map<Y.Map<unknown>>
      const metaMap = doc.getMap(META_KEY) as Y.Map<unknown>

      // 清空（避免重复 hydrate 时残留旧数据）
      nodesMap.clear()
      edgesMap.clear()
      metaMap.clear()

      for (const node of nodes) {
        nodesMap.set(node.id, nodeToYMap(doc, node))
      }
      for (const edge of edges) {
        edgesMap.set(edge.id, edgeToYMap(doc, edge))
      }
      if (graphRow) {
        metaMap.set('id', String(graphRow.id))
        metaMap.set('name', String(graphRow.name))
        metaMap.set('type', assertGraphType(String(graphRow.type)) satisfies GraphType)
        metaMap.set('projectPath', graphRow.project_path ?? null)
        metaMap.set('createdAt', String(graphRow.created_at))
        metaMap.set('updatedAt', String(graphRow.updated_at))
      }
    }, 'hydrate')
  }

  // ============================================================
  // SQLite → Y.Doc（mirror 方向）
  // ============================================================

  /** 镜像一个 node 的全部字段到 Y.Doc。doc 不存在则惰性创建（不 hydrate）。
   *  用于 repository 写入后回调。 */
  mirrorNodeUpsert(node: GraphNode): void {
    const doc = this.getOrCreateDoc(node.graphId)
    doc.transact(() => {
      const nodesMap = doc.getMap(NODES_KEY) as Y.Map<Y.Map<unknown>>
      let inner = nodesMap.get(node.id)
      if (!inner) {
        inner = new Y.Map<unknown>()
        nodesMap.set(node.id, inner)
      }
      applyNodeFields(inner, node)
    }, 'mirror-node-upsert')
  }

  /** 批量镜像节点位置（事务一次性写入以减少 update 事件数） */
  mirrorNodePositions(updates: Array<{ id: string; x: number; y: number; graphId: string }>): void {
    if (updates.length === 0) return
    // 按 graphId 分组（同一图的写在同一个 Y.Doc 内）
    const byGraph = new Map<string, Array<{ id: string; x: number; y: number }>>()
    for (const u of updates) {
      const list = byGraph.get(u.graphId) ?? []
      list.push({ id: u.id, x: u.x, y: u.y })
      byGraph.set(u.graphId, list)
    }
    for (const [graphId, items] of byGraph) {
      const doc = this.getOrCreateDoc(graphId)
      doc.transact(() => {
        const nodesMap = doc.getMap(NODES_KEY) as Y.Map<Y.Map<unknown>>
        for (const item of items) {
          const inner = nodesMap.get(item.id)
          if (!inner) continue // 节点不存在（异常路径）；不自动创建空节点
          inner.set('position', { x: item.x, y: item.y })
          inner.set('updatedAt', new Date().toISOString())
        }
      }, 'mirror-positions')
    }
  }

  /** 镜像节点删除 */
  mirrorNodeDelete(graphId: string, nodeId: string): void {
    const entry = this.docs.get(graphId)
    if (!entry) return
    const { doc } = entry
    doc.transact(() => {
      const nodesMap = doc.getMap(NODES_KEY) as Y.Map<Y.Map<unknown>>
      nodesMap.delete(nodeId)
    }, 'mirror-node-delete')
  }

  /** 镜像边创建 / 更新 */
  mirrorEdgeUpsert(edge: GraphEdge): void {
    const doc = this.getOrCreateDoc(edge.graphId)
    doc.transact(() => {
      const edgesMap = doc.getMap(EDGES_KEY) as Y.Map<Y.Map<unknown>>
      let inner = edgesMap.get(edge.id)
      if (!inner) {
        inner = new Y.Map<unknown>()
        edgesMap.set(edge.id, inner)
      }
      applyEdgeFields(inner, edge)
    }, 'mirror-edge-upsert')
  }

  /** 镜像边删除 */
  mirrorEdgeDelete(graphId: string, edgeId: string): void {
    const entry = this.docs.get(graphId)
    if (!entry) return
    const { doc } = entry
    doc.transact(() => {
      const edgesMap = doc.getMap(EDGES_KEY) as Y.Map<Y.Map<unknown>>
      edgesMap.delete(edgeId)
    }, 'mirror-edge-delete')
  }

  // ============================================================
  // Y.Doc → SQLite（远端 write-back 方向）
  // ============================================================

  /**
   * 把一个 Y.Doc 的二进制 update 应用到 doc，并把触发的"实质修改"翻译为
   * 远端订阅事件（远端 → SQLite 落库）。返回是否产生了任何修改。
   *
   * 使用方式：WS server 在收到 client 的 sync message 后，调用此方法。
   * `origin` 参数原样传给订阅者；用 `origin = { source: 'remote', clientId }`
   * 区分远端/本地起源。
   *
   * 注意：Y.Map.observe 在事务内逐 key 触发，event.changes 提供
   * `{ action: 'added' | 'updated' | 'deleted'; oldValue }` 信息。
   */
  applyRemoteUpdate(
    graphId: string,
    update: Uint8Array,
    origin: unknown,
  ): { changed: boolean; deltas: Array<{ kind: 'node' | 'edge'; action: 'create' | 'update' | 'delete'; id: string; data?: Record<string, unknown> }> } {
    const docEntry = this.docs.get(graphId) ?? this.createDocEntry(graphId)
    const { doc } = docEntry
    const nodesMap = doc.getMap(NODES_KEY) as Y.Map<Y.Map<unknown>>
    const edgesMap = doc.getMap(EDGES_KEY) as Y.Map<Y.Map<unknown>>
    const deltas: Array<{ kind: 'node' | 'edge'; action: 'create' | 'update' | 'delete'; id: string; data?: Record<string, unknown> }> = []

    const nodeObserver = (ev: Y.YMapEvent<Y.Map<unknown>>) => {
      for (const [key, change] of ev.keys.entries()) {
        const inner = nodesMap.get(key)
        if (change.action === 'delete' || !inner || inner.size === 0) {
          deltas.push({ kind: 'node', action: 'delete', id: key })
        } else if (change.action === 'add') {
          deltas.push({ kind: 'node', action: 'create', id: key, data: yMapToObject(inner) })
        } else {
          deltas.push({ kind: 'node', action: 'update', id: key, data: yMapToObject(inner) })
        }
      }
    }
    const edgeObserver = (ev: Y.YMapEvent<Y.Map<unknown>>) => {
      for (const [key, change] of ev.keys.entries()) {
        const inner = edgesMap.get(key)
        if (change.action === 'delete' || !inner || inner.size === 0) {
          deltas.push({ kind: 'edge', action: 'delete', id: key })
        } else if (change.action === 'add') {
          deltas.push({ kind: 'edge', action: 'create', id: key, data: yMapToObject(inner) })
        } else {
          deltas.push({ kind: 'edge', action: 'update', id: key, data: yMapToObject(inner) })
        }
      }
    }

    nodesMap.observe(nodeObserver)
    edgesMap.observe(edgeObserver)
    docEntry.isApplyingRemote = true
    try {
      Y.applyUpdate(doc, update, origin)
    } finally {
      docEntry.isApplyingRemote = false
      nodesMap.unobserve(nodeObserver)
      edgesMap.unobserve(edgeObserver)
    }

    if (deltas.length === 0) return { changed: false, deltas }

    // 通知远程订阅者（由调用方决定是否写 SQLite）
    const remoteSubs = this.remoteSubscribers.get(graphId)
    if (remoteSubs) {
      for (const d of deltas) {
        for (const cb of remoteSubs) {
          try {
            cb(d.kind, d.action, d.data ?? {})
          } catch (err) {
            logger.error('Remote subscriber threw for graph', graphId, err)
          }
        }
      }
    }

    return { changed: true, deltas }
  }

  /** 订阅某图的二进制 update 流（WS server 用） */
  onDocUpdate(graphId: string, callback: (update: Uint8Array, origin: unknown) => void): () => void {
    const set = this.listeners.get(graphId) ?? new Set()
    set.add(callback)
    this.listeners.set(graphId, set)
    return () => {
      set.delete(callback)
    }
  }

  /** 订阅远端写入（用于写回 SQLite） */
  onRemoteChange(graphId: string, callback: (kind: 'node' | 'edge', action: 'create' | 'update' | 'delete', payload: Record<string, unknown>) => void): () => void {
    const set = this.remoteSubscribers.get(graphId) ?? new Set()
    set.add(callback)
    this.remoteSubscribers.set(graphId, set)
    return () => {
      set.delete(callback)
    }
  }

  /** 读取 Y.Doc 当前状态（调试 / 快照 / 测试用） */
  getDocStateVector(graphId: string): Uint8Array | null {
    const entry = this.docs.get(graphId)
    if (!entry) return null
    return Y.encodeStateVector(entry.doc)
  }

  /** 读取 Y.Doc 完整二进制 update（快照 / 持久化用） */
  encodeDocState(graphId: string): Uint8Array | null {
    const entry = this.docs.get(graphId)
    if (!entry) return null
    return Y.encodeStateAsUpdate(entry.doc)
  }
}

// ============================================================
// Helpers（模块私有，不导出）
// ============================================================

/** 把 node 对象写入新创建的 Y.Map（不创建外层 map） */
function nodeToYMap(_doc: Y.Doc, node: GraphNode): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  applyNodeFields(m, node)
  return m
}

function edgeToYMap(_doc: Y.Doc, edge: GraphEdge): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  applyEdgeFields(m, edge)
  return m
}

/** 把 GraphNode 字段映射到 Y.Map（用于 mirror 写入） */
function applyNodeFields(m: Y.Map<unknown>, node: GraphNode): void {
  m.set('id', node.id)
  m.set('type', node.type)
  m.set('status', node.status)
  m.set('title', node.title)
  m.set('description', node.description ?? null)
  m.set('acceptanceCriteria', node.acceptanceCriteria ?? null)
  m.set('graphId', node.graphId)
  m.set('graphType', node.graphType)
  m.set('parentId', node.parentId ?? null)
  m.set('rules', node.rules ?? null)
  m.set('metadata', node.metadata ?? null)
  m.set('ownerRole', node.ownerRole ?? null)
  m.set('position', { x: node.position.x, y: node.position.y })
  m.set('content', node.content ?? null)
  m.set('communitySummary', node.communitySummary ?? null)
  m.set('communityLevel', node.communityLevel ?? null)
  m.set('communityId', node.communityId ?? null)
  m.set('contextRefs', node.contextRefs ?? null)
  m.set('wikiContent', node.wikiContent ?? null)
  m.set('wikiMeta', node.wikiMeta ?? null)
  m.set('createdAt', node.createdAt)
  m.set('updatedAt', node.updatedAt)
}

/** 把 GraphEdge 字段映射到 Y.Map */
function applyEdgeFields(m: Y.Map<unknown>, edge: GraphEdge): void {
  m.set('id', edge.id)
  m.set('source', edge.source)
  m.set('target', edge.target)
  m.set('label', edge.label ?? null)
  m.set('graphId', edge.graphId)
  m.set('edgeType', edge.edgeType ?? null)
  m.set('description', edge.description ?? null)
  m.set('dataFlow', edge.dataFlow ?? null)
  m.set('strength', edge.strength ?? null)
  m.set('content', edge.content ?? null)
}

/** 把 Y.Map 转回普通对象（用于远端 write-back 时传递） */
export function yMapToObject(m: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of m.entries()) {
    out[k] = v
  }
  return out
}

/** 把普通对象转换成 GraphNode 字段（远端 write-back 时使用）。
 *  缺失字段用 null/undefined；调用方负责字段完整性与状态机校验。 */
export function objectToNodeShape(obj: Record<string, unknown>): Partial<GraphNode> {
  return obj as Partial<GraphNode>
}

export function objectToEdgeShape(obj: Record<string, unknown>): Partial<GraphEdge> {
  return obj as Partial<GraphEdge>
}
