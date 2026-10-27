import { describe, it, expect } from 'vitest'
import {
  edgeTypeConfig,
  createMarkerEnd,
  getEdgeMarkerEnd,
  resolveEdgeStyle,
  GHOST_EDGE_COLOR,
} from '../edge-utils'
import { edgeTypeLabel } from '@shared/i18n'
import type { EdgeType } from '@shared/types'

describe('edge-utils', () => {
  it('has config for every EdgeType', () => {
    const types: EdgeType[] = ['default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change']
    for (const type of types) {
      expect(edgeTypeConfig[type]).toBeDefined()
      expect(edgeTypeConfig[type].color).toMatch(/^#/)
      expect(edgeTypeLabel(type)).toBeTruthy()
    }
  })

  it('createMarkerEnd returns arrow marker', () => {
    const marker = createMarkerEnd('#ff0000')
    expect(marker).toEqual({
      type: 'arrowclosed',
      width: 12,
      height: 12,
      color: '#ff0000',
    })
  })

  it('getEdgeMarkerEnd uses default for undefined type', () => {
    const marker = getEdgeMarkerEnd(undefined) as { color: string }
    expect(marker.color).toBe(edgeTypeConfig.default.color)
  })

  it('getEdgeMarkerEnd uses type-specific color', () => {
    const marker = getEdgeMarkerEnd('success') as { color: string }
    expect(marker.color).toBe(edgeTypeConfig.success.color)
  })

  it('supports hierarchical edge type in config', () => {
    expect(edgeTypeConfig.hierarchical).toBeDefined()
    expect(edgeTypeConfig.hierarchical.color).toMatch(/^#/)
  })

  // 类型配置里**不许**再有虚线字段：BizEdge 从来不读它，
  // 曾经写过的 business-flow / semantic / co-change / wiki-link 虚线全是假的
  // （注释里写着虚线、画出来是实线）。这条用例钉住「别再写永不生效的外观字段」。
  it('carries no dash pattern in the type config', () => {
    for (const cfg of Object.values(edgeTypeConfig)) {
      expect('strokeDasharray' in cfg).toBe(false)
    }
  })
})

describe('resolveEdgeStyle', () => {
  it('draws the reparent ghost edge as a green dashed line', () => {
    // 幽灵连线的 edgeType 是 'hierarchical'（它就是层级边的预览），
    // 但它的外观必须与真实层级边区分开：绿色虚线 vs 灰色实线。
    const style = resolveEdgeStyle({ edgeType: 'hierarchical', isGhost: true })
    expect(style.stroke).toBe(GHOST_EDGE_COLOR)
    expect(style.stroke).toBe('#22c55e')
    expect(style.strokeDasharray).toBe('5 5')
  })

  it('draws a real hierarchy edge as a solid grey line', () => {
    // 幽灵通道是**唯一**能把它变绿的地方 —— 否则「绿色虚线」这个承诺会失效。
    const style = resolveEdgeStyle({ edgeType: 'hierarchical' })
    expect(style.stroke).toBe('#94a3b8')
    expect(style.strokeDasharray).toBeUndefined()
  })

  it('keeps a normal semantic edge identical to the look before the refactor', () => {
    // business-flow 改之前算出来的是：stroke = config.color、strokeWidth = 1 + 0.5*2、
    // 没有 dasharray、没有 opacity。这条是「别顺手把全应用语义边外观改了」的闸门。
    const style = resolveEdgeStyle({ edgeType: 'business-flow' })
    expect(style.stroke).toBe('#3b82f6')
    expect(style.strokeWidth).toBe(2)
    expect(style.strokeDasharray).toBeUndefined()
    expect(style.opacity).toBeUndefined()
  })

  it('scales the stroke width with the edge strength', () => {
    expect(resolveEdgeStyle({ edgeType: 'semantic', strength: 1 }).strokeWidth).toBe(3)
    expect(resolveEdgeStyle({ edgeType: 'semantic', strength: 0.5 }).strokeWidth).toBe(2)
  })

  it('highlights the selected edge in blue with a 3px stroke', () => {
    const style = resolveEdgeStyle({ edgeType: 'semantic', isSelected: true })
    expect(style.stroke).toBe('#3b82f6')
    expect(style.strokeWidth).toBe(3)
  })

  it('draws a suggested edge dashed and translucent', () => {
    const style = resolveEdgeStyle({ edgeType: 'default', isSuggested: true })
    expect(style.strokeDasharray).toBe('5 5')
    expect(style.opacity).toBe(0.4)
  })

  it('draws a weak edge (strength below 0.4) with a finer dash', () => {
    const style = resolveEdgeStyle({ edgeType: 'default', strength: 0.2 })
    expect(style.strokeWidth).toBe(1.4)
    expect(style.strokeDasharray).toBe('4 3')
  })
})
