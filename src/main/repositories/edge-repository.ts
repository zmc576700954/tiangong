/**
 * Edge Repository
 * 负责 Edge 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphEdge } from '@shared/types'
import { generateId } from '../shared/env'

function parseEdgeRow(row: Record<string, unknown>): GraphEdge {
  return {
    id: row.id as string,
    source: row.source as string,
    target: row.target as string,
    label: row.label as string | undefined,
    graphId: row.graph_id as string,
    edgeType: row.edge_type as GraphEdge['edgeType'],
    content: row.content ? JSON.parse(row.content as string) : undefined,
  }
}

export class EdgeRepository {
  constructor(private db: Client) {}

  async create(data: Omit<GraphEdge, 'id'>): Promise<GraphEdge> {
    const id = generateId('edge')

    await this.db.execute({
      sql: 'INSERT INTO edges (id, source, target, label, edge_type, content, graph_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [
        id,
        data.source,
        data.target,
        data.label ?? null,
        data.edgeType ?? null,
        data.content ? JSON.stringify(data.content) : null,
        data.graphId,
      ],
    })

    return { ...data, id }
  }

  async update(id: string, data: Partial<GraphEdge>): Promise<GraphEdge> {
    const updates: string[] = []
    const args: (string | null)[] = []

    if (data.label !== undefined) { updates.push('label = ?'); args.push(data.label) }
    if (data.edgeType !== undefined) { updates.push('edge_type = ?'); args.push(data.edgeType) }
    if (data.content !== undefined) {
      updates.push('content = ?')
      args.push(data.content ? JSON.stringify(data.content) : null)
    }

    if (updates.length > 0) {
      args.push(id)
      await this.db.execute({
        sql: `UPDATE edges SET ${updates.join(', ')} WHERE id = ?`,
        args,
      })
    }

    const result = await this.db.execute({ sql: 'SELECT * FROM edges WHERE id = ?', args: [id] })
    return parseEdgeRow(result.rows[0])
  }

  async delete(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM edges WHERE id = ?', args: [id] })
  }
}
