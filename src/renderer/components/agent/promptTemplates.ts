import type { GraphNode, GraphEdge } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'
import { Code2, Shield, GitBranch, Check } from 'lucide-react'
import { collectFileAssociations, collectCrossModuleConstraints } from '../../canvas/agent-context-builder'

export interface SlashCommand {
  name: string
  /** 英文兜底文案——渲染走 labelKey / descriptionKey */
  label: string
  description: string
  /** 展示文案对应的 i18n key */
  labelKey: TranslationKey
  descriptionKey: TranslationKey
  icon: React.ComponentType<{ className?: string }>
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/implement',
    label: 'Implement',
    description: 'Implement a feature from node requirements',
    labelKey: 'command.implement',
    descriptionKey: 'agent.command.implementDescription',
    icon: Code2,
  },
  {
    name: '/fix',
    label: 'Fix Bug',
    description: 'Fix a bug with context from node',
    labelKey: 'command.fixBug',
    descriptionKey: 'agent.command.fixBugDescription',
    icon: Shield,
  },
  {
    name: '/refactor',
    label: 'Refactor',
    description: 'Refactor with constraints from node',
    labelKey: 'command.refactor',
    descriptionKey: 'agent.command.refactorDescription',
    icon: GitBranch,
  },
  {
    name: '/test',
    label: 'Add Tests',
    description: 'Add tests based on acceptance criteria',
    labelKey: 'command.addTest',
    descriptionKey: 'agent.command.addTestDescription',
    icon: Check,
  },
]

const SLASH_TO_COMMAND: Record<string, string> = {
  '/implement': 'implement',
  '/fix': 'fix_bug',
  '/refactor': 'refactor',
  '/test': 'add_test',
}

export function generatePromptTemplate(
  slashCommand: string,
  node: GraphNode | undefined,
  allNodes?: GraphNode[],
  allEdges?: GraphEdge[],
): string | null {
  const commandType = SLASH_TO_COMMAND[slashCommand]
  if (!commandType) return null
  if (!node) return null

  const lines: string[] = []

  switch (commandType) {
    case 'implement':
      lines.push(`## 开发任务：${node.title}`)
      lines.push('')
      if (node.description) {
        lines.push('### 需求描述')
        lines.push(node.description)
        lines.push('')
      }
      if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
        lines.push('### 验收标准')
        node.acceptanceCriteria.forEach((c, i) => {
          lines.push(`${i + 1}. ${c}`)
        })
        lines.push('')
      }
      if (node.rules && node.rules.length > 0) {
        lines.push('### 业务规则')
        node.rules.forEach((r) => {
          lines.push(`- ${r.title}${r.condition ? `（条件：${r.condition}）` : ''}${r.action ? ` → ${r.action}` : ''}`)
        })
        lines.push('')
      }
      lines.push('### 请按以上要求完成功能实现')
      break

    case 'fix_bug':
      lines.push(`## 修复 Bug：${node.title}`)
      lines.push('')
      lines.push('### 问题描述')
      lines.push(node.description ?? '（请在此补充 Bug 的具体描述）')
      lines.push('')
      if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
        lines.push('### 修复要求')
        node.acceptanceCriteria.forEach((c, i) => {
          lines.push(`${i + 1}. ${c}`)
        })
        lines.push('')
      }
      lines.push('### 请定位问题根因并修复，同时确保不引入新问题')
      break

    case 'refactor':
      lines.push(`## 重构任务：${node.title}`)
      lines.push('')
      if (node.description) {
        lines.push('### 当前问题')
        lines.push(node.description)
        lines.push('')
      }
      lines.push('### 重构目标')
      lines.push('（请在此补充重构的具体目标和约束）')
      lines.push('')
      lines.push('### 请在保持现有功能不变的前提下完成重构')
      break

    case 'add_test':
      lines.push(`## 添加测试：${node.title}`)
      lines.push('')
      if (node.description) {
        lines.push('### 功能说明')
        lines.push(node.description)
        lines.push('')
      }
      if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
        lines.push('### 测试应覆盖的验收标准')
        node.acceptanceCriteria.forEach((c, i) => {
          lines.push(`${i + 1}. ${c}`)
        })
        lines.push('')
      }
      lines.push('### 请为该功能编写完整的单元测试和集成测试')
      break
  }

  // Append file associations and cross-module constraints
  if (allNodes && allEdges) {
    const fileAssocs = collectFileAssociations(node.id, allNodes)
    if (fileAssocs.length > 0) {
      lines.push('### 关联文件')
      fileAssocs.forEach((a) => {
        const suffix = a.type === 'method' && a.methodName ? ` (方法: ${a.methodName})` : a.type === 'directory' ? ' (目录)' : ''
        lines.push(`- ${a.path}${suffix}`)
      })
      lines.push('')
    }

    const constraints = collectCrossModuleConstraints(node.id, allEdges, allNodes)
    if (constraints.length > 0) {
      lines.push('### 跨模块业务约束')
      constraints.forEach((c) => lines.push(`- ${c}`))
      lines.push('')
    }
  }

  return lines.join('\n')
}
