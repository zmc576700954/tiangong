/**
 * Edge Repository
 * 负责 Edge 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphEdge } from '@shared/types'
import { assertEdgeType } from '@shared/type-guards'
import { DatabaseError, ErrorCode } from '../errors'
import { generateId } from '../shared/env'
import { createLogger } from '../shared/logger'

const logger = createLogger('EdgeRepo')

function parseEdgeRow(row: Record<string, unknown>): GraphEdge {
  let content: GraphEdge['content']
  if (row.content) {
    try {
      content = JSON.parse(row.content as string)
    } catch {
      logger.warn('Failed to parse edge content:', row.content)
      content = undefined
    }
  }
  return {
    id: row.id as string,
    source: row.source as string,
    target: row.target as string,
    label: row.label as string | undefined,
    graphId: row.graph_id as string,
    edgeType: row.edge_type ? assertEdgeType(row.edge_type as string) : undefined,
    description: row.description as string | undefined,
    dataFlow: row.data_flow as string | undefined,
    strength: typeof row.strength === 'number' ? row.strength : undefined,
    content,
  }
}

export class EdgeRepository {
  constructor(private db: Client) {}

  async create(data: Omit<GraphEdge, 'id'>): Promise<GraphEdge> {
    const id = generateId('edge')

    await this.db.execute({
      sql: 'INSERT INTO edges (id, source, target, label, edge_type, content, graph_id, description, data_flow, strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        id,
        data.source,
        data.target,
        data.label ?? null,
        data.edgeType ?? null,
        data.content ? JSON.stringify(data.content) : null,
        data.graphId,
        data.description ?? null,
        data.dataFlow ?? null,
        data.strength ?? null,
      ],
    })

    return { ...data, id }
  }

  async update(id: string, data: Partial<GraphEdge>): Promise<GraphEdge> {
    const updates: string[] = []
    const args: (string | number | null)[] = []

    if (data.label !== undefined) { updates.push('label = ?'); args.push(data.label) }
    if (data.edgeType !== undefined) { updates.push('edge_type = ?'); args.push(data.edgeType) }
    if (data.content !== undefined) {
      updates.push('content = ?')
      args.push(data.content ? JSON.stringify(data.content) : null)
    }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description ?? null) }
    if (data.dataFlow !== undefined) { updates.push('data_flow = ?'); args.push(data.dataFlow ?? null) }
    if (data.strength !== undefined) { updates.push('strength = ?'); args.push(data.strength ?? null) }

    if (updates.length > 0) {
      args.push(id)
      await this.db.execute({
        sql: `UPDATE edges SET ${updates.join(', ')} WHERE id = ?`,
        args,
      })
    }

    const result = await this.db.execute({ sql: 'SELECT * FROM edges WHERE id = ?', args: [id] })
    const row = result.rows[0]
    if (!row) {
      throw new DatabaseError(`Edge not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return parseEdgeRow(row)
  }

  async delete(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM edges WHERE id = ?', args: [id] })
  }

  async listByGraph(graphId: string): Promise<GraphEdge[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM edges WHERE graph_id = ?',
      args: [graphId],
    })
    return result.rows.map((row) => parseEdgeRow(row))
  }
}
