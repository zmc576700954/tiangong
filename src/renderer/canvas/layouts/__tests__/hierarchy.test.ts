import { describe, it, expect } from 'vitest'
import {
  buildReparentGhostEdge,
  deriveHierarchyEdges,
  REPARENT_DRAGGING_Z_INDEX,
  REPARENT_TARGET_Z_INDEX,
  resolveReparentZIndex,
} from '../hierarchy'
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

describe('buildReparentGhostEdge', () => {
  it('points parent → child, the same direction as every other hierarchy edge', () => {
    // 幽灵连线画的是「候选父节点 → 被拖节点」：箭头像所有层级边一样落在子节点那一端。
    const ghost = buildReparentGhostEdge('child-dragged', 'parent-candidate', 'g1')
    expect(ghost.source).toBe('parent-candidate')
    expect(ghost.target).toBe('child-dragged')
    expect(ghost.edgeType).toBe('hierarchical')
    expect(ghost.graphId).toBe('g1')
  })

  it('agrees with the direction deriveHierarchyEdges produces for the same pair', () => {
    const { hierarchyEdges } = deriveHierarchyEdges(
      [mkNode('parent-candidate'), mkNode('child-dragged', 'parent-candidate')],
      [],
    )
    const ghost = buildReparentGhostEdge('child-dragged', 'parent-candidate', 'g1')
    expect(ghost.source).toBe(hierarchyEdges[0].source)
    expect(ghost.target).toBe(hierarchyEdges[0].target)
  })

  it('keeps a stable id that does not depend on the edge direction', () => {
    expect(buildReparentGhostEdge('child-dragged', 'parent-candidate', 'g1').id)
      .toBe('ghost-child-dragged-parent-candidate')
  })
})

describe('resolveReparentZIndex', () => {
  it('gives ordinary nodes no z-index at all', () => {
    // 普通节点不设 zIndex → 走 xyflow 的默认值 0（不能是 0 以外的值，也不能带 key）
    expect(resolveReparentZIndex(false, false)).toBeUndefined()
  })

  it('lifts the drop target above ordinary siblings', () => {
    expect(resolveReparentZIndex(true, false)).toBe(REPARENT_TARGET_Z_INDEX)
  })

  it('lifts the dragged node above the drop target', () => {
    expect(resolveReparentZIndex(false, true)).toBe(REPARENT_DRAGGING_Z_INDEX)
  })

  it('prefers the dragged node when target and dragging overlap', () => {
    // 防御性写法：被拖节点优先于落点目标
    expect(resolveReparentZIndex(true, true)).toBe(REPARENT_DRAGGING_Z_INDEX)
  })

  it('keeps the ordinary < target < dragged order', () => {
    expect(REPARENT_DRAGGING_Z_INDEX).toBeGreaterThan(REPARENT_TARGET_Z_INDEX)
    expect(REPARENT_TARGET_Z_INDEX).toBeGreaterThan(0)
  })

  it('keeps the dragged node above the drop target even when both are selected', () => {
    // SELECTED_NODE_Z = 1000（@xyflow/system/dist/esm/index.js:1602）
    // xyflow 的最终 z = 我们的 zIndex + (选中 ? 1000 : 0)，两边都选中时也要保持顺序
    const SELECTED_NODE_Z = 1000
    expect(REPARENT_DRAGGING_Z_INDEX + SELECTED_NODE_Z)
      .toBeGreaterThan(REPARENT_TARGET_Z_INDEX + SELECTED_NODE_Z)
  })
})
