import { useState } from 'react'
import {
  Trash2,
  X,
  ArrowRight,
  GitBranch,
} from 'lucide-react'
import { cn } from '../lib/utils'
import type { GraphEdge, GraphNode, FileAssociation } from '@shared/types'

// ==================== Edge Editor ====================

export function EdgeEditor({
  edge,
  nodes,
  onUpdate,
  onDelete,
}: {
  edge: GraphEdge
  nodes: GraphNode[]
  onUpdate: (data: Partial<GraphEdge>) => void
  onDelete: () => void
}) {
  const sourceNode = nodes.find((n) => n.id === edge.source)
  const targetNode = nodes.find((n) => n.id === edge.target)

  const edgeTypeOptions = [
    { value: 'default' as const, label: '默认流程', color: '#94a3b8' },
    { value: 'success' as const, label: '成功分支', color: '#22c55e' },
    { value: 'failure' as const, label: '失败分支', color: '#ef4444' },
    { value: 'condition' as const, label: '条件分支', color: '#f59e0b' },
    { value: 'business-flow' as const, label: '业务流程', color: '#3b82f6' },
  ]

  return (
    <div className="p-3 space-y-4">
      {/* Edge header */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">连接线</span>
        </div>
        <h3 className="text-base font-semibold">流程连接</h3>
      </div>

      {/* Source → Target */}
      <div className="space-y-2 p-2 bg-muted/30 rounded-md">
        <div className="flex items-center gap-2 text-sm">
          <div className="flex-1 truncate">
            <span className="text-xs text-muted-foreground">From</span>
            <div className="font-medium truncate">{sourceNode?.title || 'Unknown'}</div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
          <div className="flex-1 truncate">
            <span className="text-xs text-muted-foreground">To</span>
            <div className="font-medium truncate">{targetNode?.title || 'Unknown'}</div>
          </div>
        </div>
      </div>

      {/* Edge type selector */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">连接类型</label>
        <div className="grid grid-cols-2 gap-1.5">
          {edgeTypeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onUpdate({ edgeType: opt.value })}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors',
                edge.edgeType === opt.value
                  ? 'border-transparent text-white'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              style={
                edge.edgeType === opt.value
                  ? { backgroundColor: opt.color }
                  : undefined
              }
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor: edge.edgeType === opt.value ? 'white' : opt.color,
                }}
              />
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Label */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">条件标签</label>
        <input
          type="text"
          value={edge.label || ''}
          onChange={(e) => onUpdate({ label: e.target.value || undefined })}
          placeholder="例如：金额 > 1000"
          className="w-full px-2 py-1.5 text-sm border rounded-md bg-background"
        />
        <p className="text-[10px] text-muted-foreground">
          用于描述流程分支的触发条件
        </p>
      </div>

      {/* Edge Content (business logic) */}
      {(edge.edgeType === 'business-flow' || edge.content) && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">业务逻辑</label>
          <div className="space-y-1.5">
            <div>
              <label className="text-[10px] text-muted-foreground">判断条件</label>
              <input
                type="text"
                value={edge.content?.condition || ''}
                onChange={(e) => {
                  const condition = e.target.value || undefined
                  onUpdate({
                    label: condition,
                    content: { ...edge.content, condition },
                  })
                }}
                placeholder="如：库存 > 0"
                className="w-full mt-0.5 px-2 py-1.5 text-sm border rounded-md bg-background"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground">备注说明</label>
              <textarea
                value={edge.content?.note || ''}
                onChange={(e) =>
                  onUpdate({
                    content: { ...edge.content, note: e.target.value || undefined },
                  })
                }
                placeholder="如：退款时需同步回滚库存"
                rows={3}
                className="w-full mt-0.5 px-2 py-1.5 text-sm border rounded-md bg-background resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* Delete */}
      <div className="pt-2 border-t">
        <button
          onClick={onDelete}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-destructive border border-destructive/30 rounded-md hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete connection
        </button>
      </div>
    </div>
  )
}

// ==================== File Associations Editor ====================

export function FileAssociationsEditor({
  associations,
  onUpdate,
}: {
  associations: FileAssociation[]
  onUpdate: (v: FileAssociation[]) => void
}) {
  const [isAdding, setIsAdding] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newType, setNewType] = useState<'file' | 'directory' | 'method'>('file')
  const [newMethod, setNewMethod] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const handleAdd = () => {
    if (!newPath.trim()) return
    const assoc: FileAssociation = {
      path: newPath.trim(),
      type: newType,
      ...(newType === 'method' && newMethod.trim() && { methodName: newMethod.trim() }),
      ...(newDesc.trim() && { description: newDesc.trim() }),
    }
    onUpdate([...associations, assoc])
    setNewPath('')
    setNewMethod('')
    setNewDesc('')
    setIsAdding(false)
  }

  const handleRemove = (index: number) => {
    onUpdate(associations.filter((_, i) => i !== index))
  }

  const typeIcons: Record<string, string> = {
    file: '📄',
    directory: '📁',
    method: '⚡',
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">关联文件</label>
      {associations.length > 0 && (
        <div className="space-y-1">
          {associations.map((assoc, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2 py-1 text-sm bg-muted/50 rounded group">
              <span className="text-xs">{typeIcons[assoc.type]}</span>
              <span className="truncate flex-1 font-mono text-xs">
                {assoc.path}
                {assoc.methodName && <span className="text-muted-foreground"> :: {assoc.methodName}</span>}
              </span>
              <button
                onClick={() => handleRemove(i)}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 text-destructive transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {isAdding ? (
        <div className="space-y-1.5 p-2 border rounded-md">
          <div className="flex gap-1">
            {(['file', 'directory', 'method'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setNewType(t)}
                className={cn(
                  'px-2 py-0.5 text-[10px] rounded border transition-colors',
                  newType === t
                    ? 'bg-primary text-primary-foreground border-transparent'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'file' ? '文件' : t === 'directory' ? '目录' : '方法'}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="相对路径，如 src/order/service.ts"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
            autoFocus
          />
          {newType === 'method' && (
            <input
              type="text"
              value={newMethod}
              onChange={(e) => setNewMethod(e.target.value)}
              placeholder="方法名，如 refund"
              className="w-full px-2 py-1 text-xs border rounded bg-background"
            />
          )}
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="简要说明（可选）"
            className="w-full px-2 py-1 text-xs border rounded bg-background"
          />
          <div className="flex gap-1">
            <button onClick={handleAdd} className="flex-1 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90">
              添加
            </button>
            <button onClick={() => setIsAdding(false)} className="flex-1 py-1 text-xs border rounded hover:bg-muted">
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="w-full py-1.5 text-xs border border-dashed rounded text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          + 添加关联
        </button>
      )}
    </div>
  )
}
