import { useRef, useEffect } from 'react'
import { cn } from '../lib/utils'
import type { GraphNode, NodeStatus } from '@shared/types'
import { Pencil, Trash2 } from 'lucide-react'

interface NodeContextMenuProps {
  nodeId: string
  x: number
  y: number
  nodes: GraphNode[]
  onStatusChange: (nodeId: string, status: NodeStatus) => void
  onDelete: (nodeId: string) => void
  onClose: () => void
}

const statusOptions: { value: NodeStatus; label: string; color: string }[] = [
  { value: 'draft', label: '草稿', color: '#94a3b8' },
  { value: 'confirmed', label: '已确认', color: '#3b82f6' },
  { value: 'developing', label: '开发中', color: '#f59e0b' },
  { value: 'testing', label: '待测试', color: '#8b5cf6' },
  { value: 'review', label: '待验收', color: '#06b6d4' },
  { value: 'published', label: '已发布', color: '#22c55e' },
]

export function NodeContextMenu({
  nodeId,
  x,
  y,
  nodes,
  onStatusChange,
  onDelete,
  onClose,
}: NodeContextMenuProps) {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return null

  // 使用 ref 避免每次渲染重新绑定事件监听器
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const handleClick = () => onCloseRef.current()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [])

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
