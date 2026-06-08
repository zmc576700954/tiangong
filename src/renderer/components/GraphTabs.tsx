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
  const [newGraphType, setNewGraphType] = useState<'online' | 'dev'>('online')
  const [deriveFromGraphId, setDeriveFromGraphId] = useState<string | null>(null)

  const onlineGraphs = graphs.filter(g => g.type === 'online')

  const handleCreate = async () => {
    if (!newGraphName.trim()) return
    const sourceId = newGraphType === 'dev' && deriveFromGraphId ? deriveFromGraphId : undefined
    await createGraph(newGraphName.trim(), newGraphType, sourceId)
    setNewGraphName('')
    setDeriveFromGraphId(null)
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
          {graph.type === 'online' ? (
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
        data-testid="new-graph-btn"
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
            data-testid="graph-name-input"
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
              onClick={() => setNewGraphType('online')}
              className={cn(
                'flex-1 px-3 py-2 text-sm rounded-md border transition-colors',
                newGraphType === 'online'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'hover:bg-muted',
              )}
            >
              Online
            </button>
            <button
              onClick={() => setNewGraphType('dev')}
              className={cn(
                'flex-1 px-3 py-2 text-sm rounded-md border transition-colors',
                newGraphType === 'dev'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'hover:bg-muted',
              )}
            >
              Dev
            </button>
          </div>
          {newGraphType === 'dev' && onlineGraphs.length > 0 && (
            <div className="mb-3">
              <label className="text-xs text-muted-foreground mb-1 block">从在线图派生</label>
              <select
                value={deriveFromGraphId ?? ''}
                onChange={(e) => setDeriveFromGraphId(e.target.value || null)}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background"
              >
                <option value="">空白图</option>
                {onlineGraphs.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNewDialog(false)}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              取消
            </button>
            <button
              data-testid="create-graph-btn"
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