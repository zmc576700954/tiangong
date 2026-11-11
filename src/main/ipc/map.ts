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
import { BoundaryDerivationService, PlanDraftService, PlanDraftCycleError, itemKeys, type PlanItem } from '../map/plan-derivation'
import { buildC1Display, precheckDraftItems } from '../map/plan-draft-precheck'
import { buildWorkItemDiff, listWorkItemRevisions, recordReviseReason, type ProposedRevision } from '../map/work-item-revision'
import { createGateEngine } from '../map/gate-engine'
import { readG4Config } from '../map/work-execution-runtime'
import { WorkExecutionError } from '../map/work-execution-service'
import { getPublishedStatus } from '../map/published-guard'
import { getProjectProgress } from '../map/project-progress'
import { ProposalService } from '../map/proposal-service'
import { listModes } from '../map/mode-registry'
import { AcceptanceConfirmationError, AcceptanceConfirmationService } from '../map/acceptance-confirmation'
import { StepConfirmationError, StepConfirmationService } from '../map/step-confirmation-service'
import { assertConfirmationDisplay } from '../map/confirmation-points'
import { buildEstimateLines } from '../map/work-execution-runtime'
import type { WorkStepServiceOptions } from '../map/work-step-service'
import { getWorkExecutionService } from '../map/work-execution-registry'
import {
  MAP_EXECUTION_ADAPTER_ENV,
  MAP_EXECUTION_DISABLED_REASON,
  isMapExecutionEnabled,
  mapExecutionAdapter,
} from '../map/execution-flags'
import { missingTierCapabilities } from '../map/tier-probe'
import type { TypedHandle } from './utils'
import type { PlanDraftPreview } from '../../shared/types/ipc'

/** 分页上限（与 `map:node:timeline` 一致：1..500，非法值落回默认）。 */
function limitOf(value: unknown, fallback: number, max = 500): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

/** 确认点必填展示项入参（renderer 组装的展示数据；非对象一律按缺失处理）。 */
function displayOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function registerMapHandlers(
  typedHandle: TypedHandle,
  db: BetterSqlite3.Database,
  broadcast?: (channel: string, ...args: unknown[]) => void,
): void {
  const links = new LinkService(db)
  // G2-18：步级迁移事件统一走现有 item 变更通道（renderer 按 lineage 去抖重拉）。
  let workItems: WorkItemService
  const stepOptions: WorkStepServiceOptions = {
    onChanged: (event) => {
      const item = workItems.get(event.workItemId)
      if (!item) return
      broadcast?.('event:work-item-changed', {
        stepId: event.stepId,
        lineageId: item.lineage_id,
        revision: item.revision,
        status: event.status,
        reason: event.transition,
      })
    },
  }
  workItems = new WorkItemService(db, stepOptions)
  const workRuns = new WorkRunService(db)
  const evidence = new EvidenceService(db)
  const evidenceSuggestions = new EvidenceSuggestionService(db)
  const derivation = new BoundaryDerivationService(db)
  const planDrafts = new PlanDraftService(db, workItems)
  const acceptanceConfirm = new AcceptanceConfirmationService(db, stepOptions)
  // G2-10：C3/C4 步级确认。行数代理与 tick 闸共用同一个 estimator，避免同一
  // 步在「执行侧判定 high」而「确认视图判定 low」的两套结论。
  const stepConfirm = new StepConfirmationService(db, {
    ...stepOptions,
    estimateLines: buildEstimateLines(),
  })
  const proposals = new ProposalService(db)
  // I.8.F P1：C1 草稿级预检复用生产 gate 引擎（同一工厂、同一份 G4 配置与行数代理）。
  const draftGate = createGateEngine(db, { ...readG4Config(), estimateLines: buildEstimateLines() })
  /** 草稿 + C1 必填展示项投影；草稿不存在返回 null。 */
  const previewDraft = (id: string): PlanDraftPreview | null => {
    const draft = planDrafts.get(id)
    if (!draft) return null
    const items = JSON.parse(draft.items_json) as PlanItem[]
    const keys = itemKeys(items)
    const precheck = precheckDraftItems(draft, items, keys, draftGate)
    return {
      draft: {
        id: draft.id,
        lineage_id: draft.lineage_id,
        revision: draft.revision,
        graph_id: draft.graph_id,
        status: draft.status,
        updated_at: draft.updated_at,
      },
      display: buildC1Display(db, draft, items, keys, precheck),
    }
  }

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

  /**
   * E1 人工判断直写（写通道，G3-10）。
   *
   * 只接受「节点 + 判断文本 + 被判断对象引用」，等级与写入方由服务端固定为
   * E1/human；不接收 `actor`/`producedBy`，避免 renderer 自报身份。可选
   * `idempotencyKey` 保证同一次判断重复提交不产生第二条证据。renderer 入口归 G8。
   */
  typedHandle('map:evidence:e1:create', async (_, data: unknown) => {
    const d = (data ?? {}) as {
      graphId?: unknown
      nodeEntityKey?: unknown
      nodeId?: unknown
      projectPath?: unknown
      summary?: unknown
      ref?: unknown
      idempotencyKey?: unknown
    }
    if (typeof d.graphId !== 'string' || d.graphId === '') throw new Error('graphId is required')
    if (typeof d.nodeEntityKey !== 'string' || d.nodeEntityKey === '') {
      throw new Error('nodeEntityKey is required')
    }
    if (typeof d.summary !== 'string' || d.summary.trim() === '') throw new Error('summary is required')
    if (d.ref === undefined || d.ref === null) throw new Error('ref is required')
    if (d.nodeId !== undefined && typeof d.nodeId !== 'string') throw new Error('nodeId must be a string')
    if (d.projectPath !== undefined && typeof d.projectPath !== 'string') {
      throw new Error('projectPath must be a string')
    }
    if (d.idempotencyKey !== undefined && typeof d.idempotencyKey !== 'string') {
      throw new Error('idempotencyKey must be a string')
    }
    const result = evidence.createHumanJudgment({
      graphId: d.graphId,
      nodeEntityKey: d.nodeEntityKey,
      nodeId: d.nodeId,
      projectPath: d.projectPath,
      summary: d.summary,
      ref: d.ref,
      idempotencyKey: d.idempotencyKey,
    })
    return { evidenceId: result.row.id, reused: result.reused, row: result.row }
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

  // 执行开关只读状态：只读环境变量 + 能力票，不落库、不触发执行。
  typedHandle('map:execution:status', async () => {
    const enabled = isMapExecutionEnabled()
    const adapterName = mapExecutionAdapter() ?? null
    // G7-8：非 Tier 1（无写前审批）后端只能裸 spawn（只读或人工排期）；
    // 这里提前把结论告诉 UI，避免用户入队后才发现写步骤被拒。
    const inspection =
      enabled && adapterName ? getWorkExecutionService()?.inspectRouting(adapterName) ?? null : null
    const tier = inspection?.tier?.tier ?? null
    const tierMissing = inspection?.tier ? missingTierCapabilities(inspection.tier) : []
    let disabledReason: string | null
    if (!enabled) disabledReason = MAP_EXECUTION_DISABLED_REASON
    else if (!adapterName) disabledReason = `未配置 ${MAP_EXECUTION_ADAPTER_ENV}：无法确定执行器`
    else if (inspection && !inspection.ok) {
      disabledReason = `${inspection.reason}；该后端只能裸 spawn（只读或人工排期），写步骤会被拒绝`
    } else disabledReason = null
    return {
      enabled: enabled && (inspection ? inspection.ok : true),
      adapterName,
      disabledReason,
      tier,
      tierMissing,
    }
  })

  // G5-10 只读：项目进度聚合（节点/任务/证据分级）。项目无数据时返回空态并标注。
  typedHandle('map:project:progress', async (_, projectPath: unknown) => {
    if (typeof projectPath !== 'string' || projectPath === '') {
      throw new Error('projectPath is required')
    }
    const progress = getProjectProgress(db, projectPath)
    return {
      projectPath,
      available: progress !== null,
      nodesTotal: progress?.nodesTotal ?? 0,
      nodesVerified: progress?.nodesVerified ?? 0,
      itemsDone: progress?.itemsDone ?? 0,
      itemsFailed: progress?.itemsFailed ?? 0,
      evidenceByLevel: progress?.evidenceByLevel ?? {},
    }
  })

  // G2-13 只读：test 图 test-case 的发布徽标与统计（UI 不做，仅查询层）。
  // 只 SELECT；与 published 写路径共用同一 has_pass_evidence 判定。
  typedHandle('map:published:status', async (_, graphId: unknown) => {
    if (typeof graphId !== 'string' || graphId === '') throw new Error('graphId is required')
    return getPublishedStatus(db, graphId)
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
    const d = data as {
      id: string
      title?: string
      goal?: string
      scopeFiles?: string[]
      acceptance?: Array<Record<string, unknown>>
      dependsOn?: string[]
      reason?: string
      display?: unknown
    }
    if (typeof d.id !== 'string') throw new Error('id is required')
    // G2-10 C2：修订会置旧 revision superseded，必填展示项（diff/影响/原因/gate 结论）
    // 缺任一项即拒绝，不生成新 revision。
    const display = displayOf(d.display)
    assertConfirmationDisplay('C2', display)
    const before = workItems.get(d.id)
    if (!before) throw new Error('work item not found')
    const row = workItems.revise(d.id, {
      title: d.title,
      goal: d.goal,
      scope_files: d.scopeFiles ? JSON.stringify(d.scopeFiles) : undefined,
      acceptance_json: d.acceptance ? JSON.stringify(d.acceptance) : undefined,
      depends_on_json: d.dependsOn ? JSON.stringify(d.dependsOn) : undefined,
    })
    const reason =
      typeof d.reason === 'string' ? d.reason : typeof display?.reason === 'string' ? display.reason : ''
    // I.8.F P2：修订原因只在既有审计通道可写时留痕；不可写则返回 traced=false，
    // 由界面如实显示「未留痕」，不为此开 schema 变更。
    const audit = recordReviseReason(db, {
      lineageId: row.lineage_id,
      from: before.revision,
      to: row.revision,
      reason,
    })
    broadcast?.('event:work-item-changed', { lineageId: row.lineage_id, revision: row.revision, status: row.status })
    return { item: row, audit }
  })

  // I.8.F P2：C2 历史读通道（只 SELECT）。旧 revision 行本就在库，此前只有
  // `is_current = 1` 的读路径；这里按 lineage + revision 读，不改 is_current 语义。
  typedHandle('workitem:history', async (_, lineageId: unknown) => {
    if (typeof lineageId !== 'string' || lineageId === '') throw new Error('lineageId is required')
    return listWorkItemRevisions(db, lineageId)
  })

  // I.8.F P2：服务端字段级 diff + impact。`to` 对比历史两版；`proposed` 预检拟修订。
  typedHandle('workitem:diff', async (_, query: unknown) => {
    const q = (query ?? {}) as { lineageId?: unknown; from?: unknown; to?: unknown; proposed?: unknown }
    if (typeof q.lineageId !== 'string' || q.lineageId === '') throw new Error('lineageId is required')
    if (typeof q.from !== 'number' || !Number.isInteger(q.from)) throw new Error('from revision is required')
    if (q.to !== undefined && (typeof q.to !== 'number' || !Number.isInteger(q.to))) {
      throw new Error('to revision must be an integer')
    }
    if (q.proposed !== undefined && (!q.proposed || typeof q.proposed !== 'object' || Array.isArray(q.proposed))) {
      throw new Error('proposed must be an object')
    }
    return buildWorkItemDiff(db, draftGate, {
      lineageId: q.lineageId,
      from: q.from,
      to: q.to as number | undefined,
      proposed: q.proposed as ProposedRevision | undefined,
    })
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

  // ---- G2-10 C3/C4 步级确认（只读视图 + 决策写通道）----
  // 只对 test/human 步；agent 步不建计划期确认点（I.4 D-18），继续走 runtime
  // 的逐工具审批。风险等级由服务端派生，renderer 只读展示、不得复算（G8-3）。
  typedHandle('map:confirmation:status', async (_, query: unknown) => {
    const q = (query ?? {}) as { stepId?: unknown; workItemId?: unknown; revision?: unknown }
    if (typeof q.stepId === 'string' && q.stepId !== '') {
      return stepConfirm.inspect(q.stepId)
    }
    if (typeof q.workItemId === 'string' && q.workItemId !== '') {
      if (q.revision !== undefined && (typeof q.revision !== 'number' || !Number.isInteger(q.revision))) {
        throw new Error('revision must be an integer')
      }
      const workItem = workItems.get(q.workItemId)
      if (!workItem) return []
      const revision = typeof q.revision === 'number' ? q.revision : workItem.revision
      return stepConfirm.listForItem(q.workItemId, revision)
    }
    throw new Error('stepId or workItemId is required')
  })

  typedHandle('map:confirmation:decide', async (_, data: unknown) => {
    const d = (data ?? {}) as {
      stepId?: unknown
      decision?: unknown
      display?: unknown
      note?: unknown
      decidedBy?: unknown
    }
    if (typeof d.stepId !== 'string' || d.stepId === '') throw new Error('stepId is required')
    if (d.decision !== 'approve' && d.decision !== 'reject') {
      throw new Error("decision 必须为 'approve' 或 'reject'")
    }
    if (!d.display || typeof d.display !== 'object' || Array.isArray(d.display)) {
      // 必填展示项缺失时不允许「什么都没看就点确认」。
      throw new StepConfirmationError('CONFIRMATION_DISPLAY_MISSING', 'display 必填')
    }
    const view = stepConfirm.decide({
      stepId: d.stepId,
      decision: d.decision,
      display: d.display as Record<string, unknown>,
      note: typeof d.note === 'string' ? d.note : undefined,
      decidedBy: typeof d.decidedBy === 'string' ? d.decidedBy : undefined,
    })
    const item = workItems.get(view.workItemId)
    if (item) {
      broadcast?.('event:work-item-changed', {
        stepId: view.stepId,
        lineageId: item.lineage_id,
        revision: item.revision,
        status: item.status,
        reason: d.decision === 'approve' ? 'step_confirmation_approved' : 'step_confirmation_rejected',
      })
    }
    return view
  })

  // ---- G2-1 执行模式（只读；模式库是代码常量，不提供写通道）----
  typedHandle('mode:list', async () => listModes())

  // ---- G1-14 提案（§2.7 / II-02 / II-08 / II-21）----
  // 提案 = 对 online 事实的待采纳变更：读写都只落在 work_items / 只读视图，
  // handler 不调用任何 nodes/edges 写接口。采纳需要人工先在 online 图完成编辑，
  // 这里只收口提案状态并留审计主体。
  typedHandle('proposal:create', async (_, data) => {
    const d = (data ?? {}) as Record<string, unknown>
    if (typeof d.graphId !== 'string' || d.graphId === '') throw new Error('graphId is required')
    if (typeof d.anchorEntityKey !== 'string' || d.anchorEntityKey === '') {
      throw new Error('anchorEntityKey is required')
    }
    if (typeof d.title !== 'string' || d.title.trim() === '') throw new Error('title is required')
    if (typeof d.reason !== 'string' || d.reason.trim() === '') throw new Error('reason is required')
    if (d.after === undefined) throw new Error('after is required')
    if (d.weight !== undefined && typeof d.weight !== 'number') throw new Error('weight must be a number')
    if (d.evidenceRefs !== undefined && !Array.isArray(d.evidenceRefs)) {
      throw new Error('evidenceRefs must be an array of strings')
    }
    const result = proposals.create({
      projectPath: typeof d.projectPath === 'string' ? d.projectPath : undefined,
      graphId: d.graphId,
      anchorEntityKey: d.anchorEntityKey,
      anchorNodeId: typeof d.anchorNodeId === 'string' ? d.anchorNodeId : undefined,
      title: d.title,
      reason: d.reason,
      before: d.before,
      after: d.after,
      evidenceRefs: (d.evidenceRefs as unknown[] | undefined)?.filter((v): v is string => typeof v === 'string'),
      baseRevision: typeof d.baseRevision === 'string' ? d.baseRevision : undefined,
      conflictGroup: typeof d.conflictGroup === 'string' ? d.conflictGroup : undefined,
      weight: typeof d.weight === 'number' ? d.weight : undefined,
      createdBy: typeof d.createdBy === 'string' ? d.createdBy : undefined,
    })
    broadcast?.('event:proposal-changed', {
      graphId: d.graphId,
      nodeEntityKey: d.anchorEntityKey,
      proposalId: String(result.row.id),
      status: String(result.row.status),
    })
    return result.row
  })

  typedHandle('proposal:list', async (_, query: unknown) => {
    const q = (query ?? {}) as { graphId?: unknown; anchorEntityKey?: unknown; includeResolved?: unknown; limit?: unknown }
    if (q.graphId !== undefined && typeof q.graphId !== 'string') throw new Error('graphId must be a string')
    if (q.anchorEntityKey !== undefined && typeof q.anchorEntityKey !== 'string') {
      throw new Error('anchorEntityKey must be a string')
    }
    if (typeof q.graphId !== 'string' && typeof q.anchorEntityKey !== 'string') {
      throw new Error('graphId or anchorEntityKey is required')
    }
    return proposals.list({
      graphId: typeof q.graphId === 'string' && q.graphId !== '' ? q.graphId : undefined,
      anchorEntityKey: typeof q.anchorEntityKey === 'string' && q.anchorEntityKey !== '' ? q.anchorEntityKey : undefined,
      includeResolved: q.includeResolved === true,
      limit: limitOf(q.limit, 100, 200),
    })
  })

  typedHandle('proposal:diff', async (_, id: unknown) => {
    if (typeof id !== 'string' || id === '') throw new Error('id is required')
    return proposals.diff(id)
  })

  typedHandle('proposal:accept', async (_, data) => {
    const d = (data ?? {}) as { id?: unknown; acceptedBy?: unknown }
    if (typeof d.id !== 'string' || d.id === '') throw new Error('id is required')
    if (typeof d.acceptedBy !== 'string' || d.acceptedBy.trim() === '') {
      throw new Error('acceptedBy is required')
    }
    const result = proposals.accept(d.id, { acceptedBy: d.acceptedBy })
    broadcast?.('event:proposal-changed', {
      graphId: String(result.row.graph_id),
      nodeEntityKey: String(result.row.anchor_entity_key),
      proposalId: d.id,
      status: String(result.row.status),
    })
    return { proposal: result.row, reused: result.reused }
  })

  typedHandle('proposal:reject', async (_, data) => {
    const d = (data ?? {}) as { id?: unknown; reason?: unknown; rejectedBy?: unknown }
    if (typeof d.id !== 'string' || d.id === '') throw new Error('id is required')
    if (typeof d.reason !== 'string' || d.reason.trim() === '') throw new Error('reason is required')
    if (d.rejectedBy !== undefined && typeof d.rejectedBy !== 'string') {
      throw new Error('rejectedBy must be a string')
    }
    const result = proposals.reject(d.id, {
      reason: d.reason,
      rejectedBy: typeof d.rejectedBy === 'string' ? d.rejectedBy : undefined,
    })
    broadcast?.('event:proposal-changed', {
      graphId: String(result.row.graph_id),
      nodeEntityKey: String(result.row.anchor_entity_key),
      proposalId: d.id,
      status: String(result.row.status),
    })
    return { proposal: result.row, reused: result.reused }
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

  // C1 必经一步：createDraft 落 draft，confirm 只接受 awaiting_confirm；
  // 此前没有任何 submit 通道，导致新草稿永远确认不了。这里补最小写通道。
  typedHandle('plan:draft:submit', async (_, id: unknown) => {
    if (typeof id !== 'string') throw new Error('id is required')
    return planDrafts.submit(id)
  })

  // I.8.F P1：C1 读通道。展示项由服务端投影，renderer 只显示、不复算 gate。
  typedHandle('plan:draft:preview', async (_, id: unknown) => {
    if (typeof id !== 'string' || id === '') throw new Error('id is required')
    return previewDraft(id)
  })

  typedHandle('plan:draft:list', async (_, graphId: unknown) => {
    if (typeof graphId !== 'string' || graphId === '') throw new Error('graphId is required')
    const rows = db
      .prepare(
        `SELECT id FROM plan_drafts
          WHERE graph_id = ? AND is_current = 1 AND status IN ('draft','awaiting_confirm')
          ORDER BY updated_at DESC`,
      )
      .all(graphId) as Array<{ id: string }>
    return {
      drafts: rows
        .map((row) => previewDraft(row.id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    }
  })

  typedHandle('plan:draft:revise', async (_, data) => {
    const d = (data ?? {}) as { id?: unknown; items?: unknown }
    if (typeof d.id !== 'string' || !Array.isArray(d.items)) throw new Error('id and items are required')
    return planDrafts.revise(d.id, d.items as never)
  })

  typedHandle('plan:draft:confirm', async (_, data) => {
    const d = (data ?? {}) as { id?: unknown; confirmedBy?: unknown; display?: unknown }
    if (typeof d.id !== 'string') throw new Error('id is required')
    // G2-10 C1：确认即生成 work_items 且不可原地回退，必填展示项缺任一项即拒绝。
    assertConfirmationDisplay('C1', displayOf(d.display))
    try {
      const result = planDrafts.confirm(d.id, {
        confirmedBy: typeof d.confirmedBy === 'string' ? d.confirmedBy : undefined,
      })
      // 确认生成 work_items：按既有语义逐个广播，renderer 按 lineage 去抖重拉。
      for (const workItemId of result.workItemIds) {
        const item = workItems.get(workItemId)
        if (!item) continue
        broadcast?.('event:work-item-changed', {
          lineageId: item.lineage_id,
          revision: item.revision,
          status: item.status,
        })
      }
      return result
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
