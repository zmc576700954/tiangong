/**
 * Edge Repository
 * 负责 Edge 的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
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
  constructor(private db: BetterSqlite3.Database) {}

  create(data: Omit<GraphEdge, 'id'>): GraphEdge {
    const id = generateId('edge')

    this.db.prepare(
      'INSERT INTO edges (id, source, target, label, edge_type, content, graph_id, description, data_flow, strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
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
    )

    return { ...data, id }
  }

  update(id: string, data: Partial<GraphEdge>): GraphEdge {
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
      updates.push('updated_at = ?')
      args.push(new Date().toISOString())
      args.push(id)
      this.db.prepare(
        `UPDATE edges SET ${updates.join(', ')} WHERE id = ?`
      ).run(...args)
    }

    const row = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) {
      throw new DatabaseError(`Edge not found: ${id}`, ErrorCode.DB_QUERY_FAILED)
    }
    return parseEdgeRow(row)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM edges WHERE id = ?').run(id)
  }

  listByGraph(graphId: string): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE graph_id = ?').all(graphId) as Record<string, unknown>[]
    return rows.map((row) => parseEdgeRow(row))
  }
}
