/**
 * Snapshot Repository
 * 负责图快照的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphSnapshot, GraphNode, GraphEdge } from '@shared/types'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'

export class SnapshotRepository {
  constructor(private db: Client) {}

  async create(graphId: string, name: string, nodes: GraphNode[], edges: GraphEdge[], gitCommit?: string): Promise<GraphSnapshot> {
    const id = generateId('snapshot')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: 'INSERT INTO snapshots (id, graph_id, name, data, git_commit, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, graphId, name, JSON.stringify({ nodes, edges }), gitCommit ?? null, now],
    })

    return { id, graphId, name, data: { nodes, edges }, gitCommit, createdAt: now }
  }

  async listByGraph(graphId: string): Promise<Omit<GraphSnapshot, 'data'>[]> {
    const result = await this.db.execute({
      sql: 'SELECT id, graph_id, name, git_commit, created_at FROM snapshots WHERE graph_id = ? ORDER BY created_at DESC',
      args: [graphId],
    })
    return result.rows.map((row) => ({
      id: row.id as string,
      graphId: row.graph_id as string,
      name: row.name as string,
      gitCommit: (row.git_commit as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }))
  }

  async load(id: string): Promise<GraphSnapshot | null> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM snapshots WHERE id = ?',
      args: [id],
    })
    const row = result.rows[0]
    if (!row) return null

    const data = safeJsonParse<{ nodes: GraphNode[]; edges: GraphEdge[] }>(row.data as string, 'snapshot-data')
    return {
      id: row.id as string,
      graphId: row.graph_id as string,
      name: row.name as string,
      data: data ?? { nodes: [], edges: [] },
      gitCommit: (row.git_commit as string | null) ?? undefined,
      createdAt: row.created_at as string,
    }
  }

  async delete(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM snapshots WHERE id = ?', args: [id] })
  }
}
