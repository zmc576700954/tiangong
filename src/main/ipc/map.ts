/**
 * Map IPC Handlers（S2/S5a/S6a,session-map 蓝图 §9.2 L1 通道）
 *
 * L1 通道面：叠加层批量查询（禁止按节点轮询）、链接只读列表、节点会话时间线
 * （替代 threadStore 单线程映射,§9.5-3）、节点证据列表、work item 生命周期。
 * L2 通道（plan 系列、test 系列、evidence:suggestion 系列）随对应批次交付,此处不注册。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { LinkService, LinkValidationError } from '../map-migration/link-service'
import { runLinkIntegrityCheck } from '../map-migration/link-backfill'
import { WorkItemService } from '../map/work-item-service'
import { EvidenceService } from '../map/evidence-service'
import type { TypedHandle } from './utils'

export function registerMapHandlers(
  typedHandle: TypedHandle,
  db: BetterSqlite3.Database,
  broadcast?: (channel: string, ...args: unknown[]) => void,
): void {
  const links = new LinkService(db)
  const workItems = new WorkItemService(db)
  const evidence = new EvidenceService(db)

  // ---- 叠加层（§9.2:必须批量）----
  typedHandle('map:overlay:get', async (_, graphId: unknown) => {
    if (typeof graphId !== 'string' || graphId === '') throw new Error('graphId is required')
    const states = db
      .prepare('SELECT * FROM node_execution_state WHERE graph_id = ?')
      .all(graphId) as Array<Record<string, unknown>>
    const items = db
      .prepare(
        `SELECT id, lineage_id, revision, anchor_entity_key, title, status, gate_status, updated_at
           FROM work_items WHERE graph_id = ? AND is_current = 1
          ORDER BY updated_at DESC`,
      )
      .all(graphId) as Array<Record<string, unknown>>
    return { executionStates: states, workItems: items }
  })

  // ---- 链接只读列表 ----
  typedHandle('map:link:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { projectPath?: string; entityKey?: string }
    if (q.projectPath && q.entityKey) {
      return links.listByEntityKey(q.projectPath, q.entityKey)
    }
    if (q.projectPath) {
      return db
        .prepare("SELECT * FROM node_links WHERE project_path = ? AND status = 'active' ORDER BY created_at DESC LIMIT 500")
        .all(q.projectPath)
    }
    throw new Error('projectPath is required')
  })

  typedHandle('map:link:create', async (_, data) => {
    const linkType = (data as { linkType?: string })?.linkType ?? 'relates_to'
    if (linkType !== 'relates_to') {
      // §8.4：L1 人工入口只开 relates_to；其余 link_type 由系统回填/派生路径产生
      throw new LinkValidationError('matrix_violation', 'L1 期间人工创建仅允许 relates_to（其余类型由系统路径产生）')
    }
    const d = data as {
      projectPath: string
      fromEntityKey: string
      fromGraphId: string
      toEntityKey: string
      toGraphId: string
      reason?: string
    }
    return links.create({
      projectPath: d.projectPath,
      linkType: 'relates_to',
      fromEntityKey: d.fromEntityKey,
      fromGraphId: d.fromGraphId,
      toEntityKey: d.toEntityKey,
      toGraphId: d.toGraphId,
      origin: 'human',
      reason: d.reason,
    })
  })

  // ---- 节点会话时间线（§9.5-3:替代单线程映射;UI 保留 threadIds 全集）----
  typedHandle('map:node:timeline', async (_, query: unknown) => {
    const q = (query ?? {}) as { graphId?: string; nodeEntityKey?: string; limit?: number }
    if (typeof q.graphId !== 'string' || typeof q.nodeEntityKey !== 'string') {
      throw new Error('graphId and nodeEntityKey are required')
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500)
    const rows = db
      .prepare(
        `SELECT l.*, t.title AS thread_title, t.status AS thread_status, t.adapter_name AS thread_adapter
           FROM node_session_links l
           LEFT JOIN chat_threads t ON t.id = l.thread_id
          WHERE l.graph_id = ? AND l.node_entity_key = ?
          ORDER BY l.created_at DESC
          LIMIT ?`,
      )
      .all(q.graphId, q.nodeEntityKey, limit)
    return rows
  })

  // ---- 节点证据列表（只读）----
  typedHandle('map:node:evidence:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { graphId?: string; nodeEntityKey?: string }
    if (typeof q.graphId !== 'string' || typeof q.nodeEntityKey !== 'string') {
      throw new Error('graphId and nodeEntityKey are required')
    }
    return evidence.listForNode(q.graphId, q.nodeEntityKey)
  })

  // ---- work item 生命周期（§9.2:workitem:*）----
  typedHandle('workitem:get', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id is required')
    const row = workItems.get(id)
    if (!row) return null
    return { item: row, steps: workItems.listSteps(row.id, row.revision) }
  })

  typedHandle('workitem:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { graphId?: string; anchorEntityKey?: string; includeHistory?: boolean }
    if (typeof q.graphId !== 'string') throw new Error('graphId is required')
    const currentOnly = q.includeHistory !== true
    if (q.anchorEntityKey) {
      return db
        .prepare(
          `SELECT * FROM work_items WHERE graph_id = ? AND anchor_entity_key = ? ${currentOnly ? 'AND is_current = 1' : ''}
           ORDER BY updated_at DESC LIMIT 200`,
        )
        .all(q.graphId, q.anchorEntityKey)
    }
    return db
      .prepare(
        `SELECT * FROM work_items WHERE graph_id = ? ${currentOnly ? 'AND is_current = 1' : ''}
         ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(q.graphId)
  })

  typedHandle('workitem:create', async (_, data) => {
    const d = data as {
      projectPath?: string
      graphId: string
      anchorEntityKey?: string
      anchorNodeId?: string
      title: string
      goal?: string
      scopeFiles?: string[]
      acceptance?: Array<Record<string, unknown>>
      steps?: Array<{ title: string; stepKind?: 'agent' | 'test' | 'human' }>
      createdBy?: string
    }
    if (typeof d.graphId !== 'string' || !d.title) throw new Error('graphId and title are required')
    const row = workItems.createDraft({
      projectPath: d.projectPath,
      graphId: d.graphId,
      anchorEntityKey: d.anchorEntityKey,
      anchorNodeId: d.anchorNodeId,
      title: d.title,
      goal: d.goal,
      scopeFiles: d.scopeFiles,
      acceptance: d.acceptance,
      steps: d.steps,
      origin: 'human',
      createdBy: d.createdBy,
    })
    broadcast?.('event:work-item-changed', { lineageId: row.lineage_id, revision: row.revision, status: row.status })
    return row
  })

  typedHandle('workitem:revise', async (_, data) => {
    const d = data as { id: string; title?: string; goal?: string; scopeFiles?: string[]; acceptance?: Array<Record<string, unknown>> }
    if (typeof d.id !== 'string') throw new Error('id is required')
    const row = workItems.revise(d.id, {
      title: d.title,
      goal: d.goal,
      scope_files: d.scopeFiles ? JSON.stringify(d.scopeFiles) : undefined,
      acceptance_json: d.acceptance ? JSON.stringify(d.acceptance) : undefined,
    })
    broadcast?.('event:work-item-changed', { lineageId: row.lineage_id, revision: row.revision, status: row.status })
    return row
  })

  /**
   * run:start（§9.2:start 前必须 gate=pass/waived）——L1 人工单任务:
   * 提交确认 → gate 校验由调用方先写（本通道接收 gateResult 可选参数,人工 pass）
   * → confirm 入队。编排执行（自动 claim+驱动 run）随 L2 §5.9 交付。
   */
  typedHandle('workitem:run:start', async (_, data) => {
    const d = data as { id: string; gateResult?: 'pass' | 'waived'; waivedBy?: string; waiveReason?: string }
    if (typeof d.id !== 'string') throw new Error('id is required')
    let row = workItems.get(d.id)
    if (!row) throw new Error('work item not found')
    if (row.status === 'draft') {
      row = workItems.submitForConfirm(d.id)
    }
    if (d.gateResult) {
      workItems.setGateResult(d.id, d.gateResult, { waivedBy: d.waivedBy, waiveReason: d.waiveReason })
    }
    row = workItems.confirm(d.id)
    broadcast?.('event:work-item-changed', { lineageId: row.lineage_id, revision: row.revision, status: row.status })
    return row
  })

  typedHandle('workitem:cancel', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id is required')
    const row = workItems.cancel(id)
    broadcast?.('event:work-item-changed', { lineageId: row.lineage_id, revision: row.revision, status: row.status })
    return row
  })

  // ---- 巡检手动触发（§2.3.1：启动 + 每日 + 手动）----
  typedHandle('admin:map:integrity-check', async () => {
    return runLinkIntegrityCheck(db)
  })
}
