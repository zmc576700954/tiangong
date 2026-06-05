import { useState } from 'react'
import { FileEdit, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'
import type { AgentOutput } from '@shared/types'

interface ChangeSummaryBadgeProps {
  outputs: AgentOutput[]
  className?: string
}

export function ChangeSummaryBadge({ outputs, className }: ChangeSummaryBadgeProps) {
  const [expanded, setExpanded] = useState(false)
  const fileChanges = outputs.filter((o) => o.type === 'file_change')
  if (fileChanges.length === 0) return null

  const uniqueFiles = [...new Set(fileChanges.map((o) => o.filePath).filter(Boolean))]

  return (
    <div className={cn('mt-1', className)}>
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
        className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
        <FileEdit className="w-2.5 h-2.5" />
        <span>{uniqueFiles.length} files changed</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-3">
          {uniqueFiles.map((fp) => (
            <div key={fp} className="text-[8px] text-blue-400 font-mono truncate" title={fp!}>
              {fp}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
