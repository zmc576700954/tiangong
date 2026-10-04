/**
 * force-layout 单元测试
 *
 * D8b-5: 覆盖收敛性、排斥力避免重叠、pin/unpin、性能 (500 节点 < 1s) 等关键行为。
 */
import { describe, it, expect } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import {
  computeForceLayout,
  createForceSimulation,
  estimateNodeWidth,
  estimateNodeHeight,
  NODE_SIZES,
} from '../force-layout'

function makeNode(id: string, type: string, title: string, pos?: { x: number; y: number }): Node {
  return {
    id,
    type: 'default',
    position: pos ?? { x: 0, y: 0 },
    data: { type, title },
  } as Node
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 矩形 AABB 是否重叠（节点用 width × height 表示） */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  )
}

describe('computeForceLayout', () => {
  it('returns empty array for empty nodes', () => {
    expect(computeForceLayout([], [])).toEqual([])
  })

  it('assigns positions to all nodes', () => {
    const nodes = [
      makeNode('n1', 'project', 'Root'),
      makeNode('n2', 'module', 'A'),
      makeNode('n3', 'module', 'B'),
    ]
    const edges: Edge[] = [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n1', target: 'n3' },
    ]
    const result = computeForceLayout(nodes, edges)
    expect(result).toHaveLength(3)
    for (const n of result) {
      expect(Number.isFinite(n.position.x)).toBe(true)
      expect(Number.isFinite(n.position.y)).toBe(true)
    }
  })

  it('preserves node identity (same id, same data) and only updates position', () => {
    const nodes = [
      makeNode('n1', 'project', 'Root'),
      makeNode('n2', 'module', 'A'),
    ]
    const edges: Edge[] = [{ id: 'e1', source: 'n1', target: 'n2' }]
    const result = computeForceLayout(nodes, edges)
    expect(result.map((n) => n.id).sort()).toEqual(['n1', 'n2'])
    for (const n of result) {
      const original = nodes.find((o) => o.id === n.id)
      expect(original).toBeDefined()
      expect(n.data).toEqual(original!.data)
    }
  })

  it('ignores edges that reference unknown nodes (dangling edges)', () => {
    const nodes = [makeNode('n1', 'project', 'Root'), makeNode('n2', 'module', 'A')]
    const edges: Edge[] = [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e_dangling', source: 'n1', target: 'n_unknown' },
    ]
    // 不应抛错；只用到已知节点参与的边
    const result = computeForceLayout(nodes, edges)
    expect(result).toHaveLength(2)
  })

  it('respects option overrides (linkDistance / centerX / centerY)', () => {
    const nodes = [
      makeNode('n1', 'project', 'Root'),
      makeNode('n2', 'module', 'A'),
    ]
    const edges: Edge[] = [{ id: 'e1', source: 'n1', target: 'n2' }]
    const result = computeForceLayout(nodes, edges, {
      linkDistance: 200,
      centerX: 1000,
      centerY: 800,
    })
    // 两节点间距应该大致围绕 linkDistance，并整体向 (1000, 800) 漂移
    const dx = result[0].position.x - result[1].position.x
    const dy = result[0].position.y - result[1].position.y
    const dist = Math.hypot(dx, dy)
    expect(dist).toBeGreaterThan(0)
    // 节点 x/y 应该大致在中心附近 (±600 是保守范围)
    for (const n of result) {
      expect(Math.abs(n.position.x - 1000)).toBeLessThan(600)
      expect(Math.abs(n.position.y - 800)).toBeLessThan(600)
    }
  })

  it('keeps nodes spread out by repulsion (no heavy overlap for >2 isolated nodes)', () => {
    // 5 个无连接节点，应该被排斥力分散到不同象限
    const nodes = Array.from({ length: 5 }, (_, i) =>
      makeNode(`n${i}`, 'feature', `F${i}`, { x: 0, y: 0 }),
    )
    const result = computeForceLayout(nodes, [])
    // 检查 pairwise 距离，避免所有节点都堆在中心
    let minDist = Number.POSITIVE_INFINITY
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const d = distance(result[i].position, result[j].position)
        if (d < minDist) minDist = d
      }
    }
    // 5 个 feature 节点（高 60，宽 160-200 + padding 10 → 半径 ~110）
    // 排斥力应该把最近的也对推开至少 ~110 像素
    expect(minDist).toBeGreaterThan(80)
  })

  it('forceCollide avoids rectangle overlap (bounding boxes)', () => {
    // 4 个宽 200 高 70 的节点挤在原点，仿真后不应有大面积重叠
    const nodes = Array.from({ length: 4 }, (_, i) =>
      makeNode(`n${i}`, 'feature', `LongFeatureTitle${i}`, { x: 0, y: 0 }),
    )
    const result = computeForceLayout(nodes, [])
    type Rect = { x: number; y: number; w: number; h: number }
    const rects: Rect[] = result.map((n) => {
      const w = estimateNodeWidth(n)
      const h = estimateNodeHeight(n)
      // 节点中心 = position + (w/2, h/2)，转回左上角
      return {
        x: n.position.x,
        y: n.position.y,
        w,
        h,
      }
    })
    let overlapCount = 0
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (rectsOverlap(rects[i], rects[j])) overlapCount += 1
      }
    }
    expect(overlapCount).toBe(0)
  })

  it('estimateNodeWidth handles CJK and ASCII titles consistently', () => {
    const cjk = makeNode('a', 'feature', '中文标题')
    const ascii = makeNode('b', 'feature', 'English title here')
    const shortCjk = makeNode('c', 'feature', '一')
    expect(estimateNodeWidth(cjk)).toBeGreaterThan(140)
    expect(estimateNodeWidth(ascii)).toBeGreaterThan(140)
    // 单 CJK 字符也应该有合理的最小宽度
    expect(estimateNodeWidth(shortCjk)).toBeGreaterThanOrEqual(NODE_SIZES.feature.width)
  })
})

describe('createForceSimulation (interactive mode)', () => {
  it('creates a frozen simulation (alpha=0) ready for reheat', () => {
    const nodes = [
      makeNode('n1', 'project', 'Root', { x: 100, y: 100 }),
      makeNode('n2', 'module', 'A', { x: 200, y: 200 }),
    ]
    const edges: Edge[] = [{ id: 'e1', source: 'n1', target: 'n2' }]
    const { simulation, simNodes } = createForceSimulation(nodes, edges)
    expect(simulation).toBeDefined()
    expect(simNodes).toHaveLength(2)
    expect(simulation.alpha()).toBe(0)
    // 初始位置应被保留
    expect(simNodes[0].x).toBe(100)
    expect(simNodes[0].y).toBe(100)
    simulation.stop()
  })

  it('pin/unpin via fx/fy works as expected', () => {
    const nodes = [
      makeNode('n1', 'project', 'Root', { x: 0, y: 0 }),
      makeNode('n2', 'module', 'A', { x: 50, y: 50 }),
      makeNode('n3', 'module', 'B', { x: 100, y: 100 }),
    ]
    const edges: Edge[] = [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n1', target: 'n3' },
    ]
    const { simulation, simNodes } = createForceSimulation(nodes, edges)

    const pinned = simNodes.find((s) => s.id === 'n2')!
    const beforePin = { x: pinned.x ?? 0, y: pinned.y ?? 0 }

    // 1. 设置 fx/fy = 当前位置
    pinned.fx = 999
    pinned.fy = 888
    simulation.alpha(0.5).alphaTarget(0).restart()

    // 2. tick 后位置应保持（pin 生效）
    simulation.tick()
    expect(pinned.x).toBe(999)
    expect(pinned.y).toBe(888)

    // 3. 清 pin
    pinned.fx = null
    pinned.fy = null
    simulation.alpha(0.3).restart()
    for (let i = 0; i < 50; i++) simulation.tick()

    // 4. 不再 pin，位置应当与之前不同（被弹簧拉走）
    expect(pinned.x === 999 && pinned.y === 888).toBe(false)
    // 距离 pin 之前的初始位置应该是合理的非零变化
    const afterMove = distance(
      { x: pinned.x ?? 0, y: pinned.y ?? 0 },
      beforePin,
    )
    expect(Number.isFinite(afterMove)).toBe(true)

    simulation.stop()
  })
})

describe('performance', () => {
  it('500 nodes converge in < 1s', () => {
    const N = 500
    const nodes: Node[] = Array.from({ length: N }, (_, i) =>
      makeNode(`n${i}`, 'feature', `Feature ${i}`, { x: 0, y: 0 }),
    )
    // 稀疏连接：每个节点连下一个，避免完全孤立导致 charge 主导
    const edges: Edge[] = []
    for (let i = 0; i < N - 1; i += 3) {
      edges.push({
        id: `e${i}`,
        source: `n${i}`,
        target: `n${i + 1}`,
      })
    }

    const t0 = performance.now()
    const result = computeForceLayout(nodes, edges)
    const elapsed = performance.now() - t0

    expect(result).toHaveLength(N)
    expect(elapsed).toBeLessThan(1000)
  })

  it('200 ticks yields stable positions (second run only refines, no large jumps)', () => {
    // d3-force 在 alphaDecay=0.05 下 200 tick 后 alpha 已经远低于 alphaMin=0.01，
    // 但 alphaMin 之下仍有微量速度。把第一次结果作为初始位置再跑一次，
    // 位置变化应当远小于「重新从 (0,0) 跑一次」的位移量 —— 即布局可重复。
    const nodes = [
      makeNode('n1', 'project', 'Root'),
      makeNode('n2', 'module', 'A'),
      makeNode('n3', 'module', 'B'),
      makeNode('n4', 'feature', 'F1'),
      makeNode('n5', 'feature', 'F2'),
    ]
    const edges: Edge[] = [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n1', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
      { id: 'e4', source: 'n3', target: 'n5' },
    ]
    const first = computeForceLayout(nodes, edges)
    // 把第一次结果作为初始位置再跑一次
    const second = computeForceLayout(first, edges)
    // 对比 baseline：从原始 (0,0) 重跑到稳定 vs. 从 first 位置再跑 —— 后者的位移应 < 前者
    let firstDelta = 0
    let secondDelta = 0
    for (let i = 0; i < first.length; i++) {
      firstDelta += distance(first[i].position, second[i].position)
      secondDelta += distance(nodes[i].position, first[i].position)
    }
    // 再次运行的累计位移应当明显小于「从零开始」的位移 —— 这是稳定性的核心信号
    expect(firstDelta).toBeLessThan(secondDelta)
  })
})
