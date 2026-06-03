/**
 * dagre 自动布局引擎
 *
 * 使用 @dagrejs/dagre 计算有向图的层级布局（LR 方向），
 * 根据节点类型和标题长度估算实际尺寸，避免重叠。
 *
 * 布局后执行排序修正：按边的连接顺序排列子节点的垂直位置，
 * 避免连线交叉缠绕。
 */
import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'
import type { NodeType } from '@shared/types'

/** 每种节点类型的基准尺寸 */
const NODE_SIZES: Record<NodeType, { width: number; height: number }> = {
  project: { width: 220, height: 90 },
  module:  { width: 200, height: 80 },
  process: { width: 180, height: 70 },
  feature: { width: 160, height: 60 },
  bug:     { width: 160, height: 60 },
}

/**
 * 根据标题长度估算实际节点宽度
 * BizNode 有 min-w-[140px] max-w-[200px]，中文约 14px/字
 */
function estimateNodeWidth(node: Node): number {
  const nodeType = (node.data as Record<string, unknown>)?.type as NodeType
  const base = NODE_SIZES[nodeType] ?? NODE_SIZES.feature
  const title = String((node.data as Record<string, unknown>)?.title ?? '')
  const cjkCount = (title.match(/[一-鿿]/g) || []).length
  const otherCount = title.length - cjkCount
  const textWidth = cjkCount * 14 + otherCount * 8 + 32
  return Math.max(base.width, Math.min(200, textWidth))
}

export interface LayoutOptions {
  /** 布局方向，默认 'LR' */
  direction?: 'LR' | 'TB' | 'RL' | 'BT'
  /** 同层节点间距 */
  nodesep?: number
  /** 层级间距 */
  ranksep?: number
  /** 边与节点的间距 */
  edgesep?: number
  /** 外边距 */
  marginx?: number
  marginy?: number
}

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  direction: 'LR',
  nodesep: 120,
  ranksep: 280,
  edgesep: 30,
  marginx: 60,
  marginy: 60,
}

/**
 * 按边的连接顺序修正子节点的垂直排列，消除连线交叉。
 *
 * dagre 的 barycenter 启发式不尊重边的原始顺序，
 * 导致子节点的垂直顺序和连线顺序不一致，线头缠绕。
 * 此函数按 edges 数组中的出现顺序重排每个父节点的子节点。
 */
function sortChildrenByEdgeOrder(
  layoutNodes: Node[],
  edges: Edge[],
  nodesep: number,
): Node[] {
  // 按边顺序构建 parent → [childId, ...] 映射
  const childrenByParent = new Map<string, string[]>()
  for (const edge of edges) {
    if (!childrenByParent.has(edge.source)) {
      childrenByParent.set(edge.source, [])
    }
    childrenByParent.get(edge.source)!.push(edge.target)
  }

  // 构建 id → node 索引
  const nodeMap = new Map(layoutNodes.map((n) => [n.id, n]))

  // 对每个父节点的子节点组，按边顺序重排 Y 坐标
  for (const [, childIds] of childrenByParent) {
    if (childIds.length <= 1) continue

    // 按当前 Y 排序，获取 dagre 给的基准位置
    const children = childIds
      .map((id) => nodeMap.get(id))
      .filter((n): n is Node => n !== undefined)

    if (children.length <= 1) continue

    // 取当前子节点组的 Y 范围中心和高度
    const ys = children.map((n) => n.position.y)
    const nodeType = (children[0].data as Record<string, unknown>)?.type as NodeType
    const height = (NODE_SIZES[nodeType] ?? NODE_SIZES.feature).height
    const groupMinY = Math.min(...ys)

    // 按边顺序（即 childIds 顺序）依次分配 Y 坐标
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const idx = childIds.indexOf(child.id)
      if (idx < 0) continue
      child.position = {
        ...child.position,
        y: groupMinY + idx * (height + nodesep),
      }
    }
  }

  return layoutNodes
}

/**
 * 使用 dagre 计算节点布局，返回带有新 position 的节点数组。
 */
export function computeDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {},
): Node[] {
  if (nodes.length === 0) return nodes

  const opts = { ...DEFAULT_OPTIONS, ...options }

  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: opts.direction,
    nodesep: opts.nodesep,
    ranksep: opts.ranksep,
    edgesep: opts.edgesep,
    marginx: opts.marginx,
    marginy: opts.marginy,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    const width = estimateNodeWidth(node)
    const nodeType = (node.data as Record<string, unknown>)?.type as NodeType
    const height = (NODE_SIZES[nodeType] ?? NODE_SIZES.feature).height
    g.setNode(node.id, { width, height })
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  let layoutNodes: Node[] = nodes.map((node) => {
    const dagreNode = g.node(node.id)
    if (!dagreNode) return node

    const width = estimateNodeWidth(node)
    const nodeType = (node.data as Record<string, unknown>)?.type as NodeType
    const height = (NODE_SIZES[nodeType] ?? NODE_SIZES.feature).height

    return {
      ...node,
      position: {
        x: dagreNode.x - width / 2,
        y: dagreNode.y - height / 2,
      },
    }
  })

  // 按边顺序修正子节点垂直排列，消除连线交叉
  layoutNodes = sortChildrenByEdgeOrder(layoutNodes, edges, opts.nodesep)

  return layoutNodes
}
