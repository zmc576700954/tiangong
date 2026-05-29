import { describe, it, expect } from 'vitest'
import { collectFileAssociations, collectCrossModuleConstraints } from '../agent-context-builder'
import type { GraphNode, GraphEdge } from '@shared/types'

function makeNode(overrides: Partial<GraphNode> & { id: string; type: GraphNode['type'] }): GraphNode {
  return {
    status: 'draft',
    title: overrides.id,
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as GraphNode
}

describe('collectFileAssociations', () => {
  it('returns empty array when node has no fileAssociations', () => {
    const nodes = [makeNode({ id: 'n1', type: 'feature' })]
    expect(collectFileAssociations('n1', nodes)).toEqual([])
  })

  it('returns direct fileAssociations', () => {
    const nodes = [
      makeNode({
        id: 'n1',
        type: 'feature',
        metadata: {
          fileAssociations: [{ path: 'src/a.ts', type: 'file' }],
        },
      }),
    ]
    expect(collectFileAssociations('n1', nodes)).toEqual([
      { path: 'src/a.ts', type: 'file' },
    ])
  })

  it('collects from ancestors', () => {
    const nodes = [
      makeNode({
        id: 'module1',
        type: 'module',
        metadata: { fileAssociations: [{ path: 'src/module/', type: 'directory' }] },
      }),
      makeNode({
        id: 'feature1',
        type: 'feature',
        parentId: 'module1',
        metadata: { fileAssociations: [{ path: 'src/module/feature.ts', type: 'file' }] },
      }),
    ]
    const result = collectFileAssociations('feature1', nodes)
    expect(result).toHaveLength(2)
    expect(result.map((a) => a.path)).toContain('src/module/')
    expect(result.map((a) => a.path)).toContain('src/module/feature.ts')
  })

  it('handles missing node id gracefully', () => {
    const nodes = [makeNode({ id: 'n1', type: 'feature' })]
    expect(collectFileAssociations('nonexistent', nodes)).toEqual([])
  })
})

describe('collectCrossModuleConstraints', () => {
  it('returns empty when no business-flow edges', () => {
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'default' },
    ]
    expect(collectCrossModuleConstraints('n1', edges, [])).toEqual([])
  })

  it('collects constraints from outgoing business-flow edges', () => {
    const nodes = [
      makeNode({ id: 'n1', type: 'module' }),
      makeNode({ id: 'n2', type: 'module' }),
    ]
    const edges: GraphEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
        edgeType: 'business-flow',
        content: { condition: '退款申请通过', note: '需同步回滚库存' },
      },
    ]
    const result = collectCrossModuleConstraints('n1', edges, nodes)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('n2')
    expect(result[0]).toContain('需同步回滚库存')
    expect(result[0]).toContain('退款申请通过')
  })

  it('collects constraints from incoming business-flow edges', () => {
    const nodes = [
      makeNode({ id: 'n1', type: 'module' }),
      makeNode({ id: 'n2', type: 'module' }),
    ]
    const edges: GraphEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
        edgeType: 'business-flow',
        content: { note: '库存联动' },
      },
    ]
    const result = collectCrossModuleConstraints('n2', edges, nodes)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('n1')
    expect(result[0]).toContain('库存联动')
  })

  it('skips edges without note', () => {
    const edges: GraphEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
        edgeType: 'business-flow',
        content: { condition: '条件' },
      },
    ]
    expect(collectCrossModuleConstraints('n1', edges, [])).toEqual([])
  })
})
