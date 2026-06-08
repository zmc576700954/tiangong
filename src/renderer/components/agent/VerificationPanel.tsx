import { CheckCircle, XCircle, Loader2, Wrench, SkipForward, ArrowLeft } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { VerificationReport } from '@shared/types'

interface VerificationPanelProps {
  report: VerificationReport | null
  loading: boolean
  onRetryFailed: () => void
  onMarkComplete: () => void
  onBackToEdit: () => void
  maxRetries?: number
  currentRetry?: number
  error?: string | null
}

export function VerificationPanel({
  report,
  loading,
  onRetryFailed,
  onMarkComplete,
  onBackToEdit,
  maxRetries = 2,
  currentRetry = 0,
  error,
}: VerificationPanelProps) {
  if (loading) {
    return (
      <div className="border border-border rounded-lg p-6 bg-background flex flex-col items-center gap-3">
        <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
        <span className="text-sm text-muted-foreground">Verifying acceptance criteria...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="border border-red-500/30 rounded-lg p-4 bg-red-500/5 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <XCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
        <div className="flex items-center justify-end gap-1.5">
          <button
            onClick={onBackToEdit}
            className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            Back to Edit
          </button>
        </div>
      </div>
    )
  }

  if (!report) return null

  const allPassed = report.passedCount === report.totalCount
  const canRetry = currentRetry < maxRetries && !allPassed

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background">
      {/* Header */}
      <div className={cn(
        'flex items-center justify-between px-3 py-2 border-b border-border',
        allPassed ? 'bg-green-500/10' : 'bg-red-500/10',
      )}>
        <div className="flex items-center gap-2">
          {allPassed
            ? <CheckCircle className="w-4 h-4 text-green-400" />
            : <XCircle className="w-4 h-4 text-red-400" />}
          <span className="text-sm font-medium">
            Verification Report — {report.passedCount}/{report.totalCount} passed
          </span>
        </div>
        {currentRetry > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Retry {currentRetry}/{maxRetries}
          </span>
        )}
      </div>

      {/* Results */}
      <div className="divide-y divide-border/50">
        {report.results.map((result, i) => (
          <div key={i} className="px-3 py-2 flex items-start gap-2">
            {result.passed
              ? <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" />
              : <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-xs">{result.criterion}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{result.justification}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20">
        <button
          onClick={onBackToEdit}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to Edit
        </button>
        <div className="flex items-center gap-1.5">
          {canRetry && (
            <button
              onClick={onRetryFailed}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-orange-600/10 text-orange-400
                rounded hover:bg-orange-600/20 transition-colors"
            >
              <Wrench className="w-3 h-3" />
              Retry Failed
            </button>
          )}
          <button
            onClick={onMarkComplete}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] bg-blue-600 text-white
              rounded hover:bg-blue-700 transition-colors"
          >
            <SkipForward className="w-3 h-3" />
            Mark Complete
          </button>
        </div>
      </div>
    </div>
  )
}
