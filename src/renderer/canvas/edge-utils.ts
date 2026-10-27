import type { CSSProperties } from 'react'
import type { Edge } from '@xyflow/react'
import type { EdgeType } from '@shared/types'

/**
 * 幽灵连线（拖拽重挂的临时预览边）的颜色与虚线。
 *
 * 与「合法落点」的绿色高亮同一套绿 —— 那条幽灵线就是「这一手会挂上去」的承诺。
 */
export const GHOST_EDGE_COLOR = '#22c55e'
export const GHOST_EDGE_DASH = '5 5'

/** 选中态的描边色（全应用统一，与边类型无关） */
const SELECTED_EDGE_COLOR = '#3b82f6'

/** 描边过渡 —— 换类型 / 换选中态时颜色与线宽平滑过渡 */
const EDGE_TRANSITION = 'stroke 0.2s, stroke-width 0.2s, opacity 0.2s'

/**
 * 连线颜色等与语言无关的样式；连线**名称**走 @shared/i18n 的 edgeTypeLabel()
 *
 * ⚠️ 这里**只有颜色**是真实生效的外观来源：`BizEdge` 自己按
 * `edgeTypeConfig[edgeType].color` 拼 `BaseEdge` 的 style，边对象上的 `style`
 * 字段**不会被读**（`@xyflow/react` 把它透传给边组件，但边组件不接）。
 * 曾经给四种语义边写过 `strokeDasharray`、给 `business-flow` 写过 `animated: true`，
 * 注释里写着虚线/会动起来、实际画出来是实线且静止 —— 那些字段从来没生效过，已删
 * （留着的唯一效果是骗人）。
 *
 * ⚠️ 真正生效的「边会动」是 `GraphCanvas` 自己算的 `shouldAnimate`
 * （写在流式边对象上、由 xyflow 消费），**与这张表无关** —— 别往这里加 `animated`。
 */
export const edgeTypeConfig: Record<EdgeType, { color: string }> = {
  default: { color: '#94a3b8' },
  success: { color: '#22c55e' },
  failure: { color: '#ef4444' },
  condition: { color: '#f59e0b' },
  'business-flow': { color: '#3b82f6' },
  semantic: { color: '#3b82f6' },
  dependency: { color: '#22c55e' },
  'co-change': { color: '#f97316' },
  'wiki-link': { color: '#8b5cf6' },
  hierarchical: { color: '#94a3b8' },
}

/** 算一条边该长什么样的全部输入 */
export interface EdgeStyleInput {
  /** 边的类型 */
  edgeType: EdgeType
  /** 幽灵连线（拖拽重挂的临时预览边）—— 走独立通道，见 resolveEdgeStyle */
  isGhost?: boolean
  /** 是否选中 */
  isSelected?: boolean
  /** 关联强度 0~1 —— 决定线宽（1~3px）；缺省 0.5 */
  strength?: number
  /** 建议边（待用户确认的关联）—— 虚线 + 半透明 */
  isSuggested?: boolean
}

/**
 * 算出一条边的 `BaseEdge` style —— 「这条边长什么样」的**唯一权威**。
 *
 * 抽成纯函数是为了能单测：改这个函数等于改全应用的边外观，
 * 所以每一条分支都要有钉子（包括「普通语义边与改之前逐字一致」这条闸门）。
 *
 * 幽灵连线走**独立通道**（`isGhost`），而不是靠 `edgeType` 区分：
 * 幽灵边的 edgeType 就是 'hierarchical'（它确实是层级边的预览），
 * 但它的外观必须与真实层级边区分开 —— 绿色虚线 vs 灰色实线。
 */
export function resolveEdgeStyle(input: EdgeStyleInput): CSSProperties {
  const { edgeType, isGhost = false, isSelected = false, strength = 0.5, isSuggested = false } = input

  // 幽灵连线：绿色虚线。宽度固定 2px —— 它是预览，不该抢走落点目标的注意力。
  if (isGhost) {
    return {
      stroke: GHOST_EDGE_COLOR,
      strokeWidth: 2,
      strokeDasharray: GHOST_EDGE_DASH,
      transition: EDGE_TRANSITION,
    }
  }

  const config = edgeTypeConfig[edgeType]
  const stroke = isSelected ? SELECTED_EDGE_COLOR : config.color
  const strokeWidth = isSelected ? 3 : 1 + strength * 2

  if (isSuggested) {
    return {
      stroke,
      strokeWidth,
      strokeDasharray: '5 5',
      opacity: 0.4,
      transition: EDGE_TRANSITION,
    }
  }
  // 弱关联（strength < 0.4）画成更细一档的虚线，让「弱」在视觉上可辨
  if (strength < 0.4) {
    return {
      stroke,
      strokeWidth,
      strokeDasharray: '4 3',
      transition: EDGE_TRANSITION,
    }
  }
  return { stroke, strokeWidth, transition: EDGE_TRANSITION }
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
