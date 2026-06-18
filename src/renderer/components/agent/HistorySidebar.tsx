import { useState, useEffect, useCallback } from 'react'
import { X, Search, MessageSquare } from 'lucide-react'
import { cn, formatDate } from '../../lib/utils'
import { useAgentStore } from '../../store/agentStore'
import { useAppStore } from '../../store/appStore'
import type { AgentThread } from '@shared/types'

interface HistorySidebarProps {
  visible: boolean
  onClose: () => void
}

export function HistorySidebar({ visible, onClose }: HistorySidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [threads, setThreads] = useState<AgentThread[]>([])
  const [loading, setLoading] = useState(false)
  const selectThread = useAgentStore((s) => s.selectThread)
  const loadMessages = useAgentStore((s) => s.loadMessages)
  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)

  const loadThreads = useCallback(async () => {
    setLoading(true)
    try {
      if (searchQuery.trim()) {
        const results = await window.electronAPI['thread:search'](searchQuery)
        setThreads(results)
      } else {
        const results = await window.electronAPI['thread:list']()
        setThreads(results)
      }
    } catch (err) {
      console.error('[HistorySidebar] Failed to load threads:', err)
    } finally {
      setLoading(false)
    }
  }, [searchQuery])

  useEffect(() => {
    if (visible) loadThreads()
  }, [visible, loadThreads])

  const handleSelect = async (thread: AgentThread) => {
    await loadMessages(thread.id)
    selectThread(thread.id)
    setActiveRightPanel('agent')
    onClose()
  }

  if (!visible) return null

  return (
    <div className="fixed left-0 top-0 bottom-0 w-80 bg-background border-r border-border z-50 flex flex-col shadow-xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="text-xs font-semibold text-foreground">History</h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
          <X className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="px-2 py-1.5 border-b border-border">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-muted rounded">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search threads..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') loadThreads() }}
            className="flex-1 bg-transparent text-xs outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="text-center py-12 text-muted-foreground text-xs">Loading...</div>
        ) : threads.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-xs">No threads found</div>
        ) : (
          <div className="p-2 space-y-1">
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => handleSelect(t)}
                className={cn(
                  'w-full text-left px-2.5 py-2 rounded-md transition-colors hover:bg-muted/50 border border-transparent',
                )}
              >
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{t.title}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">{t.adapterName}</span>
                      {t.nodeBound && <span className="text-[10px] text-muted-foreground/50">node</span>}
                      <span className="text-[10px] text-muted-foreground/50">
                        {formatDate(new Date(t.createdAt))}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
