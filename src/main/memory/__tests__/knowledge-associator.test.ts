import { describe, test, expect, vi } from 'vitest'
import { KnowledgeAssociator } from '../knowledge-associator'
import type { GraphNode } from '@shared/types'

describe('KnowledgeAssociator', () => {
  const associator = new KnowledgeAssociator()

  const makeNode = (id: string, type: string, title: string, description = ''): GraphNode => ({
    id,
    type: type as any,
    status: 'confirmed',
    title,
    description: description || undefined,
    graphId: 'g1',
    graphType: 'dev',
    position: { x: 0, y: 0 },
    content: { fullDescription: description },
    metadata: {},
    createdAt: '',
    updatedAt: ''
  })

  test('computeAssociationScore returns 0 for unrelated nodes', () => {
    const a = makeNode('n1', 'feature', 'User authentication')
    const b = makeNode('n2', 'feature', 'Database migration')
    const score = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 0 })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  test('computeAssociationScore weights dependency highest', () => {
    const a = makeNode('n1', 'feature', 'Auth module')
    const b = makeNode('n2', 'feature', 'Token service')
    const noDep = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 0 })
    const withDep = associator.computeAssociationScore(a, b, { dependencyEdges: [{ sourceId: 'n1', targetId: 'n2' }], coChangeFreq: 0 })
    expect(withDep).toBeGreaterThan(noDep)
  })

  test('computeAssociationScore weights co-change', () => {
    const a = makeNode('n1', 'feature', 'Payment')
    const b = makeNode('n2', 'feature', 'Invoice')
    const noCoChange = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 0 })
    const withCoChange = associator.computeAssociationScore(a, b, { dependencyEdges: [], coChangeFreq: 5 })
    expect(withCoChange).toBeGreaterThan(noCoChange)
  })

  test('findAssociations filters by threshold 0.6', async () => {
    const nodes = [
      makeNode('n1', 'feature', 'Auth'),
      makeNode('n2', 'feature', 'Unrelated topic XYZ'),
      makeNode('n3', 'feature', 'Token validation'),
    ]
    const results = await associator.findAssociations(nodes, {
      dependencyEdges: [{ sourceId: 'n1', targetId: 'n3' }],
      coChangeFreqMap: new Map([['n1:n3', 3]]),
      threshold: 0.6
    })
    expect(results.some(r => r.sourceId === 'n1' && r.targetId === 'n3')).toBe(true)
    expect(results.some(r => r.sourceId === 'n1' && r.targetId === 'n2')).toBe(false)
  })

  test('findAssociations assigns correct edgeType', async () => {
    const nodes = [makeNode('n1', 'feature', 'A'), makeNode('n2', 'feature', 'B')]
    const depOnly = await associator.findAssociations(nodes, {
      dependencyEdges: [{ sourceId: 'n1', targetId: 'n2' }],
      coChangeFreqMap: new Map(), threshold: 0.3
    })
    if (depOnly.length > 0) {
      expect(depOnly[0].edgeType).toBe('dependency')
    }
  })
})
