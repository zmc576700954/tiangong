/**
 * Bug Repository
 * 负责 Bug 的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { BugNode } from '@shared/types'
import type { BugStatus } from '@shared/types'
import { assertBugSeverity, assertBugStatus } from '@shared/type-guards'
import { generateId } from '../shared/env'
import { DatabaseError, ErrorCode } from '../errors'

export class BugRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>): BugNode {
    const id = generateId('bug')
    const now = new Date().toISOString()

    this.db.prepare(
      'INSERT INTO bug_nodes (id, title, description, severity, status, node_id, graph_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, data.title, data.description, data.severity, data.status, data.nodeId, data.graphId, now, now)

    return { ...data, id, createdAt: now, updatedAt: now }
  }

  update(id: string, data: Partial<BugNode>): BugNode {
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

    this.db.prepare(
      `UPDATE bug_nodes SET ${updates.join(', ')} WHERE id = ?`
    ).run(...args)

    const row = this.db.prepare('SELECT * FROM bug_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
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

  delete(id: string): void {
    this.db.prepare('DELETE FROM bug_nodes WHERE id = ?').run(id)
  }

  /** 查询 Bug 当前状态（用于状态转换校验） */
  getStatus(id: string): BugStatus | null {
    const row = this.db.prepare('SELECT status FROM bug_nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return assertBugStatus(row.status as string)
  }

  listByNode(nodeId: string): BugNode[] {
    const rows = this.db.prepare('SELECT * FROM bug_nodes WHERE node_id = ? ORDER BY created_at DESC').all(nodeId) as Record<string, unknown>[]
    return rows.map((row) => ({
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
