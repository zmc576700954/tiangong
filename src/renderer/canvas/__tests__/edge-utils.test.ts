import { describe, it, expect } from 'vitest'
import { edgeTypeConfig, createMarkerEnd, getEdgeMarkerEnd } from '../edge-utils'
import type { EdgeType } from '@shared/types'

describe('edge-utils', () => {
  it('has config for every EdgeType', () => {
    const types: EdgeType[] = ['default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change']
    for (const type of types) {
      expect(edgeTypeConfig[type]).toBeDefined()
      expect(edgeTypeConfig[type].color).toMatch(/^#/)
      expect(edgeTypeConfig[type].label).toBeTruthy()
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
})
