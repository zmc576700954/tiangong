/**
 * Node Repository
 * 负责 Node 的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode } from '@shared/types'
import type { NodeStatus } from '@shared/types'
import { assertNodeType, assertNodeStatus, assertGraphType } from '@shared/type-guards'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { DatabaseError, ErrorCode } from '../errors'

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
      acceptanceCriteria: safeJsonParse<GraphNode['acceptanceCriteria']>(row.acceptance_criteria as string | null, []),
      graphId: row.graph_id as string,
      graphType: assertGraphType(row.graph_type as string, 'graphType'),
      parentId: row.parent_id as string | undefined,
      rules: safeJsonParse<GraphNode['rules']>(row.rules as string | null, undefined),
      metadata: safeJsonParse<GraphNode['metadata']>(row.metadata as string | null, undefined),
      contextRefs: safeJsonParse<GraphNode['contextRefs']>(row.context_refs as string | null, undefined),
      ownerRole: row.owner_role as GraphNode['ownerRole'],
      position: { x: row.position_x as number, y: row.position_y as number },
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } as GraphNode
  }

  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const id = generateId('node')
    const now = new Date().toISOString()

    this.db.prepare(
      `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, rules, metadata, owner_role,
        position_x, position_y, context_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.type,
      data.status,
      data.title,
      data.description ?? null,
      data.acceptanceCriteria ? JSON.stringify(data.acceptanceCriteria) : null,
      data.graphId,
      data.graphType,
      data.parentId ?? null,
      data.rules ? JSON.stringify(data.rules) : null,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.ownerRole ?? null,
      data.position.x,
      data.position.y,
      data.contextRefs ? JSON.stringify(data.contextRefs) : null,
      now,
      now,
    )

    return { ...data, id, createdAt: now, updatedAt: now }
  }

  /** 批量创建节点（事务提交） */
  createBatch(nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]): GraphNode[] {
    if (nodesData.length === 0) return []
    const now = new Date().toISOString()
    const created: GraphNode[] = []

    const stmt = this.db.prepare(
      `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, rules, metadata, owner_role,
        position_x, position_y, context_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    const insertMany = this.db.transaction((items: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => {
      for (const data of items) {
        const id = generateId('node')
        created.push({ ...data, id, createdAt: now, updatedAt: now })
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
          data.rules ? JSON.stringify(data.rules) : null,
          data.metadata ? JSON.stringify(data.metadata) : null,
          data.ownerRole ?? null,
          data.position.x,
          data.position.y,
          data.contextRefs ? JSON.stringify(data.contextRefs) : null,
          now,
          now,
        )
      }
    })

    insertMany(nodesData)
    return created
  }

  update(id: string, data: Partial<GraphNode>): GraphNode {
    const now = new Date().toISOString()

    const updates: string[] = []
    const args: (string | number | null)[] = []

    if (data.type !== undefined) { updates.push('type = ?'); args.push(data.type) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }
    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.acceptanceCriteria !== undefined) { updates.push('acceptance_criteria = ?'); args.push(JSON.stringify(data.acceptanceCriteria)) }
    if (data.parentId !== undefined) { updates.push('parent_id = ?'); args.push(data.parentId) }
    if (data.rules !== undefined) { updates.push('rules = ?'); args.push(JSON.stringify(data.rules)) }
    if (data.metadata !== undefined) { updates.push('metadata = ?'); args.push(JSON.stringify(data.metadata)) }
    if (data.contextRefs !== undefined) { updates.push('context_refs = ?'); args.push(JSON.stringify(data.contextRefs)) }
    if (data.ownerRole !== undefined) { updates.push('owner_role = ?'); args.push(data.ownerRole) }
    if (data.position !== undefined) { updates.push('position_x = ?, position_y = ?'); args.push(data.position.x, data.position.y) }

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
    // 外键 ON DELETE CASCADE 会自动删除关联的 edges 和 bug_nodes
    this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id)
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

  updateParentId(nodeId: string, parentId: string | null): void {
    this.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(parentId, nodeId)
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
