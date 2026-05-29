import type { GraphNode, GraphEdge, FileAssociation } from '@shared/types'

/** 递归收集节点及其祖先的 fileAssociations */
export function collectFileAssociations(
  nodeId: string,
  nodes: GraphNode[],
): FileAssociation[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const result: FileAssociation[] = []
  const visited = new Set<string>()

  let current: GraphNode | undefined = nodeMap.get(nodeId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    if (current.metadata?.fileAssociations) {
      result.push(...current.metadata.fileAssociations)
    }
    current = current.parentId ? nodeMap.get(current.parentId) : undefined
  }
  return result
}

/** 收集节点通过 business-flow 边连接的上下游约束 */
export function collectCrossModuleConstraints(
  nodeId: string,
  edges: GraphEdge[],
  nodes: GraphNode[],
): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const constraints: string[] = []

  for (const edge of edges) {
    if (edge.edgeType !== 'business-flow') continue
    if (!edge.content?.note) continue

    if (edge.source === nodeId) {
      const targetNode = nodeMap.get(edge.target)
      const targetLabel = targetNode?.title ?? '未知节点'
      const condition = edge.content.condition ? ` (条件: ${edge.content.condition})` : ''
      constraints.push(`连接至「${targetLabel}」: ${edge.content.note}${condition}`)
    } else if (edge.target === nodeId) {
      const sourceNode = nodeMap.get(edge.source)
      const sourceLabel = sourceNode?.title ?? '未知节点'
      const condition = edge.content.condition ? ` (条件: ${edge.content.condition})` : ''
      constraints.push(`来自「${sourceLabel}」: ${edge.content.note}${condition}`)
    }
  }
  return constraints
}
