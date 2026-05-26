import { MousePointerClick, ArrowRight, Map as MapIcon, GitBranch } from 'lucide-react'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS, EDGE_TYPE_OPTIONS } from '@shared/constants'
import type { Connection } from '@xyflow/react'
import type { GraphNode, NodeType, EdgeType, NodeStatus } from '@shared/types'
import { NodeContextMenu } from '../NodeContextMenu'

interface CanvasOverlayProps {
  isEmpty: boolean
  showNodeMenu: boolean
  menuPosition: { x: number; y: number }
  onCreateNode: (type: NodeType) => void
  showEdgeTypeMenu: boolean
  edgeMenuPosition: { x: number; y: number }
  pendingConnection: Connection | null
  onCreateEdge: (type: EdgeType) => void
  nodeContextMenu: { nodeId: string; x: number; y: number } | null
  nodes: GraphNode[]
  onNodeStatusChange: (nodeId: string, status: NodeStatus) => void
  onNodeDelete: (nodeId: string) => void
  onCloseNodeContextMenu: () => void
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
}: CanvasOverlayProps) {
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
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1">Add node</div>
          {(['module', 'process', 'feature', 'bug'] satisfies NodeType[]).map((type) => (
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
          className="absolute z-50 bg-background border rounded-lg shadow-lg py-2 w-48"
          style={{ left: edgeMenuPosition.x, top: edgeMenuPosition.y }}
        >
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            选择连接类型
          </div>
          {EDGE_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              onClick={() => onCreateEdge(opt.type)}
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
          nodes={nodes}
          onStatusChange={onNodeStatusChange}
          onDelete={onNodeDelete}
          onClose={onCloseNodeContextMenu}
        />
      )}
    </>
  )
}
