import { useState } from 'react'
import { X, Trash2, Pencil, Check, MessageSquare } from 'lucide-react'
import { cn, formatDate } from '../../lib/utils'
import type { AgentThread } from '@shared/types'

interface ThreadListOverlayProps {
  threads: AgentThread[]
  currentThreadId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onClose: () => void
}

export function ThreadListOverlay({
  threads,
  currentThreadId,
  onSelect,
  onDelete,
  onRename,
  onClose,
}: ThreadListOverlayProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

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

  const sorted = [...threads].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="absolute inset-0 z-50 bg-background flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-xs font-semibold text-foreground">Threads</h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-xs">
            No threads yet
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {sorted.map((thread) => (
              <div
                key={thread.id}
                className={cn(
                  'flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-colors group',
                  currentThreadId === thread.id
                    ? 'bg-primary/10 border border-primary/20'
                    : 'hover:bg-muted/50 border border-transparent',
                )}
                onClick={() => onSelect(thread.id)}
              >
                <MessageSquare className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
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
                        onClick={(e) => { e.stopPropagation(); handleSaveRename() }}
                        className="p-0.5 rounded hover:bg-green-100 text-green-600"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="text-xs font-medium truncate">{thread.title}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">{thread.adapterName}</span>
                        <span className="text-[10px] text-muted-foreground/50">
                          {formatDate(new Date(thread.createdAt))}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                {editingId !== thread.id && (
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleStartRename(thread) }}
                      className="p-1 rounded hover:bg-muted text-muted-foreground"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDelete(thread.id) }}
                      className="p-1 rounded hover:bg-destructive/10 text-destructive"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
