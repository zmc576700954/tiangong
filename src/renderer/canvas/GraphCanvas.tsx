import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
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
import { useAgentStore } from '../store/agentStore'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode, NodeType, EdgeType, NodeStatus } from '@shared/types'
import { BizEdge, getEdgeMarkerEnd } from './BizEdge'
import { BizNodeComponent } from './BizNode'
import { CanvasOverlay } from './components/CanvasOverlay'
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard'

interface GraphCanvasProps {
  graphId: string
}

export function GraphCanvas({ graphId }: GraphCanvasProps) {
  // PERFORMANCE: 使用细粒度选择器，避免订阅整个 store 导致的不必要重渲染
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
  const sessions = useAgentStore((state) => state.sessions)
  const { screenToFlowPosition } = useReactFlow()

  // PERFORMANCE: 预计算每个节点的 bugCount，避免每次渲染 O(n²) 的 filter
  const bugCountMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessions) {
      map.set(s.nodeId, (map.get(s.nodeId) ?? 0) + 1)
    }
    return map
  }, [sessions])

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })

  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [showEdgeTypeMenu, setShowEdgeTypeMenu] = useState(false)
  const [edgeMenuPosition, setEdgeMenuPosition] = useState({ x: 0, y: 0 })

  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  const [zoomLevel, setZoomLevel] = useState(1)

  useEffect(() => {
    loadGraph(graphId)
  }, [graphId, loadGraph])

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
      selected: node.id === selectedNodeId,
    }))

    const flowEdges: Edge[] = graphEdges.map((edge) => {
      const edgeType = edge.edgeType || 'default'
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: 'bizEdge',
        data: { edgeType },
        markerEnd: getEdgeMarkerEnd(edgeType),
        selected: edge.id === selectedEdgeId,
        animated: edgeType === 'failure',
        style: {
          stroke: edgeType === 'success' ? '#22c55e' : edgeType === 'failure' ? '#ef4444' : edgeType === 'condition' ? '#f59e0b' : '#94a3b8',
          strokeWidth: edge.id === selectedEdgeId ? 3 : 2,
        },
      }
    })

    setRfNodes(flowNodes)
    setRfEdges(flowEdges)
  }, [graphNodes, graphEdges, selectedNodeId, selectedEdgeId, bugCountMap, setRfNodes, setRfEdges])

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
    async (edgeType: EdgeType) => {
      if (!pendingConnection?.source || !pendingConnection?.target) return
      const edge = await createEdge({
        source: pendingConnection.source,
        target: pendingConnection.target,
        label: '',
        graphId,
        edgeType,
      })
      setRfEdges((eds) =>
        addEdge(
          {
            ...pendingConnection,
            id: edge.id,
            label: edge.label,
            type: 'bizEdge',
            data: { edgeType },
            markerEnd: getEdgeMarkerEnd(edgeType),
            animated: edgeType === 'failure',
            style: {
              stroke:
                edgeType === 'success' ? '#22c55e'
                  : edgeType === 'failure' ? '#ef4444'
                    : edgeType === 'condition' ? '#f59e0b'
                      : '#94a3b8',
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

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
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

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
    setShowNodeMenu(false)
    setShowEdgeTypeMenu(false)
    setPendingConnection(null)
    setNodeContextMenu(null)
  }, [selectNode, selectEdge])

  /** 计算不超出视口的菜单位置 */
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
      const pos = clampMenuPosition(event.clientX, event.clientY, 176, 240)
      setNodeContextMenu({ nodeId, x: pos.x, y: pos.y })
      setShowNodeMenu(false)
      setShowEdgeTypeMenu(false)
    },
    [clampMenuPosition],
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
  })

  const handleCreateNode = async (type: NodeType) => {
    const position = screenToFlowPosition({ x: menuPosition.x, y: menuPosition.y })
    await createNode({
      type,
      status: 'draft',
      title: `New ${NODE_TYPE_LABELS[type]}`,
      graphId,
      graphType: 'online',
      position,
      acceptanceCriteria: [],
    })
    setShowNodeMenu(false)
  }

  const handleNodeStatusChange = async (nodeId: string, status: NodeStatus) => {
    await updateNode(nodeId, { status })
    setNodeContextMenu(null)
  }

  const handleNodeDelete = async (nodeId: string) => {
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
  const edgeTypes = { bizEdge: BizEdge }

  const isEmpty = graphNodes.length === 0

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
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

        {/* 缩放级别指示器 */}
        <Panel position="bottom-left" className="m-2">
          <div className="bg-background/90 backdrop-blur border rounded-lg shadow-sm px-2 py-1 text-[10px] text-muted-foreground font-mono">
            {Math.round(zoomLevel * 100)}%
          </div>
        </Panel>

        {(selectedNodeId || selectedEdgeId) && (
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
      />
    </div>
  )
}
