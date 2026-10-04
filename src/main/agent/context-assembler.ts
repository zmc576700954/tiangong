/**
 * ContextAssembler — orchestrates context resolution + prompt assembly.
 *
 * Extracted from AgentManager in D1a. Owns:
 *  - Context resolution (ContextResolver)
 *  - Smart code-context resolution (SmartContextResolver)
 *  - Project memory loading + formatting
 *  - Session history memory loading + formatting
 *  - Prompt assembly via PromptOrchestrator
 *
 * AgentManager retains the responsibility of feeding the assembled prompt
 * into the adapter (via setResolvedContexts / setCodeContext / setMemoryContext)
 * and triggering the actual send.
 */

import type {
  AgentCommand,
  AgentSessionConfig,
  ContextRef,
  GraphNode,
  ProjectMemory,
  ResolvedContext,
} from '@shared/types'
import { ContextResolver } from '../context-resolver'
import { SmartContextResolver, type ResolvedCodeContext } from '../code-intelligence/smart-context-resolver'
import type { SymbolIndex } from '../code-intelligence/symbol-index'
import { readMemory } from '../mindmap-agent/memory'
import type { MemoryStore } from '../memory'
import { PromptOrchestrator } from '../memory/prompt-orchestrator'
import { createLogger } from '../shared/logger'

const logger = createLogger('ContextAssembler')

/** 命令类型的上下文 Token 预算（根据任务复杂度自适应） */
const CONTEXT_COMPLEXITY_BUDGET: Record<string, number> = {
  fix_bug: 6000,
  add_test: 6000,
  refactor: 10000,
  implement: 12000,
}

export class ContextAssembler {
  private contextResolver = new ContextResolver()
  private smartContextResolver?: SmartContextResolver

  /** Lazy accessor — keeps the constructor free of DB access. */
  constructor(private getMemoryStore: () => MemoryStore) {}

  /**
   * Inject code-intelligence dependencies. Smart context resolution is
   * skipped when no symbol index is available.
   */
  setSymbolIndex(symbolIndex: SymbolIndex): void {
    this.smartContextResolver = new SmartContextResolver(symbolIndex)
  }

  /**
   * Compute the optimal prompt token budget for a command type using historical
   * prompt-quality outcomes. Data-insufficient falls back to CONTEXT_COMPLEXITY_BUDGET.
   */
  computeOptimalBudget(commandType: string, outcomes: ReadonlyArray<{ commandType: string; promptTokenEstimate: number; outcome: 'success' | 'failure' }>): number {
    const relevant = outcomes.filter((e) => e.commandType === commandType)
    if (relevant.length < 5) return CONTEXT_COMPLEXITY_BUDGET[commandType] ?? 8000
    const successEntries = relevant.filter((e) => e.outcome === 'success')
    if (successEntries.length === 0) return CONTEXT_COMPLEXITY_BUDGET[commandType] ?? 8000
    const avgTokens = successEntries.reduce((sum, e) => sum + e.promptTokenEstimate, 0) / successEntries.length
    return Math.max(4000, Math.min(16000, Math.round(avgTokens * 1.2)))
  }

  /**
   * Resolve all context layers in parallel:
   *  - Standard context (ContextResolver) — driven by user-supplied contextRefs
   *  - Smart code context (SmartContextResolver) — from workingDirectory + command
   *  - Project memory (readMemory) — from .bizgraph/memory.json
   *  - Session history (MemoryStore) — recent memory items for this project
   *
   * Returns resolved contexts + the assembled prompt text + total token estimate.
   */
  async assemble(args: {
    sessionId: string
    command: AgentCommand
    adapterName: string
    sessionConfig: AgentSessionConfig | undefined
    contextRefs?: ContextRef[]
    nodes?: GraphNode[]
    optimalBudget: number
  }): Promise<{
    resolvedContexts: ResolvedContext[]
    codeContext: string | undefined
    assembled: { text: string; totalTokens: number }
  }> {
    const { command, sessionConfig, contextRefs, nodes, optimalBudget, sessionId, adapterName } = args

    const [resolvedContexts, codeContext, _memoryContext, _sessionHistoryContext] = await Promise.all([
      // 标准上下文解析（根据命令类型自适应 Token 预算）
      (contextRefs && contextRefs.length > 0)
        ? this.contextResolver.resolve(contextRefs, CONTEXT_COMPLEXITY_BUDGET[(command as AgentCommand).type] ?? 8000, {
            nodes: nodes ?? [],
            basePath: sessionConfig?.workingDirectory,
          })
        : Promise.resolve([] as ResolvedContext[]),
      // 智能代码上下文解析
      (this.smartContextResolver && sessionConfig?.workingDirectory)
        ? this.smartContextResolver.resolve({
            userQuery: typeof command === 'string' ? command : command.description,
            projectPath: sessionConfig.workingDirectory,
            nodes: nodes ?? [],
            maxSymbols: 15,
            maxFiles: 8,
            dependencyDepth: 2,
          }).then((ctx) => {
            if (ctx.primarySymbols.length > 0 || ctx.relatedFiles.length > 0) {
              return this.formatCodeContext(ctx)
            }
            return undefined
          }).catch((err) => {
            logger.warn('Smart context resolution failed:', err)
            return undefined
          })
        : Promise.resolve(undefined as string | undefined),
      // 项目记忆上下文（从 .bizgraph/memory.json 加载）
      sessionConfig?.workingDirectory
        ? readMemory(sessionConfig.workingDirectory).then((mem) => {
            return this.formatMemoryContext(mem)
          }).catch((err) => {
            logger.debug('Project memory load skipped:', err)
            return undefined
          })
        : Promise.resolve(undefined as string | undefined),
      // MEM-03: 会话历史记忆（从 MemoryStore 加载，借鉴 claude-mem 的渐进式上下文注入）
      sessionConfig?.workingDirectory
        ? this.formatSessionHistoryContext(
            sessionConfig.workingDirectory,
            sessionConfig.nodeId,
            sessionId,
          )
        : Promise.resolve(undefined as string | undefined),
    ])

    // Use PromptOrchestrator to assemble the full prompt from all context layers
    const orchestrator = new PromptOrchestrator()
    const assembled = await orchestrator.assemble({
      sessionId,
      adapterName,
      projectId: sessionConfig?.workingDirectory,
      nodeId: sessionConfig?.nodeId,
      nodeTitle: sessionConfig?.nodeTitle,
      userCommand: typeof command === 'string' ? command : command.description,
      totalBudget: optimalBudget,
      sessionConfig,
      resolvedContexts,
      codeContext,
    })

    return { resolvedContexts, codeContext, assembled }
  }

  /**
   * 将项目记忆格式化为 prompt 字符串
   */
  private formatMemoryContext(memory: ProjectMemory): string | undefined {
    const hasContent = memory.businessDomains.length > 0
      || memory.architecturePattern
      || memory.coreUserFlows.length > 0
      || memory.techConstraints.length > 0
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
      lines.push(`## 用户偏好\n- 命名风格: ${prefs.namingStyle}\n- 粒度: ${prefs.granularity}\n- 最大模块数: ${prefs.maxModules}`)
      if (prefs.avoidPatterns.length > 0) {
        lines.push(`- 避免模式: ${prefs.avoidPatterns.join(', ')}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 将会话历史记忆格式化为 prompt 字符串（借鉴 claude-mem 的渐进式上下文注入）
   */
  private async formatSessionHistoryContext(
    workingDirectory: string,
    nodeId?: string,
    _currentSessionId?: string,
  ): Promise<string | undefined> {
    const recent = await this.getMemoryStore().getRecent({
      projectId: workingDirectory,
      nodeId,
      limit: 5,
    })
    if (recent.length === 0) return undefined

    const lines: string[] = ['# 会话历史记忆（自动注入）']
    for (const item of recent) {
      lines.push(this.getMemoryStore().toCompactSummary(item))
    }

    const crossAdapter = await this.getMemoryStore().getCrossAdapter(workingDirectory, '', 3)
    if (crossAdapter.length > 0) {
      lines.push('\n## 其他 Agent 的发现')
      for (const item of crossAdapter) {
        lines.push(`[${item.adapter_name}] ${this.getMemoryStore().toCompactSummary(item)}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 将 ResolvedCodeContext 格式化为 prompt 字符串
   */
  private formatCodeContext(ctx: ResolvedCodeContext): string {
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
}