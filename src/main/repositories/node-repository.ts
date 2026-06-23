/**
 * Node Repository
 * 负责 Node 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphNode } from '@shared/types'
import type { NodeStatus } from '@shared/types'
import { assertNodeType, assertNodeStatus, assertGraphType } from '@shared/type-guards'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { DatabaseError, ErrorCode } from '../errors'

export class NodeRepository {
  constructor(private db: Client) {}

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

  async create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<GraphNode> {
    const id = generateId('node')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, rules, metadata, owner_role,
        position_x, position_y, context_refs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
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
      ],
    })

    return { ...data, id, createdAt: now, updatedAt: now }
  }

  /** 批量创建节点（LibSQL batch API，单次事务提交） */
  async createBatch(nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<GraphNode[]> {
    if (nodesData.length === 0) return []
    const now = new Date().toISOString()
    const created: GraphNode[] = []

    const statements = nodesData.map((data) => {
      const id = generateId('node')
      created.push({ ...data, id, createdAt: now, updatedAt: now })
      return {
        sql: `INSERT INTO nodes (
          id, type, status, title, description, acceptance_criteria,
          graph_id, graph_type, parent_id, rules, metadata, owner_role,
          position_x, position_y, context_refs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
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
        ],
      }
    })

    await this.db.batch(statements, 'write')
    return created
  }

  async update(id: string, data: Partial<GraphNode>): Promise<GraphNode> {
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

    await this.db.execute({
      sql: `UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`,
      args,
    })

    const result = await this.db.execute({
      sql: 'SELECT * FROM nodes WHERE id = ?',
      args: [id],
    })

    const row = result.rows[0]
    if (!row) {
      throw new DatabaseError(`Node not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return this.rowToNode(row as unknown as Record<string, unknown>)
  }

  async delete(id: string): Promise<void> {
    // 外键 ON DELETE CASCADE 会自动删除关联的 edges 和 bug_nodes
    await this.db.execute({ sql: 'DELETE FROM nodes WHERE id = ?', args: [id] })
  }

  /** 查询节点当前状态（用于状态转换校验） */
  async getStatus(id: string): Promise<NodeStatus | null> {
    const result = await this.db.execute({ sql: 'SELECT status FROM nodes WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) return null
    return assertNodeStatus(row.status as string)
  }

  /** 按 ID 查找节点，不存在时返回 null */
  async findById(id: string): Promise<GraphNode | null> {
    const result = await this.db.execute({ sql: 'SELECT * FROM nodes WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) return null
    return this.rowToNode(row as unknown as Record<string, unknown>)
  }

  async updateParentId(nodeId: string, parentId: string | null): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE nodes SET parent_id = ? WHERE id = ?',
      args: [parentId, nodeId],
    })
  }

  /** 批量更新节点位置（LibSQL batch API，单次事务提交） */
  async batchUpdatePositions(updates: Array<{ id: string; x: number; y: number }>): Promise<void> {
    if (updates.length === 0) return
    const now = new Date().toISOString()
    const statements = updates.map(({ id, x, y }) => ({
      sql: 'UPDATE nodes SET position_x = ?, position_y = ?, updated_at = ? WHERE id = ?',
      args: [x, y, now, id],
    }))
    await this.db.batch(statements, 'write')
  }
}
