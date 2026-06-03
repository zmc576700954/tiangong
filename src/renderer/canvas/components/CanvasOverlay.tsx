import { useState } from 'react'
import { MousePointerClick, ArrowRight, Map as MapIcon, GitBranch } from 'lucide-react'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS, EDGE_TYPE_OPTIONS } from '@shared/constants'
import type { Connection } from '@xyflow/react'
import type { GraphNode, NodeType, EdgeType, EdgeContent, NodeStatus } from '@shared/types'
import { NodeContextMenu } from '../NodeContextMenu'

interface CanvasOverlayProps {
  isEmpty: boolean
  showNodeMenu: boolean
  menuPosition: { x: number; y: number }
  onCreateNode: (type: NodeType) => void
  showEdgeTypeMenu: boolean
  edgeMenuPosition: { x: number; y: number }
  pendingConnection: Connection | null
  onCreateEdge: (type: EdgeType, content?: EdgeContent) => void
  nodeContextMenu: { nodeId: string; x: number; y: number } | null
  nodes: GraphNode[]
  onNodeStatusChange: (nodeId: string, status: NodeStatus) => void
  onNodeDelete: (nodeId: string) => void
  onCloseNodeContextMenu: () => void
  onAddChild: (parentId: string, childType: NodeType) => void
  onStartConnect: (sourceId: string) => void
  onEnrichNode?: (nodeId: string) => void
  onStartDev?: (nodeId: string) => void
  onAddContext?: (nodeId: string) => void
  onGenerateChildren?: (nodeId: string) => void
}

export function CanvasOverlay({
  isEmpty,
  showNodeMenu,
  menuPosition,
  onCreateNode,
  showEdgeTypeMenu,
  edgeMenuPosition,
  pendingConnection,
  onCreateEdge,
  nodeContextMenu,
  nodes,
  onNodeStatusChange,
  onNodeDelete,
  onCloseNodeContextMenu,
  onAddChild,
  onStartConnect,
  onEnrichNode,
  onStartDev,
  onAddContext,
  onGenerateChildren,
}: CanvasOverlayProps) {
  const [selectedEdgeType, setSelectedEdgeType] = useState<EdgeType | null>(null)
  const [edgeCondition, setEdgeCondition] = useState('')
  const [edgeNote, setEdgeNote] = useState('')

  const canvasNodeTypes: NodeType[] = hasProjectNode
    ? ['module', 'process', 'feature', 'bug']
    : ['project', 'module', 'process', 'feature', 'bug']

  return (
    <>
      {/* 空白画布引导 */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center space-y-4 opacity-60">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-muted flex items-center justify-center">
              <MapIcon className="w-8 h-8 text-muted-foreground" />
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
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1">添加节点</div>
          {canvasNodeTypes.map((type) => (
            <button
              key={type}
              onClick={() => onCreateNode(type)}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: NODE_TYPE_COLORS[type] }} />
              {NODE_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      )}

      {/* 边类型选择菜单 */}
      {showEdgeTypeMenu && pendingConnection && (
        <div
          className="absolute z-50 bg-background border rounded-lg shadow-lg py-2 w-56"
          style={{ left: edgeMenuPosition.x, top: edgeMenuPosition.y }}
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            选择连接类型
          </div>
          {EDGE_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => {
                if (opt.type === 'business-flow') {
                  setSelectedEdgeType('business-flow')
                } else {
                  onCreateEdge(opt.type)
                  setSelectedEdgeType(null)
                  setEdgeCondition('')
                  setEdgeNote('')
                }
              }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <div
                className="w-3 h-3 rounded-full flex-shrink-0 border"
                style={{ backgroundColor: opt.color, borderColor: opt.color }}
              />
              <div className="flex flex-col">
                <span>{opt.label}</span>
                <span className="text-[10px] text-muted-foreground">{opt.description}</span>
              </div>
            </button>
          ))}
          {selectedEdgeType === 'business-flow' && (
            <div className="px-3 pt-2 pb-1 border-t mt-1 space-y-2">
              <div>
                <label className="text-[10px] text-muted-foreground">判断条件</label>
                <input
                  type="text"
                  value={edgeCondition}
                  onChange={(e) => setEdgeCondition(e.target.value)}
                  placeholder="如：退款申请通过"
                  className="w-full mt-0.5 px-2 py-1 text-xs border rounded bg-background"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">备注说明</label>
                <textarea
                  value={edgeNote}
                  onChange={(e) => setEdgeNote(e.target.value)}
                  placeholder="如：需同步回滚库存"
                  rows={2}
                  className="w-full mt-0.5 px-2 py-1 text-xs border rounded bg-background resize-none"
                />
              </div>
              <button
                onClick={() => {
                  const content: EdgeContent = {
                    ...(edgeCondition.trim() && { condition: edgeCondition.trim() }),
                    ...(edgeNote.trim() && { note: edgeNote.trim() }),
                  }
                  onCreateEdge('business-flow', Object.keys(content).length > 0 ? content : undefined)
                  setSelectedEdgeType(null)
                  setEdgeCondition('')
                  setEdgeNote('')
                }}
                className="w-full py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
              >
                确认创建
              </button>
            </div>
          )}
        </div>
      )}

      {/* 节点右键菜单 */}
      {nodeContextMenu && (
        <NodeContextMenu
          nodeId={nodeContextMenu.nodeId}
          x={nodeContextMenu.x}
          y={nodeContextMenu.y}
          nodes={nodes}
          onStatusChange={onNodeStatusChange}
          onDelete={onNodeDelete}
          onClose={onCloseNodeContextMenu}
          onAddChild={onAddChild}
          onStartConnect={onStartConnect}
          onEnrichNode={onEnrichNode}
          onStartDev={onStartDev}
          onAddContext={onAddContext}
          onGenerateChildren={onGenerateChildren}
        />
      )}
    </>
  )
}
