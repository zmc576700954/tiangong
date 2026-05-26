import { useState } from 'react'
import { Plus, X, GitBranch, Map } from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { cn } from '../lib/utils'
import type { Graph } from '@shared/types'

interface GraphTabsProps {
  graphs: Graph[]
  currentGraphId: string | null
}

export function GraphTabs({ graphs, currentGraphId }: GraphTabsProps) {
  const { setCurrentGraph, createGraph, deleteGraph } = useGraphStore()
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newGraphName, setNewGraphName] = useState('')
  const [newGraphType, setNewGraphType] = useState<'production' | 'development'>('production')

  const handleCreate = async () => {
    if (!newGraphName.trim()) return
    await createGraph(newGraphName.trim(), newGraphType)
    setNewGraphName('')
    setShowNewDialog(false)
  }

  return (
    <div className="h-10 border-b flex items-center bg-muted/30 px-2 gap-1 flex-shrink-0">
      {graphs.map((graph) => (
        <div
          key={graph.id}
          onClick={() => setCurrentGraph(graph.id)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors group',
            currentGraphId === graph.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/50',
          )}
        >
          {graph.type === 'production' ? (
            <Map className="w-3.5 h-3.5" />
          ) : (
            <GitBranch className="w-3.5 h-3.5" />
          )}
          <span className="max-w-[120px] truncate">{graph.name}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              deleteGraph(graph.id)
            }}
            className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      {/* 新建图按钮 */}
      <button
        onClick={() => setShowNewDialog(true)}
        className="flex items-center gap-1 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {/* 新建图对话框 */}
      {showNewDialog && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-background border rounded-lg shadow-lg p-4 z-50 w-80">
          <h3 className="font-medium mb-3">新建图</h3>
          <input
            type="text"
            placeholder="图名称"
            value={newGraphName}
            onChange={(e) => setNewGraphName(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm mb-3 bg-background"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setNewGraphType('production')}
              className={cn(
                'flex-1 px-3 py-2 text-sm rounded-md border transition-colors',
                newGraphType === 'production'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'hover:bg-muted',
              )}
            >
              真实图
            </button>
            <button
              onClick={() => setNewGraphType('development')}
              className={cn(
                'flex-1 px-3 py-2 text-sm rounded-md border transition-colors',
                newGraphType === 'development'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'hover:bg-muted',
              )}
            >
              开发图
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNewDialog(false)}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              创建
            </button>
          </div>
        </div>
      )}
    </div>
  )
}