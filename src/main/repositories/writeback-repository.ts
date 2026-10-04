/**
 * Writeback Repository
 * 负责 Agent 会话生成的写回项（WritebackItem）的持久化与查询
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { WritebackItem, WritebackStatus, RollbackAction } from '@shared/types/wiki'
import { generateId } from '../shared/env'

export class WritebackRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private rowToItem(row: Record<string, unknown>): WritebackItem {
    const sourceNodeIdsRaw = row.source_node_ids as string | null | undefined
    let sourceNodeIds: string[] | undefined
    if (typeof sourceNodeIdsRaw === 'string' && sourceNodeIdsRaw.length > 0) {
      try {
        const parsed = JSON.parse(sourceNodeIdsRaw)
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0) {
          sourceNodeIds = parsed
        }
      } catch {
        // corrupt JSON silently degrade to undefined; 老数据向前兼容
      }
    }
    const rollbackActionsRaw = row.rollback_actions as string | null | undefined
    let rollbackActions: RollbackAction[] | undefined
    if (typeof rollbackActionsRaw === 'string' && rollbackActionsRaw.length > 0) {
      try {
        const parsed = JSON.parse(rollbackActionsRaw)
        if (Array.isArray(parsed) && parsed.every((x) => x && typeof x === 'object')) {
          rollbackActions = parsed as RollbackAction[]
        }
      } catch {
        // corrupt JSON silently degrade to undefined
      }
    }
    return {
      id: row.id as string,
      graphId: row.graph_id as string,
      kind: row.kind as WritebackItem['kind'],
      targetNodeId: row.target_node_id as string,
      title: row.title as string,
      content: row.content as string,
      details: (row.details as string | null) ?? undefined,
      narrative: (row.narrative as string | null) ?? undefined,
      sourceNodeIds,
      targetNodeTitle: (row.target_node_title as string | null) ?? undefined,
      sourceSessionId: row.source_session_id as string,
      confidence: row.confidence as number,
      status: row.status as WritebackStatus,
      createdAt: row.created_at as string,
      resolvedAt: (row.resolved_at as string | null) ?? null,
      rollbackActions,
    }
  }

  create(data: Omit<WritebackItem, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): WritebackItem {
    const id = generateId('writeback')
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO writeback_items
        (id, graph_id, kind, target_node_id, title, content, details, narrative,
         source_node_ids, target_node_title,
         source_session_id, confidence, status, created_at, resolved_at, rollback_actions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
    `).run(
      id, data.graphId, data.kind, data.targetNodeId, data.title, data.content,
      data.details ?? null, data.narrative ?? null,
      data.sourceNodeIds ? JSON.stringify(data.sourceNodeIds) : null,
      data.targetNodeTitle ?? null,
      data.sourceSessionId, data.confidence, now,
    )
    return { ...data, id, status: 'pending', createdAt: now, resolvedAt: null }
  }

  listPending(graphId: string): WritebackItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM writeback_items WHERE graph_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    ).all(graphId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToItem(r))
  }

  countPending(graphId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM writeback_items WHERE graph_id = ? AND status = 'pending'`,
    ).get(graphId) as { c: number }
    return row.c
  }

  /**
   * 历史 tab 数据：accepted + rolled_back。
   * 接受可选 sinceIso 时间戳用于过滤 rolled_back 30 天窗口（accepted 不限）。
   */
  listHistory(graphId: string, sinceIso?: string): WritebackItem[] {
    const sql = sinceIso
      ? `SELECT * FROM writeback_items
         WHERE graph_id = ?
           AND (status = 'accepted'
                OR (status = 'rolled_back' AND resolved_at >= ?))
         ORDER BY COALESCE(resolved_at, created_at) DESC`
      : `SELECT * FROM writeback_items
         WHERE graph_id = ? AND status IN ('accepted','rolled_back')
         ORDER BY COALESCE(resolved_at, created_at) DESC`
    const rows = (sinceIso
      ? this.db.prepare(sql).all(graphId, sinceIso)
      : this.db.prepare(sql).all(graphId)) as Record<string, unknown>[]
    return rows.map((r) => this.rowToItem(r))
  }

  findBySession(sourceSessionId: string): WritebackItem[] {
    // 含 discarded：用户丢弃不代表重新生成——「按会话去重」语义是每会话只生成一次
    const rows = this.db.prepare(
      `SELECT * FROM writeback_items WHERE source_session_id = ?`,
    ).all(sourceSessionId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToItem(r))
  }

  findById(id: string): WritebackItem | null {
    const row = this.db.prepare(`SELECT * FROM writeback_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  updateStatus(id: string, status: WritebackStatus, rollbackActions?: RollbackAction[]): void {
    const args: (string | null)[] = [status, new Date().toISOString()]
    let sql = `UPDATE writeback_items SET status = ?, resolved_at = ?`
    if (rollbackActions !== undefined) {
      sql += `, rollback_actions = ?`
      args.push(JSON.stringify(rollbackActions))
    }
    sql += ` WHERE id = ?`
    args.push(id)
    this.db.prepare(sql).run(...args)
  }
}
