/**
 * MapStore（S5a/S6a L1 渲染层）
 *
 * 叠加层批量查询 + 节点时间线/证据/任务。§9.5-3:节点会话时间线来自
 * map:node:timeline(全集 threadIds),不再依赖 threadStore 的单线程映射;
 * 派生态(execution_state)与人写 nodes.status 并列展示、不互写(§3.1)。
 */

import { create } from 'zustand'

/** workitem 通道返回行(与主进程 work_items 列对应;渲染层不直接 import main 代码)。 */
interface WorkItemRowLike {
  id: string
  lineage_id: string
  revision: number
  anchor_entity_key: string | null
  title: string
  status: string
  gate_status: string
  /** gate 未通过时缺的检查项（JSON string[]）；用于禁用执行入口并说明原因。 */
  gate_missing_json?: string | null
  cancel_reason?: string | null
  updated_at: string
}

export type ExecutionStateValue =
  | 'untouched' | 'planned' | 'in_progress' | 'implemented'
  | 'verified' | 'signed_off' | 'failed' | 'blocked' | 'stale'

export interface ExecutionStateEntry {
  node_entity_key: string
  execution_state: ExecutionStateValue
  evidence_level: string
  stale_count: number
  computed_at: number
}

export interface WorkItemSummary {
  id: string
  lineage_id: string
  revision: number
  anchor_entity_key: string | null
  title: string
  status: string
  gate_status: string
  gate_missing_json?: string | null
  cancel_reason?: string | null
  updated_at: string
}

export interface TimelineEntry {
  id: string
  thread_id: string
  thread_title: string | null
  thread_status: string | null
  thread_adapter: string | null
  link_role: string
  session_origin: string
  started_at: number | null
  ended_at: number | null
  created_at: number
}

export interface EvidenceEntry {
  id: string
  evidence_level: string
  evidence_type: string
  freshness: string
  produced_by: string
  summary: string | null
  created_at: string
  revoked_at: string | null
  /** G8-5：归属任务（node_evidence.work_item_id；主进程 SELECT * 已返回，渲染层只读）。 */
  work_item_id?: string | null
  /** G8-5：归属运行（node_evidence.work_run_id）；用于「步 → run → 证据」分层。 */
  work_run_id?: string | null
}

/** §3.4 证据建议行（evidence_suggestions）：列表只读，接受/驳回是人工裁决写通道。 */
export interface EvidenceSuggestionEntry {
  id: string
  graph_id: string
  node_entity_key: string
  suggested_level: string
  evidence_type: string
  rationale: string
  confidence: number
  status: string
  produced_by_run_id: string | null
  created_at: string
}

/**
 * node_links 只读行（人工连边列表）。
 *
 * 只有 `origin='human'` 的行可删：派生/导入链接由系统路径回填，删了会被重建，
 * 主进程因此显式拒绝（UI 侧据 origin 决定是否显示删除入口）。
 */
export interface NodeLinkEntry {
  id: string
  project_path: string
  from_entity_key: string
  to_entity_key: string
  link_type: string
  origin: string
  status: string
  reason: string | null
  created_at: string
}

/** work_steps 只读出参（workitem:get / workitem:steps:list 的显式列集合子集）。 */export interface WorkStepEntry {
  id: string
  work_item_id: string
  work_item_revision: number
  seq: number
  title: string
  step_kind: string
  status: string
  attempt: number
  depends_on_step_ids_json: string | null
  skip_reason: string | null
  failure_class: string | null
  /** manual 验收待确认请求（kind=acceptance_manual_confirm）；needs_input 时非空。 */
  input_request_json: string | null
  started_at: number | null
  ended_at: number | null
}

/** work_runs 只读出参（执行事实；failure_class 来自 agent_turns 映射）。 */
export interface WorkRunEntry {
  id: string
  work_item_id: string
  work_item_lineage_id: string
  work_item_revision: number
  step_id: string | null
  run_seq: number
  attempt: number
  executor_kind: string
  status: string
  failure_class: string | null
  /** 失败/完成摘要（work_runs.result_summary，运行时已返回，类型此前漏声明）。 */
  result_summary?: string | null
  /** 取消归因（work_runs.cancel_reason）。 */
  cancel_reason?: string | null
  /** 实际路由到的执行器（work_runs.adapter_name）。 */
  adapter_name?: string | null
  created_at: number
  started_at: number | null
  ended_at: number | null
}

/** G1-14：online 提案列表行（来自只读视图 v_online_proposals）。 */
export interface ProposalEntry {
  id: string
  lineage_id: string
  revision: number
  project_path: string | null
  graph_id: string
  anchor_entity_key: string
  title: string
  status: string
  cancel_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  base_revision: string | null
  conflict_group: string | null
  weight: number | null
  truncated: number | null
  reject_reason: string | null
  online_updated_at: string | null
  stale: number
}

/** G1-14：提案 diff（proposal:diff）；before/after 已在主进程解析/截断。 */
export interface ProposalDiffView {
  id: string
  graphId: string
  nodeEntityKey: string
  status: string
  title: string
  reason: string | null
  evidenceRefs: string[]
  baseRevision: string | null
  onlineUpdatedAt: string | null
  conflictGroup: string | null
  weight: number | null
  truncated: boolean
  stale: boolean
  rejectReason: string | null
  before: unknown
  after: unknown
  beforeText: string
  afterText: string
}

/** 执行开关只读状态（map:execution:status），用于禁用入口并解释原因。 */
export interface ExecutionStatus {
  enabled: boolean
  adapterName: string | null
  disabledReason: string | null
  /** G7-8：pinned adapter 能力票；null/缺省 = 未探测。 */
  tier?: 1 | 2 | 3 | null
  tierMissing?: string[]
}

/** workitem:get 的下钻闭包：item + steps + runs。 */
export interface WorkItemDetail {
  item: WorkItemSummary
  steps: WorkStepEntry[]
  runs: WorkRunEntry[]
}

/**
 * G8-3：步级确认视图（`map:confirmation:status` 原样投影）。
 * 只做展示：`risk.level` 与 `reasons` 由主进程派生，renderer **不得复算**。
 */
export interface StepConfirmationView {
  stepId: string
  workItemId: string
  workItemRevision: number
  stepKind: string
  point: 'C3' | 'C4' | null
  status: string
  required: boolean
  waiting: boolean
  risk: { level: 'low' | 'high'; files: number; estimatedLines: number | null; reasons: string[] } | null
  requiredDisplay: string[]
  trigger: string | null
  rejectPath: string | null
  decision: {
    decision: 'approve' | 'reject'
    decidedBy: string
    decidedAt: number
    note: string | null
    risk: 'low' | 'high'
    reasons: string[]
  } | null
  request: { point: 'C3' | 'C4'; risk: 'low' | 'high'; reasons: string[]; requested_at: number } | null
  /** §5.6 必填展示项的内容（服务端投影，renderer 原样展示并原样回传） */
  display: Record<string, unknown>
}

/**
 * I.8.F P1：C1 计划草稿视图（`plan:draft:list` / `plan:draft:preview` 原样投影）。
 * 8 个必填展示项由服务端组装（`gateMissing` 复用生产 gate 引擎），renderer 不复算。
 */
export interface PlanDraftView {
  draft: {
    id: string
    lineage_id: string
    revision: number
    graph_id: string
    status: string
    updated_at: string
  }
  display: Record<string, unknown>
}

/**
 * I.8.F P2：C2 修订历史与 diff（`workitem:history` / `workitem:diff` 原样投影）。
 * 字段级差异、impact 三项与 gate 结论全部由服务端计算，renderer 不复算。
 */
export interface WorkItemRevisionEntry {
  id: string
  revision: number
  is_current: boolean
  supersedes_id: string | null
  status: string
  gate_status: string
  title: string
  created_at: string
  updated_at: string
}

export interface WorkItemFieldDiff {
  field: string
  before: unknown
  after: unknown
  changed: boolean
}

export interface WorkItemImpact {
  kind: 'writeScope' | 'acceptance' | 'dependency'
  status: 'derived' | 'missing'
  detail: Record<string, unknown>
  /** 该影响面里推不出的具体事实；即使 status=derived 也可能非空。 */
  missing: string[]
  note: string
}

export interface WorkItemDiffView {
  lineageId: string
  from: { id: string; revision: number }
  to: { id: string | null; revision: number; stored: boolean }
  fields: WorkItemFieldDiff[]
  impact: WorkItemImpact[]
  gateResult: { status: 'stored' | 'precheck'; gateStatus: string; missing: string[] }
  reasonTrace: { sink: string | null; note: string }
}

export interface ProposedRevisionInput {
  title?: string
  goal?: string | null
  scopeFiles?: string[]
  acceptance?: Array<Record<string, unknown>>
  dependsOn?: string[]
  verificationHint?: string | null
}

/**
 * S7 起草入口的子任务条目（与主进程 `PlanItem` 同形）。
 * acceptance 必须是 D1 结构化条目 `{type: command|manual|file_check, expected}`，
 * 主进程 `normalizeAcceptanceInput` 会拒绝其他形状。
 * 索引签名：IPC 通道签名的线形是 `Array<Record<string, unknown>>`，两者必须可直接互传。
 */
export interface PlanItemInput {
  [field: string]: unknown
  key?: string
  title: string
  goal?: string
  scopeFiles?: string[]
  acceptance?: Array<Record<string, unknown>>
  dependsOn?: string[]
}

interface MapState {
  /** 叠加层：按图缓存（map:overlay:get 批量,禁止按节点轮询） */
  overlayByGraph: Map<string, { executionStates: ExecutionStateEntry[]; workItems: WorkItemSummary[] }>
  nodeTimeline: TimelineEntry[]
  nodeEvidence: EvidenceEntry[]
  /** §3.4 该节点的待裁决证据建议（默认只看 pending；裁决后重拉）。 */
  nodeSuggestions: EvidenceSuggestionEntry[]
  /** §8.4 该节点的人工连边（只读列表；删除只对 origin='human' 生效）。 */
  nodeLinks: NodeLinkEntry[]
  /** item 下钻明细缓存（workitem:get；只读,按 item id 索引） */
  workItemDetails: Record<string, WorkItemDetail>
  /** G8-3：步级确认视图缓存（map:confirmation:status；只读展示，风险由后端派生） */
  confirmationsByItem: Record<string, StepConfirmationView[]>
  /** I.8.F P1：按图缓存的计划草稿（plan:draft:list；含服务端 C1 投影） */
  planDraftsByGraph: Record<string, PlanDraftView[]>
  /** 下钻读取失败（按 item id）；与「无数据」区分，避免空列表被当成正常空态。 */
  workItemErrors: Record<string, string>
  /** 节点级读取失败（overlay / 时间线 / 证据）。 */
  nodeError: string | null
  /** 动作失败/状态提示（按 task/step/run id）。 */
  actionErrors: Record<string, string>
  executionStatus: ExecutionStatus | null
  loadingNode: boolean
  /** G1-14：当前节点提案列表（只读视图；不含 done/cancelled 的终态）。 */
  proposals: ProposalEntry[]
  /** G1-14：按提案 id 缓存的 diff（按需拉取，超 200KB 由主进程截断并标记）。 */
  proposalDiffs: Record<string, ProposalDiffView>
  /** G1-14：提案读取/动作失败（按提案 id；`__list__` 表示列表级错误）。 */
  proposalErrors: Record<string, string>

  fetchExecutionStatus: () => Promise<void>
  fetchOverlay: (graphId: string) => Promise<void>
  /** G1-14：拉取锚定节点的提案列表（只读）。 */
  fetchProposals: (graphId: string, nodeEntityKey: string) => Promise<void>
  /** G1-14：按需拉取单个提案 diff（只读）。 */
  fetchProposalDiff: (id: string) => Promise<void>
  /** G1-14：采纳提案（只收口提案状态；须人工先改 online 图）。 */
  acceptProposal: (input: { graphId: string; nodeEntityKey: string; id: string }) => Promise<void>
  /** G1-14：驳回提案（理由必填）。 */
  rejectProposal: (input: { graphId: string; nodeEntityKey: string; id: string; reason: string }) => Promise<void>
  /** §9.3 event:node-execution-state 增量更新（preload 订阅驱动） */
  applyExecutionState: (payload: { graphId: string; nodeEntityKey: string; executionState: string; evidenceLevel: string; staleCount: number }) => void
  fetchNodeData: (graphId: string, nodeEntityKey: string) => Promise<void>
  /** §3.4 证据建议列表（只读；默认 pending）。 */
  fetchEvidenceSuggestions: (graphId: string, nodeEntityKey: string) => Promise<void>
  /** §3.4 接受建议：同一事务内转写 node_evidence；成功后重拉列表明细。 */
  acceptEvidenceSuggestion: (input: { graphId: string; nodeEntityKey: string; id: string }) => Promise<void>
  /** §3.4 驳回建议：只改状态、不写证据。 */
  dismissEvidenceSuggestion: (input: { graphId: string; nodeEntityKey: string; id: string }) => Promise<void>
  /** G3-10 E1 人工判断直写：等级/写入方由主进程固定为 E1/human。 */
  createHumanJudgment: (input: {
    graphId: string
    nodeEntityKey: string
    nodeId?: string | null
    projectPath?: string | null
    summary: string
    ref: unknown
  }) => Promise<boolean>
  /** §8.4 节点连边列表（只读；需要 projectPath 才能定位同项目链接）。 */
  fetchNodeLinks: (projectPath: string, entityKey: string) => Promise<void>
  /** §8.4 撤销人工连边：只删 origin='human'，成功后重拉列表。 */
  deleteNodeLink: (input: { id: string; projectPath: string; entityKey: string }) => Promise<void>
  /** §8.4 新建人工连边（同图 relates_to）：成功后重拉列表。 */
  createNodeLink: (input: {
    graphId: string
    projectPath: string
    /** 当前节点（列表按它重拉）。 */
    entityKey: string
    fromEntityKey: string
    toEntityKey: string
    reason?: string
  }) => Promise<void>
  fetchWorkItemDetail: (id: string) => Promise<void>
  clearNodeData: () => void
  createWorkItem: (input: { graphId: string; anchorEntityKey?: string; anchorNodeId?: string; title: string; goal?: string; projectPath?: string }) => Promise<WorkItemSummary>
  startWorkItem: (id: string) => Promise<void>
  cancelWorkItem: (id: string) => Promise<void>
  /** 入队单个步骤（tick 异步驱动 turn；不是同步执行）。 */
  enqueueStep: (input: { graphId: string; workItemId: string; stepId: string }) => Promise<void>
  /** run 级取消（会尝试终止在跑进程；任务级取消不会）。 */
  cancelRun: (input: { graphId: string; workItemId: string; runId: string }) => Promise<void>
  setActionError: (key: string, message: string) => void
  /** event:work-item-changed 去抖后按 lineage 刷新已缓存明细与叠加层。 */
  applyWorkItemChanged: (payload: { lineageId: string }) => Promise<void>
  confirmAcceptance: (input: {
    graphId: string
    workItemId: string
    stepId: string
    entryIds: string[]
    note?: string
  }) => Promise<void>
  /** 步级确认决策（C3/C4）；成功后不本地猜状态，等主进程 broadcast 重拉。 */
  decideStepConfirmation: (input: {
    stepId: string
    decision: 'approve' | 'reject'
    display: Record<string, unknown>
    note?: string
  }) => Promise<void>
  /** I.8.F P1：拉取当前图的未确认草稿（只读）。 */
  fetchPlanDrafts: (graphId: string) => Promise<void>
  /** C1 提交确认：draft → awaiting_confirm，之后 confirm 才可用；成功后重拉列表。 */
  submitPlanDraft: (input: { graphId: string; id: string }) => Promise<void>
  /** C1 确认：display 原样回传；成功后重拉列表（不本地猜状态）。 */
  confirmPlanDraft: (input: { graphId: string; id: string; display: Record<string, unknown>; confirmedBy?: string }) => Promise<void>
  /** C1 驳回：不改 work_items；成功后重拉列表。 */
  rejectPlanDraft: (input: { graphId: string; id: string }) => Promise<void>
  /** S7 起草入口（v3.22）：手工多子任务计划 → plan_drafts（draft 状态）；C1 的唯一数据源。 */
  createPlanDraft: (input: {
    graphId: string
    projectPath?: string | null
    anchorEntityKey?: string | null
    anchorNodeId?: string | null
    items: PlanItemInput[]
  }) => Promise<boolean>
  /** S7 修订：产生新 revision 并置旧行 superseded；confirmed 不可修订（主进程拒绝）。 */
  revisePlanDraft: (input: { graphId: string; id: string; items: PlanItemInput[] }) => Promise<boolean>
  /** 修订编辑器预填：读草稿 items_json 原文（只读）；失败写草稿级错误并返回 null。 */
  getPlanDraftItems: (id: string) => Promise<PlanItemInput[] | null>
  /** I.8.F P2：按 lineage 拉全部 revision（含已 superseded 的旧行）。 */
  fetchWorkItemHistory: (lineageId: string) => Promise<WorkItemRevisionEntry[]>
  /** I.8.F P2：服务端算字段级 diff + impact；`to` 对比历史，`proposed` 预检拟修订。 */
  fetchWorkItemDiff: (query: {
    lineageId: string
    from: number
    to?: number
    proposed?: ProposedRevisionInput
  }) => Promise<WorkItemDiffView>
  /** C2 提交修订：`display` 原样回传；成功后刷新明细与叠加层。 */
  reviseWorkItem: (input: {
    graphId: string
    id: string
    title?: string
    goal?: string | null
    scopeFiles?: string[]
    acceptance?: Array<Record<string, unknown>>
    dependsOn?: string[]
    reason: string
    display: Record<string, unknown>
  }) => Promise<{ traced: boolean; sink: string | null; note: string } | null>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 结构化错误通道（preload STRUCTURED_ERROR_CHANNELS）成功返回原值，
 * 失败返回 `{ok:false,error:{code,message}}` 而不是 throw；统一解包成 Error。
 */
function unwrapIpc<T>(value: unknown): T {
  const envelope = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | null
  if (envelope && envelope.ok === false) {
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'IPC_ERROR'
    const message = typeof envelope.error?.message === 'string' ? envelope.error.message : '未知错误'
    throw new Error(`${code}: ${message}`)
  }
  return value as T
}

/** 步级确认决策失败时的中文提示（不把错误码直接抛给用户）。 */
const CONFIRMATION_ERROR_TEXT: Record<string, string> = {
  STEP_NOT_WAITING: '该步当前不在确认状态（可能已被处理），请刷新后重试',
  NOT_STEP_CONFIRMATION: '只有 test / human 步需要计划期确认；agent 步走逐工具审批',
  ALREADY_DECIDED: '该步已有决策，不能重复确认',
  CONFIRMATION_DISPLAY_MISSING: '必填展示项未齐，无法确认',
  STEP_NOT_FOUND: '找不到该步（可能已被删除）',
  ITEM_NOT_FOUND: '找不到该步所属任务',
}

export function describeConfirmationError(error: unknown): string {
  const raw = errorText(error)
  const sep = raw.indexOf(':')
  const code = sep > 0 ? raw.slice(0, sep).trim() : ''
  const detail = sep > 0 ? raw.slice(sep + 1).trim() : ''
  const mapped = CONFIRMATION_ERROR_TEXT[code]
  if (!mapped) return raw
  if (!detail) return mapped
  const stripped = detail.replace(/^缺少必填展示项[:：]/, '')
  return stripped && stripped !== detail ? `${mapped}：${stripped}` : mapped
}

/** C1 计划草稿动作失败的中文提示（不把错误码直接抛给用户）。 */
const PLAN_DRAFT_ERROR_TEXT: Record<string, string> = {
  CONFIRMATION_DISPLAY_MISSING: '必填展示项未齐，无法确认',
}

export function describePlanDraftError(error: unknown): string {
  const raw = errorText(error)
  // 环检测拒绝的消息形如 `计划依赖存在环:...|cycle=[...]`，不把环路径 JSON 抛给人。
  if (raw.includes('|cycle=')) return '计划依赖存在环，无法确认（请先调整子任务依赖）'
  const sep = raw.indexOf(':')
  const code = sep > 0 ? raw.slice(0, sep).trim() : ''
  const detail = sep > 0 ? raw.slice(sep + 1).trim() : ''
  const mapped = PLAN_DRAFT_ERROR_TEXT[code]
  if (!mapped) return raw
  if (!detail) return mapped
  const stripped = detail.replace(/^缺少必填展示项[:：]/, '')
  return stripped && stripped !== detail ? `${mapped}：${stripped}` : mapped
}

/** C2 修订失败提示：与 C1 同源校验，但动作是「提交修订」而非「确认计划」。 */
export function describeRevisionError(error: unknown): string {
  const raw = errorText(error)
  if (raw.startsWith('CONFIRMATION_DISPLAY_MISSING')) {
    const detail = raw.slice('CONFIRMATION_DISPLAY_MISSING:'.length).trim()
    return detail ? `必填展示项未齐，无法提交修订：${detail}` : '必填展示项未齐，无法提交修订'
  }
  return raw
}

/** 按 item id 就地更新所有已缓存图的叠加层（避免为此重拉整图）。 */
function patchOverlayItem(state: MapState, id: string, patch: Partial<WorkItemSummary>): Partial<MapState> {
  const next = new Map(state.overlayByGraph)
  for (const [graphId, overlay] of next) {
    const idx = overlay.workItems.findIndex((w) => w.id === id)
    if (idx >= 0) {
      const items = [...overlay.workItems]
      items[idx] = { ...items[idx], ...patch }
      next.set(graphId, { ...overlay, workItems: items })
      break
    }
  }
  return { overlayByGraph: next }
}

export const useMapStore = create<MapState>((set, get) => ({
  overlayByGraph: new Map(),
  nodeTimeline: [],
  nodeEvidence: [],
  nodeSuggestions: [],
  nodeLinks: [],
  workItemDetails: {},
  confirmationsByItem: {},
  planDraftsByGraph: {},
  workItemErrors: {},
  nodeError: null,
  actionErrors: {},
  executionStatus: null,
  loadingNode: false,
  proposals: [],
  proposalDiffs: {},
  proposalErrors: {},

  fetchProposals: async (graphId, nodeEntityKey) => {
    try {
      const rows = await window.electronAPI['proposal:list']({ graphId, anchorEntityKey: nodeEntityKey })
      set((state) => {
        const nextErrors = { ...state.proposalErrors }
        delete nextErrors['__list__']
        return { proposals: (rows ?? []) as unknown as ProposalEntry[], proposalErrors: nextErrors }
      })
    } catch (error) {
      set((state) => ({
        proposals: [],
        proposalErrors: { ...state.proposalErrors, __list__: `读取提案失败：${errorText(error)}` },
      }))
    }
  },

  fetchProposalDiff: async (id) => {
    try {
      const diff = await window.electronAPI['proposal:diff'](id)
      if (!diff) {
        set((state) => ({
          proposalErrors: { ...state.proposalErrors, [id]: '提案不存在或已被删除（proposal:diff 返回空）' },
        }))
        return
      }
      set((state) => {
        const nextErrors = { ...state.proposalErrors }
        delete nextErrors[id]
        return {
          proposalDiffs: { ...state.proposalDiffs, [id]: diff as unknown as ProposalDiffView },
          proposalErrors: nextErrors,
        }
      })
    } catch (error) {
      set((state) => ({
        proposalErrors: { ...state.proposalErrors, [id]: `读取 diff 失败：${errorText(error)}` },
      }))
    }
  },

  acceptProposal: async (input) => {
    try {
      await window.electronAPI['proposal:accept']({ id: input.id, acceptedBy: 'local-user' })
      await get().fetchProposals(input.graphId, input.nodeEntityKey)
    } catch (error) {
      set((state) => ({
        proposalErrors: { ...state.proposalErrors, [input.id]: errorText(error) },
      }))
    }
  },

  rejectProposal: async (input) => {
    try {
      await window.electronAPI['proposal:reject']({
        id: input.id,
        reason: input.reason,
        rejectedBy: 'local-user',
      })
      await get().fetchProposals(input.graphId, input.nodeEntityKey)
    } catch (error) {
      set((state) => ({
        proposalErrors: { ...state.proposalErrors, [input.id]: errorText(error) },
      }))
    }
  },

  fetchExecutionStatus: async () => {
    try {
      const status = await window.electronAPI['map:execution:status']()
      set({ executionStatus: status })
    } catch (error) {
      set({
        executionStatus: {
          enabled: false,
          adapterName: null,
          disabledReason: `读取执行状态失败：${errorText(error)}`,
        },
      })
    }
  },

  applyExecutionState: (payload) => {
    set((state) => {
      const cur = state.overlayByGraph.get(payload.graphId)
      if (!cur) return state // 图未拉过叠加层 → 忽略(下次 fetchOverlay 全量取)
      const others = cur.executionStates.filter((e) => e.node_entity_key !== payload.nodeEntityKey)
      return {
        overlayByGraph: new Map(state.overlayByGraph).set(payload.graphId, {
          ...cur,
          executionStates: [
            ...others,
            {
              node_entity_key: payload.nodeEntityKey,
              execution_state: payload.executionState as ExecutionStateValue,
              evidence_level: payload.evidenceLevel,
              stale_count: payload.staleCount,
              computed_at: Date.now(),
            },
          ],
        }),
      }
    })
  },

  fetchOverlay: async (graphId) => {
    try {
      const result = await window.electronAPI['map:overlay:get'](graphId)
      const overlay = {
        executionStates: (result.executionStates ?? []) as unknown as ExecutionStateEntry[],
        workItems: (result.workItems ?? []) as unknown as WorkItemSummary[],
      }
      set((state) => ({
        overlayByGraph: new Map(state.overlayByGraph).set(graphId, overlay),
        nodeError: null,
      }))
    } catch (error) {
      set({ nodeError: `读取叠加层失败：${errorText(error)}` })
    }
  },

  fetchNodeData: async (graphId, nodeEntityKey) => {
    set({ loadingNode: true, nodeError: null })
    try {
      const [timeline, evidence, items] = await Promise.all([
        window.electronAPI['map:node:timeline']({ graphId, nodeEntityKey }),
        window.electronAPI['map:node:evidence:list']({ graphId, nodeEntityKey }),
        window.electronAPI['workitem:list']({ graphId, anchorEntityKey: nodeEntityKey }),
      ])
      set({
        nodeTimeline: (timeline ?? []) as unknown as TimelineEntry[],
        nodeEvidence: (evidence ?? []) as unknown as EvidenceEntry[],
        overlayByGraph: (() => {
          // workitem:list 结果并入 overlay 缓存,叠加层读取保持单源
          const cur = get().overlayByGraph.get(graphId) ?? { executionStates: [], workItems: [] }
          const others = cur.workItems.filter((w) => w.anchor_entity_key !== nodeEntityKey)
          return new Map(get().overlayByGraph).set(graphId, {
            ...cur,
            workItems: [...others, ...(items as unknown as WorkItemSummary[])],
          })
        })(),
      })
    } catch (error) {
      set({ nodeError: `读取节点数据失败：${errorText(error)}` })
    } finally {
      set({ loadingNode: false })
    }
  },

  /**
   * item 下钻（workitem:get）：item + 当前 revision 的 steps + 全部 runs。
   * 只读；空结果(null)不写入缓存，避免用占位内容伪造"有任务"。
   * G8-3：同一轮拉取步级确认视图（只读），不另起轮询。
   */
  fetchWorkItemDetail: async (id) => {
    // 确认视图是纯展示附加项：通道缺失/失败不得连累明细读取。
    const confirmationsPromise = (async () => {
      try {
        return await window.electronAPI['map:confirmation:status']({ workItemId: id })
      } catch {
        return null
      }
    })()
    try {
      const [result, confirmations] = await Promise.all([
        window.electronAPI['workitem:get'](id),
        confirmationsPromise,
      ])
      if (!result) {
        set((state) => ({
          workItemErrors: { ...state.workItemErrors, [id]: '任务不存在或已被删除（workitem:get 返回空）' },
        }))
        return
      }
      set((state) => {
        const nextErrors = { ...state.workItemErrors }
        delete nextErrors[id]
        return {
          workItemDetails: {
            ...state.workItemDetails,
            [id]: {
              item: result.item as unknown as WorkItemSummary,
              steps: (result.steps ?? []) as unknown as WorkStepEntry[],
              runs: (result.runs ?? []) as unknown as WorkRunEntry[],
            },
          },
          // 确认视图读取失败不影响明细：保留上一次缓存，不用占位内容覆盖。
          ...(confirmations
            ? {
                confirmationsByItem: {
                  ...state.confirmationsByItem,
                  [id]: confirmations as StepConfirmationView[],
                },
              }
            : {}),
          workItemErrors: nextErrors,
        }
      })
    } catch (error) {
      set((state) => ({
        workItemErrors: { ...state.workItemErrors, [id]: `读取失败：${errorText(error)}` },
      }))
    }
  },

  /**
   * §3.4 待裁决证据建议（只读）。
   *
   * 读取失败只记错误、保留上一次列表：空数组会被界面读成「没有建议」，那是在
   * 用失败伪装空态。
   */
  fetchEvidenceSuggestions: async (graphId, nodeEntityKey) => {
    try {
      const rows = unwrapIpc<EvidenceSuggestionEntry[]>(
        await window.electronAPI['map:evidence:suggestions:list']({
          graphId,
          nodeEntityKey,
          status: 'pending',
        }),
      )
      set({ nodeSuggestions: Array.isArray(rows) ? rows : [] })
      get().setActionError('suggestions', '')
    } catch (error) {
      get().setActionError('suggestions', `读取证据建议失败：${errorText(error)}`)
    }
  },

  /** 接受建议：主进程在同事务里写 node_evidence，这里刷新建议与证据两处缓存。 */
  acceptEvidenceSuggestion: async ({ graphId, nodeEntityKey, id }) => {
    try {
      unwrapIpc(
        await window.electronAPI['map:evidence:suggestion:accept']({ id, resolvedBy: 'local-user' }),
      )
      get().setActionError(`suggestion:${id}`, '')
      await Promise.all([
        get().fetchEvidenceSuggestions(graphId, nodeEntityKey),
        get().fetchNodeData(graphId, nodeEntityKey),
      ])
    } catch (error) {
      get().setActionError(`suggestion:${id}`, `接受建议失败：${errorText(error)}`)
    }
  },

  /** 驳回建议：只改状态，不产生证据。 */
  dismissEvidenceSuggestion: async ({ graphId, nodeEntityKey, id }) => {
    try {
      unwrapIpc(
        await window.electronAPI['map:evidence:suggestion:dismiss']({ id, resolvedBy: 'local-user' }),
      )
      get().setActionError(`suggestion:${id}`, '')
      await get().fetchEvidenceSuggestions(graphId, nodeEntityKey)
    } catch (error) {
      get().setActionError(`suggestion:${id}`, `驳回建议失败：${errorText(error)}`)
    }
  },

  /**
   * G3-10 E1 人工判断直写：`actor`/`producedBy` 由主进程固定，renderer 不自报。
   * 返回是否成功——成功才清空输入框，避免失败后把用户写的判断丢掉。
   */
  createHumanJudgment: async (input) => {
    try {
      unwrapIpc(
        await window.electronAPI['map:evidence:e1:create']({
          graphId: input.graphId,
          nodeEntityKey: input.nodeEntityKey,
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
          ...(input.projectPath ? { projectPath: input.projectPath } : {}),
          summary: input.summary,
          ref: input.ref,
        }),
      )
      get().setActionError('e1', '')
      await get().fetchNodeData(input.graphId, input.nodeEntityKey)
      return true
    } catch (error) {
      get().setActionError('e1', `写入人工判断失败：${errorText(error)}`)
      return false
    }
  },

  /** §8.4 节点连边（只读）。projectPath 必需：链接按项目隔离，跨项目不能混列。 */
  fetchNodeLinks: async (projectPath, entityKey) => {
    try {
      const rows = unwrapIpc<NodeLinkEntry[]>(
        await window.electronAPI['map:link:list']({ projectPath, entityKey }),
      )
      set({ nodeLinks: Array.isArray(rows) ? rows : [] })
      get().setActionError('links', '')
    } catch (error) {
      get().setActionError('links', `读取连边失败：${errorText(error)}`)
    }
  },

  /** §8.4 撤销人工连边：只对 origin='human' 生效（主进程拒绝其余来源）。 */  deleteNodeLink: async ({ id, projectPath, entityKey }) => {
    try {
      unwrapIpc(await window.electronAPI['map:link:delete']({ id, projectPath }))
      get().setActionError(`link:${id}`, '')
      await get().fetchNodeLinks(projectPath, entityKey)
    } catch (error) {
      get().setActionError(`link:${id}`, `删除连边失败：${errorText(error)}`)
    }
  },

  /**
   * §8.4 新建人工连边。
   *
   * 只开 `relates_to`（L1 人工入口的唯一类型，主进程也会拒绝其他类型）；
   * `origin` 由主进程固定为 human——界面不自报来源，避免「人工连边」被伪造。
   */
  createNodeLink: async ({ graphId, projectPath, entityKey, fromEntityKey, toEntityKey, reason }) => {
    try {
      unwrapIpc(
        await window.electronAPI['map:link:create']({
          projectPath,
          fromEntityKey,
          fromGraphId: graphId,
          toEntityKey,
          toGraphId: graphId,
          linkType: 'relates_to',
          ...(reason ? { reason } : {}),
        }),
      )
      get().setActionError('links', '')
      await get().fetchNodeLinks(projectPath, entityKey)
    } catch (error) {
      get().setActionError('links', `新建连边失败：${errorText(error)}`)
    }
  },

  clearNodeData: () => set({ nodeTimeline: [], nodeEvidence: [], nodeSuggestions: [], nodeLinks: [] }),

  createWorkItem: async (input) => {
    const row = (await window.electronAPI['workitem:create']({
      graphId: input.graphId,
      anchorEntityKey: input.anchorEntityKey,
      anchorNodeId: input.anchorNodeId,
      title: input.title,
      goal: input.goal,
      projectPath: input.projectPath,
    })) as unknown as WorkItemRowLike
    const summary: WorkItemSummary = {
      id: row.id,
      lineage_id: row.lineage_id,
      revision: row.revision,
      anchor_entity_key: row.anchor_entity_key,
      title: row.title,
      status: row.status,
      gate_status: row.gate_status,
      updated_at: row.updated_at,
    }
    set((state) => {
      const cur = state.overlayByGraph.get(input.graphId) ?? { executionStates: [], workItems: [] }
      return { overlayByGraph: new Map(state.overlayByGraph).set(input.graphId, { ...cur, workItems: [summary, ...cur.workItems] }) }
    })
    return summary
  },

  /**
   * 任务级入队：只做 confirm（draft → awaiting_confirm → queued），不写 gate。
   * gate 必须已 pass/waived；不传 gateResult，避免前端伪造放行。
   */
  startWorkItem: async (id) => {
    try {
      const row = unwrapIpc<WorkItemRowLike>(await window.electronAPI['workitem:run:start']({ id }))
      set((state) =>
        patchOverlayItem(state, id, {
          status: row.status,
          gate_status: row.gate_status,
          revision: row.revision,
          gate_missing_json: row.gate_missing_json ?? null,
        }),
      )
      get().setActionError(id, '')
      await get().fetchWorkItemDetail(id)
    } catch (error) {
      get().setActionError(id, errorText(error))
    }
  },

  /** 任务级取消：不终止进程；有活跃 run 时 UI 必须先走 run 级取消。 */
  cancelWorkItem: async (id) => {
    try {
      const row = unwrapIpc<WorkItemRowLike>(await window.electronAPI['workitem:cancel'](id))
      set((state) => patchOverlayItem(state, id, { status: row.status, cancel_reason: row.cancel_reason ?? null }))
      get().setActionError(id, '')
      await get().fetchWorkItemDetail(id)
    } catch (error) {
      get().setActionError(id, errorText(error))
    }
  },

  enqueueStep: async ({ graphId, workItemId, stepId }) => {
    const execution = get().executionStatus
    if (!execution?.enabled) {
      get().setActionError(stepId, execution?.disabledReason ?? '执行触发未开启')
      return
    }
    if (!execution.adapterName) {
      get().setActionError(stepId, '未配置执行器（adapterName 缺失）')
      return
    }
    try {
      unwrapIpc(
        await window.electronAPI['workitem:step:run']({
          stepId,
          workItemId,
          adapterName: execution.adapterName,
        }),
      )
      get().setActionError(stepId, '')
      await Promise.all([get().fetchWorkItemDetail(workItemId), get().fetchOverlay(graphId)])
    } catch (error) {
      get().setActionError(stepId, errorText(error))
    }
  },

  cancelRun: async ({ graphId, workItemId, runId }) => {
    try {
      const result = unwrapIpc<{ cancelled?: boolean; alreadyTerminal?: boolean; status?: string }>(
        await window.electronAPI['workitem:run:cancel'](runId),
      )
      get().setActionError(
        runId,
        result.alreadyTerminal ? `运行已结束（${result.status ?? '终态'}），未取消` : '',
      )
      await Promise.all([get().fetchWorkItemDetail(workItemId), get().fetchOverlay(graphId)])
    } catch (error) {
      get().setActionError(runId, errorText(error))
    }
  },

  setActionError: (key, message) => {
    set((state) => {
      const next = { ...state.actionErrors }
      if (message) next[key] = message
      else delete next[key]
      return { actionErrors: next }
    })
  },

  applyWorkItemChanged: async ({ lineageId }) => {
    const itemIds = Object.values(get().workItemDetails)
      .filter((detail) => detail.item.lineage_id === lineageId)
      .map((detail) => detail.item.id)
    const graphIds: string[] = []
    for (const [graphId, overlay] of get().overlayByGraph) {
      if (overlay.workItems.some((item) => item.lineage_id === lineageId)) graphIds.push(graphId)
    }
    await Promise.all([
      ...itemIds.map((id) => get().fetchWorkItemDetail(id)),
      ...graphIds.map((graphId) => get().fetchOverlay(graphId)),
    ])
  },

  /** manual 验收确认：写确认事实 + 重算验收；随后刷新 item 详情与叠加层状态。 */
  confirmAcceptance: async (input) => {
    try {
      unwrapIpc(
        await window.electronAPI['workitem:acceptance:confirm']({
          stepId: input.stepId,
          workItemId: input.workItemId,
          entryIds: input.entryIds,
          note: input.note,
        }),
      )
      await get().fetchWorkItemDetail(input.workItemId)
      await get().fetchOverlay(input.graphId)
    } catch (error) {
      await get().fetchWorkItemDetail(input.workItemId)
      throw error instanceof Error ? error : new Error(String(error))
    }
  },

  /**
   * 步级确认决策：只发写请求；状态变化交给主进程 broadcast → applyWorkItemChanged。
   * 失败把结构化错误码翻成中文写到该步的 action error 上，不抛给调用方。
   */
  decideStepConfirmation: async (input) => {
    try {
      unwrapIpc(
        await window.electronAPI['map:confirmation:decide']({
          stepId: input.stepId,
          decision: input.decision,
          display: input.display,
          note: input.note,
        }),
      )
      get().setActionError(input.stepId, '')
    } catch (error) {
      get().setActionError(input.stepId, describeConfirmationError(error))
    }
  },

  /** C1 草稿列表：只读；读取失败写图级错误，不把空列表当正常空态。 */
  fetchPlanDrafts: async (graphId) => {
    try {
      const result = unwrapIpc<{ drafts: PlanDraftView[] }>(
        await window.electronAPI['plan:draft:list'](graphId),
      )
      set((state) => ({
        planDraftsByGraph: { ...state.planDraftsByGraph, [graphId]: result.drafts ?? [] },
      }))
      get().setActionError(`plan-drafts:${graphId}`, '')
    } catch (error) {
      set((state) => ({
        actionErrors: { ...state.actionErrors, [`plan-drafts:${graphId}`]: describePlanDraftError(error) },
      }))
    }
  },

  /** C1 提交确认：draft → awaiting_confirm，成功后重拉列表。 */
  submitPlanDraft: async (input) => {
    try {
      unwrapIpc(await window.electronAPI['plan:draft:submit'](input.id))
      get().setActionError(`plan-draft:${input.id}`, '')
      await get().fetchPlanDrafts(input.graphId)
    } catch (error) {
      get().setActionError(`plan-draft:${input.id}`, describePlanDraftError(error))
    }
  },

  /** C1 确认：`display` 原样回传；成功后重拉列表，不在本地猜草稿状态。 */
  confirmPlanDraft: async (input) => {
    try {
      unwrapIpc(
        await window.electronAPI['plan:draft:confirm']({
          id: input.id,
          display: input.display,
          ...(input.confirmedBy ? { confirmedBy: input.confirmedBy } : {}),
        }),
      )
      get().setActionError(`plan-draft:${input.id}`, '')
      await get().fetchPlanDrafts(input.graphId)
    } catch (error) {
      get().setActionError(`plan-draft:${input.id}`, describePlanDraftError(error))
    }
  },

  /** C1 驳回：不生成 work_items；成功后重拉列表。 */
  rejectPlanDraft: async (input) => {
    try {
      unwrapIpc(await window.electronAPI['plan:draft:reject'](input.id))
      get().setActionError(`plan-draft:${input.id}`, '')
      await get().fetchPlanDrafts(input.graphId)
    } catch (error) {
      get().setActionError(`plan-draft:${input.id}`, describePlanDraftError(error))
    }
  },

  /** S7 起草入口：落 draft 状态草稿；主进程校验非空/环，renderer 不复算。 */
  createPlanDraft: async (input) => {
    try {
      unwrapIpc(
        await window.electronAPI['plan:draft:create']({
          graphId: input.graphId,
          ...(input.projectPath ? { projectPath: input.projectPath } : {}),
          ...(input.anchorEntityKey ? { anchorEntityKey: input.anchorEntityKey } : {}),
          ...(input.anchorNodeId ? { anchorNodeId: input.anchorNodeId } : {}),
          items: input.items,
        }),
      )
      get().setActionError(`plan-draft-compose:${input.graphId}`, '')
      await get().fetchPlanDrafts(input.graphId)
      return true
    } catch (error) {
      get().setActionError(`plan-draft-compose:${input.graphId}`, describePlanDraftError(error))
      return false
    }
  },

  /** S7 修订：新 revision + 旧行 superseded；成功后重拉列表（新 id 由服务端生成）。 */
  revisePlanDraft: async (input) => {
    try {
      unwrapIpc(await window.electronAPI['plan:draft:revise']({ id: input.id, items: input.items }))
      get().setActionError(`plan-draft:${input.id}`, '')
      await get().fetchPlanDrafts(input.graphId)
      return true
    } catch (error) {
      get().setActionError(`plan-draft:${input.id}`, describePlanDraftError(error))
      return false
    }
  },

  /** 修订预填：items_json 原文按最小形状过滤（title 必须是非空字符串，其余原样保留）。 */
  getPlanDraftItems: async (id) => {
    try {
      const row = unwrapIpc<{ items_json?: unknown } | null>(
        await window.electronAPI['plan:draft:get'](id),
      )
      if (!row || typeof row.items_json !== 'string') {
        get().setActionError(`plan-draft:${id}`, '草稿不存在或没有条目原文（plan:draft:get 返回空）')
        return null
      }
      const parsed = JSON.parse(row.items_json) as unknown
      if (!Array.isArray(parsed)) {
        get().setActionError(`plan-draft:${id}`, '草稿条目原文不是数组，无法预填')
        return null
      }
      get().setActionError(`plan-draft:${id}`, '')
      return parsed.filter(
        (item): item is PlanItemInput =>
          !!item && typeof item === 'object' && typeof (item as PlanItemInput).title === 'string',
      )
    } catch (error) {
      get().setActionError(`plan-draft:${id}`, describePlanDraftError(error))
      return null
    }
  },

  /** I.8.F P2：按 lineage 读全部 revision；失败时抛给调用方（面板就地显示），不静默空列表。 */
  fetchWorkItemHistory: async (lineageId) => {
    const rows = unwrapIpc<WorkItemRevisionEntry[]>(await window.electronAPI['workitem:history'](lineageId))
    return Array.isArray(rows) ? rows : []
  },

  /** I.8.F P2：diff 完全由服务端计算；这里只解包，不做任何字段比较。 */
  fetchWorkItemDiff: async (query) => {
    return unwrapIpc<WorkItemDiffView>(await window.electronAPI['workitem:diff'](query))
  },

  /** C2 提交修订：display 原样回传；成功后刷新明细与叠加层（不本地猜新 revision）。 */
  reviseWorkItem: async (input) => {
    try {
      const result = unwrapIpc<{ item: Record<string, unknown>; audit: { traced: boolean; sink: string | null; note: string } }>(
        await window.electronAPI['workitem:revise']({
          id: input.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.goal !== undefined && input.goal !== null ? { goal: input.goal } : {}),
          ...(input.scopeFiles !== undefined ? { scopeFiles: input.scopeFiles } : {}),
          ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
          ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
          reason: input.reason,
          display: input.display,
        }),
      )
      get().setActionError(`revision:${input.id}`, '')
      await Promise.all([get().fetchWorkItemDetail(input.id), get().fetchOverlay(input.graphId)])
      return result.audit ?? null
    } catch (error) {
      get().setActionError(`revision:${input.id}`, describeRevisionError(error))
      return null
    }
  },
}))

// §9.3:派生态事件订阅(模块级一次;HMR 重复执行时先退订旧监听)。
// 用 holder 对象而非裸 let——TS 会把「初始化为 null 且中间无赋值」的模块变量
// 窄化成 never,导致后续 ?.() 报错。
const _execStateSub: { unsub: (() => void) | null } = { unsub: null }
if (typeof window !== 'undefined' && window.electronAPI?.onNodeExecutionState) {
  _execStateSub.unsub?.()
  _execStateSub.unsub = window.electronAPI.onNodeExecutionState((payload) => {
    useMapStore.getState().applyExecutionState(payload)
  })
}

// G3-3/G8-6:work item 状态变更订阅（模块级一次；按 lineage 去抖 200ms 后重拉明细）。
const _workItemSub: { unsub: (() => void) | null } = { unsub: null }
const _workItemPending: { timer: ReturnType<typeof setTimeout> | null; lineages: Set<string> } = {
  timer: null,
  lineages: new Set(),
}
if (typeof window !== 'undefined' && window.electronAPI?.onWorkItemChanged) {
  _workItemSub.unsub?.()
  _workItemSub.unsub = window.electronAPI.onWorkItemChanged((payload) => {
    _workItemPending.lineages.add(payload.lineageId)
    if (_workItemPending.timer) clearTimeout(_workItemPending.timer)
    _workItemPending.timer = setTimeout(() => {
      const lineages = [..._workItemPending.lineages]
      _workItemPending.lineages.clear()
      _workItemPending.timer = null
      for (const lineageId of lineages) {
        void useMapStore.getState().applyWorkItemChanged({ lineageId })
      }
    }, 200)
  })
}
