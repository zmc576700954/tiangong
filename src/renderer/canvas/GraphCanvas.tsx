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
  Panel,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../store/graphStore'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode, NodeType, NodeStatus } from '@shared/types'
import { BizEdge } from './BizEdge'
import { getEdgeMarkerEnd, edgeTypeConfig } from './edge-utils'
import { BizNodeComponent } from './BizNode'
import { CanvasOverlay } from './components/CanvasOverlay'
import { NodeContextPopover } from './NodeContextPopover'
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard'
import { useAutoLayout } from './hooks/useAutoLayout'
import { useConnectionMode } from './hooks/useConnectionMode'
import { useNodePositionPersistence } from './hooks/useNodePositionPersistence'
import { useNodeOperations } from './hooks/useNodeOperations'
import { useEdgeConnection } from './hooks/useEdgeConnection'
import { AlignHorizontalDistributeCenter } from 'lucide-react'

/** edgeTypes 定义在组件外部，避免每次渲染重建（@xyflow/react v12 最佳实践） */
const edgeTypes = { bizEdge: BizEdge }

/** nodeTypes 定义在组件外部，避免每次渲染重建 */
function BizNodeWrapper({ id, data, selected }: { id: string; data: GraphNode & { bugCount: number }; selected?: boolean }) {
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
  const currentGraph = graphs.find((g) => g.id === graphId)
  const projectPath = currentGraph?.projectPath

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
  // 节点位置持久化 Hook（防抖保存拖拽位置到数据库）
  // ────────────────────────────────────────────────────────────────
  const { handleNodesChange: onPositionChange } = useNodePositionPersistence(graphId)

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes)
      onPositionChange(changes)
    },
    [onNodesChange, onPositionChange],
  )

  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })

  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  const [contextPopover, setContextPopover] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  const [zoomLevel, setZoomLevel] = useState(1)

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
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      event.stopPropagation()
      const padding = 8
      const menuWidth = 176
      const menuHeight = 280
      const maxX = window.innerWidth - menuWidth - padding
      const maxY = window.innerHeight - menuHeight - padding
      const x = Math.max(padding, Math.min(event.clientX, maxX))
      const y = Math.max(padding, Math.min(event.clientY, maxY))
      setNodeContextMenu({ nodeId: node.id, x, y })
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

  /** 打开上下文编辑弹窗 */
  const handleAddContext = useCallback((nodeId: string) => {
    setContextPopover({ nodeId, x: Math.round(window.innerWidth / 2 - 144), y: Math.round(window.innerHeight / 3) })
    setNodeContextMenu(null)
  }, [])

  /** 保存节点上下文 */
  const handleSaveContext = useCallback(async (nodeId: string, contexts: import('@shared/types').ContextRef[]) => {
    try {
      await updateNode(nodeId, { contextRefs: contexts })
    } catch (err) {
      console.error('[GraphCanvas] Failed to save context:', err)
    }
    setContextPopover(null)
  }, [updateNode])

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

  const isEmpty = graphNodes.length === 0
  const hasProjectNode = graphNodes.some((n) => n.type === 'project')

  return (
    <div className="w-full h-full relative" data-testid="graph-canvas">
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
        onNodeContextMenu={handleNodeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
        // 性能优化：仅渲染视口内的节点和边，减少大型图谱的 DOM 负担
        onlyRenderVisibleElements
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
        <Background gap={16} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(node) => NODE_TYPE_COLORS[(node.data as unknown as GraphNode).type] ?? '#94a3b8'}
          maskColor="rgba(0, 0, 0, 0.1)"
          className="!bg-background/80 !border-border !rounded-lg !shadow-xs"
          pannable
          zoomable
        />

        <Panel position="bottom-left" className="m-2">
          <div className="bg-background/90 backdrop-blur border rounded-lg shadow-xs px-2 py-1 text-[10px] text-muted-foreground font-mono">
            {Math.round(zoomLevel * 100)}%
          </div>
        </Panel>

        <Panel position="top-right" className="m-2">
          <button
            onClick={applyLayout}
            className="flex items-center gap-1.5 bg-background/90 backdrop-blur border rounded-lg shadow-xs px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
            title="整理布局"
          >
            <AlignHorizontalDistributeCenter className="w-3.5 h-3.5" />
            整理布局
          </button>
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
