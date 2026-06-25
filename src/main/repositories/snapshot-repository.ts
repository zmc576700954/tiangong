/**
 * Snapshot Repository
 * 负责图快照的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { GraphSnapshot, GraphNode, GraphEdge } from '@shared/types'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'

export class SnapshotRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(graphId: string, name: string, nodes: GraphNode[], edges: GraphEdge[], gitCommit?: string): GraphSnapshot {
    const id = generateId('snapshot')
    const now = new Date().toISOString()

    this.db.prepare(
      'INSERT INTO snapshots (id, graph_id, name, data, git_commit, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, graphId, name, JSON.stringify({ nodes, edges }), gitCommit ?? null, now)

    return { id, graphId, name, data: { nodes, edges }, gitCommit, createdAt: now }
  }

  listByGraph(graphId: string, limit = 50): Omit<GraphSnapshot, 'data'>[] {
    const rows = this.db.prepare(
      'SELECT id, graph_id, name, git_commit, created_at FROM snapshots WHERE graph_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(graphId, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: row.id as string,
      graphId: row.graph_id as string,
      name: row.name as string,
      gitCommit: (row.git_commit as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }))
  }

  /** 只保留每个图最新的 keepCount 个 snapshot，删除更旧的 */
  pruneOldSnapshots(graphId: string, keepCount = 20): void {
    const ids = this.db.prepare(
      'SELECT id FROM snapshots WHERE graph_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?'
    ).all(graphId, keepCount) as { id: string }[]
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`).run(...ids.map((r) => r.id))
  }

  load(id: string): GraphSnapshot | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null

    const data = safeJsonParse<{ nodes: GraphNode[]; edges: GraphEdge[] }>(row.data as string, { nodes: [], edges: [] })
    return {
      id: row.id as string,
      graphId: row.graph_id as string,
      name: row.name as string,
      data,
      gitCommit: (row.git_commit as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id)
  }
}
