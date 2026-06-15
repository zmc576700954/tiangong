import { memo, useState, useEffect } from 'react'
import { Handle, Position } from '@xyflow/react'
import { getNodeStatusClass, cn } from '../lib/utils'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode } from '@shared/types'
import { Bug, Loader2, AlertTriangle, Check } from 'lucide-react'
import { useAgentStore } from '../store/agentStore'
import { useAgentOutputStore } from '../store/agentOutputStore'
import { ChangeSummaryBadge } from './ChangeSummaryBadge'

interface BizNodeProps {
  id: string
  data: GraphNode & { bugCount: number }
  selected?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

export const BizNodeComponent = memo(function BizNodeComponent({
  id: _id,
  data,
  selected,
  onContextMenu,
}: BizNodeProps) {
  const typeColor = NODE_TYPE_COLORS[data.type] ?? '#94a3b8'
  const isProject = data.type === 'project'

  // Agent activity state — use getThreadByNodeId to avoid threads.find() per node
  const agentThreadInfo = useAgentStore((s) => {
    const t = s.getThreadByNodeId(data.id)
    return t ? { id: t.id, status: t.status, sessionId: t.sessionId } : undefined
  })
  const agentThreadId = agentThreadInfo?.id
  const agentStatus = agentThreadInfo?.status
  const agentSessionId = agentThreadInfo?.sessionId

  const isAgentRunning = agentStatus === 'running'
  const isAgentError = agentStatus === 'error'
  const isAgentCompleted = agentStatus === 'idle' && !!agentSessionId

  // Fade-out for completed state
  const [showCompleted, setShowCompleted] = useState(false)
  useEffect(() => {
    if (isAgentCompleted) {
      setShowCompleted(true)
      const timer = setTimeout(() => setShowCompleted(false), 3000)
      return () => clearTimeout(timer)
    }
    setShowCompleted(false)
  }, [isAgentCompleted])

  // Select only this thread's outputs (not the entire Map)
  const agentOutputs = useAgentOutputStore((s) => {
    if (!agentThreadId) return []
    return s.threadOutputs[agentThreadId] ?? []
  })

  if (isProject) {
    return (
      <div
        className="group px-6 py-4 rounded-xl border-2 min-w-[180px] shadow-md cursor-default"
        style={{
          borderColor: selected ? '#3b82f6' : typeColor,
          background: `linear-gradient(135deg, ${typeColor}08, ${typeColor}15)`,
          boxShadow: selected ? '0 0 0 2px rgba(59, 130, 246, 0.3)' : undefined,
        }}
        onContextMenu={onContextMenu}
      >
        <Handle
          type="target"
          position={Position.Top}
          id="top"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-top-[5px] transition-all"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="left"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-left-[5px] transition-all"
        />
        <Handle
          type="source"
          position={Position.Bottom}
          id="bottom"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-bottom-[5px] transition-all"
        />
        <Handle
          type="source"
          position={Position.Right}
          id="right"
          className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-right-[5px] transition-all"
        />
        <div className="flex items-center gap-1.5 mb-1">
          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {NODE_TYPE_LABELS[data.type]}
          </span>
        </div>
        <div className="font-bold text-lg truncate">{data.title}</div>
      </div>
    )
  }

  const statusClass = getNodeStatusClass(data.status)

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group relative px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-xs transition-all hover:shadow-md cursor-pointer',
        statusClass,
        selected && 'ring-2 ring-blue-400 ring-offset-1',
        isAgentRunning && 'border-orange-400 animate-pulse',
        isAgentError && 'border-red-400',
        showCompleted && 'border-green-400',
      )}
      style={selected ? { borderColor: '#3b82f6' } : undefined}
      onContextMenu={onContextMenu}
    >
      {/* Target handles: top + left (连线入端) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-top-[5px] transition-all"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-left-[5px] transition-all"
      />
      {/* Source handles: bottom + right (连线出端) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-bottom-[5px] transition-all"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!w-2.5 !h-2.5 !bg-background !border-2 !border-muted-foreground/30 group-hover:!border-primary group-hover:!bg-primary/20 !-right-[5px] transition-all"
      />

      <div className="flex items-center gap-1.5 mb-1">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
          {NODE_TYPE_LABELS[data.type]}
        </span>
      </div>
      <div className="font-medium text-sm truncate">{data.title}</div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-muted-foreground">{data.status}</span>
        {data.bugCount > 0 && (
          <div className="flex items-center gap-0.5 text-[10px] text-destructive">
            <Bug className="w-3 h-3" />
            {data.bugCount}
          </div>
        )}
      </div>

      {/* Agent activity badge */}
      {(isAgentRunning || isAgentError || showCompleted) && (
        <div className={cn(
          'absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center shadow-xs',
          isAgentRunning && 'bg-orange-400',
          isAgentError && 'bg-red-400',
          showCompleted && 'bg-green-400',
        )}>
          {isAgentRunning && <Loader2 className="w-3 h-3 text-white animate-spin" />}
          {isAgentError && <AlertTriangle className="w-3 h-3 text-white" />}
          {showCompleted && <Check className="w-3 h-3 text-white" />}
        </div>
      )}

      {agentOutputs.length > 0 && (
        <ChangeSummaryBadge outputs={agentOutputs} />
      )}
    </div>
  )
})
