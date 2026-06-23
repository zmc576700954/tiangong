/**
 * Bug Repository
 * 负责 Bug 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { BugNode } from '@shared/types'
import type { BugStatus } from '@shared/types'
import { assertBugSeverity, assertBugStatus } from '@shared/type-guards'
import { generateId } from '../shared/env'
import { DatabaseError, ErrorCode } from '../errors'

export class BugRepository {
  constructor(private db: Client) {}

  async create(data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<BugNode> {
    const id = generateId('bug')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: 'INSERT INTO bug_nodes (id, title, description, severity, status, node_id, graph_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, data.title, data.description, data.severity, data.status, data.nodeId, data.graphId, now, now],
    })

    return { ...data, id, createdAt: now, updatedAt: now }
  }

  async update(id: string, data: Partial<BugNode>): Promise<BugNode> {
    const now = new Date().toISOString()

    const updates: string[] = []
    const args: (string | number | null)[] = []

    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.severity !== undefined) { updates.push('severity = ?'); args.push(data.severity) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }

    updates.push('updated_at = ?')
    args.push(now)
    args.push(id)

    await this.db.execute({
      sql: `UPDATE bug_nodes SET ${updates.join(', ')} WHERE id = ?`,
      args,
    })

    const result = await this.db.execute({
      sql: 'SELECT * FROM bug_nodes WHERE id = ?',
      args: [id],
    })

    const row = result.rows[0]
    if (!row) {
      throw new DatabaseError(`Bug not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      severity: assertBugSeverity(row.severity as string),
      status: assertBugStatus(row.status as string),
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } as BugNode
  }

  async delete(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM bug_nodes WHERE id = ?', args: [id] })
  }

  /** 查询 Bug 当前状态（用于状态转换校验） */
  async getStatus(id: string): Promise<BugStatus | null> {
    const result = await this.db.execute({ sql: 'SELECT status FROM bug_nodes WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) return null
    return assertBugStatus(row.status as string)
  }

  async listByNode(nodeId: string): Promise<BugNode[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM bug_nodes WHERE node_id = ? ORDER BY created_at DESC',
      args: [nodeId],
    })

    return result.rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      severity: assertBugSeverity(row.severity as string),
      status: assertBugStatus(row.status as string),
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    })) as BugNode[]
  }
}
