import { MapPin, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WritebackItem, WritebackKind } from '@shared/types/wiki'

interface WritebackPanelProps {
  items: WritebackItem[]
  onAccept: (itemId: string) => void
  onDiscard: (itemId: string) => void
  onNavigate: (nodeId: string) => void
  onClose: () => void
}

const KIND_LABELS: Record<WritebackKind, string> = {
  'append-log': '追加日志',
  'new-page': '新页面',
}

function KindBadge({ kind }: { kind: WritebackKind }) {
  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full border shrink-0',
        kind === 'append-log'
          ? 'bg-blue-50 text-blue-700 border-blue-200'
          : 'bg-green-50 text-green-700 border-green-200',
      )}
    >
      {KIND_LABELS[kind]}
    </span>
  )
}

export function WritebackPanel({ items, onAccept, onDiscard, onNavigate, onClose }: WritebackPanelProps) {
  return (
    <div className="absolute top-16 right-4 z-50 w-80 max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">审核队列</span>
          <span className="text-[10px] text-muted-foreground">待审核 {items.length}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">暂无待审核的写回项</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="p-2 rounded border bg-background text-xs space-y-1.5">
              <div className="flex items-center gap-1.5">
                <KindBadge kind={item.kind} />
                <span className="flex-1 truncate font-medium" title={item.title}>
                  {item.title}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {Math.round(item.confidence * 100)}%
                </span>
              </div>

              <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-3">
                {item.content}
              </p>

              <div className="flex items-center gap-1.5 pt-0.5">
                {item.kind === 'append-log' && (
                  <button
                    type="button"
                    onClick={() => onNavigate(item.targetNodeId)}
                    title="定位到目标节点"
                    className="flex items-center gap-1 px-2 py-1 rounded text-muted-foreground hover:bg-muted transition-colors"
                  >
                    <MapPin className="w-3 h-3" />
                    定位
                  </button>
                )}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => onAccept(item.id)}
                  className="px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  采纳
                </button>
                <button
                  type="button"
                  onClick={() => onDiscard(item.id)}
                  className="px-2 py-1 rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
                >
                  丢弃
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
