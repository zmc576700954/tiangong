import { create } from 'zustand'
import type { Graph, GraphNode, GraphEdge, BugNode, NodeStatus, EdgeType, EdgeContent } from '@shared/types'
import { generateId } from '../lib/utils'
import { eventBus, Events } from './eventBus'
import { canTransition } from '@shared/state-machine'

// ============================================
// 乐观更新辅助函数
// ============================================

/** 乐观创建：添加临时项 → IPC 调用 → 确认/回滚 */
async function optimisticCreate<T extends { id: string }>(
  items: T[],
  optimisticItem: T,
  ipcCall: () => Promise<T>,
  onSettle: (updated: T[]) => void,
): Promise<T> {
  const optimisticId = optimisticItem.id
  const optimisticList = [...items, optimisticItem]
  onSettle(optimisticList)

  try {
    const serverItem = await ipcCall()
    // 替换乐观项为服务端返回的真实项
    onSettle(optimisticList.map((item) => (item.id === optimisticId ? serverItem : item)))
    return serverItem
  } catch (err) {
    // 回滚：移除乐观项
    onSettle(items)
    throw err
  }
}

// ============================================
// Store 定义
// ============================================

interface GraphState {
  graphs: Graph[]
  currentGraphId: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  bugs: BugNode[]
  selectedNodeId: string | null
  selectedEdgeId: string | null

  loadGraphs: () => Promise<void>
  loadGraph: (graphId: string) => Promise<void>

  createGraph: (name: string, type: 'online' | 'dev', sourceGraphId?: string) => Promise<Graph>
  deleteGraph: (id: string) => Promise<void>
  setCurrentGraph: (id: string | null) => void

  createNode: (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GraphNode>
  createNodeBatch: (nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<GraphNode[]>
  updateNode: (id: string, data: Partial<GraphNode>) => Promise<void>
  batchUpdatePositions: (updates: Array<{ id: string; x: number; y: number }>) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  selectNode: (id: string | null) => void

  createEdge: (data: Omit<GraphEdge, 'id'>) => Promise<GraphEdge>
  updateEdge: (id: string, data: Partial<GraphEdge>) => Promise<void>
  deleteEdge: (id: string) => Promise<void>
  selectEdge: (id: string | null) => void

  createBug: (data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<BugNode>
  updateBug: (id: string, data: Partial<BugNode>) => Promise<void>
  deleteBug: (id: string) => Promise<void>

  addSuggestedEdges: (edges: Array<{ id: string; source: string; target: string; edgeType: EdgeType; strength: number; content: EdgeContent }>) => void
  confirmSuggestedEdge: (edgeId: string) => void
  rejectSuggestedEdge: (edgeId: string) => void
  confirmPreviewNode: (nodeId: string) => void
  clearPreviewNodes: () => void

  // Map-based index accessors
  getNodeById: (id: string) => GraphNode | undefined
  getNodesByType: (type: string) => GraphNode[]

  // Task 4.4.1: Frontend search index
  searchNodes: (query: string, filters?: { name?: string; type?: string; status?: string }) => GraphNode[]
}

export const useGraphStore = create<GraphState>((set, get) => {
  // 监听 Agent 状态变更事件（解耦 agentStore → graphStore 的直接引用）
  eventBus.on(Events.AGENT_STATUS_CHANGE, (nodeId: string, status: NodeStatus) => {
    get().updateNode(nodeId, { status })
  })

  return {
  // ─────────────── State ───────────────
  graphs: [],
  currentGraphId: null,
  nodes: [],
  edges: [],
  bugs: [],
  selectedNodeId: null,
  selectedEdgeId: null,

  // ─────────────── Graph Operations ───────────────
  loadGraphs: async () => {
    const graphs = await window.electronAPI['graph:list']()
    set({ graphs })
  },

  loadGraph: async (graphId: string) => {
    const result = await window.electronAPI['graph:get'](graphId)
    if (result) {
      set({
        nodes: result.nodes,
        edges: result.edges,
        bugs: result.bugs,
      })
    }
  },

  createGraph: async (name, type, sourceGraphId) => {
    if (sourceGraphId) {
      const graph = await window.electronAPI['graph:derive'](sourceGraphId, name)
      set((state) => ({ graphs: [graph, ...state.graphs] }))
      return graph
    }
    const graph = await window.electronAPI['graph:create']({ name, type })
    set((state) => ({ graphs: [graph, ...state.graphs] }))
    return graph
  },

  deleteGraph: async (id) => {
    await window.electronAPI['graph:delete'](id)
    set((state) => ({
      graphs: state.graphs.filter((g) => g.id !== id),
      currentGraphId: state.currentGraphId === id ? null : state.currentGraphId,
    }))
  },

  setCurrentGraph: (id) => {
    set({ currentGraphId: id, selectedNodeId: null, selectedEdgeId: null })
    if (id) {
      get().loadGraph(id)
    } else {
      set({ nodes: [], edges: [], bugs: [] })
    }
  },

  // ─────────────── Node Operations (乐观更新) ───────────────
  createNode: async (data) => {
    const optimisticId = generateId('node')
    const now = new Date().toISOString()
    const optimisticNode: GraphNode = { ...data, id: optimisticId, createdAt: now, updatedAt: now }

    return optimisticCreate(
      get().nodes,
      optimisticNode,
      () => window.electronAPI['node:create'](data),
      (nodes) => set({ nodes }),
    )
  },

  createNodeBatch: async (nodesData) => {
    const now = new Date().toISOString()
    const optimisticIds = nodesData.map(() => generateId('node'))
    const optimisticNodes: GraphNode[] = nodesData.map((data, i) => ({
      ...data,
      id: optimisticIds[i],
      createdAt: now,
      updatedAt: now,
    }))

    set((state) => ({ nodes: [...state.nodes, ...optimisticNodes] }))

    try {
      const created = await window.electronAPI['node:createBatch'](nodesData)
      set((state) => ({
        nodes: state.nodes.map((n) => {
          const idx = optimisticIds.indexOf(n.id)
          return idx >= 0 ? created[idx] : n
        }),
      }))
      return created
    } catch (err) {
      set((state) => ({
        nodes: state.nodes.filter((n) => !optimisticIds.includes(n.id)),
      }))
      throw err
    }
  },

  updateNode: async (id, data) => {
    const prevNode = get().nodes.find((n) => n.id === id)
    if (!prevNode) return

    // 状态机校验：如果更新包含 status，验证转换是否合法
    if (data.status && data.status !== prevNode.status) {
      if (!canTransition(prevNode.status, data.status)) {
        const err = new Error(
          `非法状态转换: "${prevNode.status}" → "${data.status}" 不被允许`,
        )
        eventBus.emit(Events.NODE_STATUS_REJECTED, id, prevNode.status, data.status, err.message)
        throw err
      }
    }

    // 乐观更新
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...data } : n)),
    }))

    try {
      const updated = await window.electronAPI['node:update'](id, data)
      set((state) => ({
        nodes: state.nodes.map((n) => (n.id === id ? updated : n)),
      }))
    } catch (err) {
      // 回滚
      set((state) => ({
        nodes: state.nodes.map((n) => (n.id === id ? prevNode : n)),
      }))
      throw err
    }
  },

  batchUpdatePositions: async (updates) => {
    const prevNodes = get().nodes
    // 乐观更新
    set((state) => ({
      nodes: state.nodes.map((n) => {
        const u = updates.find((u) => u.id === n.id)
        return u ? { ...n, position: { x: u.x, y: u.y } } : n
      }),
    }))

    try {
      await window.electronAPI['node:batchUpdatePositions'](updates)
    } catch (err) {
      set({ nodes: prevNodes })
      throw err
    }
  },

  deleteNode: async (id) => {
    const deletedNode = get().nodes.find((n) => n.id === id)
    const deletedEdges = get().edges.filter((e) => e.source === id || e.target === id)
    // 乐观删除
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    }))

    try {
      await window.electronAPI['node:delete'](id)
    } catch (err) {
      // 回滚：恢复节点和关联边
      set((state) => ({
        nodes: deletedNode ? [...state.nodes, deletedNode] : state.nodes,
        edges: [...state.edges, ...deletedEdges],
      }))
      throw err
    }
  },

  selectNode: (id) => {
    set({ selectedNodeId: id, selectedEdgeId: null })
  },

  // ─────────────── Edge Operations (乐观更新) ───────────────
  createEdge: async (data) => {
    const optimisticId = generateId('edge')
    const optimisticEdge: GraphEdge = { ...data, id: optimisticId }

    return optimisticCreate(
      get().edges,
      optimisticEdge,
      () => window.electronAPI['edge:create'](data),
      (edges) => set({ edges }),
    )
  },

  updateEdge: async (id, data) => {
    const prevEdge = get().edges.find((e) => e.id === id)
    if (!prevEdge) return

    set((state) => ({
      edges: state.edges.map((e) => (e.id === id ? { ...e, ...data } : e)),
    }))

    try {
      const updated = await window.electronAPI['edge:update'](id, data)
      set((state) => ({
        edges: state.edges.map((e) => (e.id === id ? updated : e)),
      }))
    } catch (err) {
      set((state) => ({
        edges: state.edges.map((e) => (e.id === id ? prevEdge : e)),
      }))
      throw err
    }
  },

  deleteEdge: async (id) => {
    const deletedEdge = get().edges.find((e) => e.id === id)
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== id),
      selectedEdgeId: state.selectedEdgeId === id ? null : state.selectedEdgeId,
    }))

    try {
      await window.electronAPI['edge:delete'](id)
    } catch (err) {
      set((state) => ({
        edges: deletedEdge ? [...state.edges, deletedEdge] : state.edges,
      }))
      throw err
    }
  },

  selectEdge: (id) => {
    set({ selectedEdgeId: id, selectedNodeId: null })
  },

  // ─────────────── Bug Operations (乐观更新) ───────────────
  createBug: async (data) => {
    const optimisticId = generateId('bug')
    const now = new Date().toISOString()
    const optimisticBug: BugNode = { ...data, id: optimisticId, createdAt: now, updatedAt: now }

    return optimisticCreate(
      get().bugs,
      optimisticBug,
      () => window.electronAPI['bug:create'](data),
      (bugs) => set({ bugs }),
    )
  },

  updateBug: async (id, data) => {
    const prevBug = get().bugs.find((b) => b.id === id)
    if (!prevBug) return

    set((state) => ({
      bugs: state.bugs.map((b) => (b.id === id ? { ...b, ...data } : b)),
    }))

    try {
      const updated = await window.electronAPI['bug:update'](id, data)
      set((state) => ({
        bugs: state.bugs.map((b) => (b.id === id ? updated : b)),
      }))
    } catch (err) {
      set((state) => ({
        bugs: state.bugs.map((b) => (b.id === id ? prevBug : b)),
      }))
      throw err
    }
  },

  deleteBug: async (id) => {
    const deletedBug = get().bugs.find((b) => b.id === id)
    set((state) => ({
      bugs: state.bugs.filter((b) => b.id !== id),
    }))

    try {
      await window.electronAPI['bug:delete'](id)
    } catch (err) {
      set((state) => ({
        bugs: deletedBug ? [...state.bugs, deletedBug] : state.bugs,
      }))
      throw err
    }
  },

  addSuggestedEdges: (edges) => {
    set(state => {
      const newEdges = edges.filter(e => !state.edges.some(ex => ex.source === e.source && ex.target === e.target))
      return { edges: [...state.edges, ...newEdges.map(e => ({ ...e, graphId: state.currentGraphId ?? '', label: '', id: e.id }))] }
    })
  },

  confirmSuggestedEdge: (edgeId) => {
    set(state => ({
      edges: state.edges.map(e =>
        e.id === edgeId && e.content?.suggested
          ? { ...e, content: { ...e.content, suggested: false } }
          : e
      )
    }))
    const edge = get().edges.find(e => e.id === edgeId)
    if (edge) {
      window.electronAPI['edge:update'](edgeId, { content: { ...edge.content, suggested: false } })
    }
  },

  rejectSuggestedEdge: (edgeId) => {
    set(state => ({ edges: state.edges.filter(e => e.id !== edgeId) }))
    window.electronAPI['edge:delete'](edgeId)
  },

  confirmPreviewNode: (nodeId) => {
    const node = get().nodes.find(n => n.id === nodeId)
    if (!node) return
    const { preview, ...restMetadata } = node.metadata ?? {}
    const updatedMetadata = restMetadata
    set(state => ({
      nodes: state.nodes.map(n =>
        n.id === nodeId ? { ...n, metadata: updatedMetadata } : n
      )
    }))
    window.electronAPI['node:update'](nodeId, { metadata: updatedMetadata })
  },

  clearPreviewNodes: () => {
    const previewIds = get().nodes.filter(n => n.metadata?.preview).map(n => n.id)
    previewIds.forEach(id => window.electronAPI['node:delete'](id))
    set(state => ({ nodes: state.nodes.filter(n => !n.metadata?.preview) }))
  },

  getNodeById: (id) => get().nodes.find(n => n.id === id),
  getNodesByType: (type) => get().nodes.filter(n => n.type === type),

  // Task 4.4.1: Frontend search index
  searchNodes: (query, filters) => {
    const { nodes } = get()
    const q = query.toLowerCase().trim()

    if (!q && !filters) return nodes

    let results = nodes

    // Filter by type
    if (filters?.type) {
      results = results.filter(n => n.type === filters.type)
    }

    // Filter by status
    if (filters?.status) {
      results = results.filter(n => n.status === filters.status)
    }

    // Filter by name (substring match)
    if (q) {
      results = results.filter(n => {
        const name = (filters?.name ?? n.title).toLowerCase()
        return name.includes(q) || n.description?.toLowerCase().includes(q)
      })
    }

    // Sort by relevance: exact title match > title starts with > title contains > description contains
    if (q) {
      results.sort((a, b) => {
        const aTitle = a.title.toLowerCase()
        const bTitle = b.title.toLowerCase()
        const aExact = aTitle === q ? 0 : aTitle.startsWith(q) ? 1 : aTitle.includes(q) ? 2 : 3
        const bExact = bTitle === q ? 0 : bTitle.startsWith(q) ? 1 : bTitle.includes(q) ? 2 : 3
        return aExact - bExact
      })
    }

    return results
  },
  }
})
