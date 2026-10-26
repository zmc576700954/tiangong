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
  type OnNodeDrag,
  Panel,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../store/graphStore'
import { useAppStore } from '../store/appStore'
import { useGraphRuntimeStore } from '../store/graphRuntimeStore'
import { useThreadStore } from '../store/threadStore'
import { NODE_TYPE_COLORS } from '@shared/constants'
import { nodeTypeLabel } from '@shared/i18n'
import { useI18n } from '../i18n/useI18n'
import type { GraphNode, NodeType, NodeStatus, ContextRef } from '@shared/types'
import type { LintIssue, LintReport, WritebackItem } from '@shared/types/wiki'
import { BizEdge } from './BizEdge'
import { getEdgeMarkerEnd, edgeTypeConfig } from './edge-utils'
import { cn } from '../lib/utils'
import { BizNodeComponent } from './BizNode'
import { CanvasOverlay } from './components/CanvasOverlay'
import { FanoutPromptDialog } from '../components/agent/FanoutPromptDialog'
import { NodeContextPopover } from './NodeContextPopover'
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard'
import { useAutoLayout } from './hooks/useAutoLayout'
import { useForceLayout } from './hooks/useForceLayout'
import { useConnectionMode } from './hooks/useConnectionMode'
import { useNodePositionPersistence } from './hooks/useNodePositionPersistence'
import { useNodeOperations } from './hooks/useNodeOperations'
import { useEdgeConnection } from './hooks/useEdgeConnection'
import { AlignHorizontalDistributeCenter, GitBranch, X, Search, BookOpen, FileText, ScrollText, Loader2, Network } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '../components/ui/dropdown-menu'
import { eventBus, Events } from '../store/eventBus'
import { LintPanel } from '../components/wiki/LintPanel'
import { WritebackPanel } from '../components/wiki/WritebackPanel'
import { RecipesPanel } from '../panels/RecipesPanel'
import { toastSuccess, toastError, toastInfo } from '../lib/toast'
import {
  useAwarenessConnection,
  useBroadcastLocalCursor,
  useBroadcastLocalSelection,
  useRemoteAwareness,
} from '../realtime/hooks'
import { RemoteCursors, RemotePresenceBadge } from './RemoteCursors'
import { computeRemoteSelectionByNode } from './remote-selection'

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
  const multiSelected = useGraphStore((s) => s.selectedNodeIds.has(id))
  return <BizNodeComponent id={id} data={data} selected={selected} multiSelected={multiSelected} />
}
const nodeTypes = { bizNode: BizNodeWrapper }

interface GraphCanvasProps {
  graphId: string
}

function selectedNodeIdsAsArray(set: ReadonlySet<string>): string[] {
  return Array.from(set)
}

export function GraphCanvas({ graphId }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner graphId={graphId} />
    </ReactFlowProvider>
  )
}

function GraphCanvasInner({ graphId }: GraphCanvasProps) {
  const { locale, t } = useI18n()
  const graphNodes = useGraphStore((state) => state.nodes)
  const graphEdges = useGraphStore((state) => state.edges)
  const loadGraph = useGraphStore((state) => state.loadGraph)
  const selectedNodeId = useGraphStore((state) => state.selectedNodeId)
  const selectedEdgeId = useGraphStore((state) => state.selectedEdgeId)
  const selectNode = useGraphStore((state) => state.selectNode)
  const selectEdge = useGraphStore((state) => state.selectEdge)
  const selectedNodeIds = useGraphStore((state) => state.selectedNodeIds)
  const toggleNodeSelection = useGraphStore((state) => state.toggleNodeSelection)
  const clearNodeSelection = useGraphStore((state) => state.clearNodeSelection)

  /** D10b: 当前鼠标在 flow 坐标系下的位置（XYFlow paneMouseMove 写入） */
  const _canvasCursorRef = useRef<{ x: number; y: number } | null>(null)
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

  // Listen for navigation requests from components outside ReactFlowProvider (e.g., RightPanel)
  useEffect(() => {
    const unsub = eventBus.on(Events.NAVIGATE_TO_NODE, (targetId) => {
      selectNode(targetId)
      const target = graphNodes.find((n) => n.id === targetId)
      if (target) {
        setCenter(target.position.x, target.position.y, { zoom: 1, duration: 300 })
      }
    })
    return unsub
  }, [graphNodes, selectNode, setCenter])

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
  const [importSummary, setImportSummary] = useState<{ text: string; failed: { file: string; error: string }[] } | null>(null)
  const [lintReport, setLintReport] = useState<LintReport | null>(null)
  const [lintOpen, setLintOpen] = useState(false)
  const [lintLoading, setLintLoading] = useState(false)
  const [writebackOpen, setWritebackOpen] = useState(false)
  const [writebackItems, setWritebackItems] = useState<WritebackItem[]>([])
  const [writebackCount, setWritebackCount] = useState(0)
  /** 正在处理的 itemId 集合（in-flight 守卫）。防止重复点击并让 UI 显示「处理中」。 */
  const [writebackPending, setWritebackPending] = useState<Set<string>>(new Set())
  /** 最近一次操作的错误信息；用于面板顶部 banner。null 表示无错误。 */
  const [writebackLastError, setWritebackLastError] = useState<string | null>(null)
  /** itemId → title 的查找表，给 toast 提示用（避免在异步回调里读到陈旧 closure） */
  const writebackItemsRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const m = new Map<string, string>()
    for (const it of writebackItems) m.set(it.id, it.title)
    writebackItemsRef.current = m
  }, [writebackItems])

  // ────────────────────────────────────────────────────────────────
  // Recipes panel state
  // ────────────────────────────────────────────────────────────────
  const [recipesOpen, setRecipesOpen] = useState(false)

  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  const [contextPopover, setContextPopover] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  const [showFanout, setShowFanout] = useState(false)
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<'node' | 'edge' | null>(null)

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
    // Debounce search to avoid excessive computation on every keystroke
    const timer = setTimeout(() => {
      const results = useGraphStore.getState().searchNodes(searchQuery)
      setSearchResults(results)
      setSearchIndex(0)
    }, 200)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Navigate only after Enter or an explicit next-result click.
  const goToSearchResult = useCallback((idx: number) => {
    const node = searchResults[idx]
    if (node) navigateToSearchResult(node)
  }, [searchResults, navigateToSearchResult])

  const nextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return
    const next = (searchIndex + 1) % searchResults.length
    goToSearchResult(next)
    setSearchIndex(next)
  }, [searchResults, searchIndex, goToSearchResult])

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

  // ────────────────────────────────────────────────────────────────
  // 连线模式 Hook
  // ────────────────────────────────────────────────────────────────
  const {
    connectingSourceId,
    isConnecting,
    startConnect,
    cancelConnect,
  } = useConnectionMode({ graphEdges, createEdge, graphId, setRfEdges, onConnect })

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
  // D10b: 协作 awareness — 建连 / 广播本地光标 / 广播本地选区
  // ────────────────────────────────────────────────────────────────
  useAwarenessConnection()
  const remoteStates = useRemoteAwareness()

  /** 本地 userId（首次访问 IPC 缓存） */
  const [localUserId, setLocalUserId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI['realtime:getIdentity']()
      .then((identity) => {
        if (!cancelled) setLocalUserId(identity.userId)
      })
      .catch(() => {
        // IPC 拉取失败时 awareness 仍能跑（无 identity 过滤 → 看到自己也算远端，但可用）
      })
    return () => { cancelled = true }
  }, [])

  /** 把光标位置广播到 awareness。getter 形式避免在 React mousemove 频繁触发。 */
  useBroadcastLocalCursor(() => {
    // flow 坐标系下：当前没有鼠标位置传感器（XYFlow 没现成的 cursor in API），
    // 我们让 ReactFlow 自带的 paneMouseMove 推送给一个 ref。
    return _canvasCursorRef.current
  })
  /** 选中节点列表变化 → 广播 */
  useBroadcastLocalSelection(() => selectedNodeIdsAsArray(selectedNodeIds))

  // ────────────────────────────────────────────────────────────────
  // 图加载
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadGraph(graphId)
  }, [graphId, loadGraph])

  // 刷新写回审核队列（打开面板时、图切换时、采纳/丢弃后调用）
  const refreshWriteback = useCallback(async () => {
    try {
      const [items, count] = await Promise.all([
        useGraphStore.getState().listWriteback(),
        useGraphStore.getState().countWriteback(),
      ])
      setWritebackItems(items)
      setWritebackCount(count)
    } catch (err) {
      console.error('[GraphCanvas] writeback refresh failed:', err)
    }
  }, [])

  // 图加载/切换时刷新一次计数，让菜单角标 (N) 无需打开面板即为准确；
  // 同时重置面板状态，避免切换后短暂显示上一张图的待审项
  useEffect(() => {
    setWritebackOpen(false)
    setWritebackItems([])
    setWritebackCount(0)
    refreshWriteback()
  }, [graphId, refreshWriteback])

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
      const title = currentGraph?.name ?? nodeTypeLabel('project', locale)
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
          // Clear the guard so transient failures can be retried on the next render.
          creatingProjectForGraph.current = null
        })
    }
  }, [graphNodes, graphId, createNode, graphs, locale])

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
  const DEGRADE_THRESHOLD = 200
  const EDGE_LABEL_HIDE_THRESHOLD = 1000
  const MINIMAP_UNMOUNT_THRESHOLD = 1000

  const degradation = useMemo(() => ({
    hideMiniMapAnimation: nodeCount > DEGRADE_THRESHOLD,
    simplifyEdges: nodeCount > DEGRADE_THRESHOLD,
    hideNodeTextLabels: nodeCount > DEGRADE_THRESHOLD,
    hideEdgeLabels: nodeCount > EDGE_LABEL_HIDE_THRESHOLD,
  }), [nodeCount])

  const nodeCacheRef = useRef(new Map<string, { key: string; node: Node }>())
  const edgeCacheRef = useRef(new Map<string, { key: string; edge: Edge }>())

  // D10b: 计算每个节点被哪些远端用户选中（memo on remoteStates + localUserId）
  const remoteSelectionByNode = useMemo(() => {
    if (!localUserId) return new Map<string, ReturnType<typeof computeRemoteSelectionByNode> extends Map<string, infer V> ? V : never>()
    return computeRemoteSelectionByNode(remoteStates, localUserId)
  }, [remoteStates, localUserId])

  const flowNodes = useMemo(() => {
    const cache = nodeCacheRef.current
    const nextIds = new Set<string>()

    const nodes = graphNodes.map((node) => {
      const threadInfo = nodeThreadMap.get(node.id)
      const bugCount = bugCountMap.get(node.id) ?? 0
      const selected = node.id === selectedNodeId || node.id === connectingSourceId
      const multiSelected = selectedNodeIds.has(node.id)
      // D10b: 远端用户选中本节点的颜色列表（去重 + 排序）
      const remoteEntries = remoteSelectionByNode.get(node.id)
      const remoteSelectionColors = remoteEntries && remoteEntries.length > 0
        ? Array.from(new Set(remoteEntries.map((e) => e.color))).sort()
        : undefined
      const key = JSON.stringify([
        node.id,
        node.updatedAt,
        bugCount,
        isZoomedOut,
        degradation.hideNodeTextLabels,
        connectingFrom === node.id,
        flashedNodeId === node.id,
        threadInfo?.id,
        threadInfo?.status,
        threadInfo?.sessionId,
        selected,
        multiSelected,
        remoteSelectionColors ?? null,
      ])

      nextIds.add(node.id)
      const cached = cache.get(node.id)
      if (cached?.key === key) {
        return cached.node
      }

      const flowNode: Node = {
        id: node.id,
        type: 'bizNode',
        position: node.position,
        data: {
          ...node,
          bugCount,
          isZoomedOut,
          hideTextLabels: degradation.hideNodeTextLabels,
          isConnectingSource: connectingFrom === node.id,
          isFlashed: flashedNodeId === node.id,
          hasThread: !!threadInfo,
          agentThreadId: threadInfo?.id,
          agentStatus: threadInfo?.status,
          agentSessionId: threadInfo?.sessionId,
          // D10b: 远端选中颜色
          ...(remoteSelectionColors ? { remoteSelectionColors } : {}),
        },
        draggable: node.type !== 'project',
        selected,
      }
      cache.set(node.id, { key, node: flowNode })
      return flowNode
    })

    for (const id of cache.keys()) {
      if (!nextIds.has(id)) cache.delete(id)
    }
    return nodes
  }, [graphNodes, bugCountMap, isZoomedOut, degradation.hideNodeTextLabels, connectingFrom, flashedNodeId, nodeThreadMap, selectedNodeId, connectingSourceId, selectedNodeIds, remoteSelectionByNode])

  // Sync computed flowNodes into ReactFlow's internal node state
  useEffect(() => {
    setRfNodes(flowNodes)
  }, [flowNodes, setRfNodes])

  const flowEdges = useMemo(() => {
    const cache = edgeCacheRef.current
    const nextIds = new Set<string>()

    const edges = graphEdges.map((edge) => {
      const edgeType = edge.edgeType || 'default'
      const config = edgeTypeConfig[edgeType]
      const displayLabel = edge.content?.condition
        ? (edge.content.condition.length > 20 ? edge.content.condition.slice(0, 20) + '…' : edge.content.condition)
        : edge.label
      const isSelected = edge.id === selectedEdgeId
      const shouldAnimate = !degradation.simplifyEdges && (edgeType === 'failure' || edgeType === 'business-flow')
      const shouldHideLabel = degradation.hideEdgeLabels
      const key = JSON.stringify([
        edge.id,
        edge.source,
        edge.target,
        displayLabel,
        edgeType,
        edge.content?.condition,
        edge.strength,
        isSelected,
        shouldAnimate,
        shouldHideLabel,
      ])

      nextIds.add(edge.id)
      const cached = cache.get(edge.id)
      if (cached?.key === key) {
        return cached.edge
      }

      const flowEdge: Edge = {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: shouldHideLabel ? undefined : displayLabel,
        type: 'bizEdge',
        data: { edgeType, content: edge.content, strength: edge.strength },
        markerEnd: getEdgeMarkerEnd(edgeType),
        animated: shouldAnimate,
        style: {
          stroke: config.color,
          strokeWidth: isSelected ? 3 : 2,
          strokeDasharray: config.strokeDasharray,
        },
        selected: isSelected,
      }
      cache.set(edge.id, { key, edge: flowEdge })
      return flowEdge
    })

    for (const id of cache.keys()) {
      if (!nextIds.has(id)) cache.delete(id)
    }
    return edges
  }, [graphEdges, selectedEdgeId, degradation.simplifyEdges, degradation.hideEdgeLabels])

  useEffect(() => {
    setRfEdges(flowEdges)
  }, [flowEdges, setRfEdges])

  /**
   * onNodeClick：仅处理正常模式下的节点选中
   * 连线模式已在 capture 阶段由 useConnectionMode 处理
   */
  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (isConnecting) return

      const nativeEvent = _event as MouseEvent
      const isModifier = nativeEvent?.ctrlKey || nativeEvent?.metaKey

      if (isModifier) {
        // Toggle multi-select; preserve existing single-select
        toggleNodeSelection(node.id)
        return
      }

      // Normal single-select: clear multi-select, set single-select
      selectNode(node.id)
      clearNodeSelection()
      setNodeContextMenu(null)
    },
    [selectNode, toggleNodeSelection, clearNodeSelection, isConnecting],
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
    clearNodeSelection()
    setShowNodeMenu(false)
    cancelPendingConnection()
    setNodeContextMenu(null)
    // 点击空白处取消连线模式
    cancelConnect()
  }, [selectNode, selectEdge, clearNodeSelection, cancelPendingConnection, cancelConnect])

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

  const { clearConfirmPending } = useCanvasKeyboard({
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
    onRequestDeleteConfirm: (target) => setConfirmDeleteTarget(target),
  })

  const { applyLayout } = useAutoLayout()
  const hasAppliedInitialLayout = useRef(false)
  /** 力导向布局 hook —— 提供 applyForceLayout、拖拽 pin/reheat 处理器 */
  const {
    applyForceLayout,
    exitForceMode,
    onNodeDragStart: onForceDragStart,
    onNodeDrag: onForceDrag,
    onNodeDragStop: onForceDragStop,
  } = useForceLayout()
  /** 当前布局模式：'tree' = dagre，'force' = d3-force。决定拖拽时是否触发 reheat。 */
  const [layoutMode, setLayoutMode] = useState<'tree' | 'force'>('tree')
  /** 力导向布局计算中（CPU 密集） —— 显示 spinner，禁用按钮防重入。 */
  const [forceLoading, setForceLoading] = useState(false)

  /** 进入力导向布局：显示 loading、计算、写入、退出 force mode 时清 loading。 */
  const handleApplyForceLayout = useCallback(() => {
    if (forceLoading) return
    setForceLoading(true)
    setLayoutMode('force')
    // 用 setTimeout 把 spinner 让出一帧再跑计算，避免 UI 不更新
    setTimeout(() => {
      try {
        applyForceLayout()
      } finally {
        setForceLoading(false)
      }
    }, 16)
  }, [applyForceLayout, forceLoading])

  /** 切回树形布局：先退出 force mode，再跑 dagre。 */
  const handleApplyTreeLayout = useCallback(() => {
    exitForceMode()
    setLayoutMode('tree')
    applyLayout()
  }, [exitForceMode, applyLayout])

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
    // 切图时清掉 force mode（避免 simulation 引用旧节点的 simNodes）
    exitForceMode()
    setLayoutMode('tree')
    setForceLoading(false)
  }, [graphId, exitForceMode])

  const handleCreateNode = useCallback(async (type: NodeType) => {
    const position = screenToFlowPosition({ x: menuPosition.x, y: menuPosition.y })
    const graphType = currentGraph?.type ?? 'online'
    await createNode({
      type,
      status: 'draft',
      title: type === 'wiki-page'
        ? nodeTypeLabel('wiki-page', locale)
        : t('canvas.node.newTitle', { type: nodeTypeLabel(type, locale) }),
      graphId,
      graphType,
      position,
      acceptanceCriteria: [],
      wikiContent: type === 'wiki-page'
        ? t('canvas.node.wikiContentTemplate', { title: nodeTypeLabel('wiki-page', locale) })
        : undefined,
    })
    setShowNodeMenu(false)
  }, [screenToFlowPosition, menuPosition, createNode, graphId, currentGraph?.type, locale, t])

  const handleCreateSpecialWikiPage = useCallback(async (kind: 'index' | 'log') => {
    const { indexId, logId } = await useGraphStore.getState().ensureSpecialWikiPages()
    const targetId = kind === 'index' ? indexId : logId
    if (targetId) {
      selectNode(targetId)
      const node = useGraphStore.getState().getNodeById(targetId)
      if (node) {
        setCenter(node.position.x, node.position.y, { zoom: 1, duration: 300 })
      }
    }
  }, [selectNode, setCenter])

  const handleImportWikiFiles = useCallback(async (mode: 'rule' | 'llm' = 'rule') => {
    const paths = await window.electronAPI['dialog:openFiles']({ extensions: ['md', 'markdown', 'txt'] })
    if (paths.length === 0) return
    const result = await useGraphStore.getState().importWikiFiles(paths, mode)
    setImportSummary({
      text: t('canvas.import.summary', {
        created: result.created.length,
        updated: result.updated.length,
        failed: result.failed.length,
      }),
      failed: result.failed,
    })
    setShowNodeMenu(false)
  }, [t])

  const handleLint = useCallback(async () => {
    setLintLoading(true)
    try {
      const r = await useGraphStore.getState().lintGraph()
      setLintReport(r)
      setLintOpen(true)
    } catch (err) {
      console.error('[GraphCanvas] lint failed:', err)
    } finally {
      setLintLoading(false)
    }
  }, [])

  const handleRecompute = useCallback(async () => {
    setLintLoading(true)
    try {
      await useGraphStore.getState().computeCommunities()
      const r = await useGraphStore.getState().lintGraph()
      setLintReport(r)
      setLintOpen(true)
    } catch (err) {
      console.error('[GraphCanvas] compute communities failed:', err)
    } finally {
      setLintLoading(false)
    }
  }, [])

  const handleLintNavigate = useCallback((nodeId: string) => {
    eventBus.emit(Events.NAVIGATE_TO_NODE, nodeId)
  }, [])

  const handleLintApplyFix = useCallback(async (issue: LintIssue) => {
    if (!issue.fix) return
    const graphId = useGraphStore.getState().currentGraphId
    if (!graphId) return
    try {
      await useGraphStore.getState().applyLintFix(issue.fix)
      // 重新跑 lint，把已修复项从主报告中剔除
      const fresh = await useGraphStore.getState().lintGraph()
      setLintReport(fresh)
    } catch (err) {
      console.error('[GraphCanvas] apply lint fix failed:', err)
      throw err
    }
  }, [])

  const handleOpenWriteback = useCallback(async () => {
    await refreshWriteback()
    setWritebackOpen(true)
  }, [refreshWriteback])

  const handleOpenRecipes = useCallback(() => {
    setRecipesOpen(true)
  }, [])

  const handleCloseRecipes = useCallback(() => {
    setRecipesOpen(false)
  }, [])

  const handleAcceptWriteback = useCallback(async (itemId: string) => {
    setWritebackPending((prev) => {
      if (prev.has(itemId)) return prev
      const next = new Set(prev)
      next.add(itemId)
      return next
    })
    setWritebackLastError(null)
    try {
      await useGraphStore.getState().acceptWriteback(itemId)
      await refreshWriteback()
      const gid = useGraphStore.getState().currentGraphId
      if (gid) await useGraphStore.getState().loadGraph(gid) // 采纳后图已变，刷新画布
      const title = writebackItemsRef.current.get(itemId) ?? itemId
      toastSuccess(t('toast.writeback.accepted'), title)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[GraphCanvas] accept writeback failed:', err)
      setWritebackLastError(t('toast.writeback.acceptFailed', { message: msg }))
      toastError(t('toast.writeback.acceptFailedTitle'), msg)
    } finally {
      setWritebackPending((prev) => {
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
    }
  }, [refreshWriteback, t])

  const handleDiscardWriteback = useCallback(async (itemId: string) => {
    setWritebackPending((prev) => {
      if (prev.has(itemId)) return prev
      const next = new Set(prev)
      next.add(itemId)
      return next
    })
    setWritebackLastError(null)
    try {
      await useGraphStore.getState().discardWriteback(itemId)
      await refreshWriteback()
      toastInfo(t('toast.writeback.discarded'), undefined)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[GraphCanvas] discard writeback failed:', err)
      setWritebackLastError(t('toast.writeback.discardFailed', { message: msg }))
      toastError(t('toast.writeback.discardFailedTitle'), msg)
    } finally {
      setWritebackPending((prev) => {
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
    }
  }, [refreshWriteback, t])

  /** 串行处理一批 item；任一失败立即停下，已成功的保留。 */
  const handleBatchAcceptWriteback = useCallback(async (itemIds: string[]) => {
    let successCount = 0
    let firstError: string | null = null
    for (const id of itemIds) {
      try {
        setWritebackPending((prev) => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
        await useGraphStore.getState().acceptWriteback(id)
        successCount += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        firstError = firstError ?? msg
        console.error('[GraphCanvas] batch accept failed for', id, err)
      } finally {
        setWritebackPending((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
    await refreshWriteback()
    if (successCount > 0) {
      const gid = useGraphStore.getState().currentGraphId
      if (gid) await useGraphStore.getState().loadGraph(gid)
      toastSuccess(t('toast.writeback.acceptAllDone'), t('toast.writeback.itemCount', { count: successCount, total: itemIds.length }))
    }
    if (firstError) {
      setWritebackLastError(t('toast.writeback.acceptAllPartial', { message: firstError }))
      toastError(t('toast.writeback.acceptAllFailed'), firstError)
    }
  }, [refreshWriteback, t])

  const handleBatchDiscardWriteback = useCallback(async (itemIds: string[]) => {
    let successCount = 0
    let firstError: string | null = null
    for (const id of itemIds) {
      try {
        setWritebackPending((prev) => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
        await useGraphStore.getState().discardWriteback(id)
        successCount += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        firstError = firstError ?? msg
        console.error('[GraphCanvas] batch discard failed for', id, err)
      } finally {
        setWritebackPending((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
    await refreshWriteback()
    if (successCount > 0) {
      toastInfo(t('toast.writeback.discardAllDone'), t('toast.writeback.itemCount', { count: successCount, total: itemIds.length }))
    }
    if (firstError) {
      setWritebackLastError(t('toast.writeback.discardAllPartial', { message: firstError }))
      toastError(t('toast.writeback.discardAllFailed'), firstError)
    }
  }, [refreshWriteback, t])

  const handleDismissWritebackError = useCallback(() => {
    setWritebackLastError(null)
  }, [])

  const handleWritebackNavigate = useCallback((nodeId: string) => {
    eventBus.emit(Events.NAVIGATE_TO_NODE, nodeId)
  }, [])

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
  const handleSaveContext = useCallback(async (nodeId: string, contexts: ContextRef[]) => {
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
    <div className="w-full h-full relative" data-testid="graph-canvas" role="application" aria-label={t('canvas.ariaLabel')}>
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
        onNodeDragStart={onForceDragStart as unknown as OnNodeDrag<Node>}
        onNodeDrag={onForceDrag as unknown as OnNodeDrag<Node>}
        onNodeDragStop={onForceDragStop as unknown as OnNodeDrag<Node>}
        onMouseMove={(event) => {
          // D10b: 把鼠标的 flow 坐标写入 ref，让 useBroadcastLocalCursor 周期性采样
          if (screenToFlowPosition) {
            try {
              const flow = screenToFlowPosition({
                x: (event as React.MouseEvent).clientX,
                y: (event as React.MouseEvent).clientY,
              })
              _canvasCursorRef.current = flow
            } catch {
              // screenToFlowPosition 在 ReactFlow 上下文外可能抛错
            }
          }
        }}
        onMouseLeave={() => {
          _canvasCursorRef.current = null
        }}
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
        {nodeCount <= MINIMAP_UNMOUNT_THRESHOLD && (
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
        )}

        <Panel position="bottom-left" className="m-2">
          <div className="bg-background/90 backdrop-blur border rounded-lg shadow-xs px-2 py-1 text-[10px] text-muted-foreground font-mono">
            {Math.round(zoomLevel * 100)}%
          </div>
        </Panel>

        <Panel position="bottom-left" className="m-2 ml-12">
          <RemotePresenceBadge localUserId={localUserId ?? ''} />
        </Panel>

        {/* D10b: 远端光标覆盖层 */}
        {localUserId && <RemoteCursors localUserId={localUserId} />}

        <Panel position="top-right" className="m-2">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
              title={t('canvas.search.tooltip')}
            >
              <Search className="w-3.5 h-3.5" />
              {t('canvas.search.button')}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={forceLoading}
                  className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  title={t('canvas.layout.menuTooltip')}
                  data-testid="layout-menu-trigger"
                >
                  {forceLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <AlignHorizontalDistributeCenter className="w-3.5 h-3.5" />
                  )}
                  {t('canvas.layout.arrange')}
                  <span className="ml-0.5 text-[10px] text-muted-foreground">
                    {layoutMode === 'force' ? t('canvas.layout.modeForce') : t('canvas.layout.modeTree')}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{t('canvas.layout.label')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={handleApplyTreeLayout}
                  className="flex items-start gap-2 py-2"
                  data-testid="layout-tree"
                >
                  <AlignHorizontalDistributeCenter className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex flex-col">
                    <span className="text-sm">{t('canvas.layout.tree')}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t('canvas.layout.treeDesc')}
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={handleApplyForceLayout}
                  disabled={forceLoading}
                  className="flex items-start gap-2 py-2"
                  data-testid="layout-force"
                >
                  <Network className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex flex-col">
                    <span className="text-sm">{t('canvas.layout.force')}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t('canvas.layout.forceDesc')}
                    </span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={() => handleCreateSpecialWikiPage('index')}
              className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
              title={t('canvas.graphIndex.create')}
            >
              <BookOpen className="w-3.5 h-3.5" />
              {t('canvas.graphIndex')}
            </button>
            <button
              onClick={() => handleCreateSpecialWikiPage('log')}
              className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
              title={t('canvas.graphLog.create')}
            >
              <FileText className="w-3.5 h-3.5" />
              {t('canvas.graphLog')}
            </button>
            <button
              onClick={handleOpenRecipes}
              className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
              title={t('canvas.recipes.tooltip')}
            >
              <ScrollText className="w-3.5 h-3.5" />
              Recipes
            </button>
          </div>
        </Panel>

        {connectingSourceId && (
          <Panel position="top-center" className="m-2">
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg shadow-xs px-4 py-2 text-sm text-blue-700">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span>{t('canvas.connecting.hint')}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  cancelConnect()
                }}
                className="ml-2 px-2 py-0.5 text-xs bg-white border border-blue-300 rounded hover:bg-blue-100 transition-colors"
              >
                {t('canvas.connecting.cancel')}
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
                placeholder={t('canvas.search.placeholder')}
                className="bg-transparent text-sm outline-none w-48"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchResults.length > 0) {
                    goToSearchResult(searchIndex)
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
                  onClick={nextSearchResult}
                  className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
                  title={t('canvas.search.nextResult')}
                >
                  <Search className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => { setSearchOpen(false); setSearchQuery('') }}
                className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
                title={t('canvas.search.close')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </Panel>

        {(selectedNodeId || selectedEdgeId) && !connectingSourceId && (
          <Panel position="bottom-center" className="m-2">
            <div className="flex items-center gap-2 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-muted-foreground">
              {confirmDeleteTarget ? (
                <>
                  <span className="text-destructive">{t('canvas.delete.confirm')}</span>
                  <button
                    onClick={() => {
                      if (selectedNodeId) {
                        deleteNode(selectedNodeId)
                        selectNode(null)
                      } else if (selectedEdgeId) {
                        deleteEdge(selectedEdgeId)
                        selectEdge(null)
                      }
                      setConfirmDeleteTarget(null)
                      clearConfirmPending()
                    }}
                    className="text-destructive hover:underline font-medium"
                  >
                    {t('canvas.delete.confirmButton')}
                  </button>
                  <button
                    onClick={() => { setConfirmDeleteTarget(null); clearConfirmPending() }}
                    className="hover:underline"
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <span>{selectedNodeId ? t('canvas.delete.nodeHint') : t('canvas.delete.edgeHint')}</span>
                  <span className="text-border">|</span>
                  <button
                    onClick={() => setConfirmDeleteTarget(selectedNodeId ? 'node' : 'edge')}
                    className="text-destructive hover:underline"
                  >
                    {t('canvas.delete.now')}
                  </button>
                </>
              )}
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
                <span className="text-xs text-primary">{t('canvas.notification.newAssociations', { count: n.count })}</span>
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
        onFanout={() => setShowFanout(true)}
        hasProjectNode={hasProjectNode}
        generationProgress={genProgress}
        onImportWikiFiles={() => handleImportWikiFiles('rule')}
        onImportWikiFilesLlm={() => handleImportWikiFiles('llm')}
        onLint={handleLint}
        lintLoading={lintLoading}
        onOpenWriteback={handleOpenWriteback}
        writebackCount={writebackCount}
        importSummary={importSummary}
        onDismissImportSummary={() => setImportSummary(null)}
      />

      {lintOpen && lintReport && (
        <LintPanel
          report={lintReport}
          onNavigate={handleLintNavigate}
          onClose={() => setLintOpen(false)}
          onRecompute={handleRecompute}
          onApplyFix={handleLintApplyFix}
        />
      )}

      {writebackOpen && (
        <WritebackPanel
          items={writebackItems}
          pendingIds={writebackPending}
          lastError={writebackLastError}
          onAccept={handleAcceptWriteback}
          onDiscard={handleDiscardWriteback}
          onBatchAccept={handleBatchAcceptWriteback}
          onBatchDiscard={handleBatchDiscardWriteback}
          onNavigate={handleWritebackNavigate}
          onClose={() => setWritebackOpen(false)}
          onDismissError={handleDismissWritebackError}
        />
      )}

      {recipesOpen && (
        <div className="absolute top-16 right-4 z-50 w-[480px] max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-sm font-medium">{t('recipes.title')}</span>
            <button
              type="button"
              onClick={handleCloseRecipes}
              title={t('canvas.recipes.close')}
              aria-label={t('canvas.recipes.closeAria')}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <RecipesPanel />
          </div>
        </div>
      )}

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

      <FanoutPromptDialog
        open={showFanout}
        onOpenChange={setShowFanout}
      />
    </div>
  )
}
