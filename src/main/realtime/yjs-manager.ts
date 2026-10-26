/**
 * Yjs 同步管理器（D10a）
 *
 * 把 `YjsDocRegistry` 绑定到现有 NodeRepository / EdgeRepository：
 * - repository 写操作触发 SQLite → Y.Doc 的镜像
 * - 远端（WS）写入通过 `applyRemoteUpdate` 落回 SQLite（带状态机校验）
 *
 * 这是 D10a 的集成点；不修改 repository 自身的代码（保持向后兼容），
 * 而是把"写后回调"封装成一个 manager，IPC handler 在 `registerGraphHandlers`
 * 中注入并在 repository 调用后调用。
 *
 * 远端 → SQLite 路径：
 * - update 通过 YjsDocRegistry.applyRemoteUpdate 触发 deltas
 * - deltas 经过状态机校验（status 转换）后落库
 * - 落库后 mirror 回 Y.Doc（一次完整往返）
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode, GraphEdge, NodeStatus } from '@shared/types'
import { YjsDocRegistry, yMapToObject } from './yjs-doc'
import type { NodeRepository } from '../repositories/node-repository'
import type { EdgeRepository } from '../repositories/edge-repository'
import { validateNodeTypeTransition } from '@shared/state-machine'
import { createLogger } from '../shared/logger'

const logger = createLogger('YjsManager')

export interface YjsManagerDeps {
  db: BetterSqlite3.Database
  nodeRepo: NodeRepository
  edgeRepo: EdgeRepository
}

export interface YjsSyncEvent {
  kind: 'node' | 'edge'
  action: 'create' | 'update' | 'delete'
  id: string
  data?: Record<string, unknown>
  graphId: string
}

/**
 * 把 YjsDocRegistry 包成对 repository 写入敏感的"镜像桥"。
 *
 * 用法：
 *   const manager = new YjsManager({ db, nodeRepo, edgeRepo })
 *   manager.bindRegistry(registry)
 *   // 注册到 IPC handler 调用：
 *   manager.onAfterNodeUpsert(node)
 *   manager.onAfterNodeDelete(graphId, id)
 */
export class YjsManager {
  private registry: YjsDocRegistry | null = null
  private remoteUnsubs = new Map<string, () => void>()
  /** 事件总线：远端写回 SQLite 后向订阅者广播（UI 刷新 / 状态同步） */
  private syncListeners = new Set<(event: YjsSyncEvent) => void>()

  constructor(private deps: YjsManagerDeps) {}

  /** 注入 registry（在 ipc-handlers 初始化时调用） */
  bindRegistry(registry: YjsDocRegistry): void {
    this.registry = registry
  }

  /** 解除绑定 */
  unbind(): void {
    for (const u of this.remoteUnsubs.values()) {
      try { u() } catch { /* ignore */ }
    }
    this.remoteUnsubs.clear()
    this.registry = null
  }

  /** 订阅同步事件（远端 → 本地的写回完成后触发） */
  onSync(listener: (event: YjsSyncEvent) => void): () => void {
    this.syncListeners.add(listener)
    return () => {
      this.syncListeners.delete(listener)
    }
  }

  // ============================================================
  // 写入后回调（main process repository 调用）
  // ============================================================

  onAfterNodeUpsert(node: GraphNode): void {
    if (!this.registry) return
    this.registry.mirrorNodeUpsert(node)
  }

  onAfterNodeDelete(graphId: string, nodeId: string): void {
    if (!this.registry) return
    this.registry.mirrorNodeDelete(graphId, nodeId)
  }

  onAfterNodeBatchPosition(updates: Array<{ id: string; x: number; y: number; graphId: string }>): void {
    if (!this.registry) return
    this.registry.mirrorNodePositions(updates)
  }

  onAfterEdgeUpsert(edge: GraphEdge): void {
    if (!this.registry) return
    this.registry.mirrorEdgeUpsert(edge)
  }

  onAfterEdgeDelete(graphId: string, edgeId: string): void {
    if (!this.registry) return
    this.registry.mirrorEdgeDelete(graphId, edgeId)
  }

  // ============================================================
  // 远端 → SQLite 写回
  // ============================================================

  /** 为某图建立远端监听器，把 applyRemoteUpdate 的 deltas 落库 */
  attachGraphRemoteListener(graphId: string): void {
    if (!this.registry) return
    if (this.remoteUnsubs.has(graphId)) return

    const unsubscribe = this.registry.onRemoteChange(graphId, (kind, action, payload) => {
      try {
        this.handleRemoteChange(graphId, kind, action, payload)
      } catch (err) {
        logger.error('Remote change handler failed for graph', graphId, err)
      }
    })
    this.remoteUnsubs.set(graphId, unsubscribe)
  }

  detachGraphRemoteListener(graphId: string): void {
    const u = this.remoteUnsubs.get(graphId)
    if (!u) return
    try { u() } catch { /* ignore */ }
    this.remoteUnsubs.delete(graphId)
  }

  /** 在已知图中应用远端二进制 update（WS server 调用） */
  applyRemoteUpdate(graphId: string, update: Uint8Array, origin: unknown): { changed: boolean } {
    if (!this.registry) return { changed: false }
    // 确保图已注册监听器（幂等）
    this.attachGraphRemoteListener(graphId)
    return this.registry.applyRemoteUpdate(graphId, update, origin)
  }

  private handleRemoteChange(
    graphId: string,
    kind: 'node' | 'edge',
    action: 'create' | 'update' | 'delete',
    payload: Record<string, unknown>,
  ): void {
    if (kind === 'node') {
      this.handleRemoteNodeChange(graphId, action, payload)
    } else {
      this.handleRemoteEdgeChange(graphId, action, payload)
    }
  }

  private handleRemoteNodeChange(graphId: string, action: 'create' | 'update' | 'delete', payload: Record<string, unknown>): void {
    const nodeRepo = this.deps.nodeRepo
    if (action === 'delete') {
      const id = String(payload.id ?? '')
      if (!id) return
      try {
        nodeRepo.delete(id)
        this.emit({ kind: 'node', action: 'delete', id, graphId })
      } catch (err) {
        logger.warn('Remote node delete failed:', id, err)
      }
      return
    }

    // create / update：payload 必须包含完整 GraphNode 字段
    const id = String(payload.id ?? '')
    if (!id) return

    // graphId 必须匹配路径（防止 client 伪造）
    if (payload.graphId && payload.graphId !== graphId) {
      logger.warn(`Remote node ${id} graphId mismatch: ${payload.graphId} vs ${graphId}`)
      return
    }

    // 状态机校验：远端写入 status 时必须通过 per-NodeType 矩阵
    if (payload.status !== undefined) {
      try {
        const current = nodeRepo.findById(id)
        if (current) {
          validateNodeTypeTransition(current.type, current.status, payload.status as NodeStatus, id)
        }
      } catch (err) {
        logger.warn(`Remote status transition rejected for node ${id}:`, err)
        return
      }
    }

    try {
      if (action === 'create') {
        const created = this.insertRemoteNode(payload)
        this.emit({ kind: 'node', action: 'create', id, graphId, data: { ...created } as unknown as Record<string, unknown> })
      } else {
        const updated = nodeRepo.update(id, payload as Partial<GraphNode>)
        this.emit({ kind: 'node', action: 'update', id, graphId, data: { ...updated } as unknown as Record<string, unknown> })
      }
    } catch (err) {
      logger.error(`Remote node ${action} failed:`, id, err)
    }
  }

  /**
   * 把远端 node payload 直接 INSERT 到 nodes 表，保留 payload 中的 id（CRDT 语义）。
   * 不复用 NodeRepository.create 因为后者会用 generateId 生成新 id，破坏 CRDT 收敛。
   */
  private insertRemoteNode(payload: Record<string, unknown>): GraphNode {
    const now = new Date().toISOString()
    const node: GraphNode = {
      id: String(payload.id),
      type: payload.type as GraphNode['type'],
      status: payload.status as GraphNode['status'],
      title: String(payload.title ?? ''),
      description: (payload.description as string | undefined) ?? undefined,
      acceptanceCriteria: (payload.acceptanceCriteria as GraphNode['acceptanceCriteria']) ?? [],
      graphId: String(payload.graphId),
      graphType: payload.graphType as GraphNode['graphType'],
      parentId: (payload.parentId as string | undefined) ?? undefined,
      rules: (payload.rules as GraphNode['rules']) ?? undefined,
      metadata: (payload.metadata as GraphNode['metadata']) ?? undefined,
      ownerRole: (payload.ownerRole as GraphNode['ownerRole']) ?? undefined,
      position: (payload.position as GraphNode['position']) ?? { x: 0, y: 0 },
      content: (payload.content as GraphNode['content']) ?? undefined,
      communitySummary: (payload.communitySummary as string | undefined) ?? undefined,
      communityLevel: (payload.communityLevel as number | undefined) ?? undefined,
      communityId: (payload.communityId as string | undefined) ?? undefined,
      contextRefs: (payload.contextRefs as GraphNode['contextRefs']) ?? undefined,
      wikiContent: (payload.wikiContent as string | undefined) ?? undefined,
      wikiMeta: (payload.wikiMeta as GraphNode['wikiMeta']) ?? undefined,
      createdAt: (payload.createdAt as string) ?? now,
      updatedAt: (payload.updatedAt as string) ?? now,
    }

    this.deps.db.prepare(
      `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, rules, metadata, owner_role,
        position_x, position_y, content, community_summary, community_level, community_id,
        context_refs, wiki_content, wiki_meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      node.id,
      node.type,
      node.status,
      node.title,
      node.description ?? null,
      node.acceptanceCriteria ? JSON.stringify(node.acceptanceCriteria) : null,
      node.graphId,
      node.graphType,
      node.parentId ?? null,
      node.rules ? JSON.stringify(node.rules) : null,
      node.metadata ? JSON.stringify(node.metadata) : null,
      node.ownerRole ?? null,
      node.position.x,
      node.position.y,
      node.content ? JSON.stringify(node.content) : null,
      node.communitySummary ?? null,
      node.communityLevel ?? null,
      node.communityId ?? null,
      node.contextRefs ? JSON.stringify(node.contextRefs) : null,
      node.wikiContent ?? null,
      node.wikiMeta ? JSON.stringify(node.wikiMeta) : null,
      node.createdAt,
      node.updatedAt,
    )

    return node
  }

  private handleRemoteEdgeChange(graphId: string, action: 'create' | 'update' | 'delete', payload: Record<string, unknown>): void {
    const edgeRepo = this.deps.edgeRepo
    if (action === 'delete') {
      const id = String(payload.id ?? '')
      if (!id) return
      try {
        edgeRepo.delete(id)
        this.emit({ kind: 'edge', action: 'delete', id, graphId })
      } catch (err) {
        logger.warn('Remote edge delete failed:', id, err)
      }
      return
    }
    const id = String(payload.id ?? '')
    if (!id) return
    if (payload.graphId && payload.graphId !== graphId) {
      logger.warn(`Remote edge ${id} graphId mismatch`)
      return
    }
    // 拒绝远端创建 wiki-link 类型（与本地规则一致：wiki-link 由 WikiLinkService 维护）
    if (action === 'create' && payload.edgeType === 'wiki-link') {
      logger.warn(`Remote wiki-link edge ${id} rejected (managed by WikiLinkService)`)
      return
    }

    try {
      if (action === 'create') {
        const created = edgeRepo.create(payload as unknown as Omit<GraphEdge, 'id'>)
        this.emit({ kind: 'edge', action: 'create', id, graphId, data: { ...created } as unknown as Record<string, unknown> })
      } else {
        const updated = edgeRepo.update(id, payload as Partial<GraphEdge>)
        this.emit({ kind: 'edge', action: 'update', id, graphId, data: { ...updated } as unknown as Record<string, unknown> })
      }
    } catch (err) {
      logger.error(`Remote edge ${action} failed:`, id, err)
    }
  }

  private emit(event: YjsSyncEvent): void {
    for (const cb of this.syncListeners) {
      try {
        cb(event)
      } catch (err) {
        logger.error('Sync listener threw:', err)
      }
    }
  }
}

/** 工厂函数：从 db 构造完整 manager */
export function createYjsManager(deps: YjsManagerDeps): {
  registry: YjsDocRegistry
  manager: YjsManager
} {
  const registry = new YjsDocRegistry(deps.db)
  const manager = new YjsManager(deps)
  manager.bindRegistry(registry)
  return { registry, manager }
}

// 重新导出以便测试使用
export { yMapToObject }
