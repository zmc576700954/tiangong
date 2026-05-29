import { useState, useEffect, useCallback, useRef } from 'react'
import { Circle, FileText, Folder } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useGraphStore } from '../../store/graphStore'
import type { ContextRef, FileSearchResult } from '@shared/types'

interface MentionSearchPopupProps {
  filter: string
  onSelect: (ref: ContextRef) => void
  onClose: () => void
  excludeIds: string[]
  projectPath?: string
}

type Tab = 'nodes' | 'files'

export function MentionSearchPopup({ filter, onSelect, onClose, excludeIds, projectPath }: MentionSearchPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [tab, setTab] = useState<Tab>('nodes')
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // --- Node results (existing logic) ---
  const nodes = useGraphStore((s) => s.nodes)
  const nodeResults: ContextRef[] = nodes
    .filter((n) => n.title.toLowerCase().includes(filter.toLowerCase()))
    .filter((n) => !excludeIds.includes(n.id))
    .slice(0, 8)
    .map((n) => ({ type: 'node', id: n.id, label: n.title }))

  // --- File results (new: debounced IPC call) ---
  useEffect(() => {
    if (tab !== 'files' || !projectPath || !filter) {
      setFileResults([])
      return
    }

    setFileLoading(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI['fs:searchFiles'](projectPath, filter, 12)
        setFileResults(results.filter((r) => !r.isDirectory && !excludeIds.includes(r.path)))
      } catch {
        setFileResults([])
      } finally {
        setFileLoading(false)
      }
    }, 300)

    return () => clearTimeout(debounceRef.current)
  }, [tab, projectPath, filter, excludeIds])

  // --- Combined results ---
  const results: ContextRef[] = tab === 'nodes'
    ? nodeResults
    : fileResults.map((f) => ({
        type: 'file' as const,
        id: f.path,
        label: f.relativePath,
      }))

  useEffect(() => {
    setSelectedIndex(0)
  }, [tab, filter])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (results[selectedIndex]) onSelect(results[selectedIndex])
      } else if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        setTab((t) => (t === 'nodes' ? 'files' : 'nodes'))
      }
    },
    [results, selectedIndex, onSelect, onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const showEmpty = results.length === 0 && (tab === 'nodes' || !fileLoading)

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-50">
      {/* Tab bar */}
      <div className="flex border-b border-border">
        <button
          onMouseDown={(e) => { e.preventDefault(); setTab('nodes') }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] transition-colors',
            tab === 'nodes'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Circle className="w-3 h-3" />
          Nodes
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); setTab('files') }}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] transition-colors',
            tab === 'files'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Folder className="w-3 h-3" />
          Files
        </button>
      </div>

      {/* Results */}
      <div className="max-h-[180px] overflow-y-auto">
        {showEmpty ? (
          <div className="px-3 py-3 text-center">
            <p className="text-[10px] text-muted-foreground">
              {filter ? `No ${tab} found for "${filter}"` : `Type to search ${tab}`}
            </p>
          </div>
        ) : fileLoading && tab === 'files' ? (
          <div className="px-3 py-3 text-center">
            <p className="text-[10px] text-muted-foreground animate-pulse">Searching...</p>
          </div>
        ) : (
          results.map((item, i) => (
            <button
              key={item.id}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item)
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors',
                i === selectedIndex ? 'bg-muted' : 'hover:bg-muted/50',
              )}
            >
              {item.type === 'node' ? (
                <Circle className="w-3 h-3 text-blue-400 flex-shrink-0" />
              ) : (
                <FileText className="w-3 h-3 text-green-400 flex-shrink-0" />
              )}
              <span className="text-xs truncate">{item.label}</span>
              <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                {item.type}
              </span>
            </button>
          ))
        )}
      </div>

      {/* Hint */}
      <div className="flex items-center justify-between px-2.5 py-1 border-t border-border bg-muted/30">
        <span className="text-[9px] text-muted-foreground/60">
          Tab switch · ↑↓ navigate · Enter select · Esc close
        </span>
      </div>
    </div>
  )
}
