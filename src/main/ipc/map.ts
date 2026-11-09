/**
 * Map IPC Handlers（S2/S5a/S6a,session-map 蓝图 §9.2 L1 通道）
 *
 * L1 通道面：叠加层批量查询（禁止按节点轮询）、链接只读列表、节点会话时间线
 * （替代 threadStore 单线程映射,§9.5-3）、节点证据列表、work item 生命周期。
 * L2 通道（plan 系列、test 系列、evidence:suggestion 系列）随对应批次交付,此处不注册。
 *
 * 只读查询段（run / step / work_item / 证据 / 派生状态）：本文件里的只读通道
 * 全部只 SELECT；派生状态沿用 `map:overlay:get` 的刷新语义（读缓存前先
 * `flushPendingRecomputes` + 按图惰性刷新 `derivation_version < 2`），不另造一套。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { LinkService, LinkValidationError } from '../map-migration/link-service'
import { runLinkIntegrityCheck } from '../map-migration/link-backfill'
import { WorkItemService } from '../map/work-item-service'
import { WorkRunService, WORK_RUN_STATUSES, type WorkRunStatus } from '../map/work-run-service'
import { EvidenceService, EvidenceSuggestionService, type SuggestionStatus } from '../map/evidence-service'
import { flushPendingRecomputes, refreshStaleDerivationsForGraph } from '../map/execution-state'
import { BoundaryDerivationService, PlanDraftService, PlanDraftCycleError } from '../map/plan-derivation'
import { WorkExecutionError } from '../map/work-execution-service'
import { AcceptanceConfirmationError, AcceptanceConfirmationService } from '../map/acceptance-confirmation'
import { getWorkExecutionService } from '../map/work-execution-registry'
import type { TypedHandle } from './utils'

/** 分页上限（与 `map:node:timeline` 一致：1..500，非法值落回默认）。 */
function limitOf(value: unknown, fallback: number, max = 500): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

export function registerMapHandlers(
  typedHandle: TypedHandle,
  db: BetterSqlite3.Database,
  broadcast?: (channel: string, ...args: unknown[]) => void,
): void {
  const links = new LinkService(db)
  const workItems = new WorkItemService(db)
  const workRuns = new WorkRunService(db)
  const evidence = new EvidenceService(db)
  const evidenceSuggestions = new EvidenceSuggestionService(db)
  const derivation = new BoundaryDerivationService(db)
  const planDrafts = new PlanDraftService(db, workItems)
  const acceptanceConfirm = new AcceptanceConfirmationService(db)

  // ---- 叠加层（§9.2:必须批量）----
  typedHandle('map:overlay:get', async (_, graphId: unknown) => {
    if (typeof graphId !== 'string' || graphId === '') throw new Error('graphId is required')
    // 读缓存前先兑现挂起的派生重算（500ms 去抖窗口内状态刚变、缓存还没更新）。
    flushPendingRecomputes(db, graphId)
    // 派生逻辑版本升级后按图惰性刷新旧缓存（v2 起：多 lineage 聚合）。
    refreshStaleDerivationsForGraph(db, graphId)
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

  // ---- 证据建议（只读列表）----
  typedHandle('map:evidence:suggestions:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { graphId?: unknown; nodeEntityKey?: unknown; status?: unknown; limit?: unknown }
    if (typeof q.graphId !== 'string' || q.graphId === '') throw new Error('graphId is required')
    if (q.nodeEntityKey !== undefined && typeof q.nodeEntityKey !== 'string') {
      throw new Error('nodeEntityKey must be a string')
    }
    const status = q.status
    if (status !== undefined && status !== 'pending' && status !== 'accepted' && status !== 'dismissed') {
      throw new Error('status must be pending, accepted or dismissed')
    }
    const limit = limitOf(q.limit, 200)
    return typeof q.nodeEntityKey === 'string'
      ? evidenceSuggestions.listForNode(q.graphId, q.nodeEntityKey, status as SuggestionStatus | undefined, limit)
      : evidenceSuggestions.list(q.graphId, (status as SuggestionStatus | undefined) ?? 'pending', limit)
  })

  /**
   * 建议接受（写通道）：同一事务内改建议状态 + 写 node_evidence（§3.4/§3.7.1）。
   *
   * 幂等键：建议 id。已接受再次调用返回既有证据（按 ref_json.suggestionId 定位），
   * 不产生第二条证据；不存在/已驳回/并发修改一律拒绝，不做静默降级。
   * 权限边界：仅 preload 白名单内的本地 renderer 可调用；必须提供 resolvedBy 作为
   * 审计主体，主进程不代填默认用户，也不接受远端调用。
   */
  typedHandle('map:evidence:suggestion:accept', async (_, data: unknown) => {
    const d = (data ?? {}) as { id?: unknown; resolvedBy?: unknown }
    if (typeof d.id !== 'string' || d.id === '') throw new Error('id is required')
    if (typeof d.resolvedBy !== 'string' || d.resolvedBy.trim() === '') {
      throw new Error('resolvedBy is required')
    }
    const result = evidenceSuggestions.accept(d.id, d.resolvedBy)
    broadcast?.('event:evidence-suggestion-changed', {
      graphId: result.suggestion.graph_id,
      nodeEntityKey: result.suggestion.node_entity_key,
      suggestionId: result.suggestion.id,
      status: result.suggestion.status,
      evidenceId: result.evidence.id,
    })
    return {
      suggestion: result.suggestion,
      evidenceId: result.evidence.id,
      reused: result.reused,
    }
  })

  /** 建议驳回（写通道）：只改状态、不写证据；幂等键同 accept（建议 id）。 */
  typedHandle('map:evidence:suggestion:dismiss', async (_, data: unknown) => {
    const d = (data ?? {}) as { id?: unknown; resolvedBy?: unknown }
    if (typeof d.id !== 'string' || d.id === '') throw new Error('id is required')
    if (typeof d.resolvedBy !== 'string' || d.resolvedBy.trim() === '') {
      throw new Error('resolvedBy is required')
    }
    const row = evidenceSuggestions.dismiss(d.id, d.resolvedBy)
    broadcast?.('event:evidence-suggestion-changed', {
      graphId: row.graph_id,
      nodeEntityKey: row.node_entity_key,
      suggestionId: row.id,
      status: row.status,
    })
    return row
  })

  // ---- work item 生命周期（§9.2:workitem:*）----
  /**
   * item 下钻的最小闭包：item 本体 + 当前 revision 的 steps + 该 item 的全部 runs。
   * 叠加层里的派生状态是单值折叠,明细必须从 steps/runs 取（§5.9 执行事实在 work_runs）。
   * 只读：不 flush 派生缓存（steps/runs 不读 `node_execution_state`）。
   */
  typedHandle('workitem:get', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id is required')
    const row = workItems.get(id)
    if (!row) return null
    return {
      item: row,
      steps: workItems.listStepsForRead(row.id, row.revision, 500),
      runs: workRuns.list({ workItemId: row.id, limit: 500 }),
    }
  })

  typedHandle('workitem:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { graphId?: string; anchorEntityKey?: string; includeHistory?: boolean; limit?: unknown }
    if (typeof q.graphId !== 'string') throw new Error('graphId is required')
    const currentOnly = q.includeHistory !== true
    const limit = limitOf(q.limit, 200)
    const filter = `${currentOnly ? 'AND is_current = 1' : ''}`
    if (q.anchorEntityKey) {
      return db
        .prepare(
          `SELECT * FROM work_items WHERE graph_id = ? AND anchor_entity_key = ? ${filter}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(q.graphId, q.anchorEntityKey, limit)
    }
    return db
      .prepare(
        `SELECT * FROM work_items WHERE graph_id = ? ${filter}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(q.graphId, limit)
  })

  // ---- step 只读列表（item 下钻；含 v34 的 skip_reason / failure_class）----
  typedHandle('workitem:steps:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { workItemId?: unknown; revision?: unknown; limit?: unknown }
    if (typeof q.workItemId !== 'string' || q.workItemId === '') {
      throw new Error('workItemId is required')
    }
    const item = workItems.get(q.workItemId)
    if (!item) return []
    const revision = typeof q.revision === 'number' && Number.isInteger(q.revision) ? q.revision : item.revision
    return workItems.listStepsForRead(item.id, revision, limitOf(q.limit, 200))
  })

  // ---- run 只读查询（work_runs 是执行事实;只 SELECT,不 enqueue/不触发重算）----
  typedHandle('map:run:list', async (_, query: unknown) => {
    const q = (query ?? {}) as {
      workItemId?: unknown; stepId?: unknown; graphId?: unknown; status?: unknown; limit?: unknown
    }
    const selectors = [q.workItemId, q.stepId, q.graphId].filter((v) => typeof v === 'string' && v !== '')
    if (selectors.length === 0) throw new Error('workItemId, stepId or graphId is required')
    for (const [label, value] of [['workItemId', q.workItemId], ['stepId', q.stepId], ['graphId', q.graphId]] as const) {
      if (value !== undefined && typeof value !== 'string') throw new Error(`${label} must be a string`)
    }
    let status: WorkRunStatus | undefined
    if (q.status !== undefined) {
      if (typeof q.status !== 'string' || !WORK_RUN_STATUSES.includes(q.status as WorkRunStatus)) {
        throw new Error(`status must be one of ${WORK_RUN_STATUSES.join(',')}`)
      }
      status = q.status as WorkRunStatus
    }
    return workRuns.list({
      workItemId: typeof q.workItemId === 'string' && q.workItemId !== '' ? q.workItemId : undefined,
      stepId: typeof q.stepId === 'string' && q.stepId !== '' ? q.stepId : undefined,
      graphId: typeof q.graphId === 'string' && q.graphId !== '' ? q.graphId : undefined,
      status,
      limit: limitOf(q.limit, 100),
    })
  })

  typedHandle('map:run:get', async (_, id: unknown) => {
    if (typeof id !== 'string' || id === '') throw new Error('id is required')
    return workRuns.get(id) ?? null
  })

  // ---- 证据只读（item 下钻;节点维度仍走 map:node:evidence:list）----
  typedHandle('workitem:evidence:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { workItemId?: unknown; limit?: unknown }
    if (typeof q.workItemId !== 'string' || q.workItemId === '') {
      throw new Error('workItemId is required')
    }
    return evidence.listForWorkItem(q.workItemId, limitOf(q.limit, 200))
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

  // ---- L2 执行触发（写通道；默认关闭，见 map/execution-flags.ts）----
  // 与只读白名单严格分离：这两个通道会写 work_runs / work_steps，绝不能进
  // MAP_READ_ONLY_CHANNELS。handler 只做「入队 / 条件更新取消」，turn 由主进程
  // tick 异步驱动，不在这里内联执行。
  function requireWorkExecution() {
    const service = getWorkExecutionService()
    if (!service) throw new Error('执行触发服务未装配：拒绝执行（fail-closed）')
    return service
  }

  typedHandle('workitem:step:run', async (_, data) => {
    const d = (data ?? {}) as {
      stepId?: unknown
      workItemId?: unknown
      adapterName?: unknown
      deadlineAt?: unknown
    }
    if (typeof d.stepId !== 'string' || d.stepId === '') throw new Error('stepId is required')
    if (typeof d.adapterName !== 'string' || d.adapterName.trim() === '') {
      throw new WorkExecutionError('ROUTE_MISSING', 'adapterName 必填：没有 pinned adapter 就没有路由结论')
    }
    const result = requireWorkExecution().enqueueStep({
      stepId: d.stepId,
      workItemId: typeof d.workItemId === 'string' ? d.workItemId : undefined,
      adapterName: d.adapterName,
      deadlineAt: typeof d.deadlineAt === 'number' ? d.deadlineAt : undefined,
    })
    broadcast?.('event:work-item-changed', {
      lineageId: result.run.work_item_lineage_id,
      revision: result.run.work_item_revision,
      status: workItems.get(result.run.work_item_id)?.status ?? 'queued',
      reason: 'run_enqueued',
    })
    return { runId: result.run.id, stepId: d.stepId, status: result.run.status, reused: result.reused }
  })

  typedHandle('workitem:run:cancel', async (_, id: unknown) => {
    if (typeof id !== 'string' || id === '') throw new Error('runId is required')
    const result = await requireWorkExecution().cancelRun(id)
    broadcast?.('event:work-item-changed', {
      lineageId: result.run.work_item_lineage_id,
      revision: result.run.work_item_revision,
      status: result.itemStatus ?? result.run.status,
      reason: result.cancelled ? 'run_cancelled' : 'run_terminal',
    })
    return {
      runId: result.run.id,
      status: result.run.status,
      cancelled: result.cancelled,
      alreadyTerminal: result.alreadyTerminal,
      itemStatus: result.itemStatus,
    }
  })

  /**
   * D2 manual 验收人工确认（写通道）：只记录确认事实并重算验收，不触发 turn。
   * 部分确认允许；重算仍有硬失败 → verify_fail，仍有未确认 manual → 继续等待。
   */
  typedHandle('workitem:acceptance:confirm', async (_, data) => {
    const d = (data ?? {}) as {
      stepId?: unknown
      workItemId?: unknown
      entryIds?: unknown
      note?: unknown
      confirmedBy?: unknown
    }
    if (typeof d.stepId !== 'string' && typeof d.workItemId !== 'string') {
      throw new AcceptanceConfirmationError('CONFIRM_INPUT_REQUIRED', 'stepId 或 workItemId 必填')
    }
    const entryIds = Array.isArray(d.entryIds)
      ? d.entryIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : []
    if (entryIds.length === 0) {
      throw new AcceptanceConfirmationError('CONFIRM_INPUT_REQUIRED', 'entryIds 不能为空')
    }
    const result = await acceptanceConfirm.confirm({
      stepId: typeof d.stepId === 'string' ? d.stepId : undefined,
      workItemId: typeof d.workItemId === 'string' ? d.workItemId : undefined,
      entryIds,
      note: typeof d.note === 'string' ? d.note : undefined,
      confirmedBy: typeof d.confirmedBy === 'string' ? d.confirmedBy : undefined,
    })
    broadcast?.('event:work-item-changed', {
      lineageId: result.lineageId,
      revision: result.revision,
      status: result.itemStatus,
      reason: result.stepStatus === 'needs_input' ? 'acceptance_partial_confirmed' : 'acceptance_confirmed',
    })
    return {
      stepId: result.stepId,
      workItemId: result.workItemId,
      stepStatus: result.stepStatus,
      itemStatus: result.itemStatus,
      remainingEntryIds: result.remainingEntryIds,
      confirmationBatchId: result.confirmationBatchId,
      confirmationIds: result.confirmationIds,
    }
  })

  // ---- S7 计划推导/草稿（§9.2 plan:*）----
  typedHandle('plan:derive-candidates', async (_, data) => {
    const d = (data ?? {}) as { graphId?: unknown; anchorNodeId?: unknown; changeFiles?: unknown }
    if (typeof d.graphId !== 'string') throw new Error('graphId is required')
    return derivation.derive(d.graphId, {
      anchorNodeId: typeof d.anchorNodeId === 'string' ? d.anchorNodeId : undefined,
      changeFiles: Array.isArray(d.changeFiles) ? (d.changeFiles as string[]) : undefined,
    })
  })

  typedHandle('plan:draft:create', async (_, data) => {
    const d = (data ?? {}) as Record<string, unknown>
    if (typeof d.graphId !== 'string' || !Array.isArray(d.items)) throw new Error('graphId and items are required')
    return planDrafts.createDraft({
      projectPath: typeof d.projectPath === 'string' ? d.projectPath : undefined,
      graphId: d.graphId,
      anchorEntityKey: typeof d.anchorEntityKey === 'string' ? d.anchorEntityKey : undefined,
      anchorNodeId: typeof d.anchorNodeId === 'string' ? d.anchorNodeId : undefined,
      derivationRunId: typeof d.derivationRunId === 'string' ? d.derivationRunId : undefined,
      items: d.items as never,
    })
  })

  typedHandle('plan:draft:get', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id is required')
    return planDrafts.get(id) ?? null
  })

  typedHandle('plan:draft:revise', async (_, data) => {
    const d = (data ?? {}) as { id?: unknown; items?: unknown }
    if (typeof d.id !== 'string' || !Array.isArray(d.items)) throw new Error('id and items are required')
    return planDrafts.revise(d.id, d.items as never)
  })

  typedHandle('plan:draft:confirm', async (_, data) => {
    const d = (data ?? {}) as { id?: unknown; confirmedBy?: unknown }
    if (typeof d.id !== 'string') throw new Error('id is required')
    try {
      return planDrafts.confirm(d.id, { confirmedBy: typeof d.confirmedBy === 'string' ? d.confirmedBy : undefined })
    } catch (err) {
      // 环检测拒绝带结构化环路径(渲染层 C1 展示)
      if (err instanceof PlanDraftCycleError) {
        throw new Error(`${err.message}|cycle=${JSON.stringify(err.cycle)}`)
      }
      throw err
    }
  })

  typedHandle('plan:draft:reject', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id is required')
    return planDrafts.reject(id)
  })

  // ---- 巡检手动触发（§2.3.1：启动 + 每日 + 手动）----
  typedHandle('admin:map:integrity-check', async () => {
    return runLinkIntegrityCheck(db)
  })
}
