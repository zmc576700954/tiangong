/**
 * 层级边派生
 *
 * 图谱的父子关系以 `nodes.parent_id` 为唯一事实来源，层级边由它派生而非从
 * `edges` 表读取。存储的历史层级边会在渲染时被丢弃，避免同一对父子节点
 * 出现两条线；迁移残留的 `default` 父子边同样被剔除。
 */
import type { GraphNode, GraphEdge } from '@shared/types'

export interface DerivedHierarchyResult {
  /** 按 parent_id 派生的层级边；id 形如 `derived-<source>-<target>` */
  hierarchyEdges: GraphEdge[]
  /** 原样保留的语义边（已剔除存储的 hierarchical 边与重复的 default 层级边） */
  semanticEdges: GraphEdge[]
}

/** 幽灵连线（拖拽重挂预览）的前缀 —— 画布靠它把临时边与真边区分开 */
export const GHOST_EDGE_PREFIX = 'ghost-'

/**
 * 拖拽重挂的幽灵连线 —— **父 → 子**。
 *
 * 画布上所有层级边都是父 → 子（派生边见上，主进程存的那条 hierarchical 边也是），
 * 箭头（markerEnd）落在 target 那一端。幽灵连线必须跟它们同向：
 * 反过来画的话，拖拽时箭头指向「你将要认作父节点的那个节点」，
 * 松手后真正的边 B → A 出现，箭头当场跳到另一端 —— 预览与结果相反。
 *
 * @param draggedId 被拖动的节点（将成为子节点）
 * @param parentId  候选父节点（将成为父节点）
 */
export function buildReparentGhostEdge(
  draggedId: string,
  parentId: string,
  graphId: string,
): GraphEdge {
  return {
    // id 只用于前缀识别与缓存键，与方向无关 → 保持稳定
    id: `${GHOST_EDGE_PREFIX}${draggedId}-${parentId}`,
    source: parentId,
    target: draggedId,
    graphId,
    edgeType: 'hierarchical',
  }
}

export function deriveHierarchyEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
): DerivedHierarchyResult {
  const nodeIds = new Set(nodes.map(n => n.id))
  const hierarchyEdges: GraphEdge[] = []
  for (const node of nodes) {
    if (!node.parentId) continue
    if (!nodeIds.has(node.parentId)) continue   // 孤儿不产生边
    hierarchyEdges.push({
      id: `derived-${node.parentId}-${node.id}`,
      source: node.parentId,
      target: node.id,
      graphId: node.graphId,
      edgeType: 'hierarchical',
    })
  }
  const parentChildPairs = new Set(hierarchyEdges.map(e => `${e.source} ${e.target}`))
  const semanticEdges = edges.filter((e) => {
    // ⚠️ 下面这行是「画布层判定派生边」的前提：合并集里
    // edgeType === 'hierarchical' ⟺ 派生边。GraphCanvas 的 onEdgeClick 守卫
    // 与 flowEdges 的 `selectable` 都建立在这个等价上——若这里改成保留存储的
    // hierarchical 边，那两处守卫会把**存储边**也一起判成派生边。
    if (e.edgeType === 'hierarchical') return false                      // 存储的层级边不参与渲染
    if (e.edgeType === 'default' && parentChildPairs.has(`${e.source} ${e.target}`)) return false  // 迁移残留
    return true
  })
  return { hierarchyEdges, semanticEdges }
}
