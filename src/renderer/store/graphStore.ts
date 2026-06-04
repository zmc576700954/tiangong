import { create } from 'zustand'
import type { Graph, GraphNode, GraphEdge, BugNode } from '@shared/types'
import { generateId } from '../lib/utils'

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
}

export const useGraphStore = create<GraphState>((set, get) => ({
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

  createGraph: async (name, type) => {
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
    const optimisticNode = { ...data, id: optimisticId, createdAt: now, updatedAt: now } as GraphNode

    set((state) => ({ nodes: [...state.nodes, optimisticNode] }))

    try {
      const node = await window.electronAPI['node:create'](data)
      set((state) => ({
        nodes: state.nodes.map((n) => (n.id === optimisticId ? node : n)),
      }))
      return node
    } catch (err) {
      set((state) => ({
        nodes: state.nodes.filter((n) => n.id !== optimisticId),
      }))
      throw err
    }
  },

  createNodeBatch: async (nodesData) => {
    const optimisticIds = nodesData.map(() => generateId('node'))
    const now = new Date().toISOString()
    const optimisticNodes = nodesData.map((data, i) => ({
      ...data,
      id: optimisticIds[i],
      createdAt: now,
      updatedAt: now,
    })) as GraphNode[]

    set((state) => ({ nodes: [...state.nodes, ...optimisticNodes] }))

    try {
      const created = await Promise.all(
        nodesData.map((data) => window.electronAPI['node:create'](data)),
      )
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
    const optimisticEdge = { ...data, id: optimisticId } as GraphEdge

    set((state) => ({ edges: [...state.edges, optimisticEdge] }))

    try {
      const edge = await window.electronAPI['edge:create'](data)
      set((state) => ({
        edges: state.edges.map((e) => (e.id === optimisticId ? edge : e)),
      }))
      return edge
    } catch (err) {
      set((state) => ({
        edges: state.edges.filter((e) => e.id !== optimisticId),
      }))
      throw err
    }
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
    const optimisticBug = { ...data, id: optimisticId, createdAt: now, updatedAt: now } as BugNode

    set((state) => ({ bugs: [...state.bugs, optimisticBug] }))

    try {
      const bug = await window.electronAPI['bug:create'](data)
      set((state) => ({
        bugs: state.bugs.map((b) => (b.id === optimisticId ? bug : b)),
      }))
      return bug
    } catch (err) {
      set((state) => ({
        bugs: state.bugs.filter((b) => b.id !== optimisticId),
      }))
      throw err
    }
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
}))
