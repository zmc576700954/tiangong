import { describe, it, expect } from 'vitest'
import { computeTreeLayout, findBackEdgeIds } from '../tree-layout'
import type { Node, Edge } from '@xyflow/react'

function makeNode(id: string, type: string, title: string): Node {
  return {
    id,
    type: 'default',
    position: { x: 0, y: 0 },
    data: { type, title },
  } as Node
}

function makeEdge(id: string, source: string, target: string): Edge {
  return { id, source, target } as Edge
}

describe('computeTreeLayout', () => {
  it('returns empty result for empty nodes', () => {
    const result = computeTreeLayout([], [])
    expect(result.nodes).toEqual([])
    expect(result.removedBackEdgeIds).toEqual([])
  })

  it('assigns positions to nodes in a linear chain', () => {
    // 线性链: project → module → process → feature
    const nodes = [
      makeNode('p1', 'project', 'Root'),
      makeNode('m1', 'module', 'Auth'),
      makeNode('pr1', 'process', 'Login'),
      makeNode('f1', 'feature', 'Email Login'),
    ]
    const edges = [
      makeEdge('e1', 'p1', 'm1'),
      makeEdge('e2', 'm1', 'pr1'),
      makeEdge('e3', 'pr1', 'f1'),
    ]
    const result = computeTreeLayout(nodes, edges)
    expect(result.nodes).toHaveLength(4)

    // LR 方向下，源节点 x 应小于目标节点 x
    const posById = new Map(result.nodes.map((n) => [n.id, n.position]))
    expect(posById.get('p1')!.x).toBeLessThan(posById.get('m1')!.x)
    expect(posById.get('m1')!.x).toBeLessThan(posById.get('pr1')!.x)
    expect(posById.get('pr1')!.x).toBeLessThan(posById.get('f1')!.x)
  })

  it('handles a multi-branch tree (root with multiple subtrees)', () => {
    // 多叉树: p1 有 m1, m2, m3；每个 module 各有 feature 子节点
    const nodes = [
      makeNode('p1', 'project', 'Root'),
      makeNode('m1', 'module', 'Auth'),
      makeNode('m2', 'module', 'Billing'),
      makeNode('m3', 'module', 'User'),
      makeNode('f1', 'feature', 'Login'),
      makeNode('f2', 'feature', 'Pay'),
      makeNode('f3', 'feature', 'Profile'),
    ]
    const edges = [
      makeEdge('e1', 'p1', 'm1'),
      makeEdge('e2', 'p1', 'm2'),
      makeEdge('e3', 'p1', 'm3'),
      makeEdge('e4', 'm1', 'f1'),
      makeEdge('e5', 'm2', 'f2'),
      makeEdge('e6', 'm3', 'f3'),
    ]
    const result = computeTreeLayout(nodes, edges)
    expect(result.nodes).toHaveLength(7)

    const posById = new Map(result.nodes.map((n) => [n.id, n.position]))
    // 三个 module 都在 p1 右侧（更大 x）
    expect(posById.get('m1')!.x).toBeGreaterThan(posById.get('p1')!.x)
    expect(posById.get('m2')!.x).toBeGreaterThan(posById.get('p1')!.x)
    expect(posById.get('m3')!.x).toBeGreaterThan(posById.get('p1')!.x)

    // 各 feature 在对应 module 右侧
    expect(posById.get('f1')!.x).toBeGreaterThan(posById.get('m1')!.x)
    expect(posById.get('f2')!.x).toBeGreaterThan(posById.get('m2')!.x)
    expect(posById.get('f3')!.x).toBeGreaterThan(posById.get('m3')!.x)
  })

  it('handles multiple disconnected project roots (separates components)', () => {
    // 多个 project 根，无相互连接
    const nodes = [
      makeNode('p1', 'project', 'App A'),
      makeNode('p2', 'project', 'App B'),
      makeNode('m1', 'module', 'A-module'),
      makeNode('m2', 'module', 'B-module'),
    ]
    const edges = [
      makeEdge('e1', 'p1', 'm1'),
      makeEdge('e2', 'p2', 'm2'),
    ]
    const result = computeTreeLayout(nodes, edges)
    expect(result.nodes).toHaveLength(4)
    expect(result.removedBackEdgeIds).toEqual([])

    const posById = new Map(result.nodes.map((n) => [n.id, n.position]))
    // 两个根节点位置不同（不应该重叠）
    expect(posById.get('p1')!.x).not.toBe(posById.get('p2')!.x)
    // 各 module 在其 project 右侧
    expect(posById.get('m1')!.x).toBeGreaterThan(posById.get('p1')!.x)
    expect(posById.get('m2')!.x).toBeGreaterThan(posById.get('p2')!.x)
  })

  it('defends against cycles by breaking back edges', () => {
    // 环: p1 → m1 → pr1 → p1 (回到 project 根)
    const nodes = [
      makeNode('p1', 'project', 'Root'),
      makeNode('m1', 'module', 'Auth'),
      makeNode('pr1', 'process', 'Login'),
    ]
    const edges = [
      makeEdge('e1', 'p1', 'm1'),
      makeEdge('e2', 'm1', 'pr1'),
      makeEdge('e3', 'pr1', 'p1'), // 回边（构成环）
    ]
    const result = computeTreeLayout(nodes, edges)
    expect(result.nodes).toHaveLength(3)
    // 环中至少一条边（e1 或 e3）必须被剔除，确保 dagre 拿到的是 DAG。
    // 具体哪条取决于 DFS 起点的字典序选择；两条都是有效的「断环点」。
    expect(result.removedBackEdgeIds.length).toBeGreaterThanOrEqual(1)
    const cycleEdges = new Set(['e1', 'e3'])
    const removedFromCycle = result.removedBackEdgeIds.filter((id) => cycleEdges.has(id))
    expect(removedFromCycle.length).toBeGreaterThanOrEqual(1)

    // 所有节点仍获得有限的位置（不会因为环而抛错或 NaN）
    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true)
      expect(Number.isFinite(node.position.y)).toBe(true)
    }
  })

  it('handles self-loops as back edges', () => {
    const nodes = [
      makeNode('p1', 'project', 'Root'),
      makeNode('m1', 'module', 'Auth'),
    ]
    const edges = [
      makeEdge('e1', 'p1', 'm1'),
      makeEdge('e2', 'm1', 'm1'), // 自环
    ]
    const result = computeTreeLayout(nodes, edges)
    expect(result.removedBackEdgeIds).toContain('e2')
  })

  it('sorts children by edge order to avoid crossings', () => {
    // 单一父节点 → 多个子节点；按边顺序排列避免交叉
    const nodes = [
      makeNode('p1', 'project', 'Root'),
      makeNode('a', 'feature', 'A'),
      makeNode('b', 'feature', 'B'),
      makeNode('c', 'feature', 'C'),
    ]
    // 故意打乱边顺序：A, C, B
    const edges = [
      makeEdge('e1', 'p1', 'a'),
      makeEdge('e2', 'p1', 'c'),
      makeEdge('e3', 'p1', 'b'),
    ]
    const result = computeTreeLayout(nodes, edges)
    const posById = new Map(result.nodes.map((n) => [n.id, n.position]))

    // 按边顺序排列：a (idx 0) < c (idx 1) < b (idx 2)
    expect(posById.get('a')!.y).toBeLessThan(posById.get('c')!.y)
    expect(posById.get('c')!.y).toBeLessThan(posById.get('b')!.y)
  })

  it('estimates width based on title length', () => {
    const short = makeNode('n1', 'feature', 'A')
    const long = makeNode('n2', 'feature', '非常长的中文标题宽度估算')
    const longEn = makeNode('n3', 'feature', 'Very long English feature title here please')

    const result = computeTreeLayout([short, long, longEn], [])
    expect(result.nodes).toHaveLength(3)

    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true)
      expect(Number.isFinite(node.position.y)).toBe(true)
    }
  })

  it('supports TB direction', () => {
    const nodes = [
      makeNode('p1', 'project', 'Root'),
      makeNode('m1', 'module', 'Module'),
    ]
    const edges = [makeEdge('e1', 'p1', 'm1')]
    const result = computeTreeLayout(nodes, edges, { direction: 'TB' })
    const posById = new Map(result.nodes.map((n) => [n.id, n.position]))
    // TB 方向下，源节点 y 应小于目标节点 y
    expect(posById.get('p1')!.y).toBeLessThan(posById.get('m1')!.y)
  })

  it('places 500 nodes within 500ms', () => {
    // 性能基线：500 节点的单层深树应在 500ms 内完成
    const nodes: Node[] = []
    const edges: Edge[] = []
    nodes.push(makeNode('root', 'project', 'Root'))
    for (let i = 0; i < 499; i++) {
      nodes.push(makeNode(`n${i}`, 'feature', `Feature ${i}`))
      edges.push(makeEdge(`e${i}`, 'root', `n${i}`))
    }

    const start = performance.now()
    const result = computeTreeLayout(nodes, edges)
    const elapsed = performance.now() - start

    expect(result.nodes).toHaveLength(500)
    expect(elapsed).toBeLessThan(500)
  })
})

describe('findBackEdgeIds', () => {
  it('returns empty set for DAG', () => {
    const nodes = [makeNode('a', 'project', 'A'), makeNode('b', 'module', 'B')]
    const edges = [makeEdge('e1', 'a', 'b')]
    const backEdges = findBackEdgeIds(nodes, edges)
    expect(backEdges.size).toBe(0)
  })

  it('detects direct back edge (cycle of 2)', () => {
    const nodes = [makeNode('a', 'project', 'A'), makeNode('b', 'module', 'B')]
    const edges = [
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'a'),
    ]
    const backEdges = findBackEdgeIds(nodes, edges)
    expect(backEdges.has('e2')).toBe(true)
  })

  it('detects back edge in a longer cycle', () => {
    const nodes = [
      makeNode('a', 'project', 'A'),
      makeNode('b', 'module', 'B'),
      makeNode('c', 'process', 'C'),
    ]
    const edges = [
      makeEdge('e1', 'a', 'b'),
      makeEdge('e2', 'b', 'c'),
      makeEdge('e3', 'c', 'a'), // 回边
    ]
    const backEdges = findBackEdgeIds(nodes, edges)
    expect(backEdges.has('e3')).toBe(true)
  })
})
