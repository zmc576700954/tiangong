import { useState, useEffect, useCallback } from 'react'
import { Circle, FileText } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useGraphStore } from '../../store/graphStore'
import type { ContextRef } from '@shared/types'

interface MentionSearchPopupProps {
  filter: string
  onSelect: (ref: ContextRef) => void
  onClose: () => void
  excludeIds: string[]
}

export function MentionSearchPopup({ filter, onSelect, onClose, excludeIds }: MentionSearchPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const nodes = useGraphStore((s) => s.nodes)

  const nodeResults = nodes
    .filter((n) => n.title.toLowerCase().includes(filter.toLowerCase()))
    .filter((n) => !excludeIds.includes(n.id))
    .slice(0, 5)
    .map((n) => ({
      type: 'node' as const,
      id: n.id,
      label: n.title,
    }))

  const results: ContextRef[] = nodeResults

  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

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
      }
    },
    [results, selectedIndex, onSelect, onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (results.length === 0 && filter.length > 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 bg-background border border-border rounded-lg shadow-lg p-3 z-50">
        <p className="text-xs text-muted-foreground text-center">No results for &quot;{filter}&quot;</p>
      </div>
    )
  }

  if (results.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-50">
      <div className="px-2.5 py-1.5 text-[9px] text-muted-foreground uppercase tracking-wider bg-muted/30">
        Add Context
      </div>
      {results.map((item, i) => (
        <button
          key={item.id}
          onClick={() => onSelect(item)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors',
            i === selectedIndex ? 'bg-muted' : 'hover:bg-muted/50',
          )}
        >
          {item.type === 'node' ? (
            <Circle className="w-3 h-3 text-blue-400" />
          ) : (
            <FileText className="w-3 h-3 text-green-400" />
          )}
          <span className="text-xs truncate">{item.label}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{item.type}</span>
        </button>
      ))}
    </div>
  )
}
