/**
 * 代码感知 Prompt 组装器
 * 将 SmartContextResolver 的结果组装成结构化的 Prompt
 */

import type { ResolvedCodeContext } from './smart-context-resolver'
import type { AgentSessionConfig } from '@shared/types'

export interface PromptAssemblyOptions {
  sessionConfig: AgentSessionConfig
  codeContext?: ResolvedCodeContext
  userCommand: string
}

/**
 * 代码感知 Prompt 组装器
 * 将 SmartContextResolver 的结果组装成结构化的 Prompt
 */
export class PromptAssembler {
  /**
   * 组装完整的 agent prompt
   */
  assemble(options: PromptAssemblyOptions): string {
    const { sessionConfig, codeContext, userCommand } = options
    const parts: string[] = []

    // 1. 系统级约束（scope prompt）
    parts.push(this.buildScopeSection(sessionConfig))

    // 2. 代码上下文（如果可用）
    if (codeContext) {
      parts.push(this.buildCodeContextSection(codeContext))
    }

    // 3. 用户命令
    parts.push(this.buildCommandSection(userCommand))

    return parts.join('\n\n---\n\n')
  }

  private buildScopeSection(config: AgentSessionConfig): string {
    const lines: string[] = ['# 任务范围']

    if (config.nodeTitle) {
      lines.push(`## 目标节点: ${config.nodeTitle}`)
    }

    if (config.acceptanceCriteria && config.acceptanceCriteria.length > 0) {
      lines.push('## 验收标准')
      for (const [i, criterion] of config.acceptanceCriteria.entries()) {
        lines.push(`${i + 1}. ${criterion}`)
      }
    }

    if (config.allowedFiles && config.allowedFiles.length > 0) {
      lines.push('## 允许修改的文件')
      for (const file of config.allowedFiles) {
        lines.push(`- ${file}`)
      }
    }

    if (config.forbiddenFiles && config.forbiddenFiles.length > 0) {
      lines.push('## 禁止修改的文件')
      for (const file of config.forbiddenFiles) {
        lines.push(`- ${file}`)
      }
    }

    if (config.invariantRules && config.invariantRules.length > 0) {
      lines.push('## 不变规则')
      for (const rule of config.invariantRules) {
        lines.push(`- ${rule}`)
      }
    }

    return lines.join('\n')
  }

  private buildCodeContextSection(context: ResolvedCodeContext): string {
    const lines: string[] = ['# 代码上下文']

    if (context.summary) {
      lines.push(`## 分析摘要\n${context.summary}`)
    }

    // 核心符号（用户直接提到的）
    if (context.primarySymbols.length > 0) {
      lines.push('## 核心代码')
      for (const result of context.primarySymbols) {
        lines.push(this.formatSymbol(result))
      }
    }

    // 相关符号（依赖图扩展的）
    if (context.relatedSymbols.length > 0) {
      lines.push('## 相关代码')
      for (const result of context.relatedSymbols.slice(0, 10)) {
        lines.push(this.formatSymbol(result, true))
      }
    }

    // 相关文件内容
    if (context.relatedFiles.length > 0) {
      lines.push('## 相关文件')
      for (const file of context.relatedFiles) {
        lines.push(`### ${file.filePath} (${file.reason})`)
        lines.push('```typescript')
        lines.push(file.content)
        lines.push('```')
      }
    }

    // 依赖图
    if (context.importGraph.length > 0) {
      lines.push('## 文件依赖关系')
      for (const edge of context.importGraph) {
        lines.push(`${edge.from} -> ${edge.to}`)
      }
    }

    return lines.join('\n')
  }

  private formatSymbol(result: SymbolQueryResult, compact: boolean = false): string {
    const { symbol, score, matchedBy } = result
    const header = `### ${symbol.name} (${symbol.kind}, 匹配度: ${(score * 100).toFixed(0)}%, ${matchedBy})`

    if (compact) {
      // 紧凑模式：只显示签名和位置
      return `${header}\n- 位置: ${symbol.filePath}:${symbol.line}\n- 签名: ${symbol.signature ?? 'N/A'}`
    }

    // 完整模式：显示源码
    const lines: string[] = [header]
    if (symbol.signature) lines.push(`- 签名: ${symbol.signature}`)
    lines.push(`- 位置: ${symbol.filePath}:${symbol.line}`)
    if (symbol.jsDoc) lines.push(`- 注释: ${symbol.jsDoc}`)

    if (symbol.sourceCode) {
      lines.push('```typescript')
      lines.push(symbol.sourceCode)
      lines.push('```')
    }

    return lines.join('\n')
  }

  private buildCommandSection(command: string): string {
    return `# 任务指令\n${command}`
  }
}
