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
import { PromptOrchestrator } from '../memory/prompt-orchestrator'
import { createLogger } from '../shared/logger'
import { CONTEXT_COMPLEXITY_BUDGET, type PromptFormatter } from './prompt-formatter'

const logger = createLogger('ContextAssembler')

export class ContextAssembler {
  private contextResolver = new ContextResolver()
  private smartContextResolver?: SmartContextResolver

  /**
   * PromptFormatter owns the prompt fragment formatting (project memory /
   * session history / code context) and the optimal token budget.
   */
  constructor(private formatter: PromptFormatter) {}

  /**
   * Inject code-intelligence dependencies. Smart context resolution is
   * skipped when no symbol index is available.
   */
  setSymbolIndex(symbolIndex: SymbolIndex): void {
    this.smartContextResolver = new SmartContextResolver(symbolIndex)
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
    return this.formatter.formatMemoryContext(memory)
  }

  /**
   * 将会话历史记忆格式化为 prompt 字符串（借鉴 claude-mem 的渐进式上下文注入）
   */
  private async formatSessionHistoryContext(
    workingDirectory: string,
    nodeId?: string,
    currentSessionId?: string,
  ): Promise<string | undefined> {
    return this.formatter.formatSessionHistoryContext(workingDirectory, nodeId, currentSessionId)
  }

  /**
   * 将 ResolvedCodeContext 格式化为 prompt 字符串
   */
  private formatCodeContext(ctx: ResolvedCodeContext): string {
    return this.formatter.formatCodeContext(ctx)
  }
}