// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCollapse } from '../useCollapse'
import type { GraphNode } from '@shared/types'

/**
 * store mock 必须是 **selector 形式**（useGraphStore((s) => s.nodes)）——
 * 用 getState 形式的话组件永远不因节点变化而重渲染。
 * 同时还要提供 **getState**：toggle 在被调用时读当前状态（见 dispatch 的
 * 「toggle 的引用稳定性」一节）。
 */
const { mockState } = vi.hoisted(() => ({
  mockState: {
    nodes: [] as GraphNode[],
    updateNode: vi.fn(),
  },
}))

vi.mock('../../../store/graphStore', () => ({
  useGraphStore: Object.assign(
    (selector: (s: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}))

function makeNode(id: string, parentId?: string, collapsed = false): GraphNode {
  return {
    id,
    type: 'feature',
    status: 'draft',
    title: id,
    graphId: 'g1',
    graphType: 'online',
    parentId,
    collapsed,
    position: { x: 0, y: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** p1 → m1 → c1 → c2 —— 四层，用来区分「直接子节点」和「整棵后代」 */
function makeChain(): GraphNode[] {
  return [
    makeNode('p1'),
    makeNode('m1', 'p1'),
    makeNode('c1', 'm1'),
    makeNode('c2', 'c1'),
  ]
}

describe('useCollapse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.nodes = []
    // store 的 updateNode 会同步节点状态 —— toggle 读的是**当前**状态，
    // 第二次 toggle 必须看到第一次写进去的 collapsed。
    mockState.updateNode.mockImplementation(async (id: string, data: Partial<GraphNode>) => {
      mockState.nodes = mockState.nodes.map((n) => (n.id === id ? { ...n, ...data } : n))
    })
  })

  it('hides the whole subtree when a node is collapsed', () => {
    mockState.nodes = makeChain().map((n) =>
      n.id === 'm1' ? { ...n, collapsed: true } : n,
    )

    const { result } = renderHook(() => useCollapse())

    // 折叠 m1 → 它的**整棵**子树（c1 和孙子 c2）都看不见了，
    // 但 m1 自己必须还在 —— 不然用户没法把它再展开。
    expect(result.current.visibleNodes.map((n) => n.id)).toEqual(['p1', 'm1'])
  })

  it('keeps every node visible when nothing is collapsed', () => {
    mockState.nodes = makeChain()

    const { result } = renderHook(() => useCollapse())

    expect(result.current.visibleNodes.map((n) => n.id)).toEqual(['p1', 'm1', 'c1', 'c2'])
    expect(result.current.collapsedIds.size).toBe(0)
  })

  it('persists the collapsed flag through node update', async () => {
    mockState.nodes = makeChain()

    const { result } = renderHook(() => useCollapse())
    await act(async () => {
      await result.current.toggle('m1')
    })

    // 写回走 graphStore.updateNode → node:update → nodes.collapsed 列
    expect(mockState.updateNode).toHaveBeenCalledTimes(1)
    expect(mockState.updateNode).toHaveBeenCalledWith('m1', { collapsed: true })
  })

  it('expands when toggled again', async () => {
    mockState.nodes = makeChain()

    const { result } = renderHook(() => useCollapse())
    await act(async () => {
      await result.current.toggle('m1')
    })
    await act(async () => {
      await result.current.toggle('m1')
    })

    // 第二次 toggle 必须按**当前**状态取反 —— 闭包里那份 collapsedIds 是第一次
    // 渲染时的快照（那时 m1 还没折叠），用它会把方向算反。
    expect(mockState.updateNode).toHaveBeenCalledTimes(2)
    expect(mockState.updateNode).toHaveBeenNthCalledWith(2, 'm1', { collapsed: false })
  })

  it('counts every descendant, not just the direct children', () => {
    mockState.nodes = makeChain()

    const { result } = renderHook(() => useCollapse())

    expect(result.current.hiddenDescendantCount('p1')).toBe(3)
    expect(result.current.hiddenDescendantCount('m1')).toBe(2)
    expect(result.current.hiddenDescendantCount('c1')).toBe(1)
    expect(result.current.hiddenDescendantCount('c2')).toBe(0)
  })

  it('reports which nodes are collapsed', () => {
    mockState.nodes = makeChain().map((n) =>
      n.id === 'm1' ? { ...n, collapsed: true } : n,
    )

    const { result } = renderHook(() => useCollapse())

    expect([...result.current.collapsedIds]).toEqual(['m1'])
    expect(result.current.isCollapsed('m1')).toBe(true)
    expect(result.current.isCollapsed('c1')).toBe(false)
  })

  it('does not hang on a cycle in legacy parent links', () => {
    // a → b → a 成环 —— 历史脏数据不能把画布拖死
    mockState.nodes = [
      makeNode('a', 'b'),
      makeNode('b', 'a'),
      makeNode('c', 'a'),
    ]

    const { result } = renderHook(() => useCollapse())

    expect(result.current.visibleNodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
  })
})
