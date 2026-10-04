/**
 * PromptFormatter — Prompt 上下文格式化器
 *
 * 职责：将项目记忆、会话历史记忆、代码上下文（ResolvedCodeContext）转换为
 *       注入到 agent prompt 的 Markdown 片段。同时基于历史 Prompt 质量反馈
 *       计算最优 Token 预算。
 *
 * 此模块替代 AgentManager 中以下方法的实现：
 * - formatMemoryContext
 * - formatSessionHistoryContext
 * - formatCodeContext
 * - getOptimalPromptBudget
 *
 * AgentManager 在 resolveAndSendCommand 中调用 formatter.format* 与 getOptimalPromptBudget。
 */

import type { ProjectMemory } from '@shared/types'
import type { ResolvedCodeContext } from '../code-intelligence/smart-context-resolver'
import type { MemoryStore } from '../memory'

/** 命令类型的上下文 Token 预算（与 AgentManager.CONTEXT_COMPLEXITY_BUDGET 同步） */
const DEFAULT_COMPLEXITY_BUDGET: Record<string, number> = {
  fix_bug: 6000,
  add_test: 6000,
  refactor: 10000,
  implement: 12000,
}

/** Prompt Token 预算的最小/最大边界（来自 AgentManager.getOptimalPromptBudget） */
const PROMPT_BUDGET_MIN = 4000
const PROMPT_BUDGET_MAX = 16000

export class PromptFormatter {
  /** Prompt 质量反馈记录：与 AgentManager.promptOutcomeLog 共享引用 */
  private readonly promptOutcomeLog: Array<{
    commandType: string
    promptTokenEstimate: number
    contextCount: number
    outcome: 'success' | 'failure'
    duration: number
  }>

  constructor(
    private readonly memoryStore: MemoryStore,
    promptOutcomeLog: Array<{
      commandType: string
      promptTokenEstimate: number
      contextCount: number
      outcome: 'success' | 'failure'
      duration: number
    }>,
  ) {
    this.promptOutcomeLog = promptOutcomeLog
  }

  /**
   * 将项目记忆格式化为 prompt 字符串
   */
  formatMemoryContext(memory: ProjectMemory): string | undefined {
    const hasContent =
      memory.businessDomains.length > 0 ||
      memory.architecturePattern ||
      memory.coreUserFlows.length > 0 ||
      memory.techConstraints.length > 0
    if (!hasContent) return undefined

    const lines: string[] = ['# 项目记忆']

    if (memory.businessDomains.length > 0) {
      lines.push(`## 业务域\n${memory.businessDomains.join(', ')}`)
    }
    if (memory.architecturePattern) {
      lines.push(`## 架构模式\n${memory.architecturePattern}`)
    }
    if (memory.coreUserFlows.length > 0) {
      lines.push(`## 核心用户流程\n${memory.coreUserFlows.map((f: string) => `- ${f}`).join('\n')}`)
    }
    if (memory.techConstraints.length > 0) {
      lines.push(`## 技术约束\n${memory.techConstraints.map((c: string) => `- ${c}`).join('\n')}`)
    }
    if (memory.preferences) {
      const prefs = memory.preferences
      lines.push(
        `## 用户偏好\n- 命名风格: ${prefs.namingStyle}\n- 粒度: ${prefs.granularity}\n- 最大模块数: ${prefs.maxModules}`,
      )
      if (prefs.avoidPatterns.length > 0) {
        lines.push(`- 避免模式: ${prefs.avoidPatterns.join(', ')}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 将会话历史记忆格式化为 prompt 字符串（借鉴 claude-mem 的渐进式上下文注入）
   */
  async formatSessionHistoryContext(
    workingDirectory: string,
    nodeId?: string,
    _currentSessionId?: string,
  ): Promise<string | undefined> {
    const recent = await this.memoryStore.getRecent({
      projectId: workingDirectory,
      nodeId,
      limit: 5,
    })
    if (recent.length === 0) return undefined

    const lines: string[] = ['# 会话历史记忆（自动注入）']
    for (const item of recent) {
      lines.push(this.memoryStore.toCompactSummary(item))
    }

    // 注入跨适配器记忆
    const crossAdapter = await this.memoryStore.getCrossAdapter(workingDirectory, '', 3)
    if (crossAdapter.length > 0) {
      lines.push('\n## 其他 Agent 的发现')
      for (const item of crossAdapter) {
        lines.push(`[${item.adapter_name}] ${this.memoryStore.toCompactSummary(item)}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 将 ResolvedCodeContext 格式化为 prompt 字符串
   */
  formatCodeContext(ctx: ResolvedCodeContext): string {
    const lines: string[] = ['# 代码上下文']

    if (ctx.summary) {
      lines.push(`## 分析摘要\n${ctx.summary}`)
    }

    if (ctx.primarySymbols.length > 0) {
      lines.push('## 核心代码')
      for (const result of ctx.primarySymbols) {
        const { symbol, score, matchedBy } = result
        lines.push(`### ${symbol.name} (${symbol.kind}, 匹配度: ${(score * 100).toFixed(0)}%, ${matchedBy})`)
        if (symbol.signature) lines.push(`- 签名: ${symbol.signature}`)
        lines.push(`- 位置: ${symbol.filePath}:${symbol.line}`)
        if (symbol.sourceCode) {
          lines.push('```typescript')
          lines.push(symbol.sourceCode)
          lines.push('```')
        }
      }
    }

    if (ctx.relatedSymbols.length > 0) {
      lines.push('## 相关代码')
      for (const result of ctx.relatedSymbols.slice(0, 10)) {
        const { symbol, score } = result
        lines.push(`- ${symbol.name} (${symbol.kind}): ${symbol.filePath}:${symbol.line} (得分: ${(score * 100).toFixed(0)}%)`)
      }
    }

    if (ctx.relatedFiles.length > 0) {
      lines.push('## 相关文件')
      for (const file of ctx.relatedFiles) {
        lines.push(`### ${file.filePath} (${file.reason})`)
        lines.push('```typescript')
        lines.push(file.content.slice(0, 3000))
        lines.push('```')
      }
    }

    if (ctx.importGraph.length > 0) {
      lines.push('## 文件依赖关系')
      for (const edge of ctx.importGraph) {
        lines.push(`${edge.from} -> ${edge.to}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 根据历史 Prompt 质量反馈计算最优 Token 预算
   */
  getOptimalPromptBudget(commandType: string): number {
    const relevant = this.promptOutcomeLog.filter((e) => e.commandType === commandType)
    if (relevant.length < 5) return DEFAULT_COMPLEXITY_BUDGET[commandType] ?? 8000
    const successEntries = relevant.filter((e) => e.outcome === 'success')
    if (successEntries.length === 0) return DEFAULT_COMPLEXITY_BUDGET[commandType] ?? 8000
    const avgTokens =
      successEntries.reduce((sum, e) => sum + e.promptTokenEstimate, 0) / successEntries.length
    return Math.max(PROMPT_BUDGET_MIN, Math.min(PROMPT_BUDGET_MAX, Math.round(avgTokens * 1.2)))
  }
}