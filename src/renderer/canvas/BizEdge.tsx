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
import { X, Check, Pencil, Plus } from 'lucide-react'
import { edgeTypeConfig } from './edge-utils'

/** 自定义边类型：携带 edgeType、content 和 strength 信息 */
type BizEdgeType = Edge<{ edgeType?: EdgeType; content?: EdgeContent; strength?: number }, 'bizEdge'>

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
  const confirmSuggestedEdge = useGraphStore((s) => s.confirmSuggestedEdge)
  const rejectSuggestedEdge = useGraphStore((s) => s.rejectSuggestedEdge)
  const [isEditing, setIsEditing] = useState(false)
  const labelText = typeof label === 'string' ? label : ''
  const [editLabel, setEditLabel] = useState(labelText)

  const edgeType: EdgeType = data?.edgeType ?? 'default'
  const content = data?.content
  const isBusinessFlow = edgeType === 'business-flow'
  const isSuggested = content?.suggested === true
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

  const isInteractive = selected
  const strokeColor = selected ? '#3b82f6' : config.color

  // Task 4.1.2: strength-based visual encoding
  const strength = data?.strength ?? 0.5
  const strengthStrokeWidth = 1 + strength * 2  // range 1-3px
  const isWeak = strength < 0.4

  // Task 4.1.1: suggested edge style + strength encoding
  const suggestedStyle = isSuggested
    ? { strokeDasharray: '5 5', opacity: 0.4 }
    : isWeak
      ? { strokeDasharray: '4 3' }
      : {}

  const strokeWidth = selected ? 3 : strengthStrokeWidth

  // Suggested edges have no arrow marker
  const effectiveMarkerEnd = isSuggested ? undefined : markerEnd

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        className="react-flow__edge-interaction"
      />
      <BaseEdge
        path={edgePath}
        markerEnd={effectiveMarkerEnd}
        style={{
          stroke: strokeColor,
          strokeWidth,
          transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.2s',
          ...suggestedStyle,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            'nodrag nopan pointer-events-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium shadow-xs transition-all',
            isBusinessFlow
              ? 'border-blue-300 bg-blue-50 text-blue-700'
              : selected
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : isSuggested
                  ? 'border-dashed border-amber-300 bg-amber-50 text-amber-700'
                  : 'border-slate-200 bg-white text-slate-600',
          )}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
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
                className="w-1.5 h-1.5 rounded-full shrink-0"
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

        {isSuggested && (
          <div
            className="nodrag nopan flex gap-0.5"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)`,
            }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); confirmSuggestedEdge?.(id) }}
              className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center hover:bg-green-600 shadow-sm"
              title="Confirm association"
            >
              <Plus size={10} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); rejectSuggestedEdge?.(id) }}
              className="w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 shadow-sm"
              title="Reject association"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {selected && (
          <button
            className="nodrag nopan pointer-events-auto flex items-center justify-center w-5 h-5 rounded-full bg-white border border-red-200 text-red-500 shadow-xs hover:bg-red-50 transition-colors"
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
