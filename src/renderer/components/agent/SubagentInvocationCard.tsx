import { useEffect, useState } from 'react'
import { useSubagentStore } from '../../store/subagentStore'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

interface Props {
  invocationId: string
  agentType?: string
  description?: string
}

export function SubagentInvocationCard({ invocationId, agentType, description }: Props) {
  const invocation = useSubagentStore((s) =>
    s.invocations.find((i) => i.id === invocationId)
  )
  const outputs = useSubagentStore((s) => s.outputsByInvocation.get(invocationId) ?? [])
  const cancelInvocation = useSubagentStore((s) => s.cancelInvocation)
  const getResult = useSubagentStore((s) => s.getResult)
  const [expanded, setExpanded] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)

  useEffect(() => {
    if (invocation?.status === 'completed') {
      getResult(invocationId).then((r) => {
        if (r) setResultText(r.resultText)
      })
    }
  }, [invocation?.status, invocationId, getResult])

  const status = invocation?.status ?? 'queued'
  const isActive = status === 'queued' || status === 'running'
  const isError = status === 'failed'

  const statusColor =
    status === 'completed' ? 'bg-green-500/10 text-green-600 border-green-500/30' :
    status === 'failed' ? 'bg-red-500/10 text-red-600 border-red-500/30' :
    status === 'cancelled' ? 'bg-gray-500/10 text-gray-600 border-gray-500/30' :
    'bg-blue-500/10 text-blue-600 border-blue-500/30'

  return (
    <div className={`my-2 rounded-md border px-3 py-2 text-sm ${statusColor}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-xs">🤖 {agentType ?? invocation?.agentType ?? '?'}</span>
        <Badge variant="secondary" className="text-[10px]">{status}</Badge>
        <span className="flex-1 truncate text-xs opacity-70">
          {description ?? invocation?.description ?? ''}
        </span>
        {isActive && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => cancelInvocation(invocationId)}
          >
            Cancel
          </Button>
        )}
      </div>

      {/* Live output (collapsible) */}
      {outputs.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] opacity-70 hover:opacity-100 mb-1"
          >
            {expanded ? '▼' : '▶'} {outputs.length} output line{outputs.length !== 1 ? 's' : ''}
          </button>
          {expanded && (
            <pre className="text-[10px] font-mono bg-black/5 dark:bg-white/5 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap">
              {outputs.map((o, i) => (
                <div key={i} className={o.type === 'error' ? 'text-red-500' : ''}>
                  {o.data}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* Final result (only when completed) */}
      {status === 'completed' && resultText && (
        <div className="mt-2 pt-2 border-t border-current/20">
          <div className="text-[10px] opacity-70 mb-1">
            Result • {invocation?.tokensUsed ?? 0} tokens
            {invocation?.finishedAt && invocation?.startedAt &&
              ` • ${invocation.finishedAt - invocation.startedAt}ms`}
          </div>
          <div className="text-xs whitespace-pre-wrap line-clamp-6">
            {resultText}
          </div>
        </div>
      )}

      {isError && invocation?.error && (
        <div className="mt-2 text-xs text-red-600">{invocation.error}</div>
      )}
    </div>
  )
}