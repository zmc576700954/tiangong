import type { Edge } from '@xyflow/react'
import type { EdgeType } from '@shared/types'

export const edgeTypeConfig: Record<EdgeType, { color: string; label: string; animated?: boolean; strokeDasharray?: string }> = {
  default: { color: '#94a3b8', label: '默认' },
  success: { color: '#22c55e', label: '成功' },
  failure: { color: '#ef4444', label: '失败' },
  condition: { color: '#f59e0b', label: '条件' },
  'business-flow': { color: '#3b82f6', label: '业务流程', animated: true, strokeDasharray: '8 4' },
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
