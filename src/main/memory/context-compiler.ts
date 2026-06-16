/**
 * 渐进式上下文编译器
 *
 * 借鉴 claude-mem 的 ContextBuilder + 渐进式披露设计
 * 将 Agent 输出编译为分层上下文（L1-L4），在 Token 预算内从最紧凑层开始逐层注入
 *
 * 分层结构:
 *   L1 (~20 tokens): 一行摘要，关键结论
 *   L2 (~80 tokens): 关键事实、逻辑链、受影响文件
 *   L3 (~200-500 tokens): 完整报告（JSON 序列化）
 *   L4 (可变): 关联的历史记忆（来自 MemoryStore）
 *
 * 用法:
 *   const compiler = new ContextCompiler()
 *   const layered = compiler.compile(outputs, { ... })
 *   const prompt = layered.render(budgetTokens)  // 在预算内逐层注入
 */

import type {
  AgentOutput,
  ContextLayer,
  LayeredContext,
  MemoryItem,
  TokenEconomics,
} from '@shared/types'
import { getMemoryStore } from './memory-store'
import { estimateTokens } from '../shared/token-utils'

export class ContextCompiler {
  /** 懒初始化：避免构造时 getMemoryStore() 调用 getClient() 在数据库未就绪时崩溃 */
  private _memoryStore?: ReturnType<typeof getMemoryStore>
  private get memoryStore(): ReturnType<typeof getMemoryStore> {
    if (!this._memoryStore) this._memoryStore = getMemoryStore()
    return this._memoryStore
  }

  /**
   * 将 AgentOutput 流编译为分层上下文
   */
  compile(
    outputs: AgentOutput[],
    meta: {
      sessionId?: string
      adapterName?: string
      commandDescription?: string
    },
  ): LayeredContext {
    const layers: ContextLayer[] = []

    // 提取纯文本输出
    const fullText = outputs
      .filter((o) => o.type === 'stdout' || o.type === 'complete')
      .map((o) => o.data)
      .join('\n')

    const errorText = outputs
      .filter((o) => o.type === 'stderr')
      .map((o) => o.data)
      .join('\n')

    const fileChanges = outputs.filter((o) => o.type === 'file_change' && o.filePath)
    const hasErrors = errorText.length > 0

    // --- L1: 一行摘要 (~20 tokens) ---
    const l1Parts: string[] = []
    const statusIcon = hasErrors ? '⚠️' : '✅'
    l1Parts.push(`${statusIcon} ${meta.commandDescription ?? 'Agent session'}`)
    if (meta.adapterName) l1Parts.push(`[${meta.adapterName}]`)
    if (fileChanges.length > 0) {
      l1Parts.push(`| Files: ${fileChanges.length}`)
    }
    if (hasErrors) {
      l1Parts.push('| Has errors')
    }

    const l1Content = l1Parts.join(' ')
    layers.push({
      level: 1,
      label: 'L1-Summary',
      content: l1Content,
      estimatedTokens: estimateTokens(l1Content),
    })

    // --- L2: 关键事实 (~80 tokens) ---
    const l2Lines: string[] = []

    // 选择信息密度最高的 stdout 块作为摘要源
    // 评分：含错误/文件变更关键词加分，长度加分，位置递增加分（偏后=更接近结论）
    const stdoutBlocks = outputs
      .filter((o) => o.type === 'stdout')
      .map((o) => o.data.trim())
      .filter((s) => s.length > 20)

    if (stdoutBlocks.length > 0) {
      const bestBlock = stdoutBlocks.reduce((best, block, idx) => {
        let score = block.length
        if (/error|fail|exception/i.test(block)) score += 100
        if (/\d+\s*(?:files?|tests?|passed|failed)/i.test(block)) score += 80
        if (/modified|created|deleted/i.test(block)) score += 60
        // 偏后位置的输出更可能是结论
        score += idx * 5
        return score > best.score ? { text: block, score } : best
      }, { text: '', score: -1 })

      if (bestBlock.text) {
        l2Lines.push(`Summary: ${bestBlock.text.substring(0, 300)}`)
      }
    }

    // 文件变更列表
    if (fileChanges.length > 0) {
      const fileList = fileChanges
        .slice(0, 10)
        .map((o) => `  ${o.changeType ?? 'modify'}: ${o.filePath}`)
        .join('\n')
      l2Lines.push(`Files:\n${fileList}`)
    }

    // 错误摘要
    if (hasErrors) {
      const errSummary = errorText.split('\n').filter((l) => l.trim().length > 0).slice(0, 5).join('\n')
      l2Lines.push(`Errors:\n${errSummary.substring(0, 400)}`)
    }

    const l2Content = l2Lines.join('\n\n')
    layers.push({
      level: 2,
      label: 'L2-KeyFacts',
      content: l2Content,
      estimatedTokens: estimateTokens(l2Content),
    })

    // --- L3: 完整输出 (~200-500 tokens) ---
    const l3Content = fullText.substring(0, 2000)
    layers.push({
      level: 3,
      label: 'L3-FullOutput',
      content: l3Content,
      estimatedTokens: estimateTokens(l3Content),
    })

    return { layers }
  }

  /**
   * 在 Token 预算内渲染分层上下文
   * 从 L1 开始逐层包含，直到预算耗尽
   *
   * @param context - 分层上下文
   * @param maxTokens - 可用 Token 预算
   * @returns 渲染后的上下文字符串和 Token 经济学
   */
  render(context: LayeredContext, maxTokens: number): { text: string; economics: TokenEconomics } {
    const outputParts: string[] = []
    let used = 0

    for (const layer of context.layers.sort((a, b) => a.level - b.level)) {
      if (used + layer.estimatedTokens <= maxTokens) {
        const label = layer.label.replace('L1-', '').replace('L2-', '').replace('L3-', '')
        outputParts.push(`[${label}]\n${layer.content}`)
        used += layer.estimatedTokens
      } else {
        // 预算不足，标记更深层可按需获取
        const remaining = context.layers.filter((l) => l.level > layer.level)
        if (remaining.length > 0) {
          const remainingTokens = remaining.reduce((sum, l) => sum + l.estimatedTokens, 0)
          outputParts.push(
            `[Note: ${remaining.length} deeper layer(s) available (~${remainingTokens} tokens). Request --verbose for full context.]`,
          )
        }
        break
      }
    }

    const totalDiscovery = context.layers.reduce((sum, l) => sum + l.estimatedTokens, 0)
    const savings = Math.max(0, totalDiscovery - used)

    return {
      text: outputParts.join('\n\n'),
      economics: {
        discoveryTokens: totalDiscovery,
        readTokens: used,
        savings,
        savingsPct: totalDiscovery > 0
          ? Math.round((savings / totalDiscovery) * 1000) / 10
          : 0,
      },
    }
  }

  /**
   * 将分层上下文与历史记忆组合，在预算内渲染
   *
   * @param current - 当前会话的分层上下文
   * @param history - 来自 MemoryStore 的历史记忆（已转为紧凑字符串）
   * @param budget - Token 预算
   */
  renderWithHistory(
    current: LayeredContext,
    history: MemoryItem[],
    budget: number,
  ): { text: string; economics: TokenEconomics } {
    const historyLines: string[] = []
    let historyTokens = 0

    // 自适应历史预算：根据可用历史数量动态分配 15-40%
    let historyBudgetPct = 0.15  // 基线
    if (history.length >= 3) historyBudgetPct = 0.25
    if (history.length >= 5) historyBudgetPct = 0.35
    historyBudgetPct = Math.min(historyBudgetPct, 0.4) // 上限 40%

    // 生成紧凑历史上下文
    if (history.length > 0) {
      historyLines.push('[Historical Context]')
      const store = getMemoryStore()
      for (let i = 0; i < Math.min(history.length, 5); i++) {
        const line = `  ${i + 1}. ${store.toCompactSummary(history[i])}`
        const lineTokens = estimateTokens(line)
        if (historyTokens + lineTokens > budget * historyBudgetPct) break
        historyLines.push(line)
        historyTokens += lineTokens
      }
    }

    const remainingBudget = budget - historyTokens
    const { text: currentText, economics } = this.render(
      current,
      Math.max(remainingBudget, 0),
    )

    const allParts = historyLines.length > 0
      ? [historyLines.join('\n'), currentText]
      : [currentText]

    return {
      text: allParts.join('\n\n'),
      economics: {
        ...economics,
        readTokens: economics.readTokens + historyTokens,
        savingsPct: economics.discoveryTokens > 0
          ? Math.round((economics.savings / economics.discoveryTokens) * 1000) / 10
          : 0,
      },
    }
  }

  /**
   * 便捷方法：为传递给下游 Agent 的上下文生成注入文本
   *
   * @param outputs - 上游 Agent 的输出
   * @param budget - 下游 Agent 的上下文预算
   * @param options - 可选：项目 ID（用于获取历史记忆）、节点 ID
   */
  async injectForDownstream(
    outputs: AgentOutput[],
    budget: number,
    options?: {
      projectId?: string
      nodeId?: string
      sessionId?: string
      adapterName?: string
      commandDescription?: string
    },
  ): Promise<{ text: string; economics: TokenEconomics }> {
    const layered = this.compile(outputs, {
      sessionId: options?.sessionId,
      adapterName: options?.adapterName,
      commandDescription: options?.commandDescription,
    })

    // 获取历史记忆
    const history = options?.projectId
      ? await this.memoryStore.getRecent({
          projectId: options.projectId,
          nodeId: options?.nodeId,
          limit: 5,
        })
      : []

    return this.renderWithHistory(layered, history, budget)
  }
}
