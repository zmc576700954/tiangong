import { useState, useMemo } from 'react'
import { Check, X, FileEdit, FilePlus, GitBranch, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ToolCallBlock } from '@shared/types'

interface FileChangeState {
  filePath: string
  toolCallIndex: number
  status: 'pending' | 'accepted' | 'rejected'
  changeType: 'add' | 'modify' | 'delete'
}

interface DiffReviewPanelProps {
  toolCalls: ToolCallBlock[]
  sessionId?: string
  onCommit: () => void
  onAcceptFile: (index: number) => void
  onRejectFile: (index: number, filePath: string) => void
  onAcceptAll: () => void
  onRejectAll: () => void
  committing?: boolean
}

export function DiffReviewPanel({
  toolCalls,
  onCommit,
  onAcceptFile,
  onRejectFile,
  onAcceptAll,
  onRejectAll,
  committing,
}: DiffReviewPanelProps) {
  const [expandedFile, setExpandedFile] = useState<number | null>(null)

  const fileChanges: FileChangeState[] = useMemo(() =>
    toolCalls
      .map((tc, i) => ({
        filePath: tc.filePath ?? 'unknown',
        toolCallIndex: i,
        status: tc.accepted === true ? 'accepted' as const
          : tc.accepted === false ? 'rejected' as const
          : 'pending' as const,
        changeType: tc.type === 'file_create' ? 'add' as const : 'modify' as const,
      }))
      .filter((fc) => fc.filePath !== 'unknown'),
    [toolCalls],
  )

  const allReviewed = fileChanges.every((fc) => fc.status !== 'pending')
  const acceptedCount = fileChanges.filter((fc) => fc.status === 'accepted').length

  const getChangeIcon = (changeType: string) => {
    switch (changeType) {
      case 'add': return <FilePlus className="w-3 h-3 text-purple-400" />
      case 'delete': return <X className="w-3 h-3 text-red-400" />
      default: return <FileEdit className="w-3 h-3 text-green-400" />
    }
  }

  const getStatusIcon = (status: FileChangeState['status']) => {
    switch (status) {
      case 'accepted': return <Check className="w-3 h-3 text-green-400" />
      case 'rejected': return <X className="w-3 h-3 text-red-400" />
      default: return <div className="w-3 h-3 rounded-full border border-muted-foreground/30" />
    }
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border">
        <div className="flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Changes ({fileChanges.length} files)</span>
          <span className="text-[10px] text-muted-foreground">
            {acceptedCount}/{fileChanges.length} accepted
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onAcceptAll}
            className="text-[10px] px-2 py-0.5 rounded bg-green-600/10 text-green-400 hover:bg-green-600/20 transition-colors"
          >
            Accept All
          </button>
          <button
            onClick={onRejectAll}
            className="text-[10px] px-2 py-0.5 rounded bg-red-600/10 text-red-400 hover:bg-red-600/20 transition-colors"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="max-h-60 overflow-y-auto">
        {fileChanges.map((fc, i) => (
          <div key={fc.filePath} className="border-b border-border/50 last:border-0">
            <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 transition-colors">
              <button
                onClick={() => setExpandedFile(expandedFile === i ? null : i)}
                className="shrink-0"
              >
                {expandedFile === i
                  ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
              </button>
              {getChangeIcon(fc.changeType)}
              <span className="flex-1 text-[11px] font-mono truncate">{fc.filePath}</span>
              {getStatusIcon(fc.status)}
              {fc.status === 'pending' && (
                <div className="flex gap-1 ml-1">
                  <button
                    onClick={() => onAcceptFile(fc.toolCallIndex)}
                    className="text-[9px] text-green-400 border border-green-800 rounded px-1.5 py-0.5 hover:bg-green-900/30"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => onRejectFile(fc.toolCallIndex, fc.filePath)}
                    className="text-[9px] text-red-400 border border-red-800 rounded px-1.5 py-0.5 hover:bg-red-900/30"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
            {expandedFile === i && (
              <div className="px-3 py-2 bg-background font-mono text-[10px] leading-relaxed overflow-x-auto max-h-32 overflow-y-auto">
                {toolCalls[fc.toolCallIndex]?.content.split('\n').map((line, li) => (
                  <div
                    key={li}
                    className={cn(
                      line.startsWith('+') && 'text-green-400 bg-green-500/5',
                      line.startsWith('-') && 'text-red-400 bg-red-500/5',
                    )}
                  >
                    <span className="text-muted-foreground/40 select-none w-6 inline-block text-right mr-2">
                      {li + 1}
                    </span>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end px-3 py-2 border-t border-border bg-muted/20">
        <button
          onClick={onCommit}
          disabled={!allReviewed || committing}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
            allReviewed && !committing
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          {committing && <Loader2 className="w-3 h-3 animate-spin" />}
          Commit
        </button>
      </div>
    </div>
  )
}
