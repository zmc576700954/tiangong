/**
 * Prompt Builder — 模板填充引擎
 *
 * 从图谱中组装 PromptContext，调用模板生成最终 Prompt。
 * 实现 Gate 3 最终检查。
 */

import type { GraphNode, GraphEdge } from '@shared/types'
import { buildPrompt, type TaskType, type PromptContext } from './prompt-templates'
import { finalCheck } from '../gates/final-check'

export interface BuildPromptOptions {
  /** 目标节点 */
  node: GraphNode
  /** 任务类型 */
  taskType: TaskType
  /** 所有节点（用于查找祖先和关联） */
  allNodes: GraphNode[]
  /** 所有边 */
  allEdges: GraphEdge[]
  /** 附加上下文 */
  extraContext?: string
  /** Bug 描述 */
  bugDescription?: string
  /** 重构目标 */
  refactorGoal?: string
}

/**
 * 从图谱组装 Prompt
 */
export function buildDevPrompt(options: BuildPromptOptions): string {
  const { node, taskType, allNodes, allEdges } = options

  // 1. 构建祖先链
  const ancestors = buildAncestorChain(node, allNodes)

  // 2. 查找子节点
  const children = allNodes
    .filter((n) => n.parentId === node.id)
    .map((n) => ({ title: n.title, description: n.description }))

  // 3. 查找关联边
  const relatedEdges = allEdges.filter(
    (e) => e.source === node.id || e.target === node.id,
  )

  // 4. 查找关联节点
  const relatedNodeIds = new Set(
    relatedEdges.flatMap((e) => [e.source, e.target]).filter((id) => id !== node.id),
  )
  const relatedNodes = allNodes
    .filter((n) => relatedNodeIds.has(n.id))
    .map((n) => ({ title: n.title, description: n.description }))

  // 5. 组装 PromptContext
  const ctx: PromptContext = {
    node,
    ancestors,
    children,
    relatedEdges,
    relatedNodes,
    extraContext: options.extraContext,
  }

  // 6. 生成 Prompt
  const prompt = buildPrompt(taskType, ctx, {
    bugDescription: options.bugDescription,
    refactorGoal: options.refactorGoal,
  })

  // 7. Gate 3: 最终检查
  const check = finalCheck(prompt, node.title, taskType)
  if (!check.passed) {
    // 在 Prompt 头部添加警告
    const warnings = check.issues.map((i) => `⚠️ ${i}`).join('\n')
    const suggestions = check.suggestions.map((s) => `💡 ${s}`).join('\n')
    return `<!-- 质量检查未完全通过:\n${warnings}\n${suggestions}\n-->\n\n${prompt}`
  }

  return prompt
}

/**
 * 构建祖先链：feature → process → module
 */
function buildAncestorChain(
  node: GraphNode,
  allNodes: GraphNode[],
): Array<{ title: string; description?: string; communitySummary?: string }> {
  const chain: Array<{ title: string; description?: string; communitySummary?: string }> = []
  const visited = new Set<string>()
  let current: GraphNode | undefined = node

  // 向上遍历 parentId
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId)
    const parent = allNodes.find((n) => n.id === current!.parentId)
    if (parent) {
      chain.unshift({
        title: parent.title,
        description: parent.description,
        communitySummary: parent.communitySummary,
      })
      current = parent
    } else {
      break
    }
  }

  return chain
}
