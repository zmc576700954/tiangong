import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge,
} from '@xyflow/react'
import { useCallback, useState, memo } from 'react'
import { useGraphStore } from '../store/graphStore'
import { cn } from '../lib/utils'
import type { EdgeType, EdgeContent } from '@shared/types'
import { X, Check, Pencil } from 'lucide-react'
import { edgeTypeConfig } from './edge-utils'

/** 自定义边类型：携带 edgeType 和 content 信息 */
type BizEdgeType = Edge<{ edgeType?: EdgeType; content?: EdgeContent }, 'bizEdge'>

export const BizEdge = memo(function BizEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  label,
  selected,
  markerEnd,
}: EdgeProps<BizEdgeType>) {
  const updateEdge = useGraphStore((s) => s.updateEdge)
  const [isEditing, setIsEditing] = useState(false)
  const labelText = typeof label === 'string' ? label : ''
  const [editLabel, setEditLabel] = useState(labelText)
  const [isHover, setIsHover] = useState(false)

  const edgeType: EdgeType = data?.edgeType ?? 'default'
  const content = data?.content
  const isBusinessFlow = edgeType === 'business-flow'
  const config = edgeTypeConfig[edgeType]

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.3,
  })

  const handleSaveLabel = useCallback(() => {
    updateEdge(id, { label: editLabel.trim() || undefined })
    setIsEditing(false)
  }, [id, editLabel, updateEdge])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSaveLabel()
      if (e.key === 'Escape') {
        setEditLabel(labelText)
        setIsEditing(false)
      }
    },
    [handleSaveLabel, labelText],
  )

  const isInteractive = selected || isHover
  const strokeColor = selected ? '#3b82f6' : config.color
  const strokeWidth = selected ? 3 : isHover ? 2.5 : 2

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        className="react-flow__edge-interaction"
        onMouseEnter={() => setIsHover(true)}
        onMouseLeave={() => setIsHover(false)}
      />
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: strokeColor,
          strokeWidth,
          transition: 'stroke 0.2s, stroke-width 0.2s',
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            'nodrag nopan pointer-events-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium shadow-sm transition-all',
            isBusinessFlow
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : selected
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-white text-slate-600',
          )}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          onMouseEnter={() => setIsHover(true)}
          onMouseLeave={() => setIsHover(false)}
          title={content?.note || undefined}
        >
          {isEditing ? (
            <>
              <input
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-20 bg-transparent text-xs outline-none"
                autoFocus
                onBlur={handleSaveLabel}
              />
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={handleSaveLabel}
                className="rounded p-0.5 hover:bg-green-100 text-green-600"
              >
                <Check className="w-3 h-3" />
              </button>
            </>
          ) : (
            <>
              <div
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: config.color }}
              />
              <span className="truncate max-w-[100px]">
                {labelText || config.label}
              </span>
              {isInteractive && (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setEditLabel(labelText)
                    setIsEditing(true)
                  }}
                  className="rounded p-0.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </>
          )}
        </div>

        {selected && (
          <button
            className="nodrag nopan pointer-events-auto flex items-center justify-center w-5 h-5 rounded-full bg-white border border-red-200 text-red-500 shadow-sm hover:bg-red-50 transition-colors"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 18}px)`,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              useGraphStore.getState().deleteEdge(id)
            }}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  )
})
