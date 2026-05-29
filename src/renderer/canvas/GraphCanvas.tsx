import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  useOnViewportChange,
  type Connection,
  type Edge,
  type Node,
  Panel,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../store/graphStore'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
// 浏览器端 ID 生成（不依赖 node:crypto）
function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`
}
import type { GraphNode, NodeType, EdgeType, EdgeContent, NodeStatus } from '@shared/types'
import { BizEdge } from './BizEdge'
import { getEdgeMarkerEnd, edgeTypeConfig } from './edge-utils'
import { BizNodeComponent } from './BizNode'
import { CanvasOverlay } from './components/CanvasOverlay'
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard'

/** edgeTypes 定义在组件外部，避免每次渲染重建（@xyflow/react v12 最佳实践） */
const edgeTypes = { bizEdge: BizEdge }

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

/** 沿 DOM 向上查找 ReactFlow 节点包裹层的 data-id */
function findNodeIdFromDom(el: EventTarget | null): string | null {
  let node: HTMLElement | null = el as HTMLElement | null
  while (node) {
    const id = node.getAttribute('data-id')
    if (id) return id
    node = node.parentElement
  }
  return null
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

  const { screenToFlowPosition } = useReactFlow()

  const bugCountMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const bug of bugs) {
      map.set(bug.nodeId, (map.get(bug.nodeId) ?? 0) + 1)
    }
    return map
  }, [bugs])

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  // ────────────────────────────────────────────────────────────────
  // 节点位置持久化：拦截 onNodesChange 中的拖拽结束事件，
  // 防抖保存位置到数据库，避免频繁 IPC 调用
  // ────────────────────────────────────────────────────────────────
  const pendingPositionUpdates = useRef<Map<string, { x: number; y: number }>>(new Map())
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPositionUpdates = useCallback(() => {
    const updates = pendingPositionUpdates.current
    if (updates.size === 0) return
    const store = useGraphStore.getState()
    updates.forEach((position, nodeId) => {
      store.updateNode(nodeId, { position }).catch((err) => {
        console.error('[GraphCanvas] Failed to persist node position:', err)
      })
    })
    pendingPositionUpdates.current = new Map()
  }, [])

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      // 先让 ReactFlow 更新视觉状态
      onNodesChange(changes)

      // 检测拖拽相关的 position 变化
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          // 拖拽结束时记录待保存的位置
          pendingPositionUpdates.current.set(change.id, { ...change.position })
        }
      }

      // 防抖：300ms 内没有新的位置变化则批量保存
      if (pendingPositionUpdates.current.size > 0) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = setTimeout(flushPositionUpdates, 300)
      }
    },
    [onNodesChange, flushPositionUpdates],
  )

  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })

  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [showEdgeTypeMenu, setShowEdgeTypeMenu] = useState(false)
  const [edgeMenuPosition, setEdgeMenuPosition] = useState({ x: 0, y: 0 })

  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  // 连线模式：记录源节点 ID
  const [connectingSourceId, setConnectingSourceId] = useState<string | null>(null)

  const [zoomLevel, setZoomLevel] = useState(1)

  // ────────────────────────────────────────────────────────────────
  // 使用 ref 保存最新值，避免 DOM 事件回调中的闭包陈旧问题
  // ────────────────────────────────────────────────────────────────
  const connectingSourceIdRef = useRef<string | null>(null)
  const graphEdgesRef = useRef(graphEdges)
  useEffect(() => { connectingSourceIdRef.current = connectingSourceId }, [connectingSourceId])
  useEffect(() => { graphEdgesRef.current = graphEdges }, [graphEdges])

  useEffect(() => {
    loadGraph(graphId)
    // 切换图时清空待保存的位置队列
    pendingPositionUpdates.current = new Map()
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [graphId, loadGraph])

  // 自动创建 project 根节点
  useEffect(() => {
    if (graphNodes.length === 0) return
    const hasProject = graphNodes.some((n) => n.type === 'project')
    if (!hasProject) {
      const graphs = useGraphStore.getState().graphs
      const currentGraph = graphs.find((g) => g.id === graphId)
      const title = currentGraph?.name ?? '项目'
      createNode({
        type: 'project',
        status: 'confirmed',
        title,
        graphId,
        graphType: 'online',
        position: { x: 0, y: 0 },
        acceptanceCriteria: [],
      }).catch((err) => {
        console.error('[GraphCanvas] Failed to create project node:', err)
      })
    }
  }, [graphNodes, graphId, createNode])

  // 组件卸载时刷入最后的位置更新
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        flushPositionUpdates()
      }
    }
  }, [flushPositionUpdates])

  useOnViewportChange({
    onChange: (viewport) => setZoomLevel(viewport.zoom),
  })

  useEffect(() => {
    const flowNodes: Node[] = graphNodes.map((node) => ({
      id: node.id,
      type: 'bizNode',
      position: node.position,
      data: {
        ...node,
        bugCount: bugCountMap.get(node.id) ?? 0,
      },
      selected: node.id === selectedNodeId || node.id === connectingSourceId,
      draggable: node.type !== 'project',
    }))

    const flowEdges: Edge[] = graphEdges.map((edge) => {
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
        data: { edgeType, content: edge.content },
        markerEnd: getEdgeMarkerEnd(edgeType),
        selected: edge.id === selectedEdgeId,
        animated: edgeType === 'failure' || edgeType === 'business-flow',
        style: {
          stroke: config.color,
          strokeWidth: edge.id === selectedEdgeId ? 3 : 2,
          strokeDasharray: config.strokeDasharray,
        },
      }
    })

    setRfNodes(flowNodes)
    setRfEdges(flowEdges)
  }, [graphNodes, graphEdges, selectedNodeId, selectedEdgeId, bugCountMap, connectingSourceId, setRfNodes, setRfEdges])

  // ────────────────────────────────────────────────────────────────
  // 核心修复：在 capture 阶段拦截点击，通过 data-id 检测目标节点
  // 完全绕过 ReactFlow 的合成事件系统，确保连线模式下点击可靠触发
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    function handleCaptureClick(e: MouseEvent) {
      const srcId = connectingSourceIdRef.current
      if (!srcId) return

      const targetNodeId = findNodeIdFromDom(e.target)
      if (!targetNodeId || targetNodeId === srcId) return

      // 阻止事件继续传播，防止 onPaneClick 清除连线状态
      e.stopPropagation()
      e.preventDefault()

      const edges = graphEdgesRef.current
      const exists = edges.some(
        (ed) => ed.source === srcId && ed.target === targetNodeId,
      )

      if (!exists) {
        const edgeId = generateId('edge')
        const newEdge: Edge = {
          id: edgeId,
          source: srcId,
          target: targetNodeId,
          type: 'bizEdge',
          data: { edgeType: 'default' as const },
          markerEnd: getEdgeMarkerEnd('default'),
          style: { stroke: '#94a3b8', strokeWidth: 2 },
        }
        setRfEdges((eds) => [...eds, newEdge])

        // 异步持久化到数据库
        createEdge({
          source: srcId,
          target: targetNodeId,
          label: '',
          graphId,
          edgeType: 'default',
        }).catch((err) => {
          console.error('[GraphCanvas] Failed to persist edge:', err)
        })
      }

      setConnectingSourceId(null)
      connectingSourceIdRef.current = null
    }

    // 使用 capture 阶段：在 ReactFlow 和冒泡之前拦截
    document.addEventListener('click', handleCaptureClick, { capture: true })
    return () => document.removeEventListener('click', handleCaptureClick, { capture: true })
  }, [createEdge, graphId, setRfEdges])

  const validateConnection = useCallback((connection: Connection): boolean => {
    if (!connection.source || !connection.target) return false
    if (connection.source === connection.target) return false
    const existingEdge = graphEdges.find(
      (e) => e.source === connection.source && e.target === connection.target,
    )
    if (existingEdge) return false
    return true
  }, [graphEdges])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!validateConnection(connection)) return
      if (connection.source && connection.target) {
        const sourceNode = graphNodes.find((n) => n.id === connection.source)
        const targetNode = graphNodes.find((n) => n.id === connection.target)
        if (sourceNode && targetNode) {
          const midX = (sourceNode.position.x + targetNode.position.x) / 2 + 100
          const midY = (sourceNode.position.y + targetNode.position.y) / 2
          setEdgeMenuPosition({ x: midX, y: midY })
        }
      }
      setPendingConnection(connection)
      setShowEdgeTypeMenu(true)
    },
    [validateConnection, graphNodes],
  )

  const handleCreateEdge = useCallback(
    async (edgeType: EdgeType, content?: EdgeContent) => {
      if (!pendingConnection?.source || !pendingConnection?.target) return
      const config = edgeTypeConfig[edgeType]
      const edge = await createEdge({
        source: pendingConnection.source,
        target: pendingConnection.target,
        label: '',
        graphId,
        edgeType,
        content,
      })
      setRfEdges((eds) =>
        addEdge(
          {
            ...pendingConnection,
            id: edge.id,
            label: edge.label,
            type: 'bizEdge',
            data: { edgeType, content },
            markerEnd: getEdgeMarkerEnd(edgeType),
            animated: edgeType === 'failure' || edgeType === 'business-flow',
            style: {
              stroke: config.color,
              strokeDasharray: config.strokeDasharray,
            },
          } satisfies Edge,
          eds,
        ),
      )
      setPendingConnection(null)
      setShowEdgeTypeMenu(false)
    },
    [pendingConnection, createEdge, graphId, setRfEdges],
  )

  /**
   * onNodeClick：仅处理正常模式下的节点选中
   * 连线模式已在 capture 阶段由 document click 监听器处理
   */
  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (connectingSourceIdRef.current) return
      selectNode(node.id)
      setNodeContextMenu(null)
    },
    [selectNode],
  )

  const onEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      selectEdge(edge.id)
    },
    [selectEdge],
  )

  const handleCancelConnect = useCallback(() => {
    setConnectingSourceId(null)
    connectingSourceIdRef.current = null
  }, [])

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
    setShowNodeMenu(false)
    setShowEdgeTypeMenu(false)
    setPendingConnection(null)
    setNodeContextMenu(null)
    // 点击空白处取消连线模式
    setConnectingSourceId(null)
    connectingSourceIdRef.current = null
  }, [selectNode, selectEdge])

  const clampMenuPosition = useCallback((x: number, y: number, menuWidth = 160, menuHeight = 140) => {
    const padding = 8
    const maxX = window.innerWidth - menuWidth - padding
    const maxY = window.innerHeight - menuHeight - padding
    return {
      x: Math.max(padding, Math.min(x, maxX)),
      y: Math.max(padding, Math.min(y, maxY)),
    }
  }, [])

  const onPaneContextMenu = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault()
      setMenuPosition(clampMenuPosition(event.clientX, event.clientY, 160, 140))
      setShowNodeMenu(true)
      setNodeContextMenu(null)
      selectNode(null)
      selectEdge(null)
    },
    [selectNode, selectEdge, clampMenuPosition],
  )

  const handleNodeContextMenu = useCallback(
    (event: React.MouseEvent, nodeId: string) => {
      event.preventDefault()
      event.stopPropagation()
      const padding = 8
      const menuWidth = 176
      const menuHeight = 280
      const maxX = window.innerWidth - menuWidth - padding
      const maxY = window.innerHeight - menuHeight - padding
      const x = Math.max(padding, Math.min(event.clientX, maxX))
      const y = Math.max(padding, Math.min(event.clientY, maxY))
      setNodeContextMenu({ nodeId, x, y })
      setShowNodeMenu(false)
      setShowEdgeTypeMenu(false)
    },
    [],
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
    isConnecting: !!connectingSourceId,
    onCancelConnect: handleCancelConnect,
  })

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

  const handleAddChild = useCallback(async (parentId: string, childType: NodeType) => {
    const parent = graphNodes.find((n) => n.id === parentId)
    const offsetX = parent ? 280 : 100
    const offsetY = parent ? 60 : 60
    const position = parent
      ? { x: parent.position.x + offsetX, y: parent.position.y + offsetY }
      : screenToFlowPosition({ x: 400, y: 300 })

    await createNode({
      type: childType,
      status: 'draft',
      title: `新建${NODE_TYPE_LABELS[childType]}`,
      graphId,
      graphType: childType === 'feature' || childType === 'bug' ? 'dev' : 'online',
      parentId,
      position,
      acceptanceCriteria: [],
    })
    setNodeContextMenu(null)
  }, [graphNodes, createNode, graphId, screenToFlowPosition])

  /** 进入连线模式（由右键菜单触发） */
  const handleStartConnect = useCallback((sourceId: string) => {
    setConnectingSourceId(sourceId)
    connectingSourceIdRef.current = sourceId
    setNodeContextMenu(null)
  }, [])

  const handleNodeStatusChange = async (nodeId: string, status: NodeStatus) => {
    await updateNode(nodeId, { status })
    setNodeContextMenu(null)
  }

  const handleNodeDelete = async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (node?.type === 'project') return
    await deleteNode(nodeId)
    selectNode(null)
    setNodeContextMenu(null)
  }

  const nodeTypes = useMemo(() => ({
    bizNode: (props: { id: string; data: GraphNode & { bugCount: number }; selected?: boolean }) => (
      <BizNodeComponent
        {...props}
        onContextMenu={(e) => handleNodeContextMenu(e, props.id)}
      />
    ),
  }), [handleNodeContextMenu])

  const isEmpty = graphNodes.length === 0

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
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
        <Background gap={16} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(node) => NODE_TYPE_COLORS[(node.data as unknown as GraphNode).type] ?? '#94a3b8'}
          maskColor="rgba(0, 0, 0, 0.1)"
          className="!bg-background/80 !border-border !rounded-lg !shadow-sm"
        />

        <Panel position="bottom-left" className="m-2">
          <div className="bg-background/90 backdrop-blur border rounded-lg shadow-sm px-2 py-1 text-[10px] text-muted-foreground font-mono">
            {Math.round(zoomLevel * 100)}%
          </div>
        </Panel>

        {connectingSourceId && (
          <Panel position="top-center" className="m-2">
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg shadow-sm px-4 py-2 text-sm text-blue-700">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              <span>连线模式：点击目标节点完成连线</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleCancelConnect()
                }}
                className="ml-2 px-2 py-0.5 text-xs bg-white border border-blue-300 rounded hover:bg-blue-100 transition-colors"
              >
                取消 (Esc)
              </button>
            </div>
          </Panel>
        )}

        {(selectedNodeId || selectedEdgeId) && !connectingSourceId && (
          <Panel position="bottom-center" className="m-2">
            <div className="flex items-center gap-2 bg-background/90 backdrop-blur border rounded-lg shadow-sm px-3 py-1.5 text-xs text-muted-foreground">
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
        hasProjectNode={graphNodes.some((n) => n.type === 'project')}
      />
    </div>
  )
}
