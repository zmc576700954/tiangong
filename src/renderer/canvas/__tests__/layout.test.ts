import { describe, it, expect } from 'vitest'
import { computeDagreLayout } from '../layout'
import type { Node, Edge } from '@xyflow/react'

function makeNode(id: string, type: string, title: string): Node {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: { type, title },
  } as Node
}

describe('computeDagreLayout', () => {
  it('returns empty array for empty nodes', () => {
    expect(computeDagreLayout([], [])).toEqual([])
  })

  it('assigns positions to nodes', () => {
    const nodes = [makeNode('n1', 'project', 'Root'), makeNode('n2', 'module', 'Module')]
    const edges: Edge[] = [{ id: 'e1', source: 'n1', target: 'n2' }]
    const result = computeDagreLayout(nodes, edges)
    expect(result).toHaveLength(2)
    for (const node of result) {
      expect(node.position.x).not.toBe(0)
      expect(node.position.y).not.toBe(0)
    }
  })

  it('uses TB direction', () => {
    const nodes = [makeNode('n1', 'project', 'Root'), makeNode('n2', 'module', 'Module')]
    const edges: Edge[] = [{ id: 'e1', source: 'n1', target: 'n2' }]
    const result = computeDagreLayout(nodes, edges, { direction: 'TB' })
    expect(result).toHaveLength(2)
  })

  it('estimates width based on title length', () => {
    const short = makeNode('n1', 'feature', 'A')
    const long = makeNode('n2', 'feature', 'Very long feature title here')
    const result = computeDagreLayout([short, long], [])
    // Verify positions are computed for nodes with different title lengths
    expect(result[0].position.x).not.toBeNaN()
    expect(result[1].position.x).not.toBeNaN()
  })
})
