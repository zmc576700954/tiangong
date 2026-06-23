import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useOnViewportChange,
  type Edge,
  type Node,
  type OnNodesChange,
  type OnConnect,
  type OnConnectStart,
  type OnConnectEnd,
  Panel,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../store/graphStore'
import { useAppStore } from '../store/appStore'
import { useGraphRuntimeStore } from '../store/graphRuntimeStore'
import { useThreadStore } from '../store/threadStore'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode, NodeType, NodeStatus } from '@shared/types'
import { BizEdge } from './BizEdge'
import { getEdgeMarkerEnd, edgeTypeConfig } from './edge-utils'
import { cn } from '../lib/utils'
import { BizNodeComponent } from './BizNode'
import { CanvasOverlay } from './components/CanvasOverlay'
import { NodeContextPopover } from './NodeContextPopover'
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard'
import { useAutoLayout } from './hooks/useAutoLayout'
import { useConnectionMode } from './hooks/useConnectionMode'
import { useNodePositionPersistence } from './hooks/useNodePositionPersistence'
import { useNodeOperations } from './hooks/useNodeOperations'
import { useEdgeConnection } from './hooks/useEdgeConnection'
import { AlignHorizontalDistributeCenter, GitBranch, X, Search } from 'lucide-react'
import { eventBus, Events } from '../store/eventBus'

/** edgeTypes 定义在组件外部，避免每次渲染重建（@xyflow/react v12 最佳实践） */
const edgeTypes = { bizEdge: BizEdge }

/** nodeTypes 定义在组件外部，避免每次渲染重建 */
function BizNodeWrapper({ id, data, selected }: {
  id: string
  data: GraphNode & {
    bugCount: number
    isZoomedOut?: boolean
    hideTextLabels?: boolean
    isConnectingSource?: boolean
    isFlashed?: boolean
    hasThread?: boolean
    agentThreadId?: string
    agentStatus?: string
    agentSessionId?: string
  }
  selected?: boolean
}) {
  return <BizNodeComponent id={id} data={data} selected={selected} />
}
const nodeTypes = { bizNode: BizNodeWrapper }

interface GraphCanvasProps {
  graphId: string
}

export function GraphCanvas({ graphId }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner graphId={graphId} />
    </ReactFlowProvider>
  )
}

function GraphCanvasInner({ graphId }: GraphCanvasProps) {
  const graphNodes = useGraphStore((state) => state.nodes)
  const graphEdges = useGraphStore((state) => state.edges)
  const loadGraph = useGraphStore((state) => state.loadGraph)
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId)
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId)
  const selectNode = useGraphStore((state) => state.selectNode)
  const selectEdge = useGraphStore((state) => state.selectEdge)
  const createNode = useGraphStore((state) => state.createNode)
  const createEdge = useGraphStore((state) => state.createEdge)
  const deleteNode = useGraphStore((state) => state.deleteNode)
  const deleteEdge = useGraphStore((state) => state.deleteEdge)
  const updateNode = useGraphStore((state) => state.updateNode)
  const bugs = useGraphStore((state) => state.bugs)
  const graphs = useGraphStore((state) => state.graphs)
  const notifications = useGraphStore((s) => s.associationNotifications)
  const dismissNotification = useGraphStore((s) => s.dismissAssociationNotification)
  const setConnectingFrom = useGraphRuntimeStore((s) => s.setConnectingFrom)
  const flashNode = useGraphRuntimeStore((s) => s.flashNode)
  const connectingFrom = useGraphRuntimeStore((s) => s.connectingFrom)
  const flashedNodeId = useGraphRuntimeStore((s) => s.flashedNodeId)
  const threads = useThreadStore((s) => s.threads)
  const nodeThreadMap = useMemo(() => {
    const map = new Map<string, { id: string; status?: string; sessionId?: string }>()
    for (const t of threads) {
      if (t.nodeBound) {
        map.set(t.nodeBound, { id: t.id, status: t.status, sessionId: t.sessionId })
      }
    }
    return map
  }, [threads])
  const currentGraph = graphs.find((g) => g.id === graphId)
  const projectPath = currentGraph?.projectPath

  const { screenToFlowPosition, setCenter } = useReactFlow()

  const bugCountMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const bug of bugs) {
      map.set(bug.nodeId, (map.get(bug.nodeId) ?? 0) + 1)
    }
    return map
  }, [bugs])

  const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  // ────────────────────────────────────────────────────────────────
  // 节点位置持久化 Hook（防抖保存拖拽位置到数据库）
  // ────────────────────────────────────────────────────────────────
  const { handleNodesChange: onPositionChange } = useNodePositionPersistence(graphId)

  const handleNodesChange: OnNodesChange<Node> = useCallback(
    (changes) => {
      // Let ReactFlow handle all change types internally (select, dimensions, position, remove)
      onRfNodesChange(changes)
      // Additionally persist position changes to DB
      onPositionChange(changes)
    },
    [onRfNodesChange, onPositionChange],
  )

  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })

  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  const [contextPopover, setContextPopover] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  // ────────────────────────────────────────────────────────────────
  // Node search overlay
  // ────────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GraphNode[]>([])
  const [searchIndex, setSearchIndex] = useState(0)

  const navigateToSearchResult = useCallback((node: GraphNode) => {
    selectNode(node.id)
    setCenter(node.position.x, node.position.y, { zoom: 1, duration: 300 })
  }, [selectNode, setCenter])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      setSearchIndex(0)
      return
    }
    const results = useGraphStore.getState().searchNodes(searchQuery)
    setSearchResults(results)
    setSearchIndex(0)
  }, [searchQuery])

  const searchNavTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (searchResults.length > 0 && searchOpen) {
      clearTimeout(searchNavTimer.current)
      searchNavTimer.current = setTimeout(() => {
        navigateToSearchResult(searchResults[0])
      }, 300)
    }
    return () => clearTimeout(searchNavTimer.current)
  }, [searchResults, searchOpen, navigateToSearchResult])

  // Navigate when user manually cycles through results (Enter key)
  useEffect(() => {
    if (searchResults.length > 0 && searchIndex > 0 && searchIndex < searchResults.length) {
      navigateToSearchResult(searchResults[searchIndex])
    }
  }, [searchIndex, searchResults, navigateToSearchResult])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const zoomLevel = useGraphRuntimeStore((s) => s.zoomLevel)
  const isZoomedOut = useGraphRuntimeStore((s) => s.isZoomedOut)
  const setZoomLevel = useGraphRuntimeStore((s) => s.setZoomLevel)
  const setIsZoomedOut = useGraphRuntimeStore((s) => s.setIsZoomedOut)

  const [genProgress, setGenProgress] = useState<{ stage: string; progress: number } | null>(null)

  // ────────────────────────────────────────────────────────────────
  // 连线模式 Hook
  // ────────────────────────────────────────────────────────────────
  const {
    connectingSourceId,
    isConnecting,
    startConnect,
    cancelConnect,
  } = useConnectionMode({ graphEdges, createEdge, graphId, setRfEdges })

  // ────────────────────────────────────────────────────────────────
  // 边创建流程 Hook
  // ────────────────────────────────────────────────────────────────
  const {
    pendingConnection,
    showEdgeTypeMenu,
    edgeMenuPosition,
    onConnect,
    handleCreateEdge,
    cancelPendingConnection,
  } = useEdgeConnection(graphId)

  // Connection visual feedback handlers (Task 17)
  const handleConnectStart = useCallback<OnConnectStart>(
    (_event, params) => {
      if (params?.nodeId) setConnectingFrom(params.nodeId)
    },
    [setConnectingFrom],
  )
  const handleConnectEnd = useCallback<OnConnectEnd>(() => {
    setConnectingFrom(null)
  }, [setConnectingFrom])
  const handleConnect = useCallback<OnConnect>(
    (connection) => {
      if (connection.target) flashNode(connection.target)
      onConnect(connection)
    },
    [onConnect, flashNode],
  )

  // ────────────────────────────────────────────────────────────────
  // 节点业务操作 Hook
  // ────────────────────────────────────────────────────────────────
  const {
    handleAddChild,
    handleGenerateChildren,
    handleEnrichNode,
    handleStartDev,
  } = useNodeOperations(graphId, projectPath)

  // ────────────────────────────────────────────────────────────────
  // 图加载
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadGraph(graphId)
  }, [graphId, loadGraph])

  // 生成进度事件监听
  useEffect(() => {
    const unsub = eventBus.on(Events.GENERATION_PROGRESS, (data) => {
      const payload = data as { stage: string; progress: number }
      setGenProgress(payload)
      if (payload.progress >= 100) {
        setTimeout(() => setGenProgress(null), 1500)
      }
    })
    return unsub
  }, [])

  // 自动创建 project 根节点（基于 graphId 防止竞态重复创建）
  const creatingProjectForGraph = useRef<string | null>(null)
  useEffect(() => {
    const hasProject = graphNodes.some((n) => n.type === 'project')
    if (!hasProject && creatingProjectForGraph.current !== graphId) {
      creatingProjectForGraph.current = graphId
      const currentGraph = graphs.find((g) => g.id === graphId)
      const title = currentGraph?.name ?? '项目'
      const graphType = currentGraph?.type ?? 'online'
      createNode({
        type: 'project',
        status: 'confirmed',
        title,
        graphId,
        graphType,
        position: { x: 0, y: 0 },
        acceptanceCriteria: [],
      })
        .catch((err) => {
          console.error('[GraphCanvas] Failed to create project node:', err)
        })
        .finally(() => {
          // 不清除标记 — 该 graph 已尝试过创建，失败也不重试
        })
    }
  }, [graphNodes, graphId, createNode, graphs])

  useOnViewportChange({
    onChange: (viewport) => {
      setZoomLevel(viewport.zoom)
      setIsZoomedOut(viewport.zoom < 0.5)
    },
  })

  const isEmpty = graphNodes.length === 0
  const hasProjectNode = graphNodes.some((n) => n.type === 'project')

  // ────────────────────────────────────────────────────────────────
  // 性能降级策略：节点数过多时逐步隐藏非必要元素
  // ────────────────────────────────────────────────────────────────
  const nodeCount = graphNodes.length
  const degradation = useMemo(() => ({
    hideMiniMapAnimation: nodeCount > 500,
    simplifyEdges: nodeCount > 500,
    hideNodeTextLabels: nodeCount > 500,
    hideEdgeLabels: nodeCount > 1000,
  }), [nodeCount])

  const baseFlowNodes: Node[] = useMemo(() => graphNodes.map((node) => {
    const threadInfo = nodeThreadMap.get(node.id)
    return {
      id: node.id,
      type: 'bizNode',
      position: node.position,
      data: {
        ...node,
        bugCount: bugCountMap.get(node.id) ?? 0,
        isZoomedOut,
        hideTextLabels: degradation.hideNodeTextLabels,
        isConnectingSource: connectingFrom === node.id,
        isFlashed: flashedNodeId === node.id,
        hasThread: !!threadInfo,
        agentThreadId: threadInfo?.id,
        agentStatus: threadInfo?.status,
        agentSessionId: threadInfo?.sessionId,
      },
      draggable: node.type !== 'project',
    }
  }), [graphNodes, bugCountMap, isZoomedOut, degradation.hideNodeTextLabels, connectingFrom, flashedNodeId, nodeThreadMap])

  const baseFlowEdges: Edge[] = useMemo(() => graphEdges.map((edge) => {
    const edgeType = edge.edgeType || 'default'
    const config = edgeTypeConfig[edgeType]
    const displayLabel = edge.content?.condition
      ? (edge.content.condition.length > 20 ? edge.content.condition.slice(0, 20) + '…' : edge.content.condition)
      : edge.label

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: displayLabel,
      type: 'bizEdge',
      data: { edgeType, content: edge.content, strength: edge.strength },
      markerEnd: getEdgeMarkerEnd(edgeType),
      animated: edgeType === 'failure' || edgeType === 'business-flow',
      style: {
        stroke: config.color,
        strokeWidth: 2,
        strokeDasharray: config.strokeDasharray,
      },
    }
  }), [graphEdges])

  // Apply selection styling without rebuilding the full arrays
  const flowNodes = useMemo(() => baseFlowNodes.map((n) => ({
    ...n,
    selected: n.id === selectedNodeId || n.id === connectingSourceId,
  })), [baseFlowNodes, selectedNodeId, connectingSourceId])

  // Sync computed flowNodes into ReactFlow's internal node state
  useEffect(() => {
    setRfNodes(flowNodes)
  }, [flowNodes, setRfNodes])

  const flowEdges = useMemo(() => baseFlowEdges.map((e) => {
    const isSelected = e.id === selectedEdgeId
    return {
      ...e,
      selected: isSelected,
      style: isSelected ? { ...e.style, strokeWidth: 3 } : e.style,
    }
  }), [baseFlowEdges, selectedEdgeId])

  // Apply degradation to edges: strip animation and optionally labels
  const degradedFlowEdges = useMemo(() => flowEdges.map((e) => {
    const shouldAnimate = !degradation.simplifyEdges && (e.animated ?? false)
    const shouldHideLabel = degradation.hideEdgeLabels
    return {
      ...e,
      animated: shouldAnimate,
      label: shouldHideLabel ? undefined : e.label,
    }
  }), [flowEdges, degradation.simplifyEdges, degradation.hideEdgeLabels])

  useEffect(() => {
    setRfEdges(degradedFlowEdges)
  }, [degradedFlowEdges, setRfEdges])

  /**
   * onNodeClick：仅处理正常模式下的节点选中
   * 连线模式已在 capture 阶段由 useConnectionMode 处理
   */
  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (isConnecting) return
      selectNode(node.id)
      setNodeContextMenu(null)
    },
    [selectNode, isConnecting],
  )

  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      selectEdge(edge.id)
    },
    [selectEdge],
  )

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
    setShowNodeMenu(false)
    cancelPendingConnection()
    setNodeContextMenu(null)
    // 点击空白处取消连线模式
    cancelConnect()
  }, [selectNode, selectEdge, cancelPendingConnection, cancelConnect])

  const onPaneContextMenu = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault()
      setMenuPosition({ x: event.clientX, y: event.clientY })
      setShowNodeMenu(true)
      setNodeContextMenu(null)
      selectNode(null)
      selectEdge(null)
    },
    [selectNode, selectEdge],
  )

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      event.stopPropagation()
      setNodeContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
      setShowNodeMenu(false)
      cancelPendingConnection()
    },
    [cancelPendingConnection],
  )

  useCanvasKeyboard({
    selectedNodeId,
    selectedEdgeId,
    onDeleteNode: deleteNode,
    onDeleteEdge: deleteEdge,
    onDeselect: () => {
      selectNode(null)
      selectEdge(null)
    },
    isConnecting,
    onCancelConnect: cancelConnect,
  })

  const { applyLayout } = useAutoLayout()
  const hasAppliedInitialLayout = useRef(false)

  // 首次加载图时自动应用 dagre 布局
  useEffect(() => {
    if (graphNodes.length > 0 && !hasAppliedInitialLayout.current) {
      hasAppliedInitialLayout.current = true
      // 延迟一帧让 ReactFlow 先完成首次渲染
      requestAnimationFrame(() => applyLayout())
    }
  }, [graphNodes.length, applyLayout])

  // 切换图时重置标记
  useEffect(() => {
    hasAppliedInitialLayout.current = false
    creatingProjectForGraph.current = null
  }, [graphId])

  const handleCreateNode = useCallback(async (type: NodeType) => {
    const position = screenToFlowPosition({ x: menuPosition.x, y: menuPosition.y })
    await createNode({
      type,
      status: 'draft',
      title: `新建${NODE_TYPE_LABELS[type]}`,
      graphId,
      graphType: 'online',
      position,
      acceptanceCriteria: [],
    })
    setShowNodeMenu(false)
  }, [screenToFlowPosition, menuPosition, createNode, graphId])

  /** 进入连线模式（由右键菜单触发） */
  const handleStartConnect = useCallback((sourceId: string) => {
    startConnect(sourceId)
    setNodeContextMenu(null)
  }, [startConnect])

  /** 添加节点上下文到 Agent 面板 */
  const handleAddContext = useCallback((nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node) return
    useAppStore.getState().setPendingContextRef({
      type: 'node',
      id: nodeId,
      label: node.title,
    })
    useAppStore.getState().setActiveRightPanel('agent')
    setNodeContextMenu(null)
  }, [graphNodes])

  /** 保存节点上下文 */
  const handleSaveContext = useCallback(async (nodeId: string, contexts: import('@shared/types').ContextRef[]) => {
    try {
      await updateNode(nodeId, { contextRefs: contexts })
    } catch (err) {
      console.error('[GraphCanvas] Failed to save context:', err)
    }
    setContextPopover(null)
  }, [updateNode])

  const handleNodeStatusChange = useCallback(async (nodeId: string, status: NodeStatus) => {
    try {
      await updateNode(nodeId, { status })
    } catch (err) {
      console.error('[GraphCanvas] Failed to change node status:', err)
    }
    setNodeContextMenu(null)
  }, [updateNode])

  const handleNodeDelete = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (node?.type === 'project') return
    try {
      await deleteNode(nodeId)
    } catch (err) {
      console.error('[GraphCanvas] Failed to delete node:', err)
    }
    selectNode(null)
    setNodeContextMenu(null)
  }, [graphNodes, deleteNode, selectNode])

  return (
    <div className="w-full h-full relative" data-testid="graph-canvas" role="application" aria-label="Business graph canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
        // 性能优化：仅渲染视口内的节点和边，减少大型图谱的 DOM 负担
        onlyRenderVisibleElements
        nodeDragThreshold={3}
        elevateNodesOnSelect
        defaultEdgeOptions={{
          type: 'bizEdge',
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 12,
            height: 12,
          },
        }}
        connectionLineStyle={{
          stroke: '#3b82f6',
          strokeWidth: 2,
          strokeDasharray: '5 5',
        }}
      >
        <Background gap={16} size={1} color="var(--canvas-bg)" />
        <Controls className="[&>button]:bg-background [&>button]:border-border [&>button]:text-foreground" />
        <MiniMap
          nodeColor={(node) => NODE_TYPE_COLORS[(node.data as unknown as GraphNode).type] ?? '#94a3b8'}
          maskColor="var(--canvas-minimap-bg)"
          className={cn(
            "!bg-background/80 !border-border !rounded-lg !shadow-xs",
            degradation.hideMiniMapAnimation && "!animate-none",
          )}
          pannable
          zoomable
        />

        <Panel position="bottom-left" className="m-2">
          <div className="bg-background/90 backdrop-blur border rounded-lg shadow-xs px-2 py-1 text-[10px] text-muted-foreground font-mono">
            {Math.round(zoomLevel * 100)}%
          </div>
        </Panel>

        <Panel position="top-right" className="m-2">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
              title="Search nodes (Ctrl+F)"
            >
              <Search className="w-3.5 h-3.5" />
              Search
            </button>
            <button
              onClick={applyLayout}
              className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
              title="整理布局"
            >
              <AlignHorizontalDistributeCenter className="w-3.5 h-3.5" />
              整理布局
            </button>
          </div>
        </Panel>

        {connectingSourceId && (
          <Panel position="top-center" className="m-2">
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg shadow-xs px-4 py-2 text-sm text-blue-700">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span>连线模式：点击目标节点完成连线</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  cancelConnect()
                }}
                className="ml-2 px-2 py-0.5 text-xs bg-white border border-blue-300 rounded hover:bg-blue-100 transition-colors"
              >
                取消 (Esc)
              </button>
            </div>
          </Panel>
        )}

        <Panel position="top-center" className="m-2">
          {searchOpen && (
            <div className="flex items-center gap-2 bg-background/95 backdrop-blur border rounded-lg shadow-md px-3 py-2">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search nodes..."
                className="bg-transparent text-sm outline-none w-48"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchResults.length > 0) {
                    setSearchIndex((i) => (i + 1) % searchResults.length)
                  }
                  if (e.key === 'Escape') {
                    setSearchOpen(false)
                    setSearchQuery('')
                  }
                }}
              />
              {searchResults.length > 0 && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {searchIndex + 1}/{searchResults.length}
                </span>
              )}
              {searchResults.length > 1 && (
                <button
                  onClick={() => setSearchIndex((i) => (i + 1) % searchResults.length)}
                  className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
                  title="Next result (Enter)"
                >
                  <Search className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => { setSearchOpen(false); setSearchQuery('') }}
                className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
                title="Close (Escape)"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </Panel>

        {(selectedNodeId || selectedEdgeId) && !connectingSourceId && (
          <Panel position="bottom-center" className="m-2">
            <div className="flex items-center gap-2 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-muted-foreground">
              <span>{selectedNodeId ? '按 Delete 删除节点' : '按 Delete 删除连接线'}</span>
              <span className="text-border">|</span>
              <button
                onClick={() => {
                  if (selectedNodeId) {
                    deleteNode(selectedNodeId)
                    selectNode(null)
                  } else if (selectedEdgeId) {
                    deleteEdge(selectedEdgeId)
                    selectEdge(null)
                  }
                }}
                className="text-destructive hover:underline"
              >
                立即删除
              </button>
            </div>
          </Panel>
        )}

        {notifications.length > 0 && (
          <Panel position="bottom-right">
            {notifications.map((n) => (
              <div
                key={n.id}
                className="bg-primary/10 border border-primary/30 rounded-lg px-3 py-2 mb-2 flex items-center gap-2 cursor-pointer hover:bg-primary/20 transition-colors"
                onClick={() => dismissNotification(n.id)}
              >
                <GitBranch size={14} className="text-primary" />
                <span className="text-xs text-primary">Found {n.count} new association{n.count > 1 ? 's' : ''}</span>
                <X size={12} className="text-muted-foreground ml-2" />
              </div>
            ))}
          </Panel>
        )}
      </ReactFlow>

      <CanvasOverlay
        isEmpty={isEmpty}
        showNodeMenu={showNodeMenu}
        menuPosition={menuPosition}
        onCreateNode={handleCreateNode}
        showEdgeTypeMenu={showEdgeTypeMenu}
        edgeMenuPosition={edgeMenuPosition}
        pendingConnection={pendingConnection}
        onCreateEdge={handleCreateEdge}
        nodeContextMenu={nodeContextMenu}
        nodes={graphNodes}
        onNodeStatusChange={handleNodeStatusChange}
        onNodeDelete={handleNodeDelete}
        onCloseNodeContextMenu={() => setNodeContextMenu(null)}
        onAddChild={handleAddChild}
        onStartConnect={handleStartConnect}
        onEnrichNode={handleEnrichNode}
        onStartDev={handleStartDev}
        onAddContext={handleAddContext}
        onGenerateChildren={handleGenerateChildren}
        hasProjectNode={hasProjectNode}
        generationProgress={genProgress}
      />

      {contextPopover && (
        <NodeContextPopover
          x={contextPopover.x}
          y={contextPopover.y}
          existingContexts={graphNodes.find((n) => n.id === contextPopover.nodeId)?.contextRefs ?? []}
          projectPath={projectPath}
          onSave={(contexts) => handleSaveContext(contextPopover.nodeId, contexts)}
          onClose={() => setContextPopover(null)}
        />
      )}
    </div>
  )
}
