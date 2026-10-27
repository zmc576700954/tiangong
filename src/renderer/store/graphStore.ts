import { create } from 'zustand'
import type { Graph, GraphNode, GraphEdge, BugNode, NodeStatus, EdgeType, EdgeContent } from '@shared/types'
import type { IngestResult, IngestMode, LintReport, LintFixAction, LintFixResult, ComputeResult, WritebackItem, RollbackResult } from '@shared/types/wiki'
import { generateId } from '../lib/utils'
import { eventBus, Events } from './eventBus'
import { canTransition } from '@shared/state-machine'

// ============================================
// Store 定义
// ============================================

/** Agent 状态变更事件取消订阅函数 */
let _unsubAgentStatus: (() => void) | null = null

function buildNodeMap(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]))
}

function buildEdgeMap(edges: GraphEdge[]): Map<string, GraphEdge> {
  return new Map(edges.map((e) => [e.id, e]))
}

/** wiki-link 边只服务关系查询，不进画布 */
function excludeWikiLinkEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => e.edgeType !== 'wiki-link')
}

interface GraphState {
  graphs: Graph[]
  currentGraphId: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  bugs: BugNode[]
  /** 内部 Map 索引，用于 O(1) 节点/边查找（不暴露给组件订阅） */
  _nodeMap: Map<string, GraphNode>
  _edgeMap: Map<string, GraphEdge>
  selectedNodeId: string | null
  selectedEdgeId: string | null
  selectedNodeIds: Set<string>

  loadGraphs: () => Promise<void>
  loadGraph: (graphId: string) => Promise<void>

  createGraph: (name: string, type: 'online' | 'dev', sourceGraphId?: string) => Promise<Graph>
  deleteGraph: (id: string) => Promise<void>
  setCurrentGraph: (id: string | null) => void

  createNode: (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GraphNode>
  createNodeBatch: (nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<GraphNode[]>
  updateNode: (id: string, data: Partial<GraphNode>) => Promise<void>
  batchUpdatePositions: (updates: Array<{ id: string; x: number; y: number }>) => Promise<void>
  /**
   * 只更新渲染端 store 里的位置，**不落库**。
   *
   * 拖拽结束那一下必须让 store 立刻跟上画布：`flowNodes` 的缓存键一变
   * （被拖节点的 zIndex 变化）就会整条重建，重建时带的是 store 里的位置 ——
   * store 落后 300ms 的话，节点松手瞬间会弹回拖拽前的位置。
   *
   * 落库仍然防抖、仍然能被重挂路径的抑制机制摘掉 —— 位置权威在主进程。
   */
  applyLocalPositions: (updates: Array<{ id: string; x: number; y: number }>) => void
  /** 拖拽重挂父节点 —— 父子关系变更的唯一入口（Task 6 的 graph:reparent） */
  reparentNode: (nodeId: string, newParentId: string) => Promise<void>
  deleteNode: (id: string) => Promise<void>
  selectNode: (id: string | null) => void
  toggleNodeSelection: (nodeId: string) => void
  clearNodeSelection: () => void
  selectNodeIds: (ids: string[]) => void

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

  // Association discovery notifications
  associationNotifications: Array<{ id: string; count: number; timestamp: number }>
  addAssociationNotification: (count: number) => void
  dismissAssociationNotification: (id: string) => void

  /** 清理事件监听，释放资源 */
  destroy: () => void

  /** 确保当前图存在 Graph Index / Graph Log 特殊 Wiki 页（LLM-Wiki） */
  ensureSpecialWikiPages: () => Promise<{ indexId: string | null; logId: string | null }>

  /** 导入 markdown/txt 文件为 Wiki 页面（Ingest 管线） */
  importWikiFiles: (filePaths: string[], mode?: IngestMode) => Promise<IngestResult>

  /** 运行 Wiki 图检查 */
  lintGraph: () => Promise<LintReport | null>

  /** 应用一条 Lint 修复动作（创建 stub / 补 frontmatter / 归一化标题） */
  applyLintFix: (fix: LintFixAction) => Promise<LintFixResult>

  /** 计算 Wiki 社区并刷新图 */
  computeCommunities: () => Promise<ComputeResult | null>

  /** 列出当前图的待审核写回项 */
  listWriteback: () => Promise<WritebackItem[]>

  /** 统计当前图待审核写回项数量 */
  countWriteback: () => Promise<number>

  /** 采纳写回项 */
  acceptWriteback: (itemId: string) => Promise<void>

  /** 丢弃写回项 */
  discardWriteback: (itemId: string) => Promise<void>

  /** 撤回已采纳的写回项（accepted → rolled_back）；返回 undo/skipped 详情 */
  rollbackWriteback: (itemId: string) => Promise<RollbackResult>

  /** 列出 accepted + 30 天内 rolled_back 的历史项 */
  listWritebackHistory: (sinceIso?: string) => Promise<WritebackItem[]>
}

export const useGraphStore = create<GraphState>((set, get) => {
  const setNodes = (fn: (nodes: GraphNode[]) => GraphNode[]) => {
    set((state) => {
      const next = fn(state.nodes)
      return { nodes: next, _nodeMap: buildNodeMap(next) }
    })
  }

  const setEdges = (fn: (edges: GraphEdge[]) => GraphEdge[]) => {
    set((state) => {
      const next = fn(state.edges)
      return { edges: next, _edgeMap: buildEdgeMap(next) }
    })
  }

  // 监听 Agent 状态变更事件（解耦 agentStore → graphStore 的直接引用）
  _unsubAgentStatus = eventBus.on(Events.AGENT_STATUS_CHANGE, (nodeId, status) => {
    get().updateNode(nodeId, { status: status as NodeStatus })
  })

  return {
  // ─────────────── State ───────────────
  graphs: [],
  currentGraphId: null,
  nodes: [],
  edges: [],
  bugs: [],
  _nodeMap: new Map(),
  _edgeMap: new Map(),
  selectedNodeId: null,
  selectedEdgeId: null,
  selectedNodeIds: new Set(),
  associationNotifications: [],

  // ─────────────── Graph Operations ───────────────
  loadGraphs: async () => {
    const graphs = await window.electronAPI['graph:list']()
    set({ graphs })
  },

  loadGraph: async (graphId: string) => {
    const result = await window.electronAPI['graph:get'](graphId)
    if (result) {
      const edges = excludeWikiLinkEdges(result.edges)
      set({
        nodes: result.nodes,
        edges,
        bugs: result.bugs,
        _nodeMap: buildNodeMap(result.nodes),
        _edgeMap: buildEdgeMap(edges),
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
      set({ nodes: [], edges: [], bugs: [], _nodeMap: new Map(), _edgeMap: new Map() })
    }
  },

  // ─────────────── Node Operations (乐观更新) ───────────────
  createNode: async (data) => {
    const optimisticId = generateId('node')
    const now = new Date().toISOString()
    const optimisticNode: GraphNode = { ...data, id: optimisticId, createdAt: now, updatedAt: now }

    setNodes((nodes) => [...nodes, optimisticNode])

    try {
      const serverItem = await window.electronAPI['node:create'](data)
      setNodes((nodes) => nodes.map((item) => (item.id === optimisticId ? serverItem : item)))
      return serverItem
    } catch (err) {
      setNodes((nodes) => nodes.filter((item) => item.id !== optimisticId))
      throw err
    }
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

    setNodes((nodes) => [...nodes, ...optimisticNodes])

    try {
      const created = await window.electronAPI['node:createBatch'](nodesData)
      setNodes((nodes) =>
        nodes.map((n) => {
          if (!optimisticIds.includes(n.id)) return n
          const match = created.find(c => c.title === n.title && (c.parentId ?? '') === (n.parentId ?? ''))
          return match ?? n
        }),
      )
      return created
    } catch (err) {
      setNodes((nodes) => nodes.filter((n) => !optimisticIds.includes(n.id)))
      throw err
    }
  },

  updateNode: async (id, data) => {
    const prevNode = get()._nodeMap.get(id)
    if (!prevNode) return

    // 状态机校验：如果更新包含 status，验证转换是否合法
    if (data.status && data.status !== prevNode.status) {
      if (!canTransition(prevNode.status, data.status)) {
        const err = new Error(
          `非法状态转换: "${prevNode.status}" → "${data.status}" 不被允许`,
        )
        eventBus.emit(Events.NODE_STATUS_REJECTED, id, prevNode.status, data.status)
        throw err
      }
    }

    // 乐观更新
    setNodes((nodes) => nodes.map((n) => (n.id === id ? { ...n, ...data } : n)))

    try {
      const updated = await window.electronAPI['node:update'](id, data)
      setNodes((nodes) => nodes.map((n) => (n.id === id ? updated : n)))
    } catch (err) {
      // 回滚
      setNodes((nodes) => nodes.map((n) => (n.id === id ? prevNode : n)))
      throw err
    }
  },

  batchUpdatePositions: async (updates) => {
    const updateMap = new Map(updates.map((u) => [u.id, u]))
    let prevNodes: GraphNode[] = []
    setNodes((nodes) => {
      prevNodes = nodes
      return nodes.map((n) => {
        const u = updateMap.get(n.id)
        return u ? { ...n, position: { x: u.x, y: u.y } } : n
      })
    })

    try {
      await window.electronAPI['node:batchUpdatePositions'](updates)
    } catch (err) {
      set({ nodes: prevNodes, _nodeMap: buildNodeMap(prevNodes) })
      throw err
    }
  },

  /**
   * 只改 store、不落库的位置更新。
   *
   * 拖拽结束那一下，store 必须**立刻**跟上画布：`flowNodes` 的缓存键一变
   * （被拖节点的 zIndex 变化）就会整条重建，重建时带的是 store 里的位置 ——
   * store 落后 300ms 的话，节点松手瞬间会弹回拖拽前的位置。
   *
   * 落库仍然防抖、仍然能被重挂路径的抑制机制摘掉 —— 位置权威在主进程。
   * 所以这里**没有** IPC、**没有** try/catch、**没有**回滚：不落库，没有失败可回滚。
   */
  applyLocalPositions: (updates) => {
    const updateMap = new Map(updates.map((u) => [u.id, u]))
    setNodes((nodes) =>
      nodes.map((n) => {
        const u = updateMap.get(n.id)
        return u ? { ...n, position: { x: u.x, y: u.y } } : n
      }),
    )
  },

  /**
   * 拖拽重挂父节点。
   *
   * 主进程算好锚点位置并把整棵子树平移，返回 `movedPositions`（**包含被移动节点自己**）。
   * 位置以主进程为准 —— 渲染端的自由位置持久化必须给这条路径让位。
   *
   * ⚠️ 被移动节点自己的位置也要更新：`translateSubtree` 在目标父节点已有兄弟时
   * 会把锚点挪到兄弟包围盒的左侧 / 下方，它的坐标**确实会变**。
   * 只改 parentId 不改 position → store 留旧坐标、DB 是新坐标 → 节点弹回原处。
   */
  reparentNode: async (nodeId, newParentId) => {
    const result = await window.electronAPI['graph:reparent'](nodeId, newParentId)
    const posMap = new Map(result.movedPositions.map((p) => [p.id, p]))
    setNodes((nodes) =>
      nodes.map((n) => {
        const p = posMap.get(n.id)
        const position = p ? { x: p.x, y: p.y } : n.position
        if (n.id === nodeId) return { ...n, parentId: result.newParentId, position }
        return p ? { ...n, position } : n
      }),
    )
  },

  deleteNode: async (id) => {
    const deletedNode = get()._nodeMap.get(id)
    const deletedEdges = get().edges.filter((e) => e.source === id || e.target === id)
    // 乐观删除
    setNodes((nodes) => nodes.filter((n) => n.id !== id))
    setEdges((edges) => edges.filter((e) => e.source !== id && e.target !== id))
    set({ selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId })

    try {
      await window.electronAPI['node:delete'](id)
    } catch (err) {
      // 回滚：恢复节点和关联边
      setNodes((nodes) => deletedNode ? [...nodes, deletedNode] : nodes)
      setEdges((edges) => [...edges, ...deletedEdges])
      throw err
    }
  },

  selectNode: (id) => {
    set({ selectedNodeId: id, selectedEdgeId: null })
  },

  toggleNodeSelection: (nodeId) => set((s) => {
    const next = new Set(s.selectedNodeIds)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    return { selectedNodeIds: next }
  }),

  clearNodeSelection: () => set({ selectedNodeIds: new Set() }),

  selectNodeIds: (ids) => set({ selectedNodeIds: new Set(ids) }),

  // ─────────────── Edge Operations (乐观更新) ───────────────
  createEdge: async (data) => {
    const optimisticId = generateId('edge')
    const optimisticEdge: GraphEdge = { ...data, id: optimisticId }

    setEdges((edges) => [...edges, optimisticEdge])

    try {
      const serverItem = await window.electronAPI['edge:create'](data)
      setEdges((edges) => edges.map((e) => (e.id === optimisticId ? serverItem : e)).filter((e) => e.edgeType !== 'wiki-link'))
      return serverItem
    } catch (err) {
      setEdges((edges) => edges.filter((e) => e.id !== optimisticId))
      throw err
    }
  },

  updateEdge: async (id, data) => {
    const prevEdge = get()._edgeMap.get(id)
    if (!prevEdge) return

    setEdges((edges) => edges.map((e) => (e.id === id ? { ...e, ...data } : e)))

    try {
      const updated = await window.electronAPI['edge:update'](id, data)
      setEdges((edges) => edges.map((e) => (e.id === id ? updated : e)))
    } catch (err) {
      setEdges((edges) => edges.map((e) => (e.id === id ? prevEdge : e)))
      throw err
    }
  },

  deleteEdge: async (id) => {
    const deletedEdge = get()._edgeMap.get(id)
    setEdges((edges) => edges.filter((e) => e.id !== id))
    set({ selectedEdgeId: get().selectedEdgeId === id ? null : get().selectedEdgeId })

    try {
      await window.electronAPI['edge:delete'](id)
    } catch (err) {
      setEdges((edges) => deletedEdge ? [...edges, deletedEdge] : edges)
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

    set((state) => ({ bugs: [...state.bugs, optimisticBug] }))

    try {
      const serverItem = await window.electronAPI['bug:create'](data)
      set((state) => ({
        bugs: state.bugs.map((b) => (b.id === optimisticId ? serverItem : b)),
      }))
      return serverItem
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

  addSuggestedEdges: (edges) => {
    const currentGraphId = get().currentGraphId
    setEdges((stateEdges) => {
      const newEdges = edges.filter(e => !stateEdges.some(ex => ex.source === e.source && ex.target === e.target))
      return [...stateEdges, ...newEdges.map(e => ({ ...e, graphId: currentGraphId ?? '', label: '', id: e.id }))]
    })
  },

  confirmSuggestedEdge: (edgeId) => {
    const edge = get()._edgeMap.get(edgeId)
    if (!edge || !edge.content?.suggested) return
    const newContent = { ...edge.content, suggested: false }
    setEdges((edges) =>
      edges.map(e =>
        e.id === edgeId ? { ...e, content: newContent } : e
      )
    )
    window.electronAPI['edge:update'](edgeId, { content: newContent }).catch((err) => {
      console.error('[graphStore] Failed to confirm suggested edge:', err)
      setEdges((edges) =>
        edges.map(e =>
          e.id === edgeId ? { ...e, content: edge.content } : e
        )
      )
    })
  },

  rejectSuggestedEdge: (edgeId) => {
    const edge = get()._edgeMap.get(edgeId)
    if (!edge) return
    setEdges((edges) => edges.filter(e => e.id !== edgeId))
    window.electronAPI['edge:delete'](edgeId).catch((err) => {
      console.error('[graphStore] Failed to reject suggested edge:', err)
      setEdges((edges) => [...edges, edge])
    })
  },

  confirmPreviewNode: (nodeId) => {
    const node = get()._nodeMap.get(nodeId)
    if (!node) return
    const { preview: _preview, ...restMetadata } = node.metadata ?? {}
    const updatedMetadata = restMetadata
    setNodes((nodes) =>
      nodes.map(n =>
        n.id === nodeId ? { ...n, metadata: updatedMetadata } : n
      )
    )
    window.electronAPI['node:update'](nodeId, { metadata: updatedMetadata })
  },

  clearPreviewNodes: () => {
    const previewNodes = get().nodes.filter(n => n.metadata?.preview)
    setNodes((nodes) => nodes.filter(n => !n.metadata?.preview))
    Promise.all(previewNodes.map(n => window.electronAPI['node:delete'](n.id))).catch((err: unknown) => {
      console.error('[graphStore] Failed to delete some preview nodes:', err)
    })
  },

  getNodeById: (id) => get()._nodeMap.get(id),
  getNodesByType: (type) => {
    const result: GraphNode[] = []
    for (const node of get()._nodeMap.values()) {
      if (node.type === type) result.push(node)
    }
    return result
  },

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

    // Filter by name (substring match against title)
    if (filters?.name) {
      const nameFilter = filters.name.toLowerCase()
      results = results.filter(n => n.title.toLowerCase().includes(nameFilter))
    }

    // Search by query (substring match against title/description)
    if (q) {
      results = results.filter(n => {
        const title = n.title.toLowerCase()
        return title.includes(q) || n.description?.toLowerCase().includes(q)
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

  addAssociationNotification: (count) => set((s) => ({
    associationNotifications: [...s.associationNotifications, { id: `assoc_${Date.now()}`, count, timestamp: Date.now() }],
  })),

  dismissAssociationNotification: (id) => set((s) => ({
    associationNotifications: s.associationNotifications.filter((n) => n.id !== id),
  })),

  destroy: () => {
    _unsubAgentStatus?.()
    _unsubAgentStatus = null
  },

  ensureSpecialWikiPages: async () => {
    const graphId = get().currentGraphId
    if (!graphId) return { indexId: null, logId: null }

    const graph = get().graphs.find((g) => g.id === graphId)
    const graphType = graph?.type ?? 'online'
    const existing = get().nodes.filter((n) => n.type === 'wiki-page')

    let indexNode = existing.find((n) => n.title === 'Graph Index')
    if (!indexNode) {
      indexNode = await get().createNode({
        type: 'wiki-page',
        status: 'confirmed',
        title: 'Graph Index',
        description: '本图的索引页，汇总所有节点与关系。',
        graphId,
        graphType,
        position: { x: -400, y: 0 },
        acceptanceCriteria: [],
        wikiContent: '# Graph Index\n\n这是本图的索引 Wiki 页，可以用 [[页面标题]] 链接到其他 Wiki 页面。',
        wikiMeta: { special: 'index' },
      })
    }

    let logNode = existing.find((n) => n.title === 'Graph Log')
    if (!logNode) {
      logNode = await get().createNode({
        type: 'wiki-page',
        status: 'confirmed',
        title: 'Graph Log',
        description: '本图的变更日志。',
        graphId,
        graphType,
        position: { x: -400, y: 120 },
        acceptanceCriteria: [],
        wikiContent: '# Graph Log\n\n记录本图的变更历史、Agent 会话产物与重要决策。',
        wikiMeta: { special: 'log' },
      })
    }

    return { indexId: indexNode.id, logId: logNode.id }
  },

  importWikiFiles: async (filePaths, mode) => {
    const graphId = get().currentGraphId
    if (!graphId || filePaths.length === 0) return { created: [], updated: [], failed: [] }
    const result = await window.electronAPI['wiki:ingestFiles'](graphId, filePaths, mode)
    await get().loadGraph(graphId)
    return result
  },

  lintGraph: async () => {
    const graphId = get().currentGraphId
    if (!graphId) return null
    return window.electronAPI['wiki:lint'](graphId)
  },

  applyLintFix: async (fix) => {
    const graphId = get().currentGraphId
    if (!graphId) throw new Error('no current graph')
    const result = await window.electronAPI['wiki:applyFix'](graphId, fix)
    // 修复动作可能新增/改动节点，重载图以同步状态
    await get().loadGraph(graphId)
    return result
  },

  computeCommunities: async () => {
    const graphId = get().currentGraphId
    if (!graphId) return null
    const result = await window.electronAPI['wiki:computeCommunities'](graphId)
    await get().loadGraph(graphId)
    return result
  },

  listWriteback: async () => {
    const graphId = get().currentGraphId
    if (!graphId) return []
    return window.electronAPI['wiki:listWriteback'](graphId)
  },

  countWriteback: async () => {
    const graphId = get().currentGraphId
    if (!graphId) return 0
    return window.electronAPI['wiki:countWriteback'](graphId)
  },

  acceptWriteback: async (itemId) => {
    await window.electronAPI['wiki:acceptWriteback'](itemId)
  },

  discardWriteback: async (itemId) => {
    await window.electronAPI['wiki:discardWriteback'](itemId)
  },

  rollbackWriteback: async (itemId) => {
    return window.electronAPI['wiki:rollbackWriteback'](itemId)
  },

  listWritebackHistory: async (sinceIso) => {
    const graphId = get().currentGraphId
    if (!graphId) return []
    return window.electronAPI['wiki:listWritebackHistory'](graphId, sinceIso)
  },
  }
})

// Keep internal Map indexes in sync when external callers (e.g. tests or legacy
// code) set nodes/edges directly without providing _nodeMap/_edgeMap.
const _originalGraphSetState = useGraphStore.setState.bind(useGraphStore)
useGraphStore.setState = function overrideGraphSetState(
  partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>),
  replace?: boolean,
) {
  const resolved = typeof partial === 'function'
    ? (partial as (state: GraphState) => Partial<GraphState>)(useGraphStore.getState())
    : partial
  const update: Partial<GraphState> = { ...resolved }
  if (resolved.nodes !== undefined && resolved._nodeMap === undefined) {
    update._nodeMap = buildNodeMap(resolved.nodes)
  }
  if (resolved.edges !== undefined && resolved._edgeMap === undefined) {
    update._edgeMap = buildEdgeMap(resolved.edges)
  }
  return _originalGraphSetState(update, replace as false | undefined)
} as typeof useGraphStore.setState

// HMR cleanup: unsubscribe from previous module's event bus listener
const _hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot
if (_hot) {
  _hot.dispose(() => { _unsubAgentStatus?.() })
}
