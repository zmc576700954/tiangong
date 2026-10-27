// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReparentDrag } from '../useReparentDrag'
import type { GraphNode, NodeTypeConfig } from '@shared/types'

/**
 * store mock 必须是 **selector 形式**（useGraphStore((s) => s.nodes)）。
 * 隔壁 useNodePositionPersistence.test.ts 用的是 getState 形式 ——
 * 照抄会直接报 `useGraphStore is not a function`。
 */
const { mockState, mockConfigs } = vi.hoisted(() => ({
  mockState: {
    nodes: [] as unknown[],
    reparentNode: vi.fn(),
    batchUpdatePositions: vi.fn(),
  },
  mockConfigs: {
    configs: {} as Record<string, unknown>,
    loaded: true,
  },
}))

vi.mock('../../../store/graphStore', () => ({
  useGraphStore: (selector: (s: unknown) => unknown) => selector(mockState),
}))

// 类型规则的唯一权威在主进程；渲染端只能通过这个 hook 拿。
// mock 掉它才能直接把 loaded 设成 true / false、把 configs 设成空表。
vi.mock('../useNodeTypeConfigs', () => ({
  useNodeTypeConfigs: () => mockConfigs,
}))

/**
 * 规则表：形状与主进程 nodeTypeRegistry 一致（allowedChildTypes 一定有值，
 * allowedParentTypes 可以缺省）。
 *
 * 取值上让 module 允许 feature 子节点、feature 允许 module 父节点，
 * 这样「feature-a 拖到 module-b」是一个**合法**落点 ——
 * 非法落点的用例改用 feature → feature（父侧 allowedChildTypes 不含 feature）。
 */
const RULES: Record<string, NodeTypeConfig> = {
  project: { type: 'project', label: '项目', allowedChildTypes: ['module'] },
  module: {
    type: 'module',
    label: '模块',
    allowedParentTypes: ['project'],
    allowedChildTypes: ['process', 'feature'],
  },
  process: {
    type: 'process',
    label: '流程',
    allowedParentTypes: ['module'],
    allowedChildTypes: ['feature', 'bug'],
  },
  feature: {
    type: 'feature',
    label: '功能',
    allowedParentTypes: ['process', 'module'],
    allowedChildTypes: ['bug'],
  },
  bug: {
    type: 'bug',
    label: 'BUG',
    allowedParentTypes: ['process', 'feature'],
    allowedChildTypes: [],
  },
}

function makeNode(partial: Partial<GraphNode> & Pick<GraphNode, 'id' | 'type'>): GraphNode {
  return {
    title: partial.id,
    status: 'draft',
    graphId: 'graph-1',
    graphType: 'online',
    position: { x: 0, y: 0 },
    acceptanceCriteria: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

/**
 * 命中判定用的是 force-layout 的节点尺寸估算（NODE_SIZES）：
 *   feature 160×60 / module 200×80 / process 180×70
 * 标题够短时宽度取基准宽，所以下面的指针坐标是**确定命中**的，不是「大概」。
 */
const NODES: GraphNode[] = [
  makeNode({ id: 'feature-a', type: 'feature', position: { x: 0, y: 0 }, parentId: 'process-x' }),
  makeNode({ id: 'module-b', type: 'module', position: { x: 400, y: 0 } }),
  makeNode({ id: 'feature-c', type: 'feature', position: { x: 800, y: 0 }, parentId: 'module-b' }),
  makeNode({ id: 'module-d', type: 'module', position: { x: 1200, y: 0 }, graphId: 'graph-2' }),
  makeNode({ id: 'process-x', type: 'process', position: { x: -400, y: 0 } }),
]

/** 落在 module-b 矩形内（x ∈ [400,600]、y ∈ [0,80]） */
const ON_MODULE_B = { x: 450, y: 40 }
/** 落在 feature-c 矩形内（x ∈ [800,960]、y ∈ [0,60]） */
const ON_FEATURE_C = { x: 850, y: 30 }
/** 落在 module-d 矩形内（x ∈ [1200,1400]、y ∈ [0,80]） */
const ON_MODULE_D = { x: 1250, y: 30 }
/** 空白处 */
const ON_EMPTY = { x: 500, y: 500 }

describe('useReparentDrag', () => {
  beforeEach(() => {
    mockState.reparentNode.mockReset()
    mockState.reparentNode.mockResolvedValue(undefined)
    mockState.batchUpdatePositions.mockReset()
    mockState.batchUpdatePositions.mockResolvedValue(undefined)
    mockState.nodes = NODES
    mockConfigs.configs = RULES
    mockConfigs.loaded = true
  })

  it('rejects a candidate that is a descendant of the dragged node', () => {
    // module-b → feature-c（feature-c.parentId === 'module-b'）= 挂到自己的子节点下
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('module-b') })
    act(() => { result.current.onDrag(ON_FEATURE_C) })

    expect(result.current.candidate).toEqual({
      nodeId: 'feature-c',
      valid: false,
      reason: 'cycle',
    })
  })

  it('rejects a candidate whose type is not allowed as parent', () => {
    // feature → feature：父侧 allowedChildTypes 不含 feature
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_FEATURE_C) })

    expect(result.current.candidate).toEqual({
      nodeId: 'feature-c',
      valid: false,
      reason: 'type',
    })
  })

  it('rejects a candidate in another graph', () => {
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_MODULE_D) })

    expect(result.current.candidate).toEqual({
      nodeId: 'module-d',
      valid: false,
      reason: 'cross-graph',
    })
  })

  it('accepts a valid candidate', () => {
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_MODULE_B) })

    expect(result.current.candidate).toEqual({
      nodeId: 'module-b',
      valid: true,
    })
  })

  it('returns null candidate when pointer is on empty space', () => {
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_EMPTY) })

    expect(result.current.candidate).toBeNull()
  })

  it('returns null candidate while the type rule table has not loaded', () => {
    // 规则表还没回来时不做任何判定 —— 照常判定会把所有落点判成 type 不合法，
    // 给用户一个错误的红框。
    mockConfigs.loaded = false
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_MODULE_B) })

    expect(result.current.candidate).toBeNull()
  })

  it('returns null candidate when the type rule table is empty', () => {
    // 空表 = 规则**不可用**（IPC 失败），不是「所有类型都非法」——
    // 没有规则就没有红框。
    mockConfigs.configs = {}
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_MODULE_B) })

    expect(result.current.candidate).toBeNull()
  })

  it('does not call reparentNode when the candidate is illegal', async () => {
    // 非法落点 → 只做「普通移动」，绝不能调 graph:reparent
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    await act(async () => { result.current.onDragEnd(ON_FEATURE_C) })

    expect(mockState.reparentNode).not.toHaveBeenCalled()
  })

  it('calls reparentNode with the dragged node and the candidate', async () => {
    // 合法落点 → 调 graph:reparent(draggingNodeId, candidate.nodeId)
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    await act(async () => { result.current.onDragEnd(ON_MODULE_B) })

    expect(mockState.reparentNode).toHaveBeenCalledWith('feature-a', 'module-b')
  })

  it('rolls the node back to its original position when the reparent fails', async () => {
    mockState.reparentNode.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    await act(async () => { result.current.onDragEnd(ON_MODULE_B) })

    expect(mockState.batchUpdatePositions).toHaveBeenCalledWith([
      { id: 'feature-a', x: 0, y: 0 },
    ])
  })
})
