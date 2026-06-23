import { useRef, useEffect } from 'react'
import { cn } from '../lib/utils'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode, NodeType, NodeStatus } from '@shared/types'
import { Pencil, Trash2, Plus, Link, Sparkles, Play, Paperclip, Wand2, Bot } from 'lucide-react'
import { useMenuPosition } from './hooks/useMenuPosition'

interface NodeContextMenuProps {
  nodeId: string
  x: number
  y: number
  nodes: GraphNode[]
  onStatusChange: (nodeId: string, status: NodeStatus) => void
  onDelete: (nodeId: string) => void
  onClose: () => void
  onAddChild: (parentId: string, childType: NodeType) => void
  onStartConnect: (sourceId: string) => void
  onEnrichNode?: (nodeId: string) => void
  onStartDev?: (nodeId: string) => void
  onAddContext?: (nodeId: string) => void
  onGenerateChildren?: (nodeId: string) => void
  onFanout?: () => void
}

const statusOptions: { value: NodeStatus; label: string; color: string }[] = [
  { value: 'placeholder', label: '占位', color: '#64748b' },
  { value: 'draft', label: '草稿', color: '#94a3b8' },
  { value: 'confirmed', label: '已确认', color: '#3b82f6' },
  { value: 'developing', label: '开发中', color: '#f59e0b' },
  { value: 'testing', label: '待测试', color: '#8b5cf6' },
  { value: 'review', label: '待验收', color: '#06b6d4' },
  { value: 'published', label: '已发布', color: '#22c55e' },
]

/** 根据父节点类型推断适合创建的子节点类型 */
function getChildTypeOptions(parentType: NodeType): NodeType[] {
  switch (parentType) {
    case 'project':
      return ['module']
    case 'module':
      return ['process', 'feature']
    case 'process':
      return ['feature', 'bug']
    case 'feature':
      return ['bug']
    case 'bug':
      return []
    default:
      return ['feature']
  }
}

export function NodeContextMenu({
  nodeId,
  x,
  y,
  nodes,
  onStatusChange,
  onDelete,
  onClose,
  onAddChild,
  onStartConnect,
  onEnrichNode,
  onStartDev,
  onAddContext,
  onGenerateChildren,
  onFanout,
}: NodeContextMenuProps) {
  const node = nodes.find((n) => n.id === nodeId)
  const { ref: menuRef, adjustedPos } = useMenuPosition(x, y)

  // 使用 ref 避免每次渲染重新绑定事件监听器
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const handleClick = () => onCloseRef.current()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [])

  if (!node) return null

  const childTypeOptions = getChildTypeOptions(node.type)

  return (
    <div
      ref={menuRef}
      className="absolute z-50 bg-background border rounded-lg shadow-lg py-1 w-52"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
        <Pencil className="w-3 h-3" />
        <span className="truncate">{node.title}</span>
      </div>

      {/* 添加子节点 */}
      {childTypeOptions.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Plus className="w-2.5 h-2.5" />
            添加子节点
          </div>
          <div className="px-2 pb-1 flex flex-wrap gap-1">
            {childTypeOptions.map((type) => (
              <button
                key={type}
                onClick={() => onAddChild(nodeId, type)}
                className="px-2 py-1 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1"
              >
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: NODE_TYPE_COLORS[type] }} />
                {NODE_TYPE_LABELS[type]}
              </button>
            ))}
            {onGenerateChildren && (node.type === 'module' || node.type === 'process') && (
              <button
                onClick={() => { onGenerateChildren(nodeId); onClose() }}
                className="px-2 py-1 text-[10px] rounded border border-dashed border-primary/40 text-primary hover:bg-primary/10 transition-colors flex items-center gap-1"
              >
                <Wand2 className="w-2.5 h-2.5" />
                AI 生成
              </button>
            )}
          </div>
        </>
      )}

      {/* 添加连接 */}
      <div className="px-2 pb-1">
        <button
          onClick={() => onStartConnect(nodeId)}
          data-testid="node-menu-connect"
          className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
        >
          <Link className="w-3 h-3" />
          添加关联连线
        </button>
      </div>

      {/* 添加上下文 */}
      {onAddContext && (
        <div className="px-2 pb-1">
          <button
            onClick={() => { onAddContext(nodeId); onClose() }}
            className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="w-3 h-3" />
            添加上下文
          </button>
        </div>
      )}

      {/* AI 操作 */}
      <div className="border-t mt-1 pt-1">
        <div className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <Sparkles className="w-2.5 h-2.5" />
          AI 操作
        </div>
        <div className="px-2 pb-1 space-y-0.5">
          {onEnrichNode && (
            <button
              onClick={() => { onEnrichNode(nodeId); onClose() }}
              data-testid="node-menu-enrich"
              className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <Sparkles className="w-3 h-3" />
              AI 补充详情
            </button>
          )}
          {onStartDev && (
            <button
              onClick={() => { onStartDev(nodeId); onClose() }}
              className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <Play className="w-3 h-3" />
              生成开发 Prompt
            </button>
          )}
          {onFanout && (
            <button
              onClick={() => { onFanout(); onClose() }}
              data-testid="node-menu-fanout"
              className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <Bot className="w-3 h-3" />
              Fan-out 子代理 (基于选中节点)
            </button>
          )}
        </div>
      </div>

      {/* 状态切换 */}
      {node.type !== 'project' && (
        <div className="border-t mt-1 pt-1">
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
        </div>
      )}

      {/* 删除节点 */}
      {node.type !== 'project' && (
        <div className="border-t mt-1 pt-1">
          <button
            onClick={() => onDelete(nodeId)}
            data-testid="node-menu-delete"
            className="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            删除节点
          </button>
        </div>
      )}
    </div>
  )
}
