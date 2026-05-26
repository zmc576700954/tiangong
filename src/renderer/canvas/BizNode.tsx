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
  const statusClass = getNodeStatusClass(data.status)
  const typeColor = NODE_TYPE_COLORS[data.type] ?? '#94a3b8'

  return (
    <div
      className={cn(
        'px-4 py-2.5 rounded-lg border-2 min-w-[140px] max-w-[200px] shadow-sm transition-all hover:shadow-md cursor-pointer',
        statusClass,
      )}
      onContextMenu={onContextMenu}
    >
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
