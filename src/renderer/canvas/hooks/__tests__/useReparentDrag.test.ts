// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  checkTypeRule,
  extractPointerClientPoint,
  REPARENT_SUPPRESSION_TIMEOUT_MS,
  useReparentDrag,
} from '../useReparentDrag'
// 出厂规则表（主进程唯一权威）。这个模块只依赖 @shared/types 与一个纯类型文件，不碰 electron，
// 渲染端的镜像判定必须跟它逐条一致 —— 否则就是「画布说能挂、主进程拒掉」。
import { nodeTypeRegistry } from '@main/shared/node-type-registry'
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

/** 出厂规则表（已归一化：allowedChildTypes 一定有值，allowedParentTypes 保留缺省语义） */
const REAL_RULES: Record<string, NodeTypeConfig> = Object.fromEntries(
  nodeTypeRegistry.listConfigs().map((c) => [c.type, c]),
)

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
  // 重叠的一对：overlap-a 占 [2000,2160]、overlap-b 占 [2100,2260] → 2130 同时命中两者
  makeNode({ id: 'overlap-a', type: 'feature', position: { x: 2000, y: 0 } }),
  makeNode({ id: 'overlap-b', type: 'bug', position: { x: 2100, y: 0 } }),
  // 出厂规则表下的合法落点用例：feature → process
  makeNode({ id: 'real-feature', type: 'feature', position: { x: 3000, y: 0 } }),
]

/** 落在 module-b 矩形内（x ∈ [400,600]、y ∈ [0,80]） */
const ON_MODULE_B = { x: 450, y: 40 }
/** 落在 feature-c 矩形内（x ∈ [800,960]、y ∈ [0,60]） */
const ON_FEATURE_C = { x: 850, y: 30 }
/** 落在 module-d 矩形内（x ∈ [1200,1400]、y ∈ [0,80]） */
const ON_MODULE_D = { x: 1250, y: 30 }
/** 空白处 */
const ON_EMPTY = { x: 500, y: 500 }
/** 落在 feature-a **自己**的矩形内（x ∈ [0,160]、y ∈ [0,60]） */
const ON_OWN_RECT = { x: 50, y: 30 }
/** 落在 overlap-a 与 overlap-b 的重叠区（x ∈ [2100,2160]、y ∈ [0,60]） */
const ON_OVERLAP = { x: 2130, y: 30 }
/** 落在 process-x 矩形内（x ∈ [-400,-220]、y ∈ [0,70]） */
const ON_PROCESS_X = { x: -350, y: 30 }

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

  it('never treats the dragged node itself as a drop candidate', () => {
    // 拖拽时指针必然落在被拖节点自己的矩形里 —— 它必须被排除，
    // 否则每个落点都会被它自己吃掉。
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_OWN_RECT) })

    expect(result.current.candidate).toBeNull()
  })

  it('picks the later node when two nodes overlap under the pointer', () => {
    // store 的数组顺序即渲染顺序，后者在上面 → 命中重叠区时取靠后的那个
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('feature-a') })
    act(() => { result.current.onDrag(ON_OVERLAP) })

    expect(result.current.candidate?.nodeId).toBe('overlap-b')
  })

  it('accepts feature under process under the shipping rule table', () => {
    // 出厂规则表：process.allowedChildTypes 含 feature ✓、feature.allowedParentTypes 含 process ✓
    mockConfigs.configs = REAL_RULES
    const { result } = renderHook(() => useReparentDrag())

    act(() => { result.current.onDragStart('real-feature') })
    act(() => { result.current.onDrag(ON_PROCESS_X) })

    expect(result.current.candidate).toEqual({ nodeId: 'process-x', valid: true })
  })

  it('mirrors the shipping registry: a feature cannot be mounted under a module', () => {
    // fixture 用的表把 feature → module 放行了，出厂表不允许 ——
    // 渲染端的镜像必须跟出厂表一致，否则就是「画布说能挂、主进程拒掉」。
    expect(checkTypeRule(REAL_RULES, 'process', 'feature')).toBe(true)
    expect(checkTypeRule(REAL_RULES, 'module', 'feature')).toBe(false)
  })

  it('releases a stale position suppression when the node is dragged again', () => {
    // 上一次拖拽的 IPC 若一直没落定，抑制会留在集合里 → 该节点再也自由移动不了。
    // 用户再拖一次就该恢复。
    const releasePositions = vi.fn()
    const { result } = renderHook(() => useReparentDrag({ releasePositions }))

    act(() => { result.current.onDragStart('feature-a') })

    expect(releasePositions).toHaveBeenCalledWith(['feature-a'])
  })

  it('releases the position suppression when the reparent IPC never settles', async () => {
    vi.useFakeTimers()
    try {
      const releasePositions = vi.fn()
      // 永不落定的 IPC
      mockState.reparentNode.mockReturnValueOnce(new Promise(() => {}))
      const { result } = renderHook(() => useReparentDrag({ releasePositions }))

      act(() => { result.current.onDragStart('feature-a') })
      // onDragStart 会解除上一次残留的抑制 —— 那不是本次要断言的
      releasePositions.mockClear()
      await act(async () => { result.current.onDragEnd(ON_MODULE_B) })

      expect(releasePositions).not.toHaveBeenCalled()

      act(() => { vi.advanceTimersByTime(REPARENT_SUPPRESSION_TIMEOUT_MS) })

      expect(releasePositions).toHaveBeenCalledWith(['feature-a'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('extractPointerClientPoint', () => {
  it('reads clientX/clientY from a mouse event', () => {
    const event = new MouseEvent('mousemove', { clientX: 12, clientY: 34 })
    expect(extractPointerClientPoint(event)).toEqual({ x: 12, y: 34 })
  })

  it('reads the first touch from a touch event', () => {
    const event = { touches: [{ clientX: 5, clientY: 6 }], changedTouches: [] } as unknown as TouchEvent
    expect(extractPointerClientPoint(event)).toEqual({ x: 5, y: 6 })
  })

  it('falls back to changedTouches when touches is empty (touchend)', () => {
    // touchend 时 touches 已经空了，最后的触点只在 changedTouches 里
    const event = { touches: [], changedTouches: [{ clientX: 7, clientY: 8 }] } as unknown as TouchEvent
    expect(extractPointerClientPoint(event)).toEqual({ x: 7, y: 8 })
  })

  it('returns null when the event carries no usable point', () => {
    const event = { touches: [], changedTouches: [] } as unknown as TouchEvent
    expect(extractPointerClientPoint(event)).toBeNull()
  })
})
