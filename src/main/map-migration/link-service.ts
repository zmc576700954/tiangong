/**
 * S2 LinkService（session-map 蓝图 §2.3 + §2.3.1 施工细则）
 *
 * 不变量（违反即拒绝写入）：
 *  - L1 必须带 project_path（规范化 realpath）；跨项目链接一律拒绝
 *  - L2 from/to entity_key 非空；不允许自链接
 *  - L3 两端必须能在 nodes(graph_id, entity_key) 解析——创建接口解析失败即拒绝
 *    （系统回填/巡检路径例外，可落 orphan 并写报告）
 *  - L4 (from,to,link_type) 唯一；relates_to 按端点键字典序规范化防 A→B/B→A 重复；
 *    冲突返回既有行（active 幂等返回；orphan/stale 复活为 active）
 *  - L5 link_type × 图类型方向矩阵强制（写入时校验，不靠语义约定）
 *  - L6 不建到 nodes 的外键；节点/图删除不得级联删除链接
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('LinkService')

export type LinkType =
  | 'derives_from'
  | 'implements'
  | 'verifies'
  | 'covers'
  | 'depends_on'
  | 'split_from'
  | 'merged_into'
  | 'supersedes'
  | 'relates_to'

export type GraphTypeValue = 'online' | 'dev' | 'test'
export type LinkOrigin = 'human' | 'derived' | 'import'
export type LinkStatus = 'active' | 'stale' | 'orphan'

export interface NodeLinkRow {
  id: string
  project_path: string
  from_entity_key: string
  from_graph_id: string
  from_graph_type: GraphTypeValue
  from_node_id: string | null
  to_entity_key: string
  to_graph_id: string
  to_graph_type: GraphTypeValue
  to_node_id: string | null
  link_type: LinkType
  direction: 'directed' | 'symmetric'
  confidence: number
  origin: LinkOrigin
  status: LinkStatus
  reason: string | null
  metadata: string | null
  created_at: string
  updated_at: string
}

/**
 * link_type × 图类型方向矩阵（§2.3.1）：不合法组合拒绝写入。
 * depends_on/split_from/merged_into/supersedes/relates_to 任意。
 */
export function isLinkTypeAllowed(linkType: LinkType, fromType: GraphTypeValue, toType: GraphTypeValue): boolean {
  switch (linkType) {
    case 'derives_from':
      return (fromType === 'dev' || fromType === 'test') && toType === 'online'
    case 'implements':
      return fromType === 'dev' && toType === 'online'
    case 'verifies':
      return fromType === 'test' && toType === 'dev'
    case 'covers':
      return fromType === 'test' && toType === 'online'
    default:
      return true
  }
}

export class LinkValidationError extends Error {
  constructor(
    public readonly code:
      | 'project_required'
      | 'cross_project'
      | 'empty_key'
      | 'self_link'
      | 'end_unresolvable'
      | 'matrix_violation'
      | 'link_not_found'
      | 'project_mismatch'
      | 'not_human_origin',
    message: string,
  ) {
    super(message)
    this.name = 'LinkValidationError'
  }
}

export interface CreateLinkInput {
  projectPath: string
  linkType: LinkType
  fromEntityKey: string
  fromGraphId: string
  toEntityKey: string
  toGraphId: string
  origin: LinkOrigin
  reason?: string
  metadata?: Record<string, unknown>
}

export interface DeleteLinkInput {
  id: string
  projectPath: string
  /** 删除原因（只进日志，不落库——行本身已删，没有可写回的列）。 */
  reason?: string
}

function normalizeProjectPath(p: string): string {
  return p.trim()
}

export class LinkService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * 创建/幂等复用链接。返回既有行（conflict/reuse）或新行（created）。
   * 单事务（BEGIN IMMEDIATE 语义由 better-sqlite3 transaction 保证）。
   */
  async create(input: CreateLinkInput): Promise<{ outcome: 'created' | 'reused' | 'revived'; row: NodeLinkRow }> {
    // L1：project_path 规范化 realpath；跨项目拒绝
    if (!input.projectPath || input.projectPath.trim() === '') {
      throw new LinkValidationError('project_required', 'node_links 必须携带 project_path（L1）')
    }
    const projectPath = await fs.realpath(normalizeProjectPath(input.projectPath)).catch(() => normalizeProjectPath(input.projectPath))

    // L2：非空 + 无自链接
    if (!input.fromEntityKey || !input.toEntityKey) {
      throw new LinkValidationError('empty_key', 'from/to entity_key 不能为空（L2）')
    }
    const selfLink =
      input.fromEntityKey === input.toEntityKey && input.fromGraphId === input.toGraphId
    if (selfLink) {
      throw new LinkValidationError('self_link', '不允许自链接（L2）')
    }

    // relates_to 端点字典序规范化（L4，防 A→B 与 B→A 重复）
    let { fromEntityKey, fromGraphId, toEntityKey, toGraphId } = input
    const linkType = input.linkType
    if (linkType === 'relates_to' && `${fromEntityKey}|${fromGraphId}` > `${toEntityKey}|${toGraphId}`) {
      ;[fromEntityKey, toEntityKey] = [toEntityKey, fromEntityKey]
      ;[fromGraphId, toGraphId] = [toGraphId, fromGraphId]
    }

    // 解析两端（L3）——必须在同一 project 下（L1 跨项目拒绝）。
    // 图类型以 nodes.graph_type 为准（graphs.type 是图级类型,节点级以其派生列存储）。
    const resolveEnd = (graphId: string, key: string) => {
      const graph = this.db
        .prepare('SELECT project_path FROM graphs WHERE id = ?')
        .get(graphId) as { project_path: string | null } | undefined
      if (!graph) {
        throw new LinkValidationError('end_unresolvable', `图 ${graphId} 不存在（L3）`)
      }
      if (graph.project_path !== projectPath) {
        throw new LinkValidationError('cross_project', `跨项目链接被拒绝：${graphId} 属于 ${graph.project_path ?? 'null'}（L1）`)
      }
      const node = this.db
        .prepare('SELECT id, graph_type FROM nodes WHERE graph_id = ? AND entity_key = ?')
        .get(graphId, key) as { id: string; graph_type: GraphTypeValue } | undefined
      if (!node) {
        throw new LinkValidationError('end_unresolvable', `端点不可解析：graph=${graphId} key=${key.slice(0, 8)}…（L3）`)
      }
      return node
    }
    const fromNode = resolveEnd(fromGraphId, fromEntityKey)
    const toNode = resolveEnd(toGraphId, toEntityKey)

    // L5：方向矩阵
    if (!isLinkTypeAllowed(linkType, fromNode.graph_type, toNode.graph_type)) {
      throw new LinkValidationError(
        'matrix_violation',
        `link_type=${linkType} 不允许 ${fromNode.graph_type}→${toNode.graph_type}（L5）`,
      )
    }

    const now = new Date().toISOString()
    const row: NodeLinkRow = {
      id: `nl_${Date.now()}_${randomUUID().slice(0, 8)}`,
      project_path: projectPath,
      from_entity_key: fromEntityKey,
      from_graph_id: fromGraphId,
      from_graph_type: fromNode.graph_type,
      from_node_id: fromNode.id,
      to_entity_key: toEntityKey,
      to_graph_id: toGraphId,
      to_graph_type: toNode.graph_type,
      to_node_id: toNode.id,
      link_type: linkType,
      direction: linkType === 'relates_to' ? 'symmetric' : 'directed',
      confidence: 1.0,
      origin: input.origin,
      status: 'active',
      reason: input.reason ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: now,
      updated_at: now,
    }

    const created = this.db.transaction((): { outcome: 'created' | 'reused' | 'revived'; row: NodeLinkRow } => {
      const existing = this.db
        .prepare(
          `SELECT * FROM node_links
            WHERE from_graph_id = ? AND from_entity_key = ?
              AND to_graph_id = ? AND to_entity_key = ? AND link_type = ?`,
        )
        .get(fromGraphId, fromEntityKey, toGraphId, toEntityKey, linkType) as NodeLinkRow | undefined
      if (existing) {
        if (existing.status === 'active') {
          return { outcome: 'reused', row: existing }
        }
        // orphan/stale → 复活为 active（§2.3.1 写入流程第 4 步）
        this.db
          .prepare("UPDATE node_links SET status = 'active', updated_at = ?, reason = ? WHERE id = ?")
          .run(now, input.reason ?? existing.reason, existing.id)
        return { outcome: 'revived', row: { ...existing, status: 'active', updated_at: now } }
      }
      this.db
        .prepare(
          `INSERT INTO node_links (
             id, project_path, from_entity_key, from_graph_id, from_graph_type, from_node_id,
             to_entity_key, to_graph_id, to_graph_type, to_node_id,
             link_type, direction, confidence, origin, status, reason, metadata, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id, row.project_path, row.from_entity_key, row.from_graph_id, row.from_graph_type, row.from_node_id,
          row.to_entity_key, row.to_graph_id, row.to_graph_type, row.to_node_id,
          row.link_type, row.direction, row.confidence, row.origin, row.status, row.reason, row.metadata,
          row.created_at, row.updated_at,
        )
      return { outcome: 'created', row }
    })

    const result = created()
    // §2.3.1 第 6 步：提交后发 event:map-link-changed——渲染层广播随 L1 IPC 交付接线，
    // 事务失败不广播（未提交即抛错，不会走到这里）。
    logger.info(`link ${result.outcome}: ${linkType} ${fromEntityKey.slice(0, 8)}…→${toEntityKey.slice(0, 8)}…`)
    return result
  }

  /** 按端点键查链接（叠加层只读展示用）。 */
  listByEntityKey(projectPath: string, entityKey: string): NodeLinkRow[] {
    return this.db
      .prepare(
        `SELECT * FROM node_links
          WHERE project_path = ? AND status = 'active'
            AND (from_entity_key = ? OR to_entity_key = ?)`,
      )
      .all(projectPath, entityKey, entityKey) as NodeLinkRow[]
  }

  /**
   * 删除人工创建的链接（§8.4：L1 人工入口的撤销路径）。
   *
   * 只删 `origin='human'` 的行：派生/导入链接由系统路径回填或巡检重建，人工删掉
   * 只会造成「删了又出现」的假象，所以显式拒绝而不是静默忽略。删除是硬删（行没了
   * 才是真的撤销），删除事实写日志，不写 node_links 状态列——`orphan` 语义是
   * 「端点不可解析」，不能拿来当墓碑。
   */
  async delete(input: DeleteLinkInput): Promise<NodeLinkRow> {
    if (!input.id || input.id.trim() === '') {
      throw new LinkValidationError('link_not_found', 'id 不能为空（删除必须指名道姓）')
    }
    if (!input.projectPath || input.projectPath.trim() === '') {
      throw new LinkValidationError('project_required', 'node_links 必须携带 project_path（L1）')
    }
    const projectPath = await fs
      .realpath(normalizeProjectPath(input.projectPath))
      .catch(() => normalizeProjectPath(input.projectPath))

    const removed = this.db.transaction((): NodeLinkRow => {
      const row = this.db.prepare('SELECT * FROM node_links WHERE id = ?').get(input.id) as
        | NodeLinkRow
        | undefined
      if (!row) {
        throw new LinkValidationError('link_not_found', `链接 ${input.id} 不存在`)
      }
      if (row.project_path !== projectPath) {
        throw new LinkValidationError(
          'project_mismatch',
          `链接 ${input.id} 属于 ${row.project_path}，不属于当前项目（L1）`,
        )
      }
      if (row.origin !== 'human') {
        throw new LinkValidationError(
          'not_human_origin',
          `链接 ${input.id} 由 ${row.origin} 路径产生，人工不可撤销（派生链接会被巡检重建）`,
        )
      }
      this.db.prepare('DELETE FROM node_links WHERE id = ?').run(input.id)
      return row
    })

    const row = removed()
    logger.info(
      `link deleted: ${row.id} ${row.link_type} ${row.from_entity_key.slice(0, 8)}…→${row.to_entity_key.slice(0, 8)}…` +
        (input.reason ? `（${input.reason}）` : ''),
    )
    return row
  }
}
