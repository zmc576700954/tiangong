import { useState, useEffect, useCallback, useRef } from 'react'
import { Circle, FileText, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useGraphStore } from '../../store/graphStore'
import type { ContextRef } from '@shared/types'

interface ContextPickerPopupProps {
  onSelect: (ref: ContextRef) => void
  onClose: () => void
  excludeIds: string[]
}

export function ContextPickerPopup({ onSelect, onClose, excludeIds }: ContextPickerPopupProps) {
  const [filter, setFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const nodes = useGraphStore((s) => s.nodes)
  const inputRef = useRef<HTMLInputElement>(null)

  const results: ContextRef[] = nodes
    .filter((n) => n.title.toLowerCase().includes(filter.toLowerCase()))
    .filter((n) => !excludeIds.includes(n.id))
    .slice(0, 10)
    .map((n) => ({
      type: 'node' as const,
      id: n.id,
      label: n.title,
    }))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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

  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-50">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-muted/30">
        <Search className="w-3 h-3 text-muted-foreground" />
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search nodes..."
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      {results.length === 0 ? (
        <div className="p-3">
          <p className="text-xs text-muted-foreground text-center">
            {filter ? `No results for "${filter}"` : 'No available nodes'}
          </p>
        </div>
      ) : (
        <div className="max-h-[200px] overflow-y-auto">
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
      )}
    </div>
  )
}
