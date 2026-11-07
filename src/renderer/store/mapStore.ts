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

interface MapState {
  /** 叠加层：按图缓存（map:overlay:get 批量,禁止按节点轮询） */
  overlayByGraph: Map<string, { executionStates: ExecutionStateEntry[]; workItems: WorkItemSummary[] }>
  nodeTimeline: TimelineEntry[]
  nodeEvidence: EvidenceEntry[]
  loadingNode: boolean

  fetchOverlay: (graphId: string) => Promise<void>
  fetchNodeData: (graphId: string, nodeEntityKey: string) => Promise<void>
  clearNodeData: () => void
  createWorkItem: (input: { graphId: string; anchorEntityKey?: string; anchorNodeId?: string; title: string; goal?: string; projectPath?: string }) => Promise<WorkItemSummary>
  startWorkItem: (id: string) => Promise<void>
  cancelWorkItem: (id: string) => Promise<void>
}

export const useMapStore = create<MapState>((set, get) => ({
  overlayByGraph: new Map(),
  nodeTimeline: [],
  nodeEvidence: [],
  loadingNode: false,

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
}))
