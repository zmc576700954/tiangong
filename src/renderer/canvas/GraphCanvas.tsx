import { useCallback, useEffect, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  Panel,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../store/graphStore'
import { useAgentStore } from '../store/agentStore'
import { getNodeStatusClass, cn } from '../lib/utils'
import { NODE_TYPE_LABELS, NODE_STATUS_LABELS } from '@shared/constants'
import type { GraphNode, NodeType, EdgeType, NodeStatus } from '@shared/types'
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  Bug,
  GitBranch,
  MousePointerClick,
  Trash2,
  Pencil,
  ArrowRight,
  Map,
} from 'lucide-react'
import { BizEdge, getEdgeMarkerEnd } from './BizEdge'

interface GraphCanvasProps {
  graphId: string
}

const nodeTypeColors: Record<string, string> = {
  module: '#3b82f6',
  process: '#8b5cf6',
  feature: '#22c55e',
  bug: '#ef4444',
}

const edgeTypeOptions: { type: EdgeType; label: string; color: string }[] = [
  { type: 'default', label: '默认流程', color: '#94a3b8' },
  { type: 'success', label: '成功分支', color: '#22c55e' },
  { type: 'failure', label: '失败分支', color: '#ef4444' },
  { type: 'condition', label: '条件分支', color: '#f59e0b' },
]

export function GraphCanvas({ graphId }: GraphCanvasProps) {
  const {
    nodes: graphNodes,
    edges: graphEdges,
    loadGraph,
    selectedNodeId,
    selectedEdgeId,
    selectNode,
    selectEdge,
    createNode,
    createEdge,
    deleteNode,
    deleteEdge,
    updateNode,
    edges: storeEdges,
  } = useGraphStore()
  const sessions = useAgentStore((state) => state.sessions)
  const { getZoom } = useReactFlow()

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })

  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null)
  const [showEdgeTypeMenu, setShowEdgeTypeMenu] = useState(false)
  const [edgeMenuPosition, setEdgeMenuPosition] = useState({ x: 0, y: 0 })

  // 节点右键菜单
  const [nodeContextMenu, setNodeContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  // 缩放级别
  const [zoomLevel, setZoomLevel] = useState(1)

  useEffect(() => {
    loadGraph(graphId)
  }, [graphId, loadGraph])

  // 监听缩放变化
  useEffect(() => {
    const interval = setInterval(() => {
      setZoomLevel(getZoom())
    }, 200)
    return () => clearInterval(interval)
  }, [getZoom])

  useEffect(() => {
    const flowNodes: Node[] = graphNodes.map((node) => ({
      id: node.id,
      type: 'bizNode',
      position: node.position,
      data: {
        ...node,
        bugCount: sessions.filter((s) => s.nodeId === node.id).length,
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
  }, [graphNodes, graphEdges, selectedNodeId, selectedEdgeId, sessions, setRfNodes, setRfEdges])

  const validateConnection = useCallback((connection: Connection): boolean => {
    if (!connection.source || !connection.target) return false
    if (connection.source === connection.target) return false
    const existingEdge = storeEdges.find(
      (e) => e.source === connection.source && e.target === connection.target,
    )
    if (existingEdge) return false
    return true
  }, [storeEdges])

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
          } as Edge,
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

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault()
      const e = event as React.MouseEvent
      setMenuPosition({ x: e.clientX, y: e.clientY })
      setShowNodeMenu(true)
      setNodeContextMenu(null)
      selectNode(null)
      selectEdge(null)
    },
    [selectNode, selectEdge],
  )

  // 节点右键菜单
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      event.stopPropagation()
      setNodeContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
      setShowNodeMenu(false)
      setShowEdgeTypeMenu(false)
    },
    [],
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId) {
          deleteNode(selectedNodeId)
          selectNode(null)
        } else if (selectedEdgeId) {
          deleteEdge(selectedEdgeId)
          selectEdge(null)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedNodeId, selectedEdgeId, deleteNode, deleteEdge, selectNode, selectEdge])

  const handleCreateNode = async (type: NodeType) => {
    const canvasRect = document.querySelector('.react-flow__viewport')?.getBoundingClientRect()
    if (!canvasRect) return
    const position = {
      x: menuPosition.x - canvasRect.left,
      y: menuPosition.y - canvasRect.top,
    }
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

  const nodeTypes = { bizNode: (props: { id: string; data: GraphNode & { bugCount: number }; selected?: boolean }) => (
    <BizNodeComponent
      {...props}
      onContextMenu={(e) => onNodeContextMenu(e, { id: props.id, data: props.data, position: { x: 0, y: 0 } } as unknown as Node)}
    />
  ) }
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
          nodeColor={(node) => nodeTypeColors[(node.data as unknown as GraphNode).type] ?? '#94a3b8'}
          maskColor="rgba(0, 0, 0, 0.1)"
          className="!bg-background/80 !border-border !rounded-lg !shadow-sm"
        />

        <Panel position="top-right" className="m-2">
          <div className="flex items-center gap-1 bg-background/90 backdrop-blur border rounded-lg shadow-sm p-1">
            <button className="p-1.5 rounded hover:bg-muted transition-colors" title="Zoom in">
              <ZoomIn className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-muted transition-colors" title="Zoom out">
              <ZoomOut className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded hover:bg-muted transition-colors" title="Fit view">
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </Panel>

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

      {/* 空白画布引导 */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center space-y-4 opacity-60">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-muted flex items-center justify-center">
              <Map className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-lg font-medium text-muted-foreground">画布为空</p>
              <p className="text-sm text-muted-foreground">右键点击画布创建第一个节点</p>
            </div>
            <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <MousePointerClick className="w-3.5 h-3.5" />
                <span>右键创建</span>
              </div>
              <div className="flex items-center gap-1">
                <ArrowRight className="w-3.5 h-3.5" />
                <span>拖拽连线</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 右键画布菜单 */}
      {showNodeMenu && (
        <div
          className="absolute z-50 bg-background border rounded-lg shadow-lg py-1 w-40"
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1">Add node</div>
          {(['module', 'process', 'feature', 'bug'] as NodeType[]).map((type) => (
            <button
              key={type}
              onClick={() => handleCreateNode(type)}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: nodeTypeColors[type] }} />
              {NODE_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      )}

      {/* 边类型选择菜单 */}
      {showEdgeTypeMenu && pendingConnection && (
        <div
          className="absolute z-50 bg-background border rounded-lg shadow-lg py-2 w-48"
          style={{ left: edgeMenuPosition.x, top: edgeMenuPosition.y }}
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            选择连接类型
          </div>
          {edgeTypeOptions.map((opt) => (
            <button
              key={opt.type}
              onClick={() => handleCreateEdge(opt.type)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <div
                className="w-3 h-3 rounded-full flex-shrink-0 border"
                style={{ backgroundColor: opt.color, borderColor: opt.color }}
              />
              <div className="flex flex-col">
                <span>{opt.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  {opt.type === 'default' && '标准流程连接'}
                  {opt.type === 'success' && '成功后的流程分支'}
                  {opt.type === 'failure' && '失败后的异常分支'}
                  {opt.type === 'condition' && '条件判断分支'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 节点右键菜单 */}
      {nodeContextMenu && (
        <NodeContextMenu
          nodeId={nodeContextMenu.nodeId}
          x={nodeContextMenu.x}
          y={nodeContextMenu.y}
          nodes={graphNodes}
          onStatusChange={handleNodeStatusChange}
          onDelete={handleNodeDelete}
          onClose={() => setNodeContextMenu(null)}
        />
      )}
    </div>
  )
}

function BizNodeComponent({
  id: _id,
  data,
  selected: _selected,
  onContextMenu,
}: {
  id: string
  data: GraphNode & { bugCount: number }
  selected?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const statusClass = getNodeStatusClass(data.status)
  const typeColor = nodeTypeColors[data.type] ?? '#94a3b8'

  return (
    <div
      className={cn(
        'px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-sm transition-all hover:shadow-md cursor-pointer',
        statusClass,
      )}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
          {NODE_TYPE_LABELS[data.type]}
        </span>
      </div>
      <div className="font-medium text-sm truncate">{data.title}</div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-muted-foreground">{NODE_STATUS_LABELS[data.status]}</span>
        {data.bugCount > 0 && (
          <div className="flex items-center gap-0.5 text-[10px] text-destructive">
            <Bug className="w-3 h-3" />
            {data.bugCount}
          </div>
        )}
      </div>
    </div>
  )
}

function NodeContextMenu({
  nodeId,
  x,
  y,
  nodes,
  onStatusChange,
  onDelete,
  onClose,
}: {
  nodeId: string
  x: number
  y: number
  nodes: GraphNode[]
  onStatusChange: (nodeId: string, status: NodeStatus) => void
  onDelete: (nodeId: string) => void
  onClose: () => void
}) {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return null

  const statusOptions: { value: NodeStatus; label: string; color: string }[] = [
    { value: 'draft', label: '草稿', color: '#94a3b8' },
    { value: 'confirmed', label: '已确认', color: '#3b82f6' },
    { value: 'developing', label: '开发中', color: '#f59e0b' },
    { value: 'testing', label: '待测试', color: '#8b5cf6' },
    { value: 'review', label: '待验收', color: '#06b6d4' },
    { value: 'published', label: '已发布', color: '#22c55e' },
  ]

  // Close menu when clicking outside
  useEffect(() => {
    const handleClick = () => onClose()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [onClose])

  return (
    <div
      className="absolute z-50 bg-background border rounded-lg shadow-lg py-1 w-44"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
        <Pencil className="w-3 h-3" />
        {node.title}
      </div>

      <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">状态</div>
      <div className="px-2 pb-1 grid grid-cols-3 gap-1">
        {statusOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onStatusChange(nodeId, opt.value)}
            className={cn(
              'px-1.5 py-1 text-[10px] rounded border transition-colors',
              node.status === opt.value
                ? 'border-transparent text-white'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
            style={node.status === opt.value ? { backgroundColor: opt.color } : undefined}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="border-t mt-1 pt-1">
        <button
          onClick={() => onDelete(nodeId)}
          className="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
        >
          <Trash2 className="w-3.5 h-3.5" />
          删除节点
        </button>
      </div>
    </div>
  )
}
