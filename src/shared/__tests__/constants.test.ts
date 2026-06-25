import { describe, it, expect } from 'vitest'
import { EDGE_TYPE_OPTIONS } from '../constants'
import type { EdgeType } from '../types'

describe('EDGE_TYPE_OPTIONS', () => {
  it('includes all EdgeType values', () => {
    const expected: EdgeType[] = [
      'default',
      'success',
      'failure',
      'condition',
      'business-flow',
      'semantic',
      'dependency',
      'co-change',
    ]
    const types = EDGE_TYPE_OPTIONS.map((o) => o.type)
    expect(types).toEqual(expected)
  })

  it('provides a label and color for every option', () => {
    for (const option of EDGE_TYPE_OPTIONS) {
      expect(option.label).toBeTruthy()
      expect(option.color).toMatch(/^#/)
      expect(option.description).toBeTruthy()
    }
  })
})
