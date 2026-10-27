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
    if (e.edgeType === 'hierarchical') return false                      // 存储的层级边不参与渲染
    if (e.edgeType === 'default' && parentChildPairs.has(`${e.source} ${e.target}`)) return false  // 迁移残留
    return true
  })
  return { hierarchyEdges, semanticEdges }
}
