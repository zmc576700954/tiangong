/**
 * Graph Repository
 * 负责 Graph 的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { Graph, GraphNode, GraphEdge, BugNode, GraphType, GraphFetchOptions } from '@shared/types'
import {
  assertGraphType, assertNodeType, assertNodeStatus, assertEdgeType, assertBugSeverity, assertBugStatus,
  isRecord, isStringArray, isUnknownArray,
} from '@shared/type-guards'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'

function rowStr(row: Record<string, unknown>, key: string): string {
  const val = row[key]
  if (typeof val !== 'string') throw new TypeError(`Expected string for ${key}, got ${typeof val} (row id: ${row.id ?? 'unknown'})`)
  return val
}

function rowOptStr(row: Record<string, unknown>, key: string): string | undefined {
  const val = row[key]
  if (val === null || val === undefined) return undefined
  if (typeof val !== 'string') throw new TypeError(`Expected string for ${key}, got ${typeof val} (row id: ${row.id ?? 'unknown'})`)
  return val
}

function rowNum(row: Record<string, unknown>, key: string): number {
  const val = row[key]
  if (typeof val !== 'number') throw new TypeError(`Expected number for ${key}, got ${typeof val} (row id: ${row.id ?? 'unknown'})`)
  return val
}

export class GraphRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(data: { name: string; type: GraphType; projectPath?: string }): Graph {
    const id = generateId('graph')
    const now = new Date().toISOString()

    this.db.prepare(
      'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, data.name, data.type, data.projectPath ?? null, now, now)

    return { id, name: data.name, type: data.type, projectPath: data.projectPath, createdAt: now, updatedAt: now }
  }

  list(): Graph[] {
    const rows = this.db.prepare('SELECT * FROM graphs ORDER BY updated_at DESC').all() as Record<string, unknown>[]
    return rows.map((row) => ({
      id: rowStr(row, 'id'),
      name: rowStr(row, 'name'),
      type: assertGraphType(rowStr(row, 'type')),
      projectPath: rowOptStr(row, 'project_path'),
      createdAt: rowStr(row, 'created_at'),
      updatedAt: rowStr(row, 'updated_at'),
    }))
  }

  get(
    id: string,
    options?: GraphFetchOptions,
  ): { graph: Graph; nodes: GraphNode[]; edges: GraphEdge[]; bugs: BugNode[] } | null {
    const nodeLimit = options?.limit ?? 5000
    const edgeLimit = options?.edgeLimit ?? 5000
    const bugLimit = options?.bugLimit ?? 1000
    const offset = options?.offset ?? 0
    const viewport = options?.viewport

    // Sequential queries (better-sqlite3 is synchronous, no parallelism benefit)
    const graphRow = this.db.prepare('SELECT * FROM graphs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!graphRow) return null

    let nodesRows: Record<string, unknown>[]
    if (viewport) {
      nodesRows = this.db
        .prepare('SELECT * FROM nodes WHERE graph_id = ? AND position_x BETWEEN ? AND ? AND position_y BETWEEN ? AND ? LIMIT ? OFFSET ?')
        .all(id, viewport.minX, viewport.maxX, viewport.minY, viewport.maxY, nodeLimit, offset) as Record<string, unknown>[]
    } else {
      nodesRows = this.db.prepare('SELECT * FROM nodes WHERE graph_id = ? LIMIT ? OFFSET ?').all(id, nodeLimit, offset) as Record<string, unknown>[]
    }

    let edgesRows: Record<string, unknown>[]
    if (viewport) {
      const nodeIds = nodesRows.map((row) => String(row.id))
      if (nodeIds.length > 0) {
        const placeholders = nodeIds.map(() => '?').join(',')
        edgesRows = this.db
          .prepare(`SELECT * FROM edges WHERE graph_id = ? AND (source IN (${placeholders}) OR target IN (${placeholders})) LIMIT ?`)
          .all(id, ...nodeIds, ...nodeIds, edgeLimit) as Record<string, unknown>[]
      } else {
        edgesRows = []
      }
    } else {
      edgesRows = this.db.prepare('SELECT * FROM edges WHERE graph_id = ? LIMIT ?').all(id, edgeLimit) as Record<string, unknown>[]
    }

    const bugsRows = this.db.prepare('SELECT * FROM bug_nodes WHERE graph_id = ? ORDER BY created_at DESC LIMIT ?').all(id, bugLimit) as Record<string, unknown>[]

    return {
      graph: {
        id: rowStr(graphRow, 'id'),
        name: rowStr(graphRow, 'name'),
        type: assertGraphType(rowStr(graphRow, 'type')),
        projectPath: rowOptStr(graphRow, 'project_path'),
        createdAt: rowStr(graphRow, 'created_at'),
        updatedAt: rowStr(graphRow, 'updated_at'),
      },
      nodes: nodesRows.map((row) => ({
        id: rowStr(row, 'id'),
        type: assertNodeType(rowStr(row, 'type')),
        status: assertNodeStatus(rowStr(row, 'status')),
        title: rowStr(row, 'title'),
        description: rowOptStr(row, 'description'),
        acceptanceCriteria: safeJsonParse<GraphNode['acceptanceCriteria']>(rowOptStr(row, 'acceptance_criteria'), [], isStringArray),
        graphId: rowStr(row, 'graph_id'),
        graphType: assertGraphType(rowStr(row, 'graph_type'), 'graphType'),
        parentId: rowOptStr(row, 'parent_id'),
        rules: safeJsonParse<GraphNode['rules']>(rowOptStr(row, 'rules'), undefined, isUnknownArray),
        metadata: safeJsonParse<GraphNode['metadata']>(rowOptStr(row, 'metadata'), undefined, isRecord),
        content: safeJsonParse<GraphNode['content']>(rowOptStr(row, 'content'), undefined, isRecord),
        communitySummary: rowOptStr(row, 'community_summary'),
        communityLevel: typeof row.community_level === 'number' ? row.community_level : undefined,
        contextRefs: safeJsonParse<GraphNode['contextRefs']>(rowOptStr(row, 'context_refs'), undefined, isUnknownArray),
        wikiContent: rowOptStr(row, 'wiki_content'),
        wikiMeta: safeJsonParse<GraphNode['wikiMeta']>(rowOptStr(row, 'wiki_meta'), undefined, isRecord),
        ownerRole: rowOptStr(row, 'owner_role') as GraphNode['ownerRole'],
        position: { x: rowNum(row, 'position_x'), y: rowNum(row, 'position_y') },
        createdAt: rowStr(row, 'created_at'),
        updatedAt: rowStr(row, 'updated_at'),
      })),
      edges: edgesRows.map((row) => ({
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
        content: safeJsonParse<GraphEdge['content']>(rowOptStr(row, 'content'), undefined, isRecord),
      })),
      bugs: bugsRows.map((row) => ({
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

  delete(id: string): void {
    const deleteGraph = this.db.transaction(() => {
      this.db.prepare('DELETE FROM edges WHERE graph_id = ?').run(id)
      // writeback_items 按 graph_id 显式删除（FK CASCADE 本可兜住，但这样与事务内
      // 其它表的显式删除模式一致，即使 FK pragma 被关也不会漏）
      this.db.prepare('DELETE FROM writeback_items WHERE graph_id = ?').run(id)
      this.db.prepare('DELETE FROM nodes WHERE graph_id = ?').run(id)
      this.db.prepare('DELETE FROM bug_nodes WHERE graph_id = ?').run(id)
      this.db.prepare('DELETE FROM snapshots WHERE graph_id = ?').run(id)
      this.db.prepare('DELETE FROM agent_logs WHERE graph_id = ?').run(id)
      this.db.prepare('DELETE FROM graphs WHERE id = ?').run(id)
    })
    deleteGraph()
  }

  /**
   * 只取一张图的 project_path。
   * get() 会把整张图的节点/边/缺陷全读出来，只为了一个字段太重。
   */
  getProjectPath(graphId: string): string | undefined {
    const row = this.db
      .prepare('SELECT project_path FROM graphs WHERE id = ?')
      .get(graphId) as { project_path?: string | null } | undefined
    return row?.project_path ?? undefined
  }

  getProjectPaths(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT project_path FROM graphs WHERE project_path IS NOT NULL'
    ).all() as Record<string, unknown>[]
    return rows
      .map((row) => row.project_path as string | null)
      .filter((p): p is string => p !== null && p !== undefined)
  }

  /**
   * 最近更新的图所属的项目路径 —— 用来回答「当前打开的是哪个项目」。
   * 没有带 project_path 的图时返回 undefined。
   */
  getMostRecentProjectPath(): string | undefined {
    const row = this.db.prepare(
      "SELECT project_path FROM graphs WHERE project_path IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
    ).get() as { project_path?: string } | undefined
    return row?.project_path
  }

  /** Query Writeback 项目级开关：true = 该项目强制关闭写回（仅全局开时生效） */
  isWritebackDisabled(graphId: string): boolean {
    const row = this.db.prepare('SELECT writeback_disabled FROM graphs WHERE id = ?').get(graphId) as { writeback_disabled: number | null } | undefined
    return row?.writeback_disabled === 1
  }

  /** 克隆在线图的所有节点和边到开发图（单事务保证原子性） */
  cloneGraphNodes(sourceGraphId: string, targetGraphId: string, targetGraphType: GraphType): void {
    const nodesRows = this.db.prepare('SELECT * FROM nodes WHERE graph_id = ?').all(sourceGraphId) as Record<string, unknown>[]
    const edgesRows = this.db.prepare('SELECT * FROM edges WHERE graph_id = ?').all(sourceGraphId) as Record<string, unknown>[]

    const idMap = new Map<string, string>()

    const insertNodeStmt = this.db.prepare(
      `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, sort_index, rules, metadata, content, owner_role,
        position_x, position_y, context_refs, wiki_content, wiki_meta, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const parentUpdateStmt = this.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?')
    const insertEdgeStmt = this.db.prepare(
      `INSERT INTO edges (
        id, source, target, label, edge_type, content, graph_id, description, data_flow, strength
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    // Single transaction for atomicity
    const cloneAll = this.db.transaction(() => {
      // Pass 1: Insert nodes (parent_id temporarily preserved from source)
      for (const row of nodesRows) {
        const originalId = rowStr(row, 'id')
        const newId = generateId('node')
        idMap.set(originalId, newId)

        const nodeType = assertNodeType(rowStr(row, 'type'))
        const rawStatus = rowStr(row, 'status')
        const status = nodeType === 'feature' && targetGraphType === 'dev'
          ? 'placeholder'
          : assertNodeStatus(rawStatus)

        // `collapsed` 故意**不**进 INSERT：新行拿列默认值 0（展开态）——
        // 折叠是开发者视角，从 online 派生出来的 dev 图应当是展开的（spec §4.2.1）。
        //
        // `parent_id` 用 `|| null` 归一：空串不是真实的节点 id，但在正常写入路径上可达
        // （node-repository 的 `data.parentId ?? null` 与 `String(data.parentId)` 都放行 ''），
        // 原样带过去会让目标图里出现 `parent_id = ''` 的节点，而 hierarchy-service 的
        // 子节点查询（getChildren / collectDescendants）没有 graph_id 过滤 ——
        // `WHERE parent_id = ''` 会命中**每一张图**里父 id 为空串的节点。
        insertNodeStmt.run(
          newId, nodeType, status, rowStr(row, 'title'),
          rowOptStr(row, 'description') ?? null,
          row['acceptance_criteria'],
          targetGraphId, assertGraphType(targetGraphType),
          row['parent_id'] || null,
          row['sort_index'],
          row['rules'], row['metadata'], row['content'], row['owner_role'],
          rowNum(row, 'position_x'), rowNum(row, 'position_y') + 20,
          row['context_refs'],
          row['wiki_content'],
          row['wiki_meta'],
          rowStr(row, 'created_at'), new Date().toISOString(),
        )
      }

      // Pass 2: Update parent_id mapping
      for (const [oldId, newId] of idMap) {
        const row = nodesRows.find((r) => rowStr(r, 'id') === oldId)
        if (!row) continue
        const oldParentId = rowOptStr(row, 'parent_id')
        // 没有父节点（NULL 或空串）：Pass 1 已经把它归一成 NULL 落库了，这里无需再 UPDATE。
        // 真实 id 但不在 idMap 里（父节点住在另一张图）的，落到下面的 else 分支置 NULL。
        if (!oldParentId) continue
        if (idMap.has(oldParentId)) {
          parentUpdateStmt.run(idMap.get(oldParentId)!, newId)
        } else {
          // 父节点不在源图里 —— parent_id 没有外键，Yjs 远端路径也不校验，
          // 所以「父节点住在另一张图」的脏数据是可能存在的。
          // 原样带过去会让目标图出现一条**跨图悬挂**的父子关系：
          // hierarchy-service.collectDescendants 的子节点查询没有 graph_id 过滤，
          // 顺着它会把目标图节点的后代遍历走进源图，graph:reparent 便可能把源图节点一起搬走。
          // 置 NULL —— 它在目标图里就是一个根节点（渲染层本来就按孤儿处理、不画父子线）。
          parentUpdateStmt.run(null, newId)
        }
      }

      // Pass 3: Copy edges
      for (const row of edgesRows) {
        // hierarchical 边必须与 parent_id 用**同一张** idMap 重映射，
        // 否则边会指向源图节点，与克隆出来的 parent_id 对不上。
        const newSourceId = idMap.get(rowStr(row, 'source'))
        const newTargetId = idMap.get(rowStr(row, 'target'))
        if (!newSourceId || !newTargetId) continue

        const newId = generateId('edge')
        insertEdgeStmt.run(
          newId, newSourceId, newTargetId,
          rowOptStr(row, 'label') ?? null, row['edge_type'], row['content'],
          targetGraphId, row['description'], row['data_flow'], row['strength'],
        )
      }
    })
    cloneAll()
  }
}
