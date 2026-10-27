/**
 * Node Repository
 * 负责 Node 的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode } from '@shared/types'
import type { NodeStatus } from '@shared/types'
import {
  assertNodeType, assertNodeStatus, assertGraphType,
  isRecord, isStringArray, isUnknownArray,
} from '@shared/type-guards'
import { validateNodeTypeTransition } from '@shared/state-machine'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { isDescendant } from '../shared/hierarchy-utils'
import { DatabaseError, ErrorCode, HierarchyError } from '../errors'

/**
 * 把主进程算出来的兄弟序号写回节点对象。
 *
 * 序号写在 `...data` **之后**：调用方带来的 `data.sortIndex` 只是客户端的期望值，
 * 权威号是主进程算出来的这个（与库里的 `sort_index` 一致）。
 * 根节点没有兄弟 → 序号为空 → **整个键省掉**（不是 null：`null` 既不是 number
 * 也不是 undefined，与 `GraphNode.sortIndex?: number` 不符）。
 */
function withSortIndex(node: GraphNode, sortIndex: number | undefined): GraphNode {
  if (sortIndex === undefined) {
    delete node.sortIndex
    return node
  }
  node.sortIndex = sortIndex
  return node
}

export class NodeRepository {
  constructor(private db: BetterSqlite3.Database) {}

  /** Map a database row to a GraphNode */
  private rowToNode(row: Record<string, unknown>): GraphNode {
    return {
      id: row.id as string,
      type: assertNodeType(row.type as string),
      status: assertNodeStatus(row.status as string),
      title: row.title as string,
      description: row.description as string | undefined,
      acceptanceCriteria: safeJsonParse<GraphNode['acceptanceCriteria']>(row.acceptance_criteria as string | null, [], isStringArray),
      graphId: row.graph_id as string,
      graphType: assertGraphType(row.graph_type as string, 'graphType'),
      parentId: row.parent_id as string | undefined,
      // sort_index 是**可空**列：根节点是 NULL → 映射成 undefined（不是 null）。
      // `as` 只是类型断言，NULL 在运行时仍然是 null —— 必须用 ?? undefined 真转换。
      sortIndex: (row.sort_index as number | null) ?? undefined,
      // collapsed 是 NOT NULL DEFAULT 0 → 读回来是 boolean
      collapsed: row.collapsed === 1,
      rules: safeJsonParse<GraphNode['rules']>(row.rules as string | null, undefined, isUnknownArray),
      metadata: safeJsonParse<GraphNode['metadata']>(row.metadata as string | null, undefined, isRecord),
      contextRefs: safeJsonParse<GraphNode['contextRefs']>(row.context_refs as string | null, undefined, isUnknownArray),
      wikiContent: typeof row.wiki_content === 'string' ? row.wiki_content : undefined,
      wikiMeta: safeJsonParse<GraphNode['wikiMeta']>(row.wiki_meta as string | null, undefined, isRecord),
      ownerRole: row.owner_role as GraphNode['ownerRole'],
      position: { x: row.position_x as number, y: row.position_y as number },
      content: safeJsonParse<GraphNode['content']>(row.content as string | null, undefined, isRecord),
      communitySummary: (row.community_summary as GraphNode['communitySummary']) ?? undefined,
      communityLevel: (row.community_level as GraphNode['communityLevel']) ?? undefined,
      communityId: (row.community_id as GraphNode['communityId']) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } as GraphNode
  }

  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const id = generateId('node')
    const now = new Date().toISOString()

    // 兄弟顺序（spec §4.8）：有父节点 → 该父节点现有子节点中最大的 sort_index + 1；
    // 根节点没有兄弟可言 → sort_index 保持 NULL。
    const parentId = data.parentId ?? null
    const sortIndex = parentId === null ? undefined : this.nextSortIndex(parentId)

    this.db.prepare(
      `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, sort_index, rules, metadata, owner_role,
        position_x, position_y, content, community_summary, community_level, community_id,
        context_refs, wiki_content, wiki_meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.type,
      data.status,
      data.title,
      data.description ?? null,
      data.acceptanceCriteria ? JSON.stringify(data.acceptanceCriteria) : null,
      data.graphId,
      data.graphType,
      parentId,
      sortIndex ?? null,
      data.rules ? JSON.stringify(data.rules) : null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.ownerRole ?? null,
      data.position.x,
      data.position.y,
      data.content ? JSON.stringify(data.content) : null,
      data.communitySummary ?? null,
      data.communityLevel ?? null,
      data.communityId ?? null,
      data.contextRefs ? JSON.stringify(data.contextRefs) : null,
      data.wikiContent ?? null,
      data.wikiMeta ? JSON.stringify(data.wikiMeta) : null,
      now,
      now,
    )

    return withSortIndex({ ...data, id, createdAt: now, updatedAt: now }, sortIndex)
  }

  /** 批量创建节点（事务提交） */
  createBatch(nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]): GraphNode[] {
    if (nodesData.length === 0) return []
    const now = new Date().toISOString()
    const created: GraphNode[] = []

    // 批内兄弟序号（spec §4.8）：同一父节点下的多个节点要拿**连续**的号。
    // 逐个查库会让每个节点都拿到同一个基准值（兄弟顺序就乱了）——
    // 基准每个父节点只查一次，组内按批内出现顺序递增。
    const sortIndexes = this.batchSortIndexes(nodesData)

    const stmt = this.db.prepare(
      `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, sort_index, rules, metadata, owner_role,
        position_x, position_y, content, community_summary, community_level, community_id,
        context_refs, wiki_content, wiki_meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    const insertMany = this.db.transaction((items: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => {
      for (let i = 0; i < items.length; i++) {
        const data = items[i]
        const id = generateId('node')
        const sortIndex = sortIndexes[i]
        created.push(withSortIndex({ ...data, id, createdAt: now, updatedAt: now }, sortIndex))
        stmt.run(
          id,
          data.type,
          data.status,
          data.title,
          data.description ?? null,
          data.acceptanceCriteria ? JSON.stringify(data.acceptanceCriteria) : null,
          data.graphId,
          data.graphType,
          data.parentId ?? null,
          sortIndex ?? null,
          data.rules ? JSON.stringify(data.rules) : null,
          data.metadata ? JSON.stringify(data.metadata) : null,
          data.ownerRole ?? null,
          data.position.x,
          data.position.y,
          data.content ? JSON.stringify(data.content) : null,
          data.communitySummary ?? null,
          data.communityLevel ?? null,
          data.communityId ?? null,
          data.contextRefs ? JSON.stringify(data.contextRefs) : null,
          data.wikiContent ?? null,
          data.wikiMeta ? JSON.stringify(data.wikiMeta) : null,
          now,
          now,
        )
      }
    })

    insertMany(nodesData)
    return created
  }

  /**
   * 目标父节点下的下一个兄弟序号 = 现有子节点里最大的 sort_index + 1（spec §4.8）。
   *
   * COALESCE 不能省：兄弟全是 NULL 时 MAX 返回 NULL，而 NULL + 1 在 SQLite 里
   * 仍是 NULL —— 新节点会落进布局「undefined 排最后」的兜底里，位置不确定。
   */
  private nextSortIndex(parentId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE((SELECT MAX(sort_index) FROM nodes WHERE parent_id = ?), -1) + 1 AS next',
      )
      .get(parentId) as { next: number }
    return row.next
  }

  /**
   * 批内兄弟序号：同一父节点下的多个节点拿**连续**的号。
   *
   * 基准值（COALESCE(MAX)+1）每个父节点只查一次，组内按批内出现顺序递增 ——
   * 逐个查库会让每个节点都拿到同一个基准值。
   */
  private batchSortIndexes(
    nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[],
  ): (number | undefined)[] {
    const nextByParent = new Map<string, number>()
    return nodesData.map((data) => {
      const parentId = data.parentId ?? null
      if (parentId === null) return undefined
      const next = nextByParent.get(parentId) ?? this.nextSortIndex(parentId)
      nextByParent.set(parentId, next + 1)
      return next
    })
  }

  update(id: string, data: Partial<GraphNode>): GraphNode {
    const now = new Date().toISOString()

    // 状态机强制校验：若本次更新包含 status，先读出现状（type + status），
    // 再用 `validateNodeTypeTransition` 按 per-NodeType 矩阵校验。
    // 这是消除 `agent-manager.ts:968-981` 裸 SQL 旁路后的统一入口：
    // 所有写 status 的路径都必须经此函数校验后落库。
    if (data.status !== undefined) {
      const current = this.findById(id)
      if (!current) {
        throw new DatabaseError(`Node not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
      }
      validateNodeTypeTransition(current.type, current.status, data.status, id)
    }

    const updates: string[] = []
    const args: (string | number | null)[] = []

    if (data.type !== undefined) { updates.push('type = ?'); args.push(data.type) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }
    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.acceptanceCriteria !== undefined) { updates.push('acceptance_criteria = ?'); args.push(JSON.stringify(data.acceptanceCriteria)) }
    if (data.parentId !== undefined) {
      // 防环：远端 peer 可以任意指定 parentId（spec §4.4.2）。
      // 本地 graph:reparent 已收敛到 hierarchy-service.ts 的单一入口，
      // 这里是剩下唯一需要自己守的 parent_id **更新**路径
      // （Yjs 远端更新与快照双向同步都经由这里）。
      // create() / createBatch() 也写 parent_id，但它们的 id 由服务端
      // generateId('node') 生成 —— 新节点没有后代，不可能成环，无需守。
      // 只做防环 —— 父子类型 / 跨图校验是 graph:reparent 的职责，
      // 远端路径按 spec §4.4.2 的取舍不做。
      //
      // 归一一次，比较 / 判定 / 落库三处用同一个值：parent_id 是 TEXT 列，
      // 而远端 payload 不可信（parentId 可能是 number）。不归一的话守卫是
      // 类型敏感的（`10 === '10'` 为 false），且 better-sqlite3 把 JS number
      // 绑成 REAL —— SQLite 对 TEXT 列做亲和转换后是 `'10.0'` 而非 `'10'`，
      // `WHERE id = ?` 因此匹配不到任何真实节点 → 上溯链断掉 → 两条守卫同时失效。
      const parentId = data.parentId == null ? null : String(data.parentId)
      if (parentId === id) {
        throw new HierarchyError(
          `Node cannot be its own parent: ${id}`,
          ErrorCode.HIERARCHY_SELF_PARENT,
          { nodeId: id },
        )
      }
      if (parentId && isDescendant(id, parentId, (nid) => this.getParentId(nid))) {
        throw new HierarchyError(
          `Reparent would create a cycle: ${id} -> ${parentId}`,
          ErrorCode.HIERARCHY_CYCLE,
          { nodeId: id, newParentId: parentId },
        )
      }
      updates.push('parent_id = ?'); args.push(parentId)
    }
    // 兄弟顺序（spec §4.8）—— sortIndex 是 number，直接绑定即可
    if (data.sortIndex !== undefined) { updates.push('sort_index = ?'); args.push(data.sortIndex) }
    // ⚠️ better-sqlite3 **不能绑定 boolean**（只接受 number / string / bigint / buffer / null），
    // 不显式转换的话 update(id, { collapsed: true }) 抛
    // `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null`。
    if (data.collapsed !== undefined) { updates.push('collapsed = ?'); args.push(data.collapsed ? 1 : 0) }
    if (data.rules !== undefined) { updates.push('rules = ?'); args.push(JSON.stringify(data.rules)) }
    if (data.metadata !== undefined) { updates.push('metadata = ?'); args.push(JSON.stringify(data.metadata)) }
    if (data.contextRefs !== undefined) { updates.push('context_refs = ?'); args.push(JSON.stringify(data.contextRefs)) }
    if (data.wikiContent !== undefined) { updates.push('wiki_content = ?'); args.push(data.wikiContent) }
    if (data.wikiMeta !== undefined) { updates.push('wiki_meta = ?'); args.push(JSON.stringify(data.wikiMeta)) }
    if (data.ownerRole !== undefined) { updates.push('owner_role = ?'); args.push(data.ownerRole) }
    if (data.position !== undefined) { updates.push('position_x = ?, position_y = ?'); args.push(data.position.x, data.position.y) }
    if (data.content !== undefined) { updates.push('content = ?'); args.push(JSON.stringify(data.content)) }
    if (data.communitySummary !== undefined) { updates.push('community_summary = ?'); args.push(data.communitySummary) }
    if (data.communityLevel !== undefined) { updates.push('community_level = ?'); args.push(data.communityLevel) }
    if (data.communityId !== undefined) { updates.push('community_id = ?'); args.push(data.communityId) }

    updates.push('updated_at = ?')
    args.push(now)
    args.push(id)

    this.db.prepare(
      `UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`
    ).run(...args)

    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) {
      throw new DatabaseError(`Node not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return this.rowToNode(row)
  }

  delete(id: string): void {
    const deleteNode = this.db.transaction(() => {
      // 删父节点 → 子节点变成**根节点**（spec §4.8 / plan §问题 4）。
      // 不是「子节点被删掉」，也不是「留成孤儿」——孤儿的 parent_id 仍指着
      // 已不存在的节点，排序号也悬空。先把子节点置根，再删自身。
      this.db.prepare('UPDATE nodes SET parent_id = NULL WHERE parent_id = ?').run(id)
      // 外键 ON DELETE CASCADE 会自动删除关联的 edges 和 bug_nodes
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
    })
    deleteNode()
  }

  /** 查询节点当前状态（用于状态转换校验） */
  getStatus(id: string): NodeStatus | null {
    const row = this.db.prepare('SELECT status FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return assertNodeStatus(row.status as string)
  }

  /** 按 ID 查找节点，不存在时返回 null */
  findById(id: string): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this.rowToNode(row)
  }

  /** 按图 ID 列出所有节点 */
  listByGraph(graphId: string): GraphNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE graph_id = ?').all(graphId) as Record<string, unknown>[]
    return rows.map((row) => this.rowToNode(row))
  }

  /** 取父节点 id —— 防环时逐级上溯 parent_id 链用 */
  private getParentId(id: string): string | null {
    const row = this.db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(id) as
      | { parent_id: string | null }
      | undefined
    return row?.parent_id ?? null
  }

  /** 批量更新节点位置（事务提交） */
  batchUpdatePositions(updates: Array<{ id: string; x: number; y: number }>): void {
    if (updates.length === 0) return
    const now = new Date().toISOString()
    const stmt = this.db.prepare('UPDATE nodes SET position_x = ?, position_y = ?, updated_at = ? WHERE id = ?')
    const updateMany = this.db.transaction((items: Array<{ id: string; x: number; y: number }>) => {
      for (const { id, x, y } of items) {
        stmt.run(x, y, now, id)
      }
    })
    updateMany(updates)
  }
}
