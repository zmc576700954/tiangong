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
  useStoreApi,
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
import type { RecipeDagNodeStatus } from '@shared/types/recipe'
import type { LintIssue, LintReport, WritebackItem } from '@shared/types/wiki'
import { BizEdge } from './BizEdge'
import { getEdgeMarkerEnd, createMarkerEnd, edgeTypeConfig } from './edge-utils'
import {
  buildReparentGhostEdge,
  deriveHierarchyEdges,
  GHOST_EDGE_PREFIX,
  resolveReparentZIndex,
} from './layouts/hierarchy'
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
import { useNodeTypeConfigs } from './hooks/useNodeTypeConfigs'
import { useCollapse } from './hooks/useCollapse'
import { useReparentDrag, extractPointerClientPoint, type ReparentReason } from './hooks/useReparentDrag'
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
import { RecipesPanel, type ActiveRecipeRun } from '../panels/RecipesPanel'
import { RecipeRunProgress } from '../panels/RecipeRunProgress'
import { FloatingPanel } from '../components/ui/FloatingPanel'
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

/**
 * 幽灵连线（拖拽重挂）的颜色：与合法落点的绿色高亮一致。
 *
 * 幽灵边本身由 `buildReparentGhostEdge` 构造 —— 它住在层级边派生的模块里，
 * 因为方向约定（父 → 子）跟那些边是同一条。
 */
const GHOST_EDGE_COLOR = '#22c55e'

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
    /** 拖拽重挂落点高亮 */
    isReparentTarget?: boolean
    isReparentTargetValid?: boolean
    /** 落点非法的原因 —— 徽标文案用它 */
    reparentReason?: ReparentReason
    /** 子树折叠：折叠该节点时会被隐藏的后代数（0 = 没有子节点） */
    hiddenDescendantCount?: number
    /** 子树折叠：折叠/展开（引用稳定，来自 useCollapse.toggle） */
    onToggleCollapse?: (nodeId: string) => void
  }
  selected?: boolean
}) {
  const multiSelected = useGraphStore((s) => s.selectedNodeIds.has(id))
  return <BizNodeComponent id={id} data={data} selected={selected} multiSelected={multiSelected} />
}
const nodeTypes = { bizNode: BizNodeWrapper }

/**
 * defaultEdgeOptions / connectionLineStyle 定义在模块级。
 * 它们是 ReactFlow 的受跟踪字段（fieldsToTrack），写成行内字面量会让
 * StoreUpdater 每次渲染都判定引用变化并写一次 xyflow store，触发所有订阅者重渲染。
 */
const DEFAULT_EDGE_OPTIONS = {
  type: 'bizEdge',
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 12,
    height: 12,
  },
} as const

const CONNECTION_LINE_STYLE = {
  stroke: '#3b82f6',
  strokeWidth: 2,
  strokeDasharray: '5 5',
} as const

/**
 * 布局模式持久化的 localStorage 键 —— **按项目路径分区**。
 *
 * 读与写必须用**同一个**函数：两端只要有一端用了别的键
 * （比如读端 `if (!projectPath) return`、写端 `projectPath ?? 'default'`），
 * 「没有项目路径的图」就会写进 'default' 键却永远读不回来。
 */
function layoutModeStorageKey(projectPath: string | undefined): string {
  return `bizgraph.layoutMode.${projectPath ?? 'default'}`
}

/**
 * 缩放百分比徽标单独成一个组件。
 * zoomLevel 在缩放过程中每帧都变，如果画布主组件订阅它，
 * 每次缩放都会重渲染整棵画布（连带 defaultEdgeOptions 写 store）。
 */
function ZoomLevelBadge() {
  const zoomLevel = useGraphRuntimeStore((s) => s.zoomLevel)
  return (
    <div className="bg-background/90 backdrop-blur border rounded-lg shadow-xs px-2 py-1 text-[10px] text-muted-foreground font-mono">
      {Math.round(zoomLevel * 100)}%
    </div>
  )
}

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
  /** 图是否已装载完 —— 布局模式的持久化要等它才有意义（见下方 effect） */
  const currentGraphId = currentGraph?.id

  const { screenToFlowPosition, setCenter } = useReactFlow()
  /** ReactFlow 内部 store —— 用来在「节点进 store 的那一刻」重试恢复力导向 */
  const storeApi = useStoreApi()

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
  const {
    handleNodesChange: onPositionChange,
    suppressPositions,
    releasePositions,
  } = useNodePositionPersistence(graphId)

  /**
   * 拖拽重挂（Task 10）：拖动节点时实时判定落点（绿=合法 / 红=非法），
   * 松手在合法节点上就调 `graph:reparent` 改父子关系。
   *
   * 位置权威：重挂成功后位置由主进程返回的 `movedPositions` 决定，
   * 自由位置持久化必须让位 —— `suppressPositions` / `releasePositions` 就是这个让位机制。
   */
  const {
    draggingNodeId: reparentDraggingId,
    candidate: reparentCandidate,
    onDragStart: onReparentDragStart,
    onDrag: onReparentDrag,
    onDragEnd: onReparentDragEnd,
  } = useReparentDrag({ suppressPositions, releasePositions })

  /**
   * 子树折叠（Task 12）：折叠态存在 `nodes.collapsed` 里 —— 落库后跨会话保留。
   *
   * `visibleNodes` 过滤掉被折叠节点的**整棵**后代子树（折叠节点自己可见）。
   * 布局自动获益：`flowNodes` 只画可见节点，被折叠的节点对 dagre 就是叶子，
   * 不需要动 `useAutoLayout.ts`。
   */
  const {
    toggle: toggleCollapse,
    visibleNodes,
    hiddenDescendantCount,
  } = useCollapse()

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
  const [lintLoading, setLintLoading] = useState(false)
  /**
   * 右上角浮层（Lint / Writeback / Recipes）互斥：
   * 三者都锚在 top-16 right-4，同时打开会叠在一起，谁也点不到。
   */
  const [cornerPanel, setCornerPanel] = useState<'lint' | 'writeback' | 'recipes' | null>(null)
  const [writebackItems, setWritebackItems] = useState<WritebackItem[]>([])
  const [writebackHistoryItems, setWritebackHistoryItems] = useState<WritebackItem[]>([])
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
    // 撤回操作作用于历史项（accepted / rolled_back），标题也要能查到
    for (const it of writebackHistoryItems) m.set(it.id, it.title)
    writebackItemsRef.current = m
  }, [writebackItems, writebackHistoryItems])

  // ────────────────────────────────────────────────────────────────
  // Recipes panel state
  // ────────────────────────────────────────────────────────────────
  /** 当前运行的 recipe —— 进度面板挂在画布层，不随 Recipes 弹层一起消失。 */
  const [recipeRun, setRecipeRun] = useState<ActiveRecipeRun | null>(null)
  /** 实时 step 状态：进度面板 → DAG 上色。 */
  const [recipeStepStatus, setRecipeStepStatus] = useState<Record<string, { status: RecipeDagNodeStatus; error?: string }>>({})

  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  /**
   * 节点类型规则表的唯一权威在主进程 nodeTypeRegistry，渲染端经 IPC 读取。
   * 右键菜单的「添加子节点」可选项完全由这张表决定，渲染端不再自带一份副本。
   */
  const { configs: nodeTypeConfigs } = useNodeTypeConfigs()
  const contextTargetNode = nodeContextMenu
    ? graphNodes.find((n) => n.id === nodeContextMenu.nodeId)
    : undefined
  const allowedChildTypes = contextTargetNode?.type
    ? (nodeTypeConfigs[contextTargetNode.type]?.allowedChildTypes ?? [])
    : []

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
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const [items, count, history] = await Promise.all([
        useGraphStore.getState().listWriteback(),
        useGraphStore.getState().countWriteback(),
        useGraphStore.getState().listWritebackHistory(since),
      ])
      setWritebackItems(items)
      setWritebackCount(count)
      setWritebackHistoryItems(history)
    } catch (err) {
      console.error('[GraphCanvas] writeback refresh failed:', err)
    }
  }, [])

  // 图加载/切换时刷新一次计数，让菜单角标 (N) 无需打开面板即为准确；
  // 同时重置面板状态，避免切换后短暂显示上一张图的待审项
  useEffect(() => {
    setCornerPanel((prev) => (prev === 'writeback' ? null : prev))
    setWritebackItems([])
    setWritebackHistoryItems([])
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

  /**
   * 拖拽重挂落点高亮的**原始值**。
   *
   * 进 `flowNodes` 的 useMemo 依赖数组的必须是引用稳定的原始值 —— candidate 是对象，
   * 每次指针移动都是新引用，放进依赖里会让依赖每帧变 → memo 每帧重算 →
   * useEffect(() => setRfNodes(flowNodes)) 每帧触发 → 无限重渲染（画布白屏）。
   */
  const reparentTargetId = reparentCandidate?.nodeId ?? null
  const reparentTargetValid = reparentCandidate?.valid ?? false
  const reparentReason = reparentCandidate?.reason

  const flowNodes = useMemo(() => {
    const cache = nodeCacheRef.current
    const nextIds = new Set<string>()

    const nodes = visibleNodes.map((node) => {
      const threadInfo = nodeThreadMap.get(node.id)
      const bugCount = bugCountMap.get(node.id) ?? 0
      const selected = node.id === selectedNodeId || node.id === connectingSourceId
      const multiSelected = selectedNodeIds.has(node.id)
      // D10b: 远端用户选中本节点的颜色列表（去重 + 排序）
      const remoteEntries = remoteSelectionByNode.get(node.id)
      const remoteSelectionColors = remoteEntries && remoteEntries.length > 0
        ? Array.from(new Set(remoteEntries.map((e) => e.color))).sort()
        : undefined
      /**
       * 落点高亮标记 —— **按节点派生**。
       *
       * 缓存 key 是按节点算的：把 `reparentTargetId` 塞进去会让**每个**节点的 key 都变
       * → 每次指针移动都重建全部节点对象 → 拖拽全程掉帧。
       * 派生的布尔值只有目标节点那一条缓存失效。
       */
      const isReparentTarget = reparentTargetId === node.id
      const isReparentTargetValid = isReparentTarget && reparentTargetValid
      const nodeReparentReason = isReparentTarget ? reparentReason : undefined
      /** 被拖节点 —— 绘制层级要抬到落点目标之上（见 resolveReparentZIndex） */
      const isReparentDragging = reparentDraggingId === node.id
      /** 本节点的绘制层级（普通节点 undefined → 不设 zIndex） */
      const reparentZIndex = resolveReparentZIndex(isReparentTarget, isReparentDragging)
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
        isReparentTarget,
        isReparentTargetValid,
        nodeReparentReason ?? null,
        isReparentDragging,
        // 子树折叠：折叠态本身 + 折叠时会被藏起来的后代数。
        // 后代数**必须**进键：给一个已折叠的节点新增子节点时，该节点自己的
        // `updatedAt` 不会变（`node:create` 只写新节点）→ 缓存命中 → 徽标
        // 数字停在旧值。折叠态进键是为了让折叠指示器的方向跟「子树已隐藏」
        // 这件事同步（乐观更新阶段 updatedAt 还没变）。
        node.collapsed ?? false,
        hiddenDescendantCount(node.id),
      ])

      nextIds.add(node.id)
      const cached = cache.get(node.id)
      if (cached?.key === key) {
        const prev = cached.node
        // position 不在缓存键里，但位置变了必须换新对象：xyflow 的
        // adoptUserNodes 只在 userNode 引用变化时才重建 internal node，
        // 复用旧对象会让画布沿用拖拽前的坐标，节点松手后弹回原位。
        if (prev.position === node.position) return prev
        const moved: Node = {
          ...prev,
          position: node.position,
          data: { ...prev.data, position: node.position },
        }
        cache.set(node.id, { key, node: moved })
        return moved
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
          // 拖拽重挂落点高亮
          isReparentTarget,
          isReparentTargetValid,
          reparentReason: nodeReparentReason,
          // 子树折叠：折叠指示器 + 徽标。
          // 后代数由 useCollapse 算好传进来 —— BizNode 是逐节点渲染的，
          // 自己数一遍就是 O(n²)。
          hiddenDescendantCount: hiddenDescendantCount(node.id),
          onToggleCollapse: toggleCollapse,
        },
        draggable: node.type !== 'project',
        selected,
        // 重挂拖拽期间的绘制层级：普通节点 < 落点目标 < 被拖节点。
        // 落点目标要抬到兄弟之上（原因徽标溢出到节点框外面，会被后画的兄弟盖住）；
        // 被拖节点要抬到落点目标之上（用户正在拖的节点不能被它要放上去的节点埋掉）。
        // xyflow 在 zIndexMode 'basic' 下认用户给的 zIndex（选中节点另有 +1000）。
        // 普通节点不带 zIndex 这个 key → 走 xyflow 的默认值 0。
        ...(reparentZIndex !== undefined ? { zIndex: reparentZIndex } : {}),
      }
      cache.set(node.id, { key, node: flowNode })
      return flowNode
    })

    for (const id of cache.keys()) {
      if (!nextIds.has(id)) cache.delete(id)
    }
    return nodes
  }, [visibleNodes, hiddenDescendantCount, toggleCollapse, bugCountMap, isZoomedOut, degradation.hideNodeTextLabels, connectingFrom, flashedNodeId, nodeThreadMap, selectedNodeId, connectingSourceId, selectedNodeIds, remoteSelectionByNode, reparentTargetId, reparentTargetValid, reparentReason, reparentDraggingId])

  // Sync computed flowNodes into ReactFlow's internal node state
  useEffect(() => {
    setRfNodes(flowNodes)
  }, [flowNodes, setRfNodes])

  /**
   * 画布上真正要画的边集 = 派生的层级边 + 保留的语义边。
   *
   * 层级关系以 `nodes.parent_id` 为唯一事实来源，层级边由它派生；存储里的
   * 历史层级边与迁移残留的 default 父子边在派生时就被丢弃。
   *
   * ⚠️ 这里必须自己包一层 useMemo —— mergedEdges 会作为 flowEdges 的依赖。
   * 写成 useMemo 外面的一次性计算 = 每帧新数组引用 → flowEdges 每帧重算
   * → useEffect(() => setRfEdges(flowEdges)) 每帧触发 → setRfEdges 是 useState setter
   * → 无限重渲染循环（React: Maximum update depth exceeded），画布白屏。
   */
  const mergedEdges = useMemo(() => {
    const { hierarchyEdges, semanticEdges } = deriveHierarchyEdges(graphNodes, graphEdges)
    const base = [...hierarchyEdges, ...semanticEdges]
    // 幽灵连线：候选父节点 → 被拖节点。临时边，不进 store、不落库，松手即消失。
    // 方向跟画布上所有层级边一致（父 → 子，箭头落在子节点那端）——
    // 反过来画的话，松手后真正的边出现时箭头会当场跳到另一端，预览与结果相反。
    // 只在**合法**落点时出现（非法落点退化成普通移动，不该有连线暗示）。
    if (!reparentTargetId || !reparentTargetValid || !reparentDraggingId) return base
    const ghostEdge = buildReparentGhostEdge(reparentDraggingId, reparentTargetId, graphId)
    return [...base, ghostEdge]
  }, [graphNodes, graphEdges, reparentTargetId, reparentTargetValid, reparentDraggingId, graphId])

  const flowEdges = useMemo(() => {
    const cache = edgeCacheRef.current
    const nextIds = new Set<string>()

    const edges = mergedEdges.map((edge) => {
      const edgeType = edge.edgeType || 'default'
      const config = edgeTypeConfig[edgeType]
      /** 幽灵连线（拖拽重挂的临时虚线）—— 用 id 前缀识别 */
      const isGhost = edge.id.startsWith(GHOST_EDGE_PREFIX)
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
        // 整个 content：suggested / note / trigger / guard 等字段变化都要让边重建，
        // 否则「确认建议边」后画布仍是建议态，✓/✗ 按钮点不掉。
        edge.content,
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
        markerEnd: isGhost ? createMarkerEnd(GHOST_EDGE_COLOR) : getEdgeMarkerEnd(edgeType),
        animated: shouldAnimate,
        // 派生层级边不可选中：它没有对应的存储边对象，选中后右侧面板找不到、
        // 删除也删不掉（删的只是 parent_id 的镜像，派生边照样画出来）。
        // ⚠️ 这一条挡不住 onEdgeClick —— @xyflow/react 的 EdgeWrapper 里
        // onClick 在 `if (isSelectable)` 块**外面**，所以 onEdgeClick 里还要再挡一道。
        selectable: edgeType === 'hierarchical' ? false : undefined,
        style: {
          stroke: isGhost ? GHOST_EDGE_COLOR : config.color,
          strokeWidth: isSelected ? 3 : 2,
          strokeDasharray: isGhost ? '5 5' : config.strokeDasharray,
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
  }, [mergedEdges, selectedEdgeId, degradation.simplifyEdges, degradation.hideEdgeLabels])

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
      // 派生层级边是 parent_id 的渲染产物，没有对应的存储边对象——
      // 选中它右侧面板找不到、删除也删不掉。层级靠 reparent 改（Task 6/9/10）。
      if (edge.data?.edgeType === 'hierarchical') return
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
    restoreForceLayout,
    exitForceMode,
    onNodeDragStart: onForceDragStart,
    onNodeDrag: onForceDrag,
    onNodeDragStop: onForceDragStop,
  } = useForceLayout()
  /**
   * 当前布局模式 —— `null` 表示**还没从 localStorage 读回来**。
   *
   * ⚠️ 必须是三态，不能是 `'tree' | 'force'`：
   * `layoutMode` 初值若写死 'tree'，首屏那个「自动跑 dagre」的 effect
   * 会在模式读回来**之前**就把画布排成树形 → 用户存的力导向坐标当场被覆盖
   * （而且 `applyLayout()` 会把坐标**写回 DB**）。
   * 所以：模式未读回 → **不跑** dagre；读回为 'tree' → 照跑；读回为 'force' → 不跑，
   * 并且要**真的**进入力导向模式（见下方 restore effect）。
   */
  const [layoutMode, setLayoutMode] = useState<'tree' | 'force' | null>(null)
  /** 力导向布局计算中（CPU 密集） —— 显示 spinner，禁用按钮防重入。 */
  const [forceLoading, setForceLoading] = useState(false)

  /**
   * 屏幕坐标 → flow 坐标。
   *
   * 命中判定需要 flow 坐标，`getBoundingClientRect()` 给的是屏幕坐标。
   * `screenToFlowPosition` 在 ReactFlow 上下文外可能抛错 —— 包 try/catch，
   * 别让一次坐标换算异常打断拖拽。
   *
   * 触屏：xyflow 的拖拽事件在触摸时是裸 TouchEvent，没有 clientX/clientY，
   * 坐标要从 touches / changedTouches 里取（见 extractPointerClientPoint）。
   */
  const toFlowPosition = useCallback(
    (event: MouseEvent | TouchEvent): { x: number; y: number } | null => {
      const point = extractPointerClientPoint(event)
      if (!point) return null
      try {
        return screenToFlowPosition(point)
      } catch {
        return null
      }
    },
    [screenToFlowPosition],
  )

  /**
   * 力导向布局下**不启用**重挂。
   *
   * 力导向模式下一次拖拽结束会把**所有**节点的仿真坐标整体写回数据库
   * （useForceLayout.onNodeDragStop），那会覆盖掉重挂算出来的锚点位置与
   * 整棵子树的平移结果。要同时支持两者得把仿真按新坐标重新播种 ——
   * 那是 useForceLayout 的重构，超出本任务范围。
   *
   * 模式还没读回来（`layoutMode === null`）时按「不是力导向」处理 —— 那只是一帧的
   * 窗口（读回 effect 与首屏渲染几乎同时），并且重挂与否最终由读回后的模式决定。
   */
  const reparentEnabled = layoutMode !== 'force'

  /**
   * 拖拽回调 —— 力导向 reheat 与重挂候选检测**共存**，不是二选一。
   *
   * 位置持久化的入口不是 onNodeDragStop，而是 xyflow 的 onNodesChange
   * （`change.type === 'position' && !change.dragging`，即拖拽结束的那一下）。
   */
  const handleNodeDragStart = useCallback<OnNodeDrag<Node>>(
    (event, node) => {
      onForceDragStart(event as unknown as React.MouseEvent, node)
      if (!reparentEnabled) return
      onReparentDragStart(node.id)
    },
    [onForceDragStart, reparentEnabled, onReparentDragStart],
  )

  const handleNodeDrag = useCallback<OnNodeDrag<Node>>(
    (event, node) => {
      onForceDrag(event as unknown as React.MouseEvent, node)
      if (!reparentEnabled) return
      const flow = toFlowPosition(event)
      if (flow) onReparentDrag(flow)
    },
    [onForceDrag, reparentEnabled, toFlowPosition, onReparentDrag],
  )

  const handleNodeDragStop = useCallback<OnNodeDrag<Node>>(
    (event, node) => {
      onForceDragStop(event as unknown as React.MouseEvent, node)
      if (!reparentEnabled) return
      const flow = toFlowPosition(event)
      if (flow) onReparentDragEnd(flow)
    },
    [onForceDragStop, reparentEnabled, toFlowPosition, onReparentDragEnd],
  )

  /**
   * 写回 localStorage —— **只在用户真的切换布局时写**。
   *
   * ⚠️ 千万别做成 effect（`useEffect(() => setItem(key, layoutMode), [layoutMode, projectPath])`）：
   * 那样首帧就会把 'tree' 写进真正的键 → 正好覆盖掉用户上次的选择。
   */
  const persistLayoutMode = useCallback(
    (mode: 'tree' | 'force') => {
      localStorage.setItem(layoutModeStorageKey(projectPath), mode)
    },
    [projectPath],
  )

  /** 进入力导向布局：显示 loading、计算、写入、退出 force mode 时清 loading。 */
  const handleApplyForceLayout = useCallback(() => {
    if (forceLoading) return
    setForceLoading(true)
    setLayoutMode('force')
    persistLayoutMode('force')
    // 用 setTimeout 把 spinner 让出一帧再跑计算，避免 UI 不更新
    setTimeout(() => {
      try {
        applyForceLayout()
      } finally {
        setForceLoading(false)
      }
    }, 16)
  }, [applyForceLayout, forceLoading, persistLayoutMode])

  /** 切回树形布局：先退出 force mode，再跑 dagre。 */
  const handleApplyTreeLayout = useCallback(() => {
    exitForceMode()
    setLayoutMode('tree')
    persistLayoutMode('tree')
    applyLayout()
  }, [exitForceMode, applyLayout, persistLayoutMode])

  /**
   * 首屏自动应用 dagre 布局。
   *
   * ⚠️ **必须等布局模式读回来**（`layoutMode === 'tree'`）：
   * 模式还没读回就排树形 → 用户存的力导向坐标当场被覆盖，
   * 而且 `applyLayout()` 会把坐标**写回 DB**（`useAutoLayout` 里的
   * `batchUpdatePositions`）→ 用户的布局被静默毁掉。
   * 模式读回为 'force' 时**不能**跑 dagre —— 那条路走的是「恢复力导向」。
   */
  useEffect(() => {
    if (layoutMode !== 'tree') return
    if (graphNodes.length > 0 && !hasAppliedInitialLayout.current) {
      hasAppliedInitialLayout.current = true
      // 延迟一帧让 ReactFlow 先完成首次渲染
      requestAnimationFrame(() => applyLayout())
    }
  }, [graphNodes.length, applyLayout, layoutMode])

  // 切换图时重置标记
  useEffect(() => {
    hasAppliedInitialLayout.current = false
    creatingProjectForGraph.current = null
    // 切图时清掉 force mode（避免 simulation 引用旧节点的 simNodes）
    exitForceMode()
    // ⚠️ 置成 `null`（**未读回**）而不是 'tree'：切图后必须重新读一次模式，
    // 读回来之前不能跑 dagre（否则新图会先被排成树形，坐标还落库）。
    setLayoutMode(null)
    setForceLoading(false)
  }, [graphId, exitForceMode])

  /**
   * 读回布局模式（localStorage，不进 DB）。
   *
   * ⚠️ **不能**放进 `useState` 的初始化函数：`projectPath` 来自 store 里的 graphs，
   * 首帧还没装载完 → 首帧读到的是 `bizgraph.layoutMode.default`（多半是空的）
   * → 用户存的真实布局根本没被读到；等 `projectPath` 到位，写回路径又会把当前值
   * （'tree'）写到真正的键上 → 用户存的布局被静默覆盖掉。
   *
   * ⚠️ **「等它到位」用 `currentGraph` 判断，不用 `projectPath`**：
   * `projectPath` 为空有两种含义 —— 「图还没装载完」（该等）和
   * 「这张图**真的**没有项目路径」（不该等）。`currentGraph` 存在即表示图装载完了。
   * 没有项目路径的图读的是 `bizgraph.layoutMode.default` 那个键 —— 读和写必须对称。
   *
   * ⚠️ **必须声明在「切图重置」effect 之后**：切图时两个 effect 会在同一次提交里跑，
   * 顺序决定谁赢 —— 读到的持久化值必须赢过重置用的 'tree'。
   */
  useEffect(() => {
    if (!currentGraphId) return
    const stored = localStorage.getItem(layoutModeStorageKey(projectPath))
    setLayoutMode(stored === 'force' ? 'force' : 'tree')
  }, [currentGraphId, projectPath])

  /**
   * 恢复成 'force' 时必须**真的**进入力导向模式 —— 不能只把工具栏上的字符串改成 'force'。
   *
   * 只改字符串的后果（三个都真实发生过）：
   *   - 首屏 dagre 照跑 → 用户摆好的坐标被覆盖并落库；
   *   - `isForceModeRef` 还是 false → 拖拽处理器全部提前 return →
   *     力导向模式下的「钉住 + reheat + 落库」是死的；
   *   - 工具栏写着「力导向」，画布却是树形，拖起来也没反应。
   *
   * 恢复用的是 `restoreForceLayout()`：用**当前坐标**建一个冻结的 simulation，
   * **不重算、不落库**（`applyForceLayout()` 会重算 + 落库，恢复路径绝不能用它）。
   *
   * ⚠️ **必须跟着节点集合走，而不是恢复一次就完事**：
   * 图元数据（`graph:list`）和节点（`graph:get`）是**两条独立的 IPC**，
   * 元数据先到 → 模式先被读回 → 但那时画布上可能只有那个「自动创建的项目根节点」。
   * 在这份残缺的节点集合上建出来的 simulation 里**没有用户的节点** →
   * 拖它们时 `simNodes.get(id)` 落空 → 力导向拖拽照样是死的。
   * 所以：节点集合一变就重建 simulation（用当前坐标，不重算、不落库）。
   *
   * ⚠️ **只在节点集合变化时重建** —— 位置变化不重建：
   * 拖拽过程中 store 的 nodes 数组每帧都在变（位置在动），若按数组引用判断，
   * 就会在拖拽中途重建 simulation → 钉住的状态被丢掉 → 拖拽失效。
   */
  useEffect(() => {
    if (layoutMode !== 'force') return
    let lastNodes: Node[] | null = null
    const sync = () => {
      const nodes = storeApi.getState().nodes
      if (lastNodes && nodes === lastNodes) return
      const idSetChanged =
        !lastNodes ||
        nodes.length !== lastNodes.length ||
        nodes.some((n, i) => lastNodes?.[i]?.id !== n.id)
      lastNodes = nodes
      if (!idSetChanged) return
      // 拿不到这张图的节点就返回 false —— 不能把「没建成」当成「建成」。
      // 节点稍后进 store 时，store 的订阅会再触发一次 sync。
      restoreForceLayout(graphId)
    }
    sync()
    const unsub = storeApi.subscribe(sync)
    return unsub
  }, [layoutMode, graphId, restoreForceLayout, storeApi])

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
      setCornerPanel('lint')
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
      setCornerPanel('lint')
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
    setCornerPanel('writeback')
  }, [refreshWriteback])

  const handleOpenRecipes = useCallback(() => {
    // 再点一次同一个按钮 = 收起
    setCornerPanel((prev) => (prev === 'recipes' ? null : 'recipes'))
  }, [])

  const handleCloseRecipes = useCallback(() => {
    setCornerPanel((prev) => (prev === 'recipes' ? null : prev))
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

  /** 撤回已采纳的写回项：accepted → rolled_back。失败保留原状态。 */
  const handleRollbackWriteback = useCallback(async (itemId: string) => {
    setWritebackPending((prev) => {
      if (prev.has(itemId)) return prev
      const next = new Set(prev)
      next.add(itemId)
      return next
    })
    setWritebackLastError(null)
    try {
      const result = await useGraphStore.getState().rollbackWriteback(itemId)
      await refreshWriteback()
      const gid = useGraphStore.getState().currentGraphId
      if (gid) await useGraphStore.getState().loadGraph(gid) // 撤回后图已变，刷新画布
      const title = writebackItemsRef.current.get(itemId) ?? itemId
      const undone = result?.undoneActions?.length ?? 0
      const skipped = result?.skippedActions?.length ?? 0
      if (skipped > 0) {
        toastInfo(
          t('toast.writeback.rolledBackPartial'),
          t('toast.writeback.rollbackPartialDetail', { title, undone, skipped }),
        )
      } else {
        toastSuccess(t('toast.writeback.rolledBack'), title)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[GraphCanvas] rollback writeback failed:', err)
      setWritebackLastError(t('toast.writeback.rollbackFailed', { message: msg }))
      toastError(t('toast.writeback.rollbackFailedTitle'), msg)
    } finally {
      setWritebackPending((prev) => {
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
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
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
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
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        connectionLineStyle={CONNECTION_LINE_STYLE}
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
          <ZoomLevelBadge />
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
        allowedChildTypes={allowedChildTypes}
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

      {cornerPanel === 'lint' && lintReport && (
        <LintPanel
          report={lintReport}
          onNavigate={handleLintNavigate}
          onClose={() => setCornerPanel(null)}
          onRecompute={handleRecompute}
          onApplyFix={handleLintApplyFix}
        />
      )}

      {cornerPanel === 'writeback' && (
        <WritebackPanel
          items={writebackItems}
          historyItems={writebackHistoryItems}
          pendingIds={writebackPending}
          lastError={writebackLastError}
          onAccept={handleAcceptWriteback}
          onDiscard={handleDiscardWriteback}
          onRollback={handleRollbackWriteback}
          onBatchAccept={handleBatchAcceptWriteback}
          onBatchDiscard={handleBatchDiscardWriteback}
          onNavigate={handleWritebackNavigate}
          onClose={() => setCornerPanel(null)}
          onDismissError={handleDismissWritebackError}
        />
      )}

      {cornerPanel === 'recipes' && (
        <FloatingPanel
          isOpen
          onClose={handleCloseRecipes}
          title={t('recipes.title')}
          variant="corner"
          width="xl"
          showCloseButton={false}
          headerActions={
            <button
              type="button"
              onClick={handleCloseRecipes}
              title={t('canvas.recipes.close')}
              aria-label={t('canvas.recipes.closeAria')}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          }
        >
          <RecipesPanel
            onActiveRunChange={setRecipeRun}
            liveStepStatus={recipeStepStatus}
          />
        </FloatingPanel>
      )}

      {/* Recipe 运行进度：挂在画布层（portal 到视口右下角），
          关掉 Recipes 弹层也不影响进度显示。 */}
      {recipeRun && (
        <RecipeRunProgress
          recipe={recipeRun.recipe}
          runId={recipeRun.runId}
          onStepUpdate={(stepId, status, error) =>
            setRecipeStepStatus((prev) => ({ ...prev, [stepId]: { status, error } }))
          }
          onClose={() => setRecipeRun(null)}
        />
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
