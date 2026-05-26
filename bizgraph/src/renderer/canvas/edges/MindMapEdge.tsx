/**
 * 思维导图风格的自定义连线
 * 父节点右侧 -> 水平延伸 -> 垂直折线 -> 子节点左侧
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react'
import { useGraphStore } from '../../store/graphStore'
import type { GraphEdge } from '@shared/types'

export function MindMapEdge({
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
  style,
  markerEnd,
}: EdgeProps) {
  const edgeData = data as (GraphEdge & { condition?: string }) | undefined
  const condition = edgeData?.condition

  // 判断方向：父在左子向右 / 父在右子向左
  const isLeftToRight = sourceX < targetX

  // 计算水平中点
  const midX = (sourceX + targetX) / 2

  // 构建正交折线路径
  // 从 source 右侧出发，水平到 midX，垂直到 targetY，水平到 target 左侧
  const path = isLeftToRight
    ? `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`

  // 边的样式
  const strokeColor = edgeData?.style?.stroke || (selected ? '#3b82f6' : '#94a3b8')
  const strokeWidth = edgeData?.style?.strokeWidth || 2
  const strokeDasharray = edgeData?.style?.strokeDasharray

  // 标签位置：水平中点处
  const labelX = midX
  const labelY = (sourceY + targetY) / 2

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: strokeColor,
          strokeWidth,
          strokeDasharray,
          ...style,
        }}
        markerEnd={markerEnd}
      />
      {(label || condition) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
          >
            <div
              className="px-2 py-0.5 text-[11px] bg-background border rounded-md shadow-sm whitespace-nowrap"
              style={{
                color: strokeColor,
                borderColor: strokeColor + '40',
              }}
            >
              {condition || label}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
