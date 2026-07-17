import { useState, useMemo } from 'react'
import { Search, Plus, PanelLeftClose, PanelLeft, Pencil, Trash2, Check } from 'lucide-react'
import { cn, formatDate } from '../../lib/utils'
import type { AgentThread } from '@shared/types'

interface ThreadListSidebarProps {
  threads: AgentThread[]
  currentThreadId: string | null
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelect: (id: string) => void
  onNewThread: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

function getLastUpdatedAt(thread: AgentThread): number {
  const lastMessage = thread.messages[thread.messages.length - 1]
  return lastMessage?.timestamp ?? thread.createdAt
}

export function ThreadListSidebar({
  threads,
  currentThreadId,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onNewThread,
  onDelete,
  onRename,
}: ThreadListSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const sorted = [...threads].sort((a, b) => getLastUpdatedAt(b) - getLastUpdatedAt(a))
    if (!query) return sorted
    return sorted.filter(
      (t) =>
        t.title.toLowerCase().includes(query) ||
        t.adapterName.toLowerCase().includes(query),
    )
  }, [threads, searchQuery])

  const handleStartRename = (thread: AgentThread) => {
    setEditingId(thread.id)
    setEditValue(thread.title)
  }

  const handleSaveRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this thread?')) {
      onDelete(id)
    }
  }

  return (
    <div
      className={cn(
        'shrink-0 border-r border-border bg-muted/30 flex flex-col transition-all duration-200',
        collapsed ? 'w-12' : 'w-56',
      )}
    >
      <div className="flex items-center justify-between px-2 py-2 border-b border-border h-9">
        {!collapsed && <span className="text-xs font-semibold text-foreground">Threads</span>}
        <button
          onClick={onToggleCollapsed}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeft className="w-3.5 h-3.5" />
          ) : (
            <PanelLeftClose className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="px-2 py-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search threads..."
              className="w-full pl-7 pr-2 py-1 text-xs bg-background border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {filteredThreads.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-xs px-2">
            {searchQuery ? 'No matching threads' : 'No threads yet'}
          </div>
        ) : (
          <div className={cn('space-y-1', collapsed ? 'p-1.5' : 'p-2')}>
            {filteredThreads.map((thread) => {
              const isSelected = currentThreadId === thread.id
              const initial = thread.title.charAt(0).toUpperCase() || '?'
              const updatedAt = getLastUpdatedAt(thread)

              if (collapsed) {
                return (
                  <button
                    key={thread.id}
                    onClick={() => onSelect(thread.id)}
                    title={`${thread.title} · ${thread.adapterName}`}
                    className={cn(
                      'w-full flex items-center justify-center h-8 rounded-md transition-colors border',
                      isSelected
                        ? 'bg-primary/10 border-primary/20'
                        : 'hover:bg-muted/50 border-transparent',
                    )}
                  >
                    <span className="text-xs font-medium">{initial}</span>
                  </button>
                )
              }

              return (
                <div
                  key={thread.id}
                  className={cn(
                    'flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors group border',
                    isSelected
                      ? 'bg-primary/10 border-primary/20'
                      : 'hover:bg-muted/50 border-transparent',
                  )}
                  onClick={() => onSelect(thread.id)}
                >
                  <div className="shrink-0 w-6 h-6 rounded bg-muted flex items-center justify-center">
                    <span className="text-[10px] font-medium">{initial}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    {editingId === thread.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="flex-1 px-1.5 py-0.5 text-xs bg-background border rounded"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSaveRename()
                          }}
                          className="p-0.5 rounded hover:bg-green-100 text-green-600"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="text-xs font-medium truncate">{thread.title}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground">
                            {thread.adapterName}
                          </span>
                          <span className="text-[10px] text-muted-foreground/50">
                            {formatDate(new Date(updatedAt))}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  {editingId !== thread.id && (
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleStartRename(thread)
                        }}
                        className="p-1 rounded hover:bg-muted text-muted-foreground"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDelete(thread.id)
                        }}
                        className="p-1 rounded hover:bg-destructive/10 text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className={cn('border-t border-border', collapsed ? 'p-1.5' : 'p-2')}>
        <button
          onClick={onNewThread}
          className={cn(
            'flex items-center justify-center gap-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors text-foreground w-full',
            collapsed ? 'h-8' : 'px-2 py-1.5',
          )}
          title="New Thread"
        >
          <Plus className="w-3.5 h-3.5" />
          {!collapsed && 'New Thread'}
        </button>
      </div>
    </div>
  )
}
