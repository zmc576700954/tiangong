import { X, FileText, Circle, Plus } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ContextRef } from '@shared/types'

interface ContextBarProps {
  contexts: ContextRef[]
  onRemove: (id: string) => void
  onAdd: () => void
}

export function ContextBar({ contexts, onRemove, onAdd }: ContextBarProps) {
  if (contexts.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-[10px] text-muted-foreground">No context attached</span>
        <button
          onClick={onAdd}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors border border-dashed border-border rounded-full px-2 py-0.5"
        >
          <Plus className="w-2.5 h-2.5" /> @
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border flex-wrap">
      <span className="text-[10px] text-muted-foreground mr-1">Context:</span>
      {contexts.map((ctx) => (
        <span
          key={ctx.id}
          className={cn(
            'inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full',
            ctx.type === 'node'
              ? 'bg-blue-500/10 text-blue-400'
              : 'bg-green-500/10 text-green-400',
          )}
        >
          {ctx.type === 'node' ? (
            <Circle className="w-2 h-2" />
          ) : (
            <FileText className="w-2 h-2" />
          )}
          <span className="max-w-[100px] truncate">{ctx.label}</span>
          <button
            onClick={() => onRemove(ctx.id)}
            className="hover:text-foreground transition-colors"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <button
        onClick={onAdd}
        className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors border border-dashed border-border rounded-full px-2 py-0.5"
      >
        <Plus className="w-2.5 h-2.5" /> @
      </button>
    </div>
  )
}
