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
  created_at: number
  started_at: number | null
  ended_at: number | null
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
  loadingNode: boolean

  fetchOverlay: (graphId: string) => Promise<void>
  /** §9.3 event:node-execution-state 增量更新（preload 订阅驱动） */
  applyExecutionState: (payload: { graphId: string; nodeEntityKey: string; executionState: string; evidenceLevel: string; staleCount: number }) => void
  fetchNodeData: (graphId: string, nodeEntityKey: string) => Promise<void>
  fetchWorkItemDetail: (id: string) => Promise<void>
  clearNodeData: () => void
  createWorkItem: (input: { graphId: string; anchorEntityKey?: string; anchorNodeId?: string; title: string; goal?: string; projectPath?: string }) => Promise<WorkItemSummary>
  startWorkItem: (id: string) => Promise<void>
  cancelWorkItem: (id: string) => Promise<void>
  confirmAcceptance: (input: {
    graphId: string
    workItemId: string
    stepId: string
    entryIds: string[]
    note?: string
  }) => Promise<void>
}

export const useMapStore = create<MapState>((set, get) => ({
  overlayByGraph: new Map(),
  nodeTimeline: [],
  nodeEvidence: [],
  workItemDetails: {},
  loadingNode: false,

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
    const result = await window.electronAPI['map:overlay:get'](graphId)
    const overlay = {
      executionStates: (result.executionStates ?? []) as unknown as ExecutionStateEntry[],
      workItems: (result.workItems ?? []) as unknown as WorkItemSummary[],
    }
    set((state) => ({ overlayByGraph: new Map(state.overlayByGraph).set(graphId, overlay) }))
  },

  fetchNodeData: async (graphId, nodeEntityKey) => {
    set({ loadingNode: true })
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
    } finally {
      set({ loadingNode: false })
    }
  },

  /**
   * item 下钻（workitem:get）：item + 当前 revision 的 steps + 全部 runs。
   * 只读；空结果(null)不写入缓存，避免用占位内容伪造"有任务"。
   */
  fetchWorkItemDetail: async (id) => {
    const result = await window.electronAPI['workitem:get'](id)
    if (!result) return
    set((state) => ({
      workItemDetails: {
        ...state.workItemDetails,
        [id]: {
          item: result.item as unknown as WorkItemSummary,
          steps: (result.steps ?? []) as unknown as WorkStepEntry[],
          runs: (result.runs ?? []) as unknown as WorkRunEntry[],
        },
      },
    }))
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

  startWorkItem: async (id) => {
    const row = (await window.electronAPI['workitem:run:start']({ id, gateResult: 'pass' })) as unknown as WorkItemRowLike
    set((state) => {
      const next = new Map(state.overlayByGraph)
      for (const [graphId, overlay] of next) {
        const idx = overlay.workItems.findIndex((w) => w.id === id)
        if (idx >= 0) {
          const items = [...overlay.workItems]
          items[idx] = { ...items[idx], status: row.status, gate_status: row.gate_status, revision: row.revision }
          next.set(graphId, { ...overlay, workItems: items })
          break
        }
      }
      return { overlayByGraph: next }
    })
  },

  cancelWorkItem: async (id) => {
    const row = (await window.electronAPI['workitem:cancel'](id)) as unknown as WorkItemRowLike
    set((state) => {
      const next = new Map(state.overlayByGraph)
      for (const [graphId, overlay] of next) {
        const idx = overlay.workItems.findIndex((w) => w.id === id)
        if (idx >= 0) {
          const items = [...overlay.workItems]
          items[idx] = { ...items[idx], status: row.status }
          next.set(graphId, { ...overlay, workItems: items })
          break
        }
      }
      return { overlayByGraph: next }
    })
  },

  /** manual 验收确认：写确认事实 + 重算验收；随后刷新 item 详情与叠加层状态。 */
  confirmAcceptance: async (input) => {
    await window.electronAPI['workitem:acceptance:confirm']({
      stepId: input.stepId,
      workItemId: input.workItemId,
      entryIds: input.entryIds,
      note: input.note,
    })
    await get().fetchWorkItemDetail(input.workItemId)
    await get().fetchOverlay(input.graphId)
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
