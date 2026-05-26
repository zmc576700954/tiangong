/**
 * 树形思维导图布局算法
 * 基于 parentId 构建层级结构，计算节点位置
 */

import type { GraphNode } from '@shared/types'

export type LayoutMode = 'free' | 'tree'

/** 树形布局配置 */
export interface TreeLayoutConfig {
  /** 层间距（水平方向） */
  levelGap: number
  /** 节点高度（含间距） */
  nodeHeight: number
  /** 根节点起始 X */
  rootX: number
  /** 根节点之间的间距 */
  rootGap: number
}

export const DEFAULT_TREE_CONFIG: TreeLayoutConfig = {
  levelGap: 240,
  nodeHeight: 100,
  rootX: 80,
  rootGap: 60,
}

/** 子树尺寸 */
interface SubtreeSize {
  width: number
  height: number
}

/**
 * 计算树形布局
 * @param nodes 所有节点
 * @param config 布局配置
 * @returns 节点 ID -> 位置的映射
 */
export function computeTreeLayout(
  nodes: GraphNode[],
  config: TreeLayoutConfig = DEFAULT_TREE_CONFIG,
): Record<string, { x: number; y: number }> {
  const { levelGap, nodeHeight, rootX, rootGap } = config

  // 构建父子映射
  const childrenMap = new Map<string, string[]>()
  const nodeMap = new Map<string, GraphNode>()

  for (const node of nodes) {
    nodeMap.set(node.id, node)
    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId) || []
      siblings.push(node.id)
      childrenMap.set(node.parentId, siblings)
    }
  }

  // 按某种稳定顺序排序子节点（比如创建时间）
  for (const [parentId, children] of childrenMap) {
    children.sort((a, b) => {
      const nodeA = nodeMap.get(a)
      const nodeB = nodeMap.get(b)
      return (nodeA?.createdAt || '').localeCompare(nodeB?.createdAt || '')
    })
  }

  // 找出根节点（parentId 为空，且没有被折叠的父节点）
  const rootIds = nodes
    .filter((n) => !n.parentId)
    .map((n) => n.id)
    .sort((a, b) => {
      const nodeA = nodeMap.get(a)
      const nodeB = nodeMap.get(b)
      return (nodeA?.createdAt || '').localeCompare(nodeB?.createdAt || '')
    })

  // 没有根节点，无法构建树形布局
  if (rootIds.length === 0) {
    // 回退：所有节点保持原位置
    const positions: Record<string, { x: number; y: number }> = {}
    for (const node of nodes) {
      positions[node.id] = { ...node.position }
    }
    return positions
  }

  // 缓存子树尺寸（避免重复计算）
  const sizeCache = new Map<string, SubtreeSize>()

  function getSubtreeSize(nodeId: string): SubtreeSize {
    if (sizeCache.has(nodeId)) return sizeCache.get(nodeId)!

    const node = nodeMap.get(nodeId)
    const children = childrenMap.get(nodeId) || []

    // 如果节点被折叠，或者没有子节点，视为叶子
    if (node?.collapsed || children.length === 0) {
      const size = { width: 1, height: 1 }
      sizeCache.set(nodeId, size)
      return size
    }

    let totalHeight = 0
    let maxWidth = 0
    for (const childId of children) {
      const childSize = getSubtreeSize(childId)
      totalHeight += childSize.height
      maxWidth = Math.max(maxWidth, childSize.width)
    }

    const size = { width: maxWidth + 1, height: totalHeight }
    sizeCache.set(nodeId, size)
    return size
  }

  // 计算位置
  const positions: Record<string, { x: number; y: number }> = {}

  function layoutNode(nodeId: string, x: number, centerY: number) {
    positions[nodeId] = { x, y: centerY }

    const node = nodeMap.get(nodeId)
    const children = childrenMap.get(nodeId) || []

    // 折叠状态不布局子节点
    if (node?.collapsed || children.length === 0) return

    // 计算所有子节点占据的总高度
    let totalChildHeight = 0
    for (const childId of children) {
      totalChildHeight += getSubtreeSize(childId).height * nodeHeight
    }

    // 子节点的起始 Y 位置（第一个子节点的顶部）
    let currentTop = centerY - totalChildHeight / 2

    for (const childId of children) {
      const childSize = getSubtreeSize(childId)
      const childHeightPx = childSize.height * nodeHeight
      const childCenterY = currentTop + childHeightPx / 2

      layoutNode(childId, x + levelGap, childCenterY)
      currentTop += childHeightPx
    }
  }

  // 布局所有根节点
  let totalRootsHeight = 0
  for (const rootId of rootIds) {
    totalRootsHeight += getSubtreeSize(rootId).height * nodeHeight
  }

  let currentTop = -totalRootsHeight / 2
  for (const rootId of rootIds) {
    const rootSize = getSubtreeSize(rootId)
    const rootHeightPx = rootSize.height * nodeHeight
    const rootCenterY = currentTop + rootHeightPx / 2

    layoutNode(rootId, rootX, rootCenterY)
    currentTop += rootHeightPx + rootGap
  }

  return positions
}

/**
 * 根据折叠状态，过滤出需要渲染的节点和边
 */
export function filterVisibleNodes(nodes: GraphNode[]): GraphNode[] {
  const visibleIds = new Set<string>()
  const childrenMap = new Map<string, string[]>()

  for (const node of nodes) {
    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId) || []
      siblings.push(node.id)
      childrenMap.set(node.parentId, siblings)
    }
  }

  // DFS 遍历，遇到 collapsed 节点停止深入
  function visit(nodeId: string) {
    visibleIds.add(nodeId)
    const node = nodes.find((n) => n.id === nodeId)
    if (node?.collapsed) return
    const children = childrenMap.get(nodeId) || []
    for (const childId of children) {
      visit(childId)
    }
  }

  // 从根节点开始
  for (const node of nodes) {
    if (!node.parentId) {
      visit(node.id)
    }
  }

  return nodes.filter((n) => visibleIds.has(n.id))
}

/**
 * 获取某节点的所有子孙节点 ID（包含自身）
 */
export function getDescendantIds(nodes: GraphNode[], nodeId: string): string[] {
  const result: string[] = []
  const childrenMap = new Map<string, string[]>()

  for (const node of nodes) {
    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId) || []
      siblings.push(node.id)
      childrenMap.set(node.parentId, siblings)
    }
  }

  function dfs(id: string) {
    result.push(id)
    const children = childrenMap.get(id) || []
    for (const childId of children) {
      dfs(childId)
    }
  }

  dfs(nodeId)
  return result
}

/**
 * 获取某节点的直接子节点
 */
export function getChildNodes(nodes: GraphNode[], parentId: string): GraphNode[] {
  return nodes.filter((n) => n.parentId === parentId)
}

/**
 * 判断节点是否有子节点
 */
export function hasChildren(nodes: GraphNode[], nodeId: string): boolean {
  return nodes.some((n) => n.parentId === nodeId)
}
