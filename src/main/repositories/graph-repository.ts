/**
 * Graph Repository
 * 负责 Graph 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { Graph, GraphNode, GraphEdge, BugNode, GraphType } from '@shared/types'
import { generateId } from '../shared/env'

function rowStr(row: Record<string, unknown>, key: string): string {
  const val = row[key]
  if (typeof val !== 'string') throw new TypeError(`Expected string for ${key}, got ${typeof val}`)
  return val
}

function rowOptStr(row: Record<string, unknown>, key: string): string | undefined {
  const val = row[key]
  if (val === null || val === undefined) return undefined
  if (typeof val !== 'string') throw new TypeError(`Expected string for ${key}, got ${typeof val}`)
  return val
}

function rowNum(row: Record<string, unknown>, key: string): number {
  const val = row[key]
  if (typeof val !== 'number') throw new TypeError(`Expected number for ${key}, got ${typeof val}`)
  return val
}

export class GraphRepository {
  constructor(private db: Client) {}

  async create(data: { name: string; type: GraphType; projectPath?: string }): Promise<Graph> {
    const id = generateId('graph')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, data.name, data.type, data.projectPath ?? null, now, now],
    })

    return { id, name: data.name, type: data.type, projectPath: data.projectPath, createdAt: now, updatedAt: now }
  }

  async list(): Promise<Graph[]> {
    const result = await this.db.execute('SELECT * FROM graphs ORDER BY updated_at DESC')
    return result.rows.map((row) => ({
      id: rowStr(row, 'id'),
      name: rowStr(row, 'name'),
      type: rowStr(row, 'type') as GraphType,
      projectPath: rowOptStr(row, 'project_path'),
      createdAt: rowStr(row, 'created_at'),
      updatedAt: rowStr(row, 'updated_at'),
    }))
  }

  async get(id: string): Promise<{ graph: Graph; nodes: GraphNode[]; edges: GraphEdge[]; bugs: BugNode[] } | null> {
    // PERFORMANCE: 并行执行无依赖关系的查询，减少总等待时间
    const [graphResult, nodesResult, edgesResult, bugsResult] = await Promise.all([
      this.db.execute({ sql: 'SELECT * FROM graphs WHERE id = ?', args: [id] }),
      this.db.execute({ sql: 'SELECT * FROM nodes WHERE graph_id = ?', args: [id] }),
      this.db.execute({ sql: 'SELECT * FROM edges WHERE graph_id = ?', args: [id] }),
      this.db.execute({ sql: 'SELECT * FROM bug_nodes WHERE graph_id = ? ORDER BY created_at DESC', args: [id] }),
    ])

    if (graphResult.rows.length === 0) return null

    const graph = graphResult.rows[0]

    return {
      graph: {
        id: rowStr(graph, 'id'),
        name: rowStr(graph, 'name'),
        type: rowStr(graph, 'type') as GraphType,
        projectPath: rowOptStr(graph, 'project_path'),
        createdAt: rowStr(graph, 'created_at'),
        updatedAt: rowStr(graph, 'updated_at'),
      },
      nodes: nodesResult.rows.map((row) => ({
        id: rowStr(row, 'id'),
        type: rowStr(row, 'type') as GraphNode['type'],
        status: rowStr(row, 'status') as GraphNode['status'],
        title: rowStr(row, 'title'),
        description: rowOptStr(row, 'description'),
        acceptanceCriteria: row.acceptance_criteria ? JSON.parse(rowStr(row, 'acceptance_criteria')) : undefined,
        graphId: rowStr(row, 'graph_id'),
        graphType: rowStr(row, 'graph_type') as GraphNode['graphType'],
        parentId: rowOptStr(row, 'parent_id'),
        rules: row.rules ? JSON.parse(rowStr(row, 'rules')) : undefined,
        metadata: row.metadata ? JSON.parse(rowStr(row, 'metadata')) : undefined,
        contextRefs: row.context_refs ? JSON.parse(rowStr(row, 'context_refs')) : undefined,
        ownerRole: rowOptStr(row, 'owner_role') as GraphNode['ownerRole'],
        position: { x: rowNum(row, 'position_x'), y: rowNum(row, 'position_y') },
        createdAt: rowStr(row, 'created_at'),
        updatedAt: rowStr(row, 'updated_at'),
      })),
      edges: edgesResult.rows.map((row) => ({
        id: rowStr(row, 'id'),
        source: rowStr(row, 'source'),
        target: rowStr(row, 'target'),
        label: rowOptStr(row, 'label'),
        graphId: rowStr(row, 'graph_id'),
        edgeType: rowOptStr(row, 'edge_type') as GraphEdge['edgeType'],
      })),
      bugs: bugsResult.rows.map((row) => ({
        id: rowStr(row, 'id'),
        title: rowStr(row, 'title'),
        description: rowStr(row, 'description'),
        severity: rowStr(row, 'severity') as BugNode['severity'],
        status: rowStr(row, 'status') as BugNode['status'],
        nodeId: rowStr(row, 'node_id'),
        graphId: rowStr(row, 'graph_id'),
        createdAt: rowStr(row, 'created_at'),
        updatedAt: rowStr(row, 'updated_at'),
      })),
    }
  }

  async delete(id: string): Promise<void> {
    await this.db.execute('BEGIN TRANSACTION')
    try {
      await this.db.execute({ sql: 'DELETE FROM edges WHERE graph_id = ?', args: [id] })
      await this.db.execute({ sql: 'DELETE FROM nodes WHERE graph_id = ?', args: [id] })
      await this.db.execute({ sql: 'DELETE FROM bug_nodes WHERE graph_id = ?', args: [id] })
      await this.db.execute({ sql: 'DELETE FROM graphs WHERE id = ?', args: [id] })
      await this.db.execute('COMMIT')
    } catch (err) {
      await this.db.execute('ROLLBACK').catch(() => {})
      throw err
    }
  }

  async getProjectPaths(): Promise<string[]> {
    const result = await this.db.execute(
      'SELECT DISTINCT project_path FROM graphs WHERE project_path IS NOT NULL'
    )
    return result.rows
      .map((row) => row.project_path as string | null)
      .filter((p): p is string => p !== null && p !== undefined)
  }
}
