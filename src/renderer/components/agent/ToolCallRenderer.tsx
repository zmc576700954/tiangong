import { useState } from 'react'
import { FileEdit, GitBranch, Terminal, FilePlus, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ToolCallBlock } from '@shared/types'

const TYPE_CONFIG = {
  file_edit: { icon: FileEdit, label: 'file_edit', color: 'text-green-400' },
  diff: { icon: GitBranch, label: 'diff', color: 'text-orange-400' },
  terminal: { icon: Terminal, label: 'terminal', color: 'text-blue-400' },
  file_create: { icon: FilePlus, label: 'file_create', color: 'text-purple-400' },
} as const

export function ToolCallRenderer({
  block,
}: {
  block: ToolCallBlock
}) {
  const [expanded, setExpanded] = useState(true)
  const config = TYPE_CONFIG[block.type]
  const Icon = config.icon

  return (
    <div className="border border-border rounded-md overflow-hidden my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-muted/50 hover:bg-muted transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        )}
        <Icon className={cn('w-3 h-3', config.color)} />
        <span className="text-[10px] text-muted-foreground font-mono">{config.label}</span>
        {block.filePath && (
          <span className="text-[10px] text-blue-400 font-mono ml-auto truncate">
            {block.filePath}
          </span>
        )}
      </button>
      {expanded && (
        <div className="p-2.5 bg-background font-mono text-[11px] leading-relaxed overflow-x-auto max-h-48 overflow-y-auto select-text">
          {block.content.split('\n').map((line, i) => (
            <div key={i} className={getLineClass(line, block.type)}>
              <span className="text-muted-foreground/40 select-none w-6 inline-block text-right mr-2">
                {i + 1}
              </span>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function getLineClass(line: string, type: ToolCallBlock['type']): string {
  if (type !== 'diff') return ''
  if (line.startsWith('+')) return 'text-green-400 bg-green-500/5'
  if (line.startsWith('-')) return 'text-red-400 bg-red-500/5'
  return ''
}
