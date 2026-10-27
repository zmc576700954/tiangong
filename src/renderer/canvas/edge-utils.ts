import type { Edge } from '@xyflow/react'
import type { EdgeType } from '@shared/types'

/** 连线颜色等与语言无关的样式；连线**名称**走 @shared/i18n 的 edgeTypeLabel() */
export const edgeTypeConfig: Record<EdgeType, { color: string; animated?: boolean; strokeDasharray?: string }> = {
  default: { color: '#94a3b8' },
  success: { color: '#22c55e' },
  failure: { color: '#ef4444' },
  condition: { color: '#f59e0b' },
  'business-flow': { color: '#3b82f6', animated: true, strokeDasharray: '8 4' },
  semantic: { color: '#3b82f6', strokeDasharray: '6 4' },
  dependency: { color: '#22c55e' },
  'co-change': { color: '#f97316', strokeDasharray: '2 4' },
  'wiki-link': { color: '#8b5cf6', strokeDasharray: '4 4' },
  hierarchical: { color: '#94a3b8' },
}

export function createMarkerEnd(color: string): Edge['markerEnd'] {
  return {
    type: 'arrowclosed',
    width: 12,
    height: 12,
    color,
  }
}

export function getEdgeMarkerEnd(edgeType: EdgeType | undefined): Edge['markerEnd'] {
  const color = edgeTypeConfig[edgeType || 'default'].color
  return createMarkerEnd(color)
}
