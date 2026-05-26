import { useCallback, useEffect, useState, useMemo } from 'react'
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
  type Connection,
  type Edge,
  type Node,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useGraphStore } from '../store/graphStore'
import { useAgentStore } from '../store/agentStore'
import { BizNodeComponent, nodeTypeColors } from './nodes/BizNodeComponent'
import { MindMapEdge } from './edges/MindMapEdge'
import { computeTreeLayout, filterVisibleNodes } from './layout/treeLayout'
import { cn } from '../lib/utils'
import { NODE_TYPE_LABELS } from '@shared/constants'
import type { GraphNode, NodeType } from '@shared/types'
import { EdgeEditPopover } from '../components/EdgeEditPopover'
import {
  Maximize,
  LayoutTree,
  LayoutGrid,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'

interface GraphCanvasProps {
  graphId: string
}

// 自定义 Edge 类型注册
const edgeTypes = {
  mindMap: MindMapEdge,
}

const nodeTypes = {
  bizNode: BizNodeComponent,
}

export function GraphCanvas({ graphId }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner graphId={graphId} />
    </ReactFlowProvider>
  )
}

function GraphCanvasInner({ graphId }: GraphCanvasProps) {
  const {
    nodes: graphNodes,
    edges: graphEdges,
    loadGraph,
    selectedNodeId,
    selectNode,
    createNode,
    createEdge,
    updateNode,
    deleteNode,
    deleteEdge,
  } = useGraphStore()
  const { sessions } = useAgentStore()
  const { screenToFlowPosition, fitView } = useReactFlow()

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([])

  const [layoutMode, setLayoutMode] = useState<'free' | 'tree'>('free')
  const [showNodeMenu, setShowNodeMenu] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)

  // 加载图数据
  useEffect(() => {
    loadGraph(graphId)
  }, [graphId, loadGraph])

  // 计算树形布局位置
  const treePositions = useMemo(() => {
    if (layoutMode !== 'tree') return null
    return computeTreeLayout(graphNodes)
  }, [layoutMode, graphNodes])

  // 同步到 React Flow
  useEffect(() => {
    // Tree 模式下过滤掉被折叠的节点
    const visibleNodes =
      layoutMode === 'tree'
        ? filterVisibleNodes(graphNodes)
        : graphNodes

    const flowNodes: Node[] = visibleNodes.map((node) => ({
      id: node.id,
      type: 'bizNode',
      position:
        layoutMode === 'tree' && treePositions?.[node.id]
          ? treePositions[node.id]
          : node.position,
      data: {
        ...node,
        bugCount: useAgentStore
          .getState()
          .sessions.filter((s) => s.nodeId === node.id).length,
        layoutMode,
      },
      selected: node.id === selectedNodeId,
      // Tree 模式下禁止拖拽
      draggable: layoutMode === 'free',
    }))

    // Tree 模式下只显示可见节点之间的边
    const visibleNodeIds = new Set(visibleNodes.map((n) => n.id))
    const visibleEdges =
      layoutMode === 'tree'
        ? graphEdges.filter(
            (e) =>
              visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
          )
        : graphEdges

    const flowEdges: Edge[] = visibleEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.condition || edge.label,
      // Tree 模式下使用自定义 mindMap 边，否则使用用户设置的类型
      type:
        layoutMode === 'tree'
          ? 'mindMap'
          : edge.edgeType || 'default',
      data: edge,
      animated: false,
      markerEnd:
        edge.markerEnd === 'none'
          ? undefined
          : edge.markerEnd || 'arrow',
      style: edge.style
        ? {
            stroke: edge.style.stroke,
            strokeWidth: edge.style.strokeWidth,
            strokeDasharray: edge.style.strokeDasharray,
          }
        : undefined,
    }))

    setRfNodes(flowNodes)
    setRfEdges(flowEdges)
  }, [
    graphNodes,
    graphEdges,
    selectedNodeId,
    sessions,
    layoutMode,
    treePositions,
    setRfNodes,
    setRfEdges,
  ])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        createEdge({
          source: connection.source,
          target: connection.target,
          label: '',
          graphId,
          edgeType: layoutMode === 'tree' ? 'smoothstep' : 'default',
        }).then((edge) => {
          setRfEdges((eds) =>
            addEdge(
              {
                ...connection,
                id: edge.id,
                label: edge.condition || edge.label,
                type: layoutMode === 'tree' ? 'mindMap' : edge.edgeType || 'default',
              },
              eds
            )
          )
        })
      }
    },
    [createEdge, graphId, layoutMode, setRfEdges]
  )

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      selectNode(node.id)
    },
    [selectNode]
  )

  const onPaneClick = useCallback(() => {
    selectNode(null)
    setShowNodeMenu(false)
  }, [selectNode])

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      setMenuPosition({ x: event.clientX, y: event.clientY })
      setShowNodeMenu(true)
    },
    []
  )

  const handleCreateNode = async (type: NodeType) => {
    const position = screenToFlowPosition({
      x: menuPosition.x,
      y: menuPosition.y,
    })

    await createNode({
      type,
      status: 'draft',
      title: `新${NODE_TYPE_LABELS[type]}`,
      graphId,
      graphType: 'production',
      position,
      acceptanceCriteria: [],
    })

    setShowNodeMenu(false)
  }

  // 切换布局模式
  const toggleLayoutMode = useCallback(() => {
    const newMode = layoutMode === 'free' ? 'tree' : 'free'
    setLayoutMode(newMode)
    // 切换后自动适配视图
    setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 50)
  }, [layoutMode, fitView])

  // 全部展开
  const expandAll = useCallback(async () => {
    for (const node of graphNodes) {
      if (node.collapsed) {
        await updateNode(node.id, { collapsed: false })
      }
    }
  }, [graphNodes, updateNode])

  // 全部折叠
  const collapseAll = useCallback(async () => {
    // 只折叠有子节点的节点
    const hasChild = (nodeId: string) =>
      graphNodes.some((n) => n.parentId === nodeId)
    for (const node of graphNodes) {
      if (hasChild(node.id) && !node.collapsed) {
        await updateNode(node.id, { collapsed: true })
      }
    }
  }, [graphNodes, updateNode])

  // 自动排列（树形模式下重新计算）
  const autoArrange = useCallback(() => {
    if (layoutMode === 'tree') {
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 50)
    }
  }, [layoutMode, fitView])

  // 双击边编辑
  const onEdgeDoubleClick = useCallback(
    (_: unknown, edge: Edge) => {
      const graphEdge = graphEdges.find((e) => e.id === edge.id)
      if (graphEdge) {
        setEditingEdgeId(graphEdge.id)
      }
    },
    [graphEdges]
  )

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // 忽略输入框内的快捷键
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return
      }

      // Tab: 为选中节点创建子节点
      if (e.key === 'Tab' && selectedNodeId) {
        e.preventDefault()
        const parent = graphNodes.find((n) => n.id === selectedNodeId)
        if (!parent) return

        const siblingCount = graphNodes.filter(
          (n) => n.parentId === selectedNodeId
        ).length
        const childX = parent.position.x + 260
        const childY = parent.position.y + siblingCount * 110

        const child = await createNode({
          type: 'module',
          status: 'draft',
          title: `子节点 ${siblingCount + 1}`,
          graphId: parent.graphId,
          graphType: parent.graphType,
          parentId: selectedNodeId,
          position: { x: childX, y: childY },
          acceptanceCriteria: [],
        })

        await createEdge({
          source: selectedNodeId,
          target: child.id,
          graphId: parent.graphId,
          edgeType: 'smoothstep',
        })

        // 如果父节点是折叠状态，自动展开
        if (parent.collapsed) {
          await updateNode(selectedNodeId, { collapsed: false })
        }
      }

      // Delete / Backspace: 删除选中节点
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeId) {
        e.preventDefault()
        // 级联删除子孙节点
        const descendantIds: string[] = []
        const collect = (parentId: string) => {
          const children = graphNodes.filter((n) => n.parentId === parentId)
          for (const c of children) {
            descendantIds.push(c.id)
            collect(c.id)
          }
        }
        collect(selectedNodeId)
        for (const id of descendantIds.reverse()) {
          await deleteNode(id)
        }
        await deleteNode(selectedNodeId)
      }

      // Space: 折叠/展开选中节点
      if (e.key === ' ' && selectedNodeId) {
        e.preventDefault()
        const node = graphNodes.find((n) => n.id === selectedNodeId)
        if (node && graphNodes.some((n) => n.parentId === selectedNodeId)) {
          await updateNode(selectedNodeId, {
            collapsed: !node.collapsed,
          })
        }
      }

      // Ctrl+L: 切换布局模式
      if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        toggleLayoutMode()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    selectedNodeId,
    graphNodes,
    graphId,
    createNode,
    createEdge,
    updateNode,
    deleteNode,
    toggleLayoutMode,
  ])

  // 当前正在编辑的边
  const editingEdge = editingEdgeId
    ? graphEdges.find((e) => e.id === editingEdgeId)
    : null

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onEdgeDoubleClick={onEdgeDoubleClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
        minZoom={0.1}
        maxZoom={2}
      >
        <Background gap={16} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(node) =>
            nodeTypeColors[(node.data as GraphNode).type] ?? '#94a3b8'
          }
          maskColor="rgba(0, 0, 0, 0.1)"
        />

        {/* 顶部工具栏 */}
        <Panel position="top-left" className="m-2">
          <div className="flex items-center gap-1 bg-background/90 backdrop-blur border rounded-lg shadow-sm p-1">
            {/* 布局模式切换 */}
            <button
              onClick={toggleLayoutMode}
              className={cn(
                'flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors',
                layoutMode === 'tree'
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              )}
              title={
                layoutMode === 'tree' ? '切换到自由布局' : '切换到树形布局'
              }
            >
              {layoutMode === 'tree' ? (
                <>
                  <LayoutTree className="w-3.5 h-3.5" />
                  树形
                </>
              ) : (
                <>
                  <LayoutGrid className="w-3.5 h-3.5" />
                  自由
                </>
              )}
            </button>

            <div className="w-px h-4 bg-border mx-0.5" />

            {/* 全部展开 */}
            <button
              onClick={expandAll}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="全部展开"
            >
              <ChevronDown className="w-4 h-4" />
            </button>

            {/* 全部折叠 */}
            <button
              onClick={collapseAll}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="全部折叠"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <div className="w-px h-4 bg-border mx-0.5" />

            {/* 适应视图 */}
            <button
              onClick={() => fitView({ padding: 0.2 })}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title="适应视图"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </Panel>
      </ReactFlow>

      {/* 画布空白处右键菜单 */}
      {showNodeMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowNodeMenu(false)}
          />
          <div
            className="absolute z-50 bg-background border rounded-lg shadow-lg py-1 w-40"
            style={{ left: menuPosition.x, top: menuPosition.y }}
          >
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1">
              添加节点
            </div>
            {(
              [
                'module',
                'process',
                'rule',
                'api',
                'service',
                'entity',
              ] as NodeType[]
            ).map((type) => (
              <button
                key={type}
                onClick={() => handleCreateNode(type)}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
              >
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: nodeTypeColors[type] }}
                />
                {NODE_TYPE_LABELS[type]}
              </button>
            ))}

            {layoutMode === 'tree' && (
              <>
                <div className="border-t my-1" />
                <button
                  onClick={() => {
                    autoArrange()
                    setShowNodeMenu(false)
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
                >
                  <Maximize className="w-3.5 h-3.5 text-muted-foreground" />
                  重新排列
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* 边编辑浮层 */}
      {editingEdge && (
        <EdgeEditPopover
          edge={editingEdge}
          onClose={() => setEditingEdgeId(null)}
        />
      )}
    </div>
  )
}
