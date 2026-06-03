import { Handle, Position } from '@xyflow/react'
import { getNodeStatusClass, cn } from '../lib/utils'
import { NODE_TYPE_LABELS, NODE_TYPE_COLORS } from '@shared/constants'
import type { GraphNode } from '@shared/types'
import { Bug } from 'lucide-react'

interface BizNodeProps {
  id: string
  data: GraphNode & { bugCount: number }
  selected?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

export function BizNodeComponent({
  id: _id,
  data,
  selected: _selected,
  onContextMenu,
}: BizNodeProps) {
  const typeColor = NODE_TYPE_COLORS[data.type] ?? '#94a3b8'
  const isProject = data.type === 'project'

  if (isProject) {
    return (
      <div
        className="group px-6 py-4 rounded-xl border-2 min-w-[180px] shadow-md cursor-default"
        style={{
          borderColor: typeColor,
          background: `linear-gradient(135deg, ${typeColor}08, ${typeColor}15)`,
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
          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
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
      className={cn(
        'group px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-sm transition-all hover:shadow-md cursor-pointer',
        statusClass,
      )}
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
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: typeColor }} />
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
    </div>
  )
}
