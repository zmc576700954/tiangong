// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useNodeOperations } from '../useNodeOperations'
import { useToastStore } from '../../../lib/toast'

const { mockState } = vi.hoisted(() => ({
  mockState: {
    nodes: [] as unknown[],
    createNode: vi.fn(),
    createEdge: vi.fn(),
    updateNode: vi.fn(),
  },
}))

// useNodeOperations 用的是 **selector 形式**的 store（useGraphStore((state) => state.nodes)），
// 不是 getState 形式 —— mock 成 { getState: vi.fn() } 会直接报 useGraphStore is not a function。
vi.mock('../../../store/graphStore', () => ({
  useGraphStore: (selector: (s: unknown) => unknown) => selector(mockState),
}))

// 没有 <ReactFlowProvider /> 时 useReactFlow() 会抛 —— 必须 mock 掉。
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ screenToFlowPosition: (p: { x: number; y: number }) => p }),
}))

describe('useNodeOperations — 补建层级边', () => {
  // createNode 的桩必须**每次调用返回不同的 id** ——
  // 否则「两条边共用同一个 target」这种错法也是绿的。
  let nodeSeq = 0

  beforeEach(() => {
    vi.clearAllMocks()
    mockState.nodes = []
    nodeSeq = 0
    mockState.createNode.mockImplementation(async () => ({ id: `child${++nodeSeq}` }))
    mockState.createEdge.mockResolvedValue({ id: 'edge1' })
  })

  it('creates a hierarchical edge when adding a child', async () => {
    const { result } = renderHook(() => useNodeOperations('g1'))
    await result.current.handleAddChild('parent1', 'module')

    expect(mockState.createNode).toHaveBeenCalledTimes(1)
    expect(mockState.createNode.mock.calls[0][0]).toMatchObject({ parentId: 'parent1' })
    expect(mockState.createEdge).toHaveBeenCalledTimes(1)
    expect(mockState.createEdge.mock.calls[0][0]).toMatchObject({
      source: 'parent1',
      target: 'child1',
      edgeType: 'hierarchical',
    })
  })

  it('creates a hierarchical edge for each AI-generated child', async () => {
    mockState.nodes = [{ id: 'parent1', title: 'P', type: 'module', position: { x: 0, y: 0 } }]
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      'mindmap:generateModule': vi.fn().mockResolvedValue({
        children: [{ title: 'C1' }, { title: 'C2' }],
        childType: 'process',
      }),
    }
    const { result } = renderHook(() => useNodeOperations('g1', '/proj'))
    await result.current.handleGenerateChildren('parent1')

    expect(mockState.createNode).toHaveBeenCalledTimes(2)
    expect(mockState.createEdge).toHaveBeenCalledTimes(2)
    expect(mockState.createEdge.mock.calls[0][0]).toMatchObject({
      source: 'parent1',
      target: 'child1',
      edgeType: 'hierarchical',
    })
    // 每条边必须指向**各自**的孩子 —— 两条边共用一个 target 就是错的
    expect(mockState.createEdge.mock.calls[1][0].target).not.toBe(
      mockState.createEdge.mock.calls[0][0].target,
    )
    expect(mockState.createEdge.mock.calls[1][0]).toMatchObject({
      source: 'parent1',
      target: 'child2',
      edgeType: 'hierarchical',
    })
  })

  // F11：createNode 失败时不能变成 unhandled rejection。
  //
  // onAddChild 的类型是 (parentId: string, childType: NodeType) => void ——
  // NodeContextMenu.tsx:101 的 `onClick={() => onAddChild(nodeId, type)}` 既不 await
  // 也不 catch。这里刻意**不 await** 返回的 promise，模拟真实调用方：
  // 实现没兜住 createNode 的失败时，被丢弃的 promise 会被 Node 判成「未处理的拒绝」。
  it('does not produce an unhandled rejection when createNode fails', async () => {
    const rejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockState.createNode.mockRejectedValue(new Error('createNode boom'))

    try {
      const { result } = renderHook(() => useNodeOperations('g1'))
      // 刻意不 await —— 真实调用方（NodeContextMenu）也不 await
      void result.current.handleAddChild('parent1', 'module')
      // 让微任务队列跑完，并给 Node 判定「未处理的拒绝」的机会
      await new Promise((resolve) => setImmediate(resolve))

      expect(rejections).toHaveLength(0)
      // 失败被记了日志（不是静默吞掉）
      expect(consoleError).toHaveBeenCalled()
      // 节点都没建出来，绝不能拿 undefined 的 id 去建边
      expect(mockState.createEdge).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      consoleError.mockRestore()
    }
  })
})

// ============================================================
// 静默失败归零（Task 9）：失败给出 error toast，但正确逻辑不许动
// ============================================================

describe('useNodeOperations — 建节点/建边失败不再静默', () => {
  let nodeSeq = 0

  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.getState().clear()
    mockState.nodes = []
    nodeSeq = 0
    mockState.createNode.mockImplementation(async () => ({ id: `child${++nodeSeq}` }))
    mockState.createEdge.mockResolvedValue({ id: 'edge1' })
  })

  it('createNode 失败 → error toast，且绝不建边', async () => {
    mockState.createNode.mockRejectedValueOnce(new Error('createNode boom'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { result } = renderHook(() => useNodeOperations('g1'))
      await result.current.handleAddChild('parent1', 'module')

      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0].title).toContain('新建节点失败')
      expect(errors[0].message).toContain('createNode boom')
      expect(useToastStore.getState().toasts.filter((t) => t.kind === 'success')).toHaveLength(0)

      // 现有正确逻辑必须钉住：建节点失败就拿不到 created.id，
      // 绝不能去建边（会造出一条指向不存在节点的边）
      expect(mockState.createEdge).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('createNode 成功但层级边失败 → error toast（节点已建成、图上少了一根线）', async () => {
    mockState.createEdge.mockRejectedValueOnce(new Error('edge boom'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { result } = renderHook(() => useNodeOperations('g1'))
      await result.current.handleAddChild('parent1', 'module')

      // 节点确实建成了 —— 失败的只是那条层级边
      expect(mockState.createNode).toHaveBeenCalledTimes(1)

      const errors = useToastStore.getState().toasts.filter((t) => t.kind === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0].title).toContain('创建层级连线失败')
      expect(errors[0].message).toContain('edge boom')
      expect(useToastStore.getState().toasts.filter((t) => t.kind === 'success')).toHaveLength(0)
    } finally {
      consoleError.mockRestore()
    }
  })
})
