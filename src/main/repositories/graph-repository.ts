/**
 * Graph Repository
 * 负责 Graph 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { Graph, GraphNode, GraphEdge, BugNode, GraphType } from '@shared/types'
import { assertGraphType, assertNodeType, assertNodeStatus, assertEdgeType, assertBugSeverity, assertBugStatus } from '@shared/type-guards'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'

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
      type: assertGraphType(rowStr(row, 'type')),
      projectPath: rowOptStr(row, 'project_path'),
      createdAt: rowStr(row, 'created_at'),
      updatedAt: rowStr(row, 'updated_at'),
    }))
  }

  async get(
    id: string,
    options?: { nodeLimit?: number; edgeLimit?: number; bugLimit?: number },
  ): Promise<{ graph: Graph; nodes: GraphNode[]; edges: GraphEdge[]; bugs: BugNode[] } | null> {
    const nodeLimit = options?.nodeLimit ?? 5000
    const edgeLimit = options?.edgeLimit ?? 5000
    const bugLimit = options?.bugLimit ?? 1000

    // PERFORMANCE: 并行执行无依赖关系的查询，减少总等待时间
    const [graphResult, nodesResult, edgesResult, bugsResult] = await Promise.all([
      this.db.execute({ sql: 'SELECT * FROM graphs WHERE id = ?', args: [id] }),
      this.db.execute({ sql: 'SELECT * FROM nodes WHERE graph_id = ? LIMIT ?', args: [id, nodeLimit] }),
      this.db.execute({ sql: 'SELECT * FROM edges WHERE graph_id = ? LIMIT ?', args: [id, edgeLimit] }),
      this.db.execute({ sql: 'SELECT * FROM bug_nodes WHERE graph_id = ? ORDER BY created_at DESC LIMIT ?', args: [id, bugLimit] }),
    ])

    if (graphResult.rows.length === 0) return null

    const graph = graphResult.rows[0]

    return {
      graph: {
        id: rowStr(graph, 'id'),
        name: rowStr(graph, 'name'),
        type: assertGraphType(rowStr(graph, 'type')),
        projectPath: rowOptStr(graph, 'project_path'),
        createdAt: rowStr(graph, 'created_at'),
        updatedAt: rowStr(graph, 'updated_at'),
      },
      nodes: nodesResult.rows.map((row) => ({
        id: rowStr(row, 'id'),
        type: assertNodeType(rowStr(row, 'type')),
        status: assertNodeStatus(rowStr(row, 'status')),
        title: rowStr(row, 'title'),
        description: rowOptStr(row, 'description'),
        acceptanceCriteria: safeJsonParse<GraphNode['acceptanceCriteria']>(rowOptStr(row, 'acceptance_criteria'), []),
        graphId: rowStr(row, 'graph_id'),
        graphType: assertGraphType(rowStr(row, 'graph_type'), 'graphType'),
        parentId: rowOptStr(row, 'parent_id'),
        rules: safeJsonParse(rowOptStr(row, 'rules'), undefined),
        metadata: safeJsonParse(rowOptStr(row, 'metadata'), undefined),
        content: safeJsonParse(rowOptStr(row, 'content'), undefined),
        communitySummary: rowOptStr(row, 'community_summary'),
        communityLevel: typeof row.community_level === 'number' ? row.community_level : undefined,
        contextRefs: safeJsonParse<GraphNode['contextRefs']>(rowOptStr(row, 'context_refs'), undefined),
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
        edgeType: ((): GraphEdge['edgeType'] => {
          const raw = rowOptStr(row, 'edge_type')
          return raw ? assertEdgeType(raw) : undefined
        })(),
        description: rowOptStr(row, 'description'),
        dataFlow: rowOptStr(row, 'data_flow'),
        strength: typeof row.strength === 'number' ? row.strength : undefined,
        content: safeJsonParse<GraphEdge['content']>(rowOptStr(row, 'content'), undefined),
      })),
      bugs: bugsResult.rows.map((row) => ({
        id: rowStr(row, 'id'),
        title: rowStr(row, 'title'),
        description: rowStr(row, 'description'),
        severity: assertBugSeverity(rowStr(row, 'severity')),
        status: assertBugStatus(rowStr(row, 'status')),
        nodeId: rowStr(row, 'node_id'),
        graphId: rowStr(row, 'graph_id'),
        createdAt: rowStr(row, 'created_at'),
        updatedAt: rowStr(row, 'updated_at'),
      })),
    }
  }

  async delete(id: string): Promise<void> {
    await this.db.batch([
      { sql: 'DELETE FROM edges WHERE graph_id = ?', args: [id] },
      { sql: 'DELETE FROM nodes WHERE graph_id = ?', args: [id] },
      { sql: 'DELETE FROM bug_nodes WHERE graph_id = ?', args: [id] },
      { sql: 'DELETE FROM snapshots WHERE graph_id = ?', args: [id] },
      { sql: 'DELETE FROM agent_logs WHERE graph_id = ?', args: [id] },
      { sql: 'DELETE FROM graphs WHERE id = ?', args: [id] },
    ], 'write')
  }

  async getProjectPaths(): Promise<string[]> {
    const result = await this.db.execute(
      'SELECT DISTINCT project_path FROM graphs WHERE project_path IS NOT NULL'
    )
    return result.rows
      .map((row) => row.project_path as string | null)
      .filter((p): p is string => p !== null && p !== undefined)
  }

  /** 克隆在线图的所有节点和边到开发图 */
  async cloneGraphNodes(sourceGraphId: string, targetGraphId: string, targetGraphType: GraphType): Promise<void> {
    const nodes = await this.db.execute({
      sql: 'SELECT * FROM nodes WHERE graph_id = ?',
      args: [sourceGraphId],
    })

    const idMap = new Map<string, string>()

    // Pass 1: 插入节点（parent_id 暂时保留原值）— 批量执行
    const nodeInserts = nodes.rows.map((row) => {
      const originalId = rowStr(row, 'id')
      const newId = generateId('node')
      idMap.set(originalId, newId)

      const nodeType = assertNodeType(rowStr(row, 'type'))
      const rawStatus = rowStr(row, 'status')
      const status = nodeType === 'feature' && targetGraphType === 'dev'
        ? 'placeholder'
        : assertNodeStatus(rawStatus)

      return {
        sql: `INSERT INTO nodes (
          id, type, status, title, description, acceptance_criteria,
          graph_id, graph_type, parent_id, rules, metadata, content, owner_role,
          position_x, position_y, context_refs, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId, nodeType, status, rowStr(row, 'title'),
          rowOptStr(row, 'description') ?? null,
          row['acceptance_criteria'],
          targetGraphId, assertGraphType(targetGraphType),
          row['parent_id'],
          row['rules'], row['metadata'], row['content'], row['owner_role'],
          rowNum(row, 'position_x'), rowNum(row, 'position_y') + 20,
          row['context_refs'],
          rowStr(row, 'created_at'), new Date().toISOString(),
        ],
      }
    })
    await this.db.batch(nodeInserts, 'write')

    // Pass 2: 批量更新 parent_id 映射
    const rowById = new Map<string, Record<string, unknown>>()
    for (const row of nodes.rows) {
      rowById.set(rowStr(row, 'id'), row as Record<string, unknown>)
    }
    const parentUpdates: Array<{ sql: string; args: [string, string] }> = []
    for (const [oldId, newId] of idMap) {
      const row = rowById.get(oldId)
      if (!row) continue
      const oldParentId = rowOptStr(row, 'parent_id')
      if (oldParentId && idMap.has(oldParentId)) {
        parentUpdates.push({
          sql: 'UPDATE nodes SET parent_id = ? WHERE id = ?',
          args: [idMap.get(oldParentId)!, newId],
        })
      }
    }
    if (parentUpdates.length > 0) {
      await this.db.batch(parentUpdates, 'write')
    }

    // Pass 3: 批量复制边
    const edges = await this.db.execute({
      sql: 'SELECT * FROM edges WHERE graph_id = ?',
      args: [sourceGraphId],
    })

    const edgeInserts = edges.rows
      .map((row) => {
        const newSourceId = idMap.get(rowStr(row, 'source'))
        const newTargetId = idMap.get(rowStr(row, 'target'))
        if (!newSourceId || !newTargetId) return null

        const newId = generateId('edge')
        return {
          sql: `INSERT INTO edges (
            id, source, target, label, edge_type, content, graph_id, description, data_flow, strength
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            newId, newSourceId, newTargetId,
            rowOptStr(row, 'label') ?? null, row['edge_type'], row['content'],
            targetGraphId, row['description'], row['data_flow'], row['strength'],
          ],
        }
      })
      .filter((stmt): stmt is NonNullable<typeof stmt> => stmt !== null)

    if (edgeInserts.length > 0) {
      await this.db.batch(edgeInserts, 'write')
    }
  }
}
