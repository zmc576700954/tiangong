import { describe, it, expect } from 'vitest'
import { deriveHierarchyEdges } from '../hierarchy'
import type { GraphNode, GraphEdge, EdgeType } from '@shared/types'

const mkNode = (id: string, parentId?: string): GraphNode => ({
  id, type: 'feature', status: 'draft', title: id,
  graphId: 'g1', graphType: 'online', parentId,
  position: { x: 0, y: 0 }, createdAt: 't', updatedAt: 't',
})

const mkEdge = (id: string, source: string, target: string, edgeType: EdgeType): GraphEdge => ({
  id, source, target, edgeType, graphId: 'g1',
})

describe('deriveHierarchyEdges', () => {
  it('derives one hierarchy edge per parented node', () => {
    const { hierarchyEdges } = deriveHierarchyEdges([mkNode('p'), mkNode('c', 'p')], [])
    expect(hierarchyEdges).toHaveLength(1)
    expect(hierarchyEdges[0]).toMatchObject({ source: 'p', target: 'c', edgeType: 'hierarchical' })
    expect(hierarchyEdges[0].id).toBe('derived-p-c')
  })

  it('excludes stored hierarchical edges from semantic edges', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('c', 'p')],
      [mkEdge('e1', 'p', 'c', 'hierarchical')],
    )
    expect(semanticEdges.find(e => e.id === 'e1')).toBeUndefined()
  })

  it('keeps semantic edges that are not parent-child pairs', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('a'), mkNode('b')],
      [mkEdge('e1', 'a', 'b', 'business-flow')],
    )
    expect(semanticEdges.map(e => e.id)).toEqual(['e1'])
  })

  it('keeps default edges that are not parent-child pairs', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('a'), mkNode('b')],
      [mkEdge('e1', 'a', 'b', 'default')],
    )
    expect(semanticEdges.map(e => e.id)).toEqual(['e1'])
  })

  it('drops default edges that duplicate a parent-child pair', () => {
    const { semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('c', 'p')],
      [mkEdge('e1', 'p', 'c', 'default')],
    )
    expect(semanticEdges.map(e => e.id)).toEqual([])
  })

  it('produces no edge for a node whose parent is missing', () => {
    const { hierarchyEdges } = deriveHierarchyEdges([mkNode('orphan', 'gone')], [])
    expect(hierarchyEdges).toEqual([])
  })

  it('produces no edge for a root node', () => {
    const { hierarchyEdges } = deriveHierarchyEdges([mkNode('root')], [])
    expect(hierarchyEdges).toEqual([])
  })

  it('produces exactly one edge for a parented node that also has a stored edge', () => {
    const { hierarchyEdges, semanticEdges } = deriveHierarchyEdges(
      [mkNode('p'), mkNode('c', 'p')],
      [mkEdge('e1', 'p', 'c', 'default')],
    )
    const all = [...hierarchyEdges, ...semanticEdges]
    expect(all.filter(e => e.source === 'p' && e.target === 'c')).toHaveLength(1)
  })

  it('produces exactly one edge for a parented node with no stored edge', () => {
    const { hierarchyEdges, semanticEdges } = deriveHierarchyEdges([mkNode('p'), mkNode('c', 'p')], [])
    const all = [...hierarchyEdges, ...semanticEdges]
    expect(all.filter(e => e.source === 'p' && e.target === 'c')).toHaveLength(1)
  })
})
