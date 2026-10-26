/**
 * d3-force 力导向布局引擎
 *
 * D8a 树形布局（dagre）适合 project → module → process → feature 的层级图，
 * 但基座版 graph 是 heterogeneous 的：模块间有 cross-reference、feature 有依赖。
 * D8b 加力导向布局（d3-force） — 节点按边关系 + 排斥力自动均衡。
 *
 * 用法：
 * - 一键布局：`computeForceLayout(nodes, edges)` 同步 200 tick 后返回定位后的 nodes
 * - 交互模式：`createForceSimulation(...)` 返回仿真实例，配合拖拽事件实现 pin / reheat
 */
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { Node, Edge } from '@xyflow/react'
import type { NodeType } from '@shared/types'

/** 每种节点类型的基准尺寸，与 `layout.ts` 的 dagre 实现保持一致 */
export const NODE_SIZES: Record<NodeType, { width: number; height: number }> = {
  project: { width: 220, height: 90 },
  module:  { width: 200, height: 80 },
  process: { width: 180, height: 70 },
  feature: { width: 160, height: 60 },
  bug:     { width: 160, height: 60 },
  'wiki-page': { width: 180, height: 70 },
}

/** 仿真节点 datum —— 在 d3-force 内部流动的位置对象 */
export interface ForceNodeDatum extends SimulationNodeDatum {
  id: string
  /** 节点真实尺寸（用于 collide 半径） */
  width: number
  height: number
}

/** 仿真链接 datum —— 由 forceLink 在内部把 source/target 替换为 ForceNodeDatum 引用 */
export interface ForceLinkDatum extends SimulationLinkDatum<ForceNodeDatum> {
  source: string | ForceNodeDatum
  target: string | ForceNodeDatum
}

/**
 * 根据标题长度估算实际节点宽度（与 dagre 实现保持一致）
 * BizNode 有 min-w-[140px] max-w-[200px]，中文约 14px/字
 */
export function estimateNodeWidth(node: Node): number {
  const nodeType = (node.data as Record<string, unknown>)?.type as NodeType
  const base = NODE_SIZES[nodeType] ?? NODE_SIZES.feature
  const title = String((node.data as Record<string, unknown>)?.title ?? '')
  const cjkCount = (title.match(/[一-鿿]/g) || []).length
  const otherCount = title.length - cjkCount
  const textWidth = cjkCount * 14 + otherCount * 8 + 32
  return Math.max(base.width, Math.min(200, textWidth))
}

export function estimateNodeHeight(node: Node): number {
  const nodeType = (node.data as Record<string, unknown>)?.type as NodeType
  return (NODE_SIZES[nodeType] ?? NODE_SIZES.feature).height
}

export interface ForceLayoutOptions {
  /** 边作为弹簧的静止距离 */
  linkDistance?: number
  /** 节点间排斥力强度（负值） */
  chargeStrength?: number
  /** 画布中心 x —— forceCenter 把整体拉向此点 */
  centerX?: number
  /** 画布中心 y */
  centerY?: number
  /** 节点不重叠的额外 padding（碰撞半径 = nodeSize/2 + padding） */
  collisionPadding?: number
  /** alpha 衰减速度；越大冷却越快。0.05 ≈ 200 tick 收敛 */
  alphaDecay?: number
  /** 同步 tick 次数 */
  ticks?: number
  /** 是否保留已有节点位置作为初始 guess（true 时只重排有边相连的节点） */
  preserveInitialPositions?: boolean
}

const DEFAULT_OPTIONS: Required<ForceLayoutOptions> = {
  linkDistance: 80,
  chargeStrength: -300,
  centerX: 400,
  centerY: 300,
  collisionPadding: 10,
  alphaDecay: 0.05,
  ticks: 200,
  preserveInitialPositions: true,
}

/**
 * 一键式力导向布局：同步跑 N tick 后返回新位置的 nodes。
 *
 * 不修改入参，返回新的 nodes 数组（保持原引用 id 等元数据）。
 * 边作为弹簧、节点相互排斥、向中心收缩、不重叠 —— 与 prompt D8b-2 一致。
 */
export function computeForceLayout(
  nodes: Node[],
  edges: Edge[],
  options: ForceLayoutOptions = {},
): Node[] {
  if (nodes.length === 0) return nodes

  const opts = { ...DEFAULT_OPTIONS, ...options }

  // 1. 构建仿真节点，保留当前 position 作为初始 guess（保证布局稳定可重复）
  const simNodes: ForceNodeDatum[] = nodes.map((n) => {
    const initialX = opts.preserveInitialPositions ? n.position.x : opts.centerX + (Math.random() - 0.5) * 100
    const initialY = opts.preserveInitialPositions ? n.position.y : opts.centerY + (Math.random() - 0.5) * 100
    return {
      id: n.id,
      x: initialX,
      y: initialY,
      width: estimateNodeWidth(n),
      height: estimateNodeHeight(n),
    }
  })

  const nodeMap = new Map(simNodes.map((sn) => [sn.id, sn]))

  // 2. 过滤掉悬空边，避免 forceLink 抛错
  const simLinks: ForceLinkDatum[] = edges
    .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }))

  // 3. 创建并启动仿真（.stop() 后我们手动 tick，避免异步回调）
  const simulation: Simulation<ForceNodeDatum, ForceLinkDatum> = forceSimulation<ForceNodeDatum>(simNodes)
    .force(
      'link',
      forceLink<ForceNodeDatum, ForceLinkDatum>(simLinks)
        .id((d) => d.id)
        .distance(opts.linkDistance),
    )
    .force('charge', forceManyBody<ForceNodeDatum>().strength(opts.chargeStrength))
    .force('center', forceCenter<ForceNodeDatum>(opts.centerX, opts.centerY))
    .force(
      'collide',
      forceCollide<ForceNodeDatum>().radius(
        (d) => Math.max(d.width, d.height) / 2 + opts.collisionPadding,
      ),
    )
    .alphaDecay(opts.alphaDecay)
    .stop()

  // 4. 同步推进 N tick —— d3-force 支持离屏 tick，结果纯函数
  for (let i = 0; i < opts.ticks; i++) {
    simulation.tick()
  }

  // 5. 把仿真位置写回 nodes（保留原 ReactFlow 数据，仅覆盖 position）
  return nodes.map((node) => {
    const sn = nodeMap.get(node.id)
    if (!sn) return node
    return {
      ...node,
      position: {
        x: sn.x ?? node.position.x,
        y: sn.y ?? node.position.y,
      },
    }
  })
}

/**
 * 创建交互式力导向仿真 —— 用于「拖拽时临时 pin、拖拽后 reheat」场景。
 *
 * 返回的 simulation 在 force layout 模式下保持「冻结」（alpha=0）状态。
 * 调用方通过 `onDragStart` 设置 fx/fy + alphaTarget=0；`onDragStop` 清 fx/fy + alpha=0.3 重启。
 *
 * 注意：返回的 simNodes 与 ReactFlow 的 nodes 是平行数据 —— 调用方需要在
 * simulation 收敛后手动把 simNodes 的 x/y 写回 ReactFlow 状态。
 */
export function createForceSimulation(
  nodes: Node[],
  edges: Edge[],
  options: ForceLayoutOptions = {},
): {
  simulation: Simulation<ForceNodeDatum, ForceLinkDatum>
  simNodes: ForceNodeDatum[]
} {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const simNodes: ForceNodeDatum[] = nodes.map((n) => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: estimateNodeWidth(n),
    height: estimateNodeHeight(n),
  }))

  const nodeMap = new Map(simNodes.map((sn) => [sn.id, sn]))

  const simLinks: ForceLinkDatum[] = edges
    .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }))

  const simulation: Simulation<ForceNodeDatum, ForceLinkDatum> = forceSimulation<ForceNodeDatum>(simNodes)
    .force(
      'link',
      forceLink<ForceNodeDatum, ForceLinkDatum>(simLinks)
        .id((d) => d.id)
        .distance(opts.linkDistance),
    )
    .force('charge', forceManyBody<ForceNodeDatum>().strength(opts.chargeStrength))
    .force('center', forceCenter<ForceNodeDatum>(opts.centerX, opts.centerY))
    .force(
      'collide',
      forceCollide<ForceNodeDatum>().radius(
        (d) => Math.max(d.width, d.height) / 2 + opts.collisionPadding,
      ),
    )
    .alphaDecay(opts.alphaDecay)
    .alpha(0) // 初始冻结，等调用方 reheat

  return { simulation, simNodes }
}
