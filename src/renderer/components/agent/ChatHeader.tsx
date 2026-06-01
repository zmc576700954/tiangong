import { useState } from 'react'
import { Plus, List, Maximize2, Minimize2, ChevronDown, Terminal, MessageSquare, Clock } from 'lucide-react'
import { cn } from '../../lib/utils'

interface ChatHeaderProps {
  adapterName: string
  adapters: { name: string; installed: boolean }[]
  threadTitle: string
  viewMode: 'chat' | 'terminal'
  expanded: boolean
  onSelectAdapter: (name: string) => void
  onNewThread: () => void
  onToggleThreads: () => void
  onToggleView: (mode: 'chat' | 'terminal') => void
  onToggleExpand: () => void
  onOpenCli?: () => void
  onOpenHistory?: () => void
}

export function ChatHeader({
  adapterName,
  adapters,
  threadTitle,
  viewMode,
  expanded,
  onSelectAdapter,
  onNewThread,
  onToggleThreads,
  onToggleView,
  onToggleExpand,
  onOpenCli,
  onOpenHistory,
}: ChatHeaderProps) {
  const [showAdapterMenu, setShowAdapterMenu] = useState(false)
  const installedAdapters = adapters.filter((a) => a.installed)

  return (
    <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border bg-muted/30 flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative">
          <button
            onClick={() => setShowAdapterMenu(!showAdapterMenu)}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md hover:bg-muted transition-colors"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="truncate max-w-[80px]">{adapterName || 'Select Agent'}</span>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          </button>
          {showAdapterMenu && (
            <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-50 overflow-hidden min-w-[140px]">
              {installedAdapters.map((a) => (
                <button
                  key={a.name}
                  onClick={() => { onSelectAdapter(a.name); setShowAdapterMenu(false) }}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 text-xs hover:bg-muted transition-colors text-left',
                    adapterName === a.name && 'bg-muted',
                  )}
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground truncate max-w-[120px]">
          {threadTitle}
        </span>
      </div>

      <div className="flex items-center gap-0.5">
        <button
          onClick={onNewThread}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
          title="New Thread"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onToggleThreads}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
          title="Threads"
        >
          <List className="w-3.5 h-3.5" />
        </button>
        {onOpenHistory && (
          <button
            onClick={onOpenHistory}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
            title="History"
          >
            <Clock className="w-3.5 h-3.5" />
          </button>
        )}
        {onOpenCli && (
          <button
            onClick={onOpenCli}
            className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground"
            title="Open in CLI"
          >
            <Terminal className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex bg-muted rounded overflow-hidden ml-1">
          <button
            onClick={() => onToggleView('chat')}
            className={cn(
              'px-1.5 py-0.5 text-[10px] transition-colors',
              viewMode === 'chat' ? 'bg-background text-foreground' : 'text-muted-foreground',
            )}
          >
            <MessageSquare className="w-3 h-3" />
          </button>
          <button
            onClick={() => onToggleView('terminal')}
            className={cn(
              'px-1.5 py-0.5 text-[10px] transition-colors',
              viewMode === 'terminal' ? 'bg-background text-foreground' : 'text-muted-foreground',
            )}
          >
            <Terminal className="w-3 h-3" />
          </button>
        </div>
        <button
          onClick={onToggleExpand}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground ml-1"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}
