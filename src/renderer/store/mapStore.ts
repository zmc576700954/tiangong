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

/** work_steps 只读出参（workitem:get / workitem:steps:list 的显式列集合子集）。 */
export interface WorkStepEntry {
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

interface MapState {
  /** 叠加层：按图缓存（map:overlay:get 批量,禁止按节点轮询） */
  overlayByGraph: Map<string, { executionStates: ExecutionStateEntry[]; workItems: WorkItemSummary[] }>
  nodeTimeline: TimelineEntry[]
  nodeEvidence: EvidenceEntry[]
  /** item 下钻明细缓存（workitem:get；只读,按 item id 索引） */
  workItemDetails: Record<string, WorkItemDetail>
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
  workItemDetails: {},
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
   */
  fetchWorkItemDetail: async (id) => {
    try {
      const result = await window.electronAPI['workitem:get'](id)
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
          workItemErrors: nextErrors,
        }
      })
    } catch (error) {
      set((state) => ({
        workItemErrors: { ...state.workItemErrors, [id]: `读取失败：${errorText(error)}` },
      }))
    }
  },

  clearNodeData: () => set({ nodeTimeline: [], nodeEvidence: [] }),

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
