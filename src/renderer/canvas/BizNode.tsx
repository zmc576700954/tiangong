import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { getNodeStatusClass, cn } from '../lib/utils'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode, AgentOutput } from '@shared/types'
import { Bug, Loader2, AlertTriangle, Check } from 'lucide-react'
import { useAgentOutputStore } from '../store/agentOutputStore'
import { useGraphStore } from '../store/graphStore'
import { ChangeSummaryBadge } from './ChangeSummaryBadge'

const EMPTY_OUTPUTS: AgentOutput[] = []

interface BizNodeProps {
  id: string
  data: GraphNode & {
    bugCount: number
    isZoomedOut?: boolean
    hideTextLabels?: boolean
    isConnectingSource?: boolean
    isFlashed?: boolean
    hasThread?: boolean
    agentThreadId?: string
    agentStatus?: string
    agentSessionId?: string
  }
  selected?: boolean
  multiSelected?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

export const BizNodeComponent = memo(function BizNodeComponent({
  id: _id,
  data,
  selected,
  multiSelected,
  onContextMenu,
}: BizNodeProps) {
  const typeColor = NODE_TYPE_COLORS[data.type] ?? 'hsl(var(--muted-foreground))'
  const isProject = data.type === 'project'
  const isPreview = data.metadata?.preview === true

  const { isConnectingSource, isFlashed, agentThreadId, agentStatus, agentSessionId } = data
  const isPotentialTarget = !!isConnectingSource
  const isFlashing = !!isFlashed

  const isAgentRunning = agentStatus === 'running'
  const isAgentError = agentStatus === 'error'
  const isAgentCompleted = agentStatus === 'idle' && !!agentSessionId

  // Select only this thread's outputs — stable empty array when no outputs
  const agentOutputs = useAgentOutputStore((s) => {
    if (!agentThreadId) return EMPTY_OUTPUTS as AgentOutput[]
    return s.threadOutputs[agentThreadId] ?? EMPTY_OUTPUTS as AgentOutput[]
  })

  if (isProject) {
    return (
      <div
        className="group px-6 py-4 rounded-xl border-2 min-w-[180px] shadow-md cursor-default"
        style={{
          borderColor: multiSelected ? '#8b5cf6' : selected ? '#3b82f6' : typeColor,
          background: `linear-gradient(135deg, ${typeColor}08, ${typeColor}15)`,
          boxShadow: multiSelected
            ? '0 0 0 2px rgba(139, 92, 246, 0.3)'
            : selected
              ? '0 0 0 2px rgba(59, 130, 246, 0.3)'
              : undefined,
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
        'group relative px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-xs hover:shadow-md cursor-pointer',
        statusClass,
        selected && 'ring-2 ring-blue-400 ring-offset-1',
        multiSelected && 'ring-2 ring-purple-400 ring-offset-1',
        isAgentRunning && 'border-orange-400 animate-pulse',
        isAgentError && 'border-red-400',
        isAgentCompleted && 'border-green-400',
        isPreview && 'opacity-50 border-dashed border-2 border-gray-400 dark:border-gray-500',
        isPotentialTarget && 'animate-breathe',
        isFlashing && 'animate-flash-once',
      )}
      style={{
        borderColor: multiSelected ? '#8b5cf6' : selected ? typeColor : undefined,
        transition: 'border-color var(--duration-normal), box-shadow var(--duration-normal), transform var(--duration-normal)',
        transform: selected || multiSelected ? 'scale(1.02)' : 'scale(1)',
        boxShadow: multiSelected
          ? '0 0 0 2px rgba(139, 92, 246, 0.3)'
          : selected
            ? `0 0 0 2px ${typeColor}40`
            : undefined,
      }}
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
        <span className={cn("text-[10px] text-muted-foreground uppercase tracking-wider", (data.isZoomedOut || data.hideTextLabels) && "hidden")}>
          {NODE_TYPE_LABELS[data.type]}
        </span>
      </div>
      <div className={cn("font-medium text-sm truncate", data.isZoomedOut && "text-[8px]", data.hideTextLabels && "text-[8px]")}>{data.title}</div>
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
      {(isAgentRunning || isAgentError || isAgentCompleted) && (
        <div className={cn(
          'absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center shadow-xs',
          isAgentRunning && 'bg-orange-400',
          isAgentError && 'bg-red-400',
          isAgentCompleted && 'bg-green-400 animate-fade-out-3s',
        )}>
          {isAgentRunning && <Loader2 className="w-3 h-3 text-white animate-spin" />}
          {isAgentError && <AlertTriangle className="w-3 h-3 text-white" />}
          {isAgentCompleted && <Check className="w-3 h-3 text-white" />}
        </div>
      )}

      {isPreview && (
        <div className="flex gap-1 mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); useGraphStore.getState().confirmPreviewNode(data.id) }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-300"
          >
            Confirm
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); useGraphStore.getState().clearPreviewNodes() }}
            className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300"
          >
            Clear
          </button>
        </div>
      )}

      {agentOutputs.length > 0 && (
        <ChangeSummaryBadge outputs={agentOutputs} />
      )}
    </div>
  )
})
