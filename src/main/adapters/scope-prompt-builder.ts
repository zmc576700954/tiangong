/**
 * 范围约束提示词构建器
 * 从 BaseAdapter 中提取，降低单文件复杂度
 *
 * 将 AgentSessionConfig 转换为自然语言约束说明，
 * 注入到 Agent prompt 中限制文件修改范围。
 */

import type { AgentSessionConfig, ResolvedContext } from '@shared/types'
import type { ProjectMemory } from '@shared/types'

/**
 * 构建范围约束提示词
 * @param config - 会话配置
 * @param resolvedContexts - 已解析的上下文列表
 * @param codeContext - 智能代码上下文
 * @param memory - 项目记忆（可选，用于注入用户偏好）
 */
export function buildScopePrompt(
  config: AgentSessionConfig,
  resolvedContexts?: ResolvedContext[],
  codeContext?: string,
  memory?: ProjectMemory,
): string {
  const lines: string[] = []

  lines.push(`# 业务节点：${config.nodeTitle}`)
  lines.push('')

  if (config.acceptanceCriteria.length > 0) {
    lines.push('## 验收标准')
    for (const criteria of config.acceptanceCriteria) {
      lines.push(`- ${criteria}`)
    }
    lines.push('')
  }

  if (config.allowedFiles.length > 0) {
    lines.push('## 允许修改的文件（白名单）')
    for (const file of config.allowedFiles) {
      lines.push(`- ${file}`)
    }
    lines.push('')
  }

  if (config.forbiddenFiles.length > 0) {
    lines.push('## 禁止修改的文件（黑名单）')
    for (const file of config.forbiddenFiles) {
      lines.push(`- ${file}`)
    }
    lines.push('')
  }

  if (config.invariantRules.length > 0) {
    lines.push('## 业务不变量')
    for (const rule of config.invariantRules) {
      lines.push(`- ${rule}`)
    }
    lines.push('')
  }

  if (config.upstreamContext) {
    lines.push('## 上游契约')
    lines.push(config.upstreamContext)
    lines.push('')
  }

  if (config.downstreamContext) {
    lines.push('## 下游契约')
    lines.push(config.downstreamContext)
    lines.push('')
  }

  if (config.bugContext && config.bugContext.length > 0) {
    lines.push('## 待修复 Bug')
    for (const bug of config.bugContext) {
      lines.push(`### ${bug.title} [${bug.severity}]`)
      lines.push(bug.description)
      lines.push('')
    }
  }

  // 注入智能代码上下文
  if (codeContext) {
    lines.push(codeContext)
    lines.push('')
  }

  // 注入已解析的上下文
  if (resolvedContexts && resolvedContexts.length > 0) {
    lines.push('## 附加上下文')
    for (const ctx of resolvedContexts) {
      lines.push(`### ${ctx.label} (${ctx.type})`)
      lines.push(ctx.content)
      lines.push('')
    }
  }

  // 注入项目记忆偏好，使 Agent 行为与用户偏好一致
  if (memory) {
    lines.push('## 项目偏好')
    lines.push(`- 命名风格：${memory.preferences.namingStyle === 'business' ? '使用业务语言' : memory.preferences.namingStyle === 'technical' ? '使用技术术语' : '业务与技术结合'}`)
    lines.push(`- 模块粒度：${memory.preferences.granularity === 'fine' ? '倾向于细粒度拆分' : memory.preferences.granularity === 'coarse' ? '倾向于粗粒度合并' : '中等粒度'}`)
    if (memory.preferences.maxModules) {
      lines.push(`- 建议模块数：不超过 ${memory.preferences.maxModules} 个`)
    }
    if (memory.preferences.avoidPatterns.length > 0) {
      lines.push(`- 应避免：${memory.preferences.avoidPatterns.join('、')}`)
    }
    if (memory.coreUserFlows.length > 0) {
      lines.push(`- 核心流程：${memory.coreUserFlows.join('、')}`)
    }
    if (memory.techConstraints.length > 0) {
      lines.push(`- 技术约束：${memory.techConstraints.join('、')}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
