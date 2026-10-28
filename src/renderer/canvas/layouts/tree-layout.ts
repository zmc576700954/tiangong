/**
 * 树形自动布局（dagre 引擎）
 *
 * 使用 @dagrejs/dagre 计算有向图的层级布局（默认 LR 方向）。
 * 在调用 dagre 之前先做循环检测，将回边从边集合中剔除，
 * 避免 dagre 在遇到环时抛出异常或产生不可预测的位置。
 *
 * 布局后按兄弟序号修正子节点的垂直排列，消除连线交叉。
 * 多连通分量分别跑 dagre 再横向并排，避免分量重叠在同一原点。
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
  'wiki-page': { width: 180, height: 70 },
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

function estimateNodeHeight(node: Node): number {
  const nodeType = (node.data as Record<string, unknown>)?.type as NodeType
  return (NODE_SIZES[nodeType] ?? NODE_SIZES.feature).height
}

export interface TreeLayoutOptions {
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

const DEFAULT_OPTIONS: Required<TreeLayoutOptions> = {
  direction: 'LR',
  nodesep: 120,
  ranksep: 280,
  edgesep: 30,
  marginx: 60,
  marginy: 60,
}

export interface TreeLayoutResult {
  /** 应用布局后的节点数组 */
  nodes: Node[]
  /** 被剔除的循环回边 ID 列表 */
  removedBackEdgeIds: string[]
}

/**
 * 对节点集合求连通分量（无向意义下）
 * 返回分量数组，每个分量是节点 ID 列表，按字典序稳定排序，
 * 保证多次运行结果一致。
 */
function findConnectedComponents(nodes: Node[], edges: Edge[]): string[][] {
  const adjacency = new Map<string, Set<string>>()
  for (const node of nodes) adjacency.set(node.id, new Set())
  for (const edge of edges) {
    if (adjacency.has(edge.source) && adjacency.has(edge.target)) {
      adjacency.get(edge.source)!.add(edge.target)
      adjacency.get(edge.target)!.add(edge.source)
    }
  }

  const visited = new Set<string>()
  const components: string[][] = []
  for (const node of nodes) {
    if (visited.has(node.id)) continue
    const component: string[] = []
    const stack = [node.id]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      component.push(current)
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor)
      }
    }
    component.sort()
    components.push(component)
  }
  return components
}

/**
 * 通过 DFS 检测有向图中的回边（构成环的边）。
 * 返回构成回边的边 ID 集合，从输入中剔除这些边后图即为 DAG。
 */
export function findBackEdgeIds(nodes: Node[], edges: Edge[]): Set<string> {
  const backEdgeIds = new Set<string>()
  const adjacency = new Map<string, { target: string; edgeId: string }[]>()

  for (const node of nodes) adjacency.set(node.id, [])
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, [])
    adjacency.get(edge.source)!.push({ target: edge.target, edgeId: edge.id })
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const node of nodes) color.set(node.id, WHITE)

  function dfs(u: string) {
    color.set(u, GRAY)
    const neighbors = adjacency.get(u) ?? []
    for (const { target: v, edgeId } of neighbors) {
      const c = color.get(v) ?? WHITE
      if (c === GRAY) {
        // back edge
        backEdgeIds.add(edgeId)
      } else if (c === WHITE) {
        dfs(v)
      }
    }
    color.set(u, BLACK)
  }

  for (const node of nodes) {
    if ((color.get(node.id) ?? WHITE) === WHITE) {
      dfs(node.id)
    }
  }

  return backEdgeIds
}

/**
 * 按兄弟序号修正子节点的垂直排列，消除连线交叉。
 *
 * dagre 的 barycenter 启发式不尊重兄弟顺序，
 * 导致子节点的垂直顺序和连线顺序不一致，线头缠绕。
 * 此函数按子节点的 `sortIndex`（同父节点下的兄弟序号，spec §4.8）重排。
 *
 * **兜底路径是承重的**：没有 `sortIndex` 的兄弟（存量节点 / 绕过了主进程写入的路径）
 * 排在**最后**，且保持它们原有的相对顺序。渲染层不能假设上游一定干净 ——
 * `Number(null)` 是 0（不是 NaN！），直接 Number() 会把「缺失」当成序号 0 排到最前面。
 */
function sortChildrenBySortIndex(
  layoutNodes: Node[],
  edges: Edge[],
  nodesep: number,
): Node[] {
  const childrenByParent = new Map<string, string[]>()
  for (const edge of edges) {
    if (!childrenByParent.has(edge.source)) {
      childrenByParent.set(edge.source, [])
    }
    childrenByParent.get(edge.source)!.push(edge.target)
  }

  const nodeMap = new Map(layoutNodes.map((n) => [n.id, n]))

  for (const [, childIds] of childrenByParent) {
    if (childIds.length <= 1) continue

    // 同一个孩子可能有多条边（父子对 + 语义边）—— 去重，别让它占两个位置
    const seen = new Set<string>()
    const children = childIds
      .map((id) => nodeMap.get(id))
      .filter((n): n is Node => {
        if (n === undefined) return false
        if (seen.has(n.id)) return false
        seen.add(n.id)
        return true
      })

    if (children.length <= 1) continue

    // 有序号的按序号升序在前；没序号的排在后面，保持原相对顺序
    const ordered = children
      .map((node, index) => ({ node, index, sortIndex: readSortIndex(node) }))
      .sort((a, b) => {
        if (a.sortIndex === undefined && b.sortIndex === undefined) return a.index - b.index
        if (a.sortIndex === undefined) return 1
        if (b.sortIndex === undefined) return -1
        return a.sortIndex - b.sortIndex || a.index - b.index
      })
      .map((entry) => entry.node)

    const ys = ordered.map((n) => n.position.y)
    // 行高取**原顺序**里第一个孩子的类型 —— 与改序前的行为一致（只改顺序，不改间距）
    const height = estimateNodeHeight(children[0])
    const groupMinY = Math.min(...ys)

    ordered.forEach((child, idx) => {
      child.position = {
        ...child.position,
        y: groupMinY + idx * (height + nodesep),
      }
    })
  }

  return layoutNodes
}

/**
 * 读节点上的兄弟序号。
 *
 * `Node['data']` 是 `Record<string, unknown>` → 取出来是 unknown。
 * ⚠️ **缺失的判断必须同时覆盖 undefined 与 null**：
 * `Number(undefined)` 是 NaN（比较恒为 false，静默弄坏兜底路径），
 * `Number(null)` 是 **0**（缺失的节点会被当成序号 0 排到最前面）。
 */
function readSortIndex(node: Node): number | undefined {
  const raw = (node.data as Record<string, unknown> | undefined)?.sortIndex
  if (raw === undefined || raw === null) return undefined
  const value = Number(raw)
  return Number.isNaN(value) ? undefined : value
}

function componentNodesByIds(
  ids: string[],
  nodeById: Map<string, Node>,
): Node[] {
  const out: Node[] = []
  for (const id of ids) {
    const node = nodeById.get(id)
    if (node) out.push(node)
  }
  return out
}

/**
 * 使用 dagre 计算节点布局。
 *
 * 流程：
 * 1. 求连通分量；每个分量单独跑一次 dagre（避免分量重叠在同一原点）
 * 2. 每个分量内部做循环检测，剔除回边
 * 3. 按兄弟序号（sortIndex）修正子节点垂直排列
 * 4. 把各分量的结果横向并排，分量之间留 COL_GAP
 *
 * 返回包含剔除回边 ID 列表的 TreeLayoutResult。
 */
export function computeTreeLayout(
  nodes: Node[],
  edges: Edge[],
  options: TreeLayoutOptions = {},
): TreeLayoutResult {
  if (nodes.length === 0) {
    return { nodes, removedBackEdgeIds: [] }
  }

  const opts = { ...DEFAULT_OPTIONS, ...options }
  const COL_GAP = Math.max(opts.ranksep, 200)
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const components = findConnectedComponents(nodes, edges)
  const allBackEdgeIds = new Set<string>()
  const layouted: Node[] = []

  let colOffset = 0
  for (const componentIds of components) {
    const componentNodes = componentNodesByIds(componentIds, nodeById)
    if (componentNodes.length === 0) continue

    const componentNodeIdSet = new Set(componentIds)
    const componentEdges = edges.filter(
      (e) => componentNodeIdSet.has(e.source) && componentNodeIdSet.has(e.target),
    )

    const backEdgeIds = findBackEdgeIds(componentNodes, componentEdges)
    for (const id of backEdgeIds) allBackEdgeIds.add(id)
    const safeEdges = componentEdges.filter((e) => !backEdgeIds.has(e.id))

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

    for (const node of componentNodes) {
      const width = estimateNodeWidth(node)
      const height = estimateNodeHeight(node)
      g.setNode(node.id, { width, height })
    }
    for (const edge of safeEdges) {
      g.setEdge(edge.source, edge.target)
    }

    dagre.layout(g)

    // 计算此分量在 dagre 坐标下的包围盒
    let minX = Infinity
    let maxX = -Infinity
    const gWidths = new Map<string, number>()
    for (const node of componentNodes) {
      const dagreNode = g.node(node.id)
      const width = estimateNodeWidth(node)
      gWidths.set(node.id, width)
      if (dagreNode) {
        const left = dagreNode.x - width / 2
        const right = dagreNode.x + width / 2
        if (left < minX) minX = left
        if (right > maxX) maxX = right
      }
    }

    for (const node of componentNodes) {
      const dagreNode = g.node(node.id)
      if (!dagreNode) {
        layouted.push(node)
        continue
      }
      const width = gWidths.get(node.id) ?? estimateNodeWidth(node)
      const height = estimateNodeHeight(node)
      // 把分量平移到 colOffset 右侧
      const translatedX = dagreNode.x - width / 2 + (colOffset - minX)
      layouted.push({
        ...node,
        position: {
          x: translatedX,
          y: dagreNode.y - height / 2,
        },
      })
    }

    // 推进 colOffset 到此分量右侧
    if (Number.isFinite(maxX) && Number.isFinite(minX)) {
      colOffset += maxX - minX + COL_GAP
    }
  }

  // 按兄弟序号修正子节点垂直排列（用全部安全边，保证一致性）
  const safeEdgesAll = edges.filter((e) => !allBackEdgeIds.has(e.id))
  const sorted = sortChildrenBySortIndex(layouted, safeEdgesAll, opts.nodesep)

  return {
    nodes: sorted,
    removedBackEdgeIds: Array.from(allBackEdgeIds),
  }
}
