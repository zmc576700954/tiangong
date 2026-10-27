// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { useCollapse } from '../useCollapse'
import type { GraphNode } from '@shared/types'

type MockState = {
  nodes: GraphNode[]
  updateNode: (id: string, data: Partial<GraphNode>) => Promise<void>
}

/**
 * 可订阅的 store mock —— 照 zustand v5 的实现抄：
 * `useSyncExternalStore(api.subscribe, () => selector(api.getState()))`。
 *
 * ⚠️ 只调 selector、**根本不订阅**的 mock 挡不住「实现误用 `getState()` 在渲染期
 * 读节点」这个错误 —— 那样写的话 7 条老测试照样全绿，而生产环境里组件永远
 * 不会因节点变化而重渲染（折叠状态改了画布却不更新）。这个 mock 真的会订阅，
 * 所以「store 变了 → 组件重渲染 → visibleNodes 跟着变」是可测的。
 */
const { store, mockState } = vi.hoisted(() => {
  type Listener = () => void
  const listeners = new Set<Listener>()
  const updateNode = vi.fn<(id: string, data: Partial<GraphNode>) => Promise<void>>()
  let state: MockState = { nodes: [], updateNode }
  const api = {
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** 状态没变时必须返回**同一个引用** —— 否则 useSyncExternalStore 会报
     *  「getSnapshot 的结果没有缓存」 */
    getSnapshot(): MockState { return state },
    getState(): MockState { return state },
    /** 换掉整个 state 对象（**不**原地改字段）—— 订阅者靠引用变化被叫醒 */
    setState(next: MockState): void {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
  /**
   * 活视图：写 `mockState.nodes = [...]` 等价于换掉 store 的节点（并唤醒订阅者）。
   * 这样「换节点」只有一个入口，测试里不必关心 store 的内部形状。
   */
  const view = {
    get nodes(): GraphNode[] { return state.nodes },
    set nodes(next: GraphNode[]) { api.setState({ ...state, nodes: next }) },
    updateNode,
  }
  return { store: api, mockState: view }
})

vi.mock('../../../store/graphStore', () => ({
  useGraphStore: Object.assign(
    <T,>(selector: (s: MockState) => T): T =>
      useSyncExternalStore(
        store.subscribe,
        () => selector(store.getSnapshot()),
        () => selector(store.getSnapshot()),
      ),
    { getState: store.getState },
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

/**
 * 历史脏数据：a → b → a 成环，c 挂在 a 下面。
 * `collapsedId` 决定折叠的是环上的哪一个节点。
 */
function makeCyclicNodes(collapsedId?: string): GraphNode[] {
  return [
    makeNode('a', 'b', collapsedId === 'a'),
    makeNode('b', 'a', collapsedId === 'b'),
    makeNode('c', 'a'),
  ]
}

describe('useCollapse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.nodes = []
    // store 的 updateNode 会同步节点状态 —— toggle 读的是**当前**状态，
    // 第二次 toggle 必须看到第一次写进去的 collapsed。
    mockState.updateNode.mockImplementation(async (id, data) => {
      const current = store.getSnapshot()
      store.setState({
        ...current,
        nodes: current.nodes.map((n) => (n.id === id ? { ...n, ...data } : n)),
      })
    })
  })

  it('hides the whole subtree when a node is collapsed', () => {
    mockState.nodes = makeChain().map((n) => (n.id === 'm1' ? { ...n, collapsed: true } : n))

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
    mockState.nodes = makeChain().map((n) => (n.id === 'm1' ? { ...n, collapsed: true } : n))

    const { result } = renderHook(() => useCollapse())

    expect([...result.current.collapsedIds]).toEqual(['m1'])
    expect(result.current.isCollapsed('m1')).toBe(true)
    expect(result.current.isCollapsed('c1')).toBe(false)
  })

  it('does not hang on a cycle in legacy parent links', () => {
    // a → b → a 成环 —— 历史脏数据不能把画布拖死
    mockState.nodes = makeCyclicNodes()

    const { result } = renderHook(() => useCollapse())

    expect(result.current.visibleNodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
  })

  // ── 复审修复轮 1 ──────────────────────────────────────────────

  it('keeps a collapsed node visible when legacy parent links form a cycle', () => {
    const nodes = makeCyclicNodes('a')
    mockState.nodes = nodes

    const { result } = renderHook(() => useCollapse())

    // 折叠节点自己必须还在 —— 用户能点到的折叠按钮，点完不能把按钮本身点没了。
    // 折叠态是**落库**的，它要是被藏起来，重开应用就再也展不开。
    expect(result.current.visibleNodes.map((n) => n.id)).toContain('a')
    // 徽标数字必须等于实际被藏起来的节点数（用两个集合相减算，不写死数字）
    const actuallyHidden = nodes.length - result.current.visibleNodes.length
    expect(result.current.hiddenDescendantCount('a')).toBe(actuallyHidden)
  })

  it('does not depend on which node of the cycle is collapsed', () => {
    const nodes = makeCyclicNodes('b')
    mockState.nodes = nodes

    const { result } = renderHook(() => useCollapse())

    expect(result.current.visibleNodes.map((n) => n.id)).toContain('b')
    const actuallyHidden = nodes.length - result.current.visibleNodes.length
    expect(result.current.hiddenDescendantCount('b')).toBe(actuallyHidden)
  })

  it('handles a 20000-level deep chain without blowing the stack', () => {
    // ⚠️ 这条测试钉的是**复杂度**，不只是「不爆栈」。
    //
    // 修复前那版实现（865854f）给**每个节点各走一遍完整的祖先链**
    // （`hasCollapsedAncestor`）→ O(n × 深度)。2000 层只要约 2×10⁶ 步，
    // 照样能过 —— 也就是说仓库里没有任何东西能挡住实现退化回 O(n × 深度)。
    //
    // 20000 层把两件事一起钉住：
    // - **复杂度**：O(n × 深度) ≈ 2×10⁸ 步 → 实测 9882 ms → 下面的显式耗时断言必红；
    // - **爆栈**：V8 的调用栈大约 1 万帧 —— 2000 层递归不会炸，20000 层会炸。
    //
    // 好的实现（一趟向下 DFS + 一趟反序累加）约 15–30 ms → 对 1000 ms 的阈值
    // 有 30–60 倍余量，CI 慢机也不会误报。
    const depth = 20000
    const nodes: GraphNode[] = []
    for (let i = 0; i < depth; i++) {
      nodes.push(makeNode(`n${i}`, i === 0 ? undefined : `n${i - 1}`))
    }
    mockState.nodes = nodes

    const startedAt = Date.now()
    const { result } = renderHook(() => useCollapse())
    const elapsed = Date.now() - startedAt

    expect(result.current.visibleNodes).toHaveLength(depth)
    expect(result.current.hiddenDescendantCount('n0')).toBe(depth - 1)
    // 显式断言耗时：不只靠 vitest 的 5 秒超时 —— 超时的失败信息是一句干巴巴的
    // 「Test timed out in 5000ms」，看不出是复杂度退化；这条断言的失败信息
    // 直接指向「复杂度」。
    expect(elapsed).toBeLessThan(1000)
  })

  it('re-renders with the new nodes when the store changes', () => {
    mockState.nodes = [makeNode('p1'), makeNode('m1', 'p1')]
    const { result } = renderHook(() => useCollapse())
    expect(result.current.visibleNodes.map((n) => n.id)).toEqual(['p1', 'm1'])

    // store 变了 → 订阅者被叫醒 → 组件重渲染 → visibleNodes 跟着变。
    // 实现如果误用 getState() 在渲染期读节点（没有订阅），这里不会变。
    act(() => {
      mockState.nodes = [makeNode('p1'), makeNode('m1', 'p1'), makeNode('c1', 'm1')]
    })
    expect(result.current.visibleNodes.map((n) => n.id)).toEqual(['p1', 'm1', 'c1'])

    act(() => {
      mockState.nodes = [
        makeNode('p1'),
        makeNode('m1', 'p1', true),
        makeNode('c1', 'm1'),
      ]
    })
    expect(result.current.visibleNodes.map((n) => n.id)).toEqual(['p1', 'm1'])
  })

  it('keeps the toggle reference stable across re-renders', () => {
    mockState.nodes = [makeNode('p1'), makeNode('m1', 'p1')]
    const { result } = renderHook(() => useCollapse())

    const toggleBefore = result.current.toggle

    // 折叠集合变了 —— 实现如果写成 useCallback([collapsedIds])，引用就会换新，
    // 注入 flowNode.data 的回调每帧换新 → 缓存键算不出它 → 节点对象反复重建。
    act(() => {
      mockState.nodes = [makeNode('p1'), makeNode('m1', 'p1', true)]
    })

    expect(result.current.collapsedIds.has('m1')).toBe(true) // 确认状态确实变了
    expect(result.current.toggle).toBe(toggleBefore)
  })
})
