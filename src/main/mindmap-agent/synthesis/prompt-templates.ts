/**
 * Prompt 模板系统
 *
 * 根据任务类型和节点内容，生成结构化的 Agent 执行 Prompt。
 * 模板设计基于 GraphRAG MixedContext：结构化 KG 对象 + 非结构化文本混合。
 */

import type { GraphNode, GraphEdge, NodeType } from '@shared/types'

export type TaskType = 'feature' | 'bugfix' | 'refactor'

export interface PromptContext {
  /** 目标节点 */
  node: Partial<GraphNode> & { title: string; type: NodeType }
  /** 祖先链（module → process → feature） */
  ancestors: Array<{ title: string; description?: string; communitySummary?: string }>
  /** 子节点 */
  children?: Array<{ title: string; description?: string }>
  /** 关联边 */
  relatedEdges: GraphEdge[]
  /** 边连接的对端节点 */
  relatedNodes: Array<{ title: string; description?: string }>
  /** 用户附加上下文 */
  extraContext?: string
}

/**
 * 生成功能开发 Prompt
 */
export function buildFeaturePrompt(ctx: PromptContext): string {
  const sections: string[] = []

  // 业务上下文
  sections.push('# 业务上下文')

  // 祖先链（从 module 到 process）
  for (const ancestor of ctx.ancestors) {
    sections.push(`## ${ancestor.title}`)
    if (ancestor.communitySummary) {
      sections.push(ancestor.communitySummary)
    } else if (ancestor.description) {
      sections.push(ancestor.description)
    }
  }

  // 目标功能节点
  sections.push(`\n## 功能点：${ctx.node.title}`)
  if (ctx.node.description) {
    sections.push(ctx.node.description)
  }

  // 节点详细内容
  const content = ctx.node.content
  if (content) {
    if (content.businessRules && content.businessRules.length > 0) {
      sections.push('\n### 业务规则')
      for (const rule of content.businessRules) {
        sections.push(`- **${rule.title}**: 当 ${rule.condition}，执行 ${rule.action}`)
      }
    }

    if (content.acceptanceCriteria && content.acceptanceCriteria.length > 0) {
      sections.push('\n### 验收标准')
      for (const criteria of content.acceptanceCriteria) {
        sections.push(`- [ ] ${criteria}`)
      }
    }

    if (content.implementationNotes && content.implementationNotes.length > 0) {
      sections.push('\n### 实现要点')
      for (const note of content.implementationNotes) {
        sections.push(`- ${note}`)
      }
    }

    if (content.codeSignatures && content.codeSignatures.length > 0) {
      sections.push('\n### 关联代码签名')
      for (const sig of content.codeSignatures) {
        sections.push(`- ${sig}`)
      }
    }
  }

  // 子节点
  if (ctx.children && ctx.children.length > 0) {
    sections.push('\n### 子功能')
    for (const child of ctx.children) {
      sections.push(`- ${child.title}: ${child.description || ''}`)
    }
  }

  // 依赖关系
  if (ctx.relatedEdges.length > 0) {
    sections.push('\n## 依赖关系')
    for (const edge of ctx.relatedEdges) {
      const target = ctx.relatedNodes.find((n) => n.title)
      const targetName = target?.title || edge.target
      const desc = edge.description ? ` (${edge.description})` : ''
      const flow = edge.dataFlow ? ` → ${edge.dataFlow}` : ''
      sections.push(`- ${edge.source} → ${targetName}${desc}${flow}`)
    }
  }

  // 范围约束
  if (content?.relatedFiles && content.relatedFiles.length > 0) {
    sections.push('\n## 范围约束')
    sections.push('允许修改的文件：')
    for (const file of content.relatedFiles) {
      sections.push(`- ${file}`)
    }
  }

  // 附加上下文
  if (ctx.extraContext) {
    sections.push(`\n## 附加上下文\n${ctx.extraContext}`)
  }

  // 任务
  sections.push('\n# 任务')
  sections.push('请实现上述功能点，遵循业务规则，满足所有验收标准。')
  sections.push('修改范围严格限定在"范围约束"列出的文件内。')

  return sections.join('\n')
}

/**
 * 生成 Bug 修复 Prompt
 */
export function buildBugfixPrompt(ctx: PromptContext, bugDescription?: string): string {
  const sections: string[] = []

  sections.push('# 业务上下文')
  for (const ancestor of ctx.ancestors) {
    sections.push(`## ${ancestor.title}`)
    if (ancestor.communitySummary) {
      sections.push(ancestor.communitySummary)
    }
  }

  sections.push(`\n## 问题所在：${ctx.node.title}`)
  if (ctx.node.description) {
    sections.push(ctx.node.description)
  }

  if (bugDescription) {
    sections.push(`\n### 问题描述\n${bugDescription}`)
  }

  const content = ctx.node.content
  if (content) {
    if (content.businessRules && content.businessRules.length > 0) {
      sections.push('\n### 相关业务规则')
      for (const rule of content.businessRules) {
        sections.push(`- **${rule.title}**: 当 ${rule.condition}，执行 ${rule.action}`)
      }
    }

    if (content.acceptanceCriteria && content.acceptanceCriteria.length > 0) {
      sections.push('\n### 期望行为')
      for (const criteria of content.acceptanceCriteria) {
        sections.push(`- ${criteria}`)
      }
    }
  }

  if (content?.relatedFiles && content.relatedFiles.length > 0) {
    sections.push('\n## 范围约束')
    sections.push('允许修改的文件：')
    for (const file of content.relatedFiles) {
      sections.push(`- ${file}`)
    }
  }

  sections.push('\n# 任务')
  sections.push('请修复上述问题，确保修复后满足所有业务规则和期望行为。')

  return sections.join('\n')
}

/**
 * 生成重构 Prompt
 */
export function buildRefactorPrompt(ctx: PromptContext, refactorGoal?: string): string {
  const sections: string[] = []

  sections.push('# 业务上下文')
  for (const ancestor of ctx.ancestors) {
    sections.push(`## ${ancestor.title}`)
    if (ancestor.communitySummary) {
      sections.push(ancestor.communitySummary)
    }
  }

  sections.push(`\n## 重构目标：${ctx.node.title}`)
  if (refactorGoal) {
    sections.push(`\n### 目标\n${refactorGoal}`)
  }

  if (ctx.node.description) {
    sections.push(`\n### 当前状态\n${ctx.node.description}`)
  }

  const content = ctx.node.content
  if (content) {
    if (content.businessRules && content.businessRules.length > 0) {
      sections.push('\n### 必须保持的业务规则')
      for (const rule of content.businessRules) {
        sections.push(`- **${rule.title}**: 当 ${rule.condition}，执行 ${rule.action}`)
      }
    }
  }

  // 依赖关系（重构需要特别注意）
  if (ctx.relatedEdges.length > 0) {
    sections.push('\n## 影响范围（依赖关系）')
    for (const edge of ctx.relatedEdges) {
      sections.push(`- ${edge.source} → ${edge.target}${edge.description ? ` (${edge.description})` : ''}`)
    }
  }

  if (content?.relatedFiles && content.relatedFiles.length > 0) {
    sections.push('\n## 范围约束')
    sections.push('允许修改的文件：')
    for (const file of content.relatedFiles) {
      sections.push(`- ${file}`)
    }
  }

  sections.push('\n# 任务')
  sections.push('请进行重构，保持所有业务规则不变，不改变外部行为。')

  return sections.join('\n')
}

/**
 * 根据任务类型选择模板
 */
export function buildPrompt(
  taskType: TaskType,
  ctx: PromptContext,
  options?: { bugDescription?: string; refactorGoal?: string },
): string {
  switch (taskType) {
    case 'feature':
      return buildFeaturePrompt(ctx)
    case 'bugfix':
      return buildBugfixPrompt(ctx, options?.bugDescription)
    case 'refactor':
      return buildRefactorPrompt(ctx, options?.refactorGoal)
  }
}
