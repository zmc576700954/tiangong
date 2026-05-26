import { create } from 'zustand'
import type { Graph, GraphNode, GraphEdge, BugNode } from '@shared/types'

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
  updateNode: (id: string, data: Partial<GraphNode>) => Promise<void>
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
  graphs: [],
  currentGraphId: null,
  nodes: [],
  edges: [],
  bugs: [],
  selectedNodeId: null,
  selectedEdgeId: null,

  loadGraphs: async () => {
    const graphs = await window.electronAPI['graph:list']() as Graph[]
    set({ graphs })
  },

  loadGraph: async (graphId: string) => {
    const result = await window.electronAPI['graph:get'](graphId) as { graph: Graph; nodes: GraphNode[]; edges: GraphEdge[] } | null
    if (result) {
      set({
        nodes: result.nodes,
        edges: result.edges,
      })
      const allBugs: BugNode[] = []
      for (const node of result.nodes) {
        const nodeBugs = await window.electronAPI['bug:listByNode'](node.id) as BugNode[]
        allBugs.push(...nodeBugs)
      }
      set({ bugs: allBugs })
    }
  },

  createGraph: async (name, type) => {
    const graph = await window.electronAPI['graph:create']({ name, type }) as Graph
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

  createNode: async (data) => {
    const node = await window.electronAPI['node:create'](data) as GraphNode
    set((state) => ({ nodes: [...state.nodes, node] }))
    return node
  },

  updateNode: async (id, data) => {
    const updated = await window.electronAPI['node:update'](id, data) as GraphNode
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? updated : n)),
    }))
  },

  deleteNode: async (id) => {
    await window.electronAPI['node:delete'](id)
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    }))
  },

  selectNode: (id) => {
    set({ selectedNodeId: id, selectedEdgeId: null })
  },

  createEdge: async (data) => {
    const edge = await window.electronAPI['edge:create'](data) as GraphEdge
    set((state) => ({ edges: [...state.edges, edge] }))
    return edge
  },

  updateEdge: async (id, data) => {
    const updated = await window.electronAPI['edge:update'](id, data) as GraphEdge
    set((state) => ({
      edges: state.edges.map((e) => (e.id === id ? updated : e)),
    }))
  },

  deleteEdge: async (id) => {
    await window.electronAPI['edge:delete'](id)
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== id),
      selectedEdgeId: state.selectedEdgeId === id ? null : state.selectedEdgeId,
    }))
  },

  selectEdge: (id) => {
    set({ selectedEdgeId: id, selectedNodeId: null })
  },

  createBug: async (data) => {
    const bug = await window.electronAPI['bug:create'](data) as BugNode
    set((state) => ({ bugs: [...state.bugs, bug] }))
    return bug
  },

  updateBug: async (id, data) => {
    const updated = await window.electronAPI['bug:update'](id, data) as BugNode
    set((state) => ({
      bugs: state.bugs.map((b) => (b.id === id ? updated : b)),
    }))
  },

  deleteBug: async (id) => {
    await window.electronAPI['bug:delete'](id)
    set((state) => ({
      bugs: state.bugs.filter((b) => b.id !== id),
    }))
  },
}))
