import { X, FileText, Circle, Plus, Folder, AlignLeft } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ContextRef } from '@shared/types'

type ContextKind = 'node' | 'file' | 'project' | 'snippet' | 'text'

function getContextKind(ctx: ContextRef): ContextKind {
  if (ctx.type === 'node') return 'node'
  if (ctx.type === 'file') return 'file'
  if (ctx.kind === 'project') return 'project'
  if (ctx.kind === 'snippet') return 'snippet'
  return 'text'
}

const CONTEXT_STYLES: Record<ContextKind, { icon: React.ReactNode; className: string; iconClass: string }> = {
  node: {
    icon: <Circle className="w-2.5 h-2.5" />,
    className: 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/15',
    iconClass: 'text-blue-400',
  },
  file: {
    icon: <FileText className="w-2.5 h-2.5" />,
    className: 'bg-green-500/10 text-green-400 hover:bg-green-500/15',
    iconClass: 'text-green-400',
  },
  project: {
    icon: <Folder className="w-2.5 h-2.5" />,
    className: 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/15',
    iconClass: 'text-amber-400',
  },
  snippet: {
    icon: <AlignLeft className="w-2.5 h-2.5" />,
    className: 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/15',
    iconClass: 'text-purple-400',
  },
  text: {
    icon: <AlignLeft className="w-2.5 h-2.5" />,
    className: 'bg-muted text-muted-foreground hover:bg-muted/80',
    iconClass: 'text-muted-foreground',
  },
}

interface ContextBarProps {
  contexts: ContextRef[]
  onRemove: (id: string) => void
  onAdd: () => void
}

export function ContextBar({ contexts, onRemove, onAdd }: ContextBarProps) {
  const totalTokens =
    contexts.length > 0 && contexts.every((c) => typeof c.tokenEstimate === 'number')
      ? contexts.reduce((sum, c) => sum + (c.tokenEstimate ?? 0), 0)
      : undefined

  if (contexts.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-[10px] text-muted-foreground">附加上下文以聚焦 Agent 关注范围</span>
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
      <span className="text-[10px] text-muted-foreground mr-1 shrink-0">Context:</span>
      {contexts.map((ctx) => {
        const kind = getContextKind(ctx)
        const style = CONTEXT_STYLES[kind]
        return (
          <span
            key={ctx.id}
            className={cn(
              'inline-flex items-center gap-1 text-[10px] pl-1.5 pr-1 h-5 rounded-full transition-colors shrink-0 max-w-[140px]',
              style.className,
            )}
            title={ctx.label}
          >
            <span className={cn('shrink-0', style.iconClass)}>{style.icon}</span>
            <span className="truncate">{ctx.label}</span>
            {typeof ctx.tokenEstimate === 'number' && (
              <span className="opacity-70 shrink-0">~{ctx.tokenEstimate}</span>
            )}
            <button
              onClick={() => onRemove(ctx.id)}
              className="shrink-0 hover:text-foreground transition-colors p-0.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        )
      })}
      <button
        onClick={onAdd}
        className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors border border-dashed border-border rounded-full px-2 py-0.5 shrink-0"
      >
        <Plus className="w-2.5 h-2.5" /> @
      </button>
      {totalTokens !== undefined && (
        <span className="ml-auto text-[10px] text-muted-foreground shrink-0">~{totalTokens} tokens</span>
      )}
    </div>
  )
}
