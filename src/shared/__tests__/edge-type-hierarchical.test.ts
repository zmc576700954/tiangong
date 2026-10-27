import { describe, it, expect } from 'vitest'
import { EDGE_TYPE_VALUES } from '../types/graph'
import { assertEdgeType, isEdgeType } from '../type-guards'
import { edgeTypeLabel } from '../i18n'

describe('hierarchical edge type', () => {
  it('is a legal EdgeType value', () => {
    expect(EDGE_TYPE_VALUES).toContain('hierarchical')
    expect(isEdgeType('hierarchical')).toBe(true)
  })

  it('assertEdgeType accepts hierarchical without throwing', () => {
    expect(() => assertEdgeType('hierarchical')).not.toThrow()
    expect(assertEdgeType('hierarchical')).toBe('hierarchical')
  })

  it('has a translated label instead of the raw type string', () => {
    expect(edgeTypeLabel('hierarchical')).toBeTruthy()
    expect(edgeTypeLabel('hierarchical')).not.toBe('hierarchical')
  })
})
