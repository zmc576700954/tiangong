import type { ContextState } from '@shared/types'

interface Props {
  state: ContextState | null
  onCompact?: () => void
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function formatLastCompact(timestamp: number): string {
  const elapsedMs = Date.now() - timestamp
  const m = Math.round(elapsedMs / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function ContextWaterlineBar({ state, onCompact }: Props) {
  if (!state || state.tokensMax === 0) return null

  const pct = Math.round(state.ratio * 100)
  const color = state.ratio < 0.5
    ? 'bg-green-500'
    : state.ratio < 0.75
      ? 'bg-yellow-500'
      : 'bg-red-500'

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground px-2 min-w-0"
      title={`Context usage: ${state.tokensUsed.toLocaleString()} / ${state.tokensMax.toLocaleString()} tokens`}
    >
      <div className="flex-1 min-w-[60px] max-w-[160px] h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="tabular-nums whitespace-nowrap text-[10px]">
        {pct}% ({formatTokens(state.tokensUsed)}/{formatTokens(state.tokensMax)})
      </span>
      {state.lastCompactedAt && (
        <span className="text-muted-foreground whitespace-nowrap text-[10px]">
          ⏱ {formatLastCompact(state.lastCompactedAt)}
        </span>
      )}
      {onCompact && (
        <button
          onClick={onCompact}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-muted border border-border"
          title="Compact context now"
        >
          Compact
        </button>
      )}
    </div>
  )
}
