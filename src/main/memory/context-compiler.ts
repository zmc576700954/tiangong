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
 *   const layered = await compiler.compile(outputs, { ... })
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
import { GraphMemory } from './graph-memory'
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
  async compile(
    outputs: AgentOutput[],
    meta: {
      sessionId?: string
      adapterName?: string
      commandDescription?: string
      projectId?: string
      nodeId?: string
    },
  ): Promise<LayeredContext> {
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
    let l3Content = fullText.substring(0, 2000)
    if (meta.projectId) {
      const graphCtx = await this._buildL3GraphContext(meta.projectId, outputs)
      if (graphCtx) {
        l3Content += '\n\n' + graphCtx
      }
    }
    layers.push({
      level: 3,
      label: 'L3-FullOutput',
      content: l3Content,
      estimatedTokens: estimateTokens(l3Content),
    })

    // --- L4: 关联历史记忆 (可变) ---
    const l4Content = await this._buildL4(meta.projectId, meta.nodeId)
    if (l4Content) {
      layers.push({
        level: 4,
        label: 'L4-关联历史',
        content: l4Content,
        estimatedTokens: estimateTokens(l4Content),
      })
    }

    return { layers }
  }

  /**
   * 构建L4层：从 MemoryStore 获取关联历史记忆
   * 使用 this.memoryStore 懒 getter，通过 getRecent() 获取最近记忆
   * 返回格式: "[kind] title" 每行一条，出错时返回空字符串
   *
   * 如果 nodeId 存在，额外获取节点关联记忆中的 files_modified 并追加
   */
  private async _buildL4(projectId?: string, nodeId?: string): Promise<string> {
    try {
      const recent = await this.memoryStore.getRecent({
        projectId,
        limit: 5,
      })
      if (!recent || recent.length === 0) return ''

      let content = recent
        .map((item) => `[${item.kind}] ${item.title}`)
        .join('\n')

      // 如果存在 nodeId，获取节点关联记忆中的相关文件
      if (nodeId) {
        try {
          const nodeMemories = await this.memoryStore.getByNode(nodeId, 3)
          const files = nodeMemories
            .flatMap((m) => m.files_modified)
            .filter((f) => f.length > 0)
          const uniqueFiles = [...new Set(files)]
          if (uniqueFiles.length > 0) {
            content += `\nRelated files: ${uniqueFiles.join(', ')}`
          }
        } catch {
          // node-associated context is optional, ignore errors
        }
      }

      return content
    } catch {
      return ''
    }
  }

  /**
   * 构建 L3 层的图记忆上下文
   *
   * 使用 GraphMemory.inferRelations 推断记忆之间的因果关系，
   * 将置信度 > 0.5 的前 5 条关系格式化为可读文本注入 L3 层。
   *
   * @param projectId - 项目 ID
   * @param _outputs - 当前输出（保留供未来使用）
   * @returns 格式化的图关系文本，出错时返回空字符串
   */
  private async _buildL3GraphContext(projectId: string, _outputs: AgentOutput[]): Promise<string> {
    try {
      const store = getMemoryStore()
      const recent = await store.getRecent({ projectId, limit: 20 })
      if (recent.length < 2) return ''

      const graphMemory = new GraphMemory(store)
      const [first, ...rest] = recent
      const relations = graphMemory.inferRelations(first, rest)

      const topRelations = relations
        .filter((r) => r.confidence > 0.5)
        .slice(0, 5)

      if (topRelations.length === 0) return ''

      return topRelations
        .map((r) => `${r.reason} (${r.relation}, confidence: ${r.confidence.toFixed(2)})`)
        .join('\n')
    } catch {
      return ''
    }
  }

  /**
   * 在 Token 预算内渲染分层上下文
   * 从 L1 开始逐层包含，直到预算耗尽
   *
   * 支持预算感知深度选择 (budgetFraction):
   *   - budgetFraction > 0.7: 包含 L1-L4 (所有层)
   *   - budgetFraction 0.4-0.7: 包含 L1-L3
   *   - budgetFraction < 0.4: 仅包含 L1 摘要
   *
   * @param context - 分层上下文
   * @param maxTokens - 可用 Token 预算
   * @param budgetFraction - 可选，预算占总上下文的比例 (0-1)，用于深度自适应
   * @returns 渲染后的上下文字符串和 Token 经济学
   */
  render(context: LayeredContext, maxTokens: number, budgetFraction?: number): { text: string; economics: TokenEconomics } {
    // 预算感知深度选择：根据 budgetFraction 决定最大包含层数
    let maxLevel: 1 | 2 | 3 | 4 = 4
    if (budgetFraction !== undefined) {
      if (budgetFraction < 0.4) {
        maxLevel = 1
      } else if (budgetFraction < 0.7) {
        maxLevel = 3
      }
      // budgetFraction >= 0.7 → maxLevel = 4 (all layers)
    }

    const outputParts: string[] = []
    let used = 0

    for (const layer of context.layers.sort((a, b) => a.level - b.level)) {
      // 深度裁剪：跳过超过 maxLevel 的层
      if (layer.level > maxLevel) continue

      if (used + layer.estimatedTokens <= maxTokens) {
        const label = layer.label.replace(/^L\d+-/, '')
        outputParts.push(`[${label}]\n${layer.content}`)
        used += layer.estimatedTokens
      } else {
        // 预算不足，标记更深层可按需获取
        const remaining = context.layers.filter((l) => l.level > layer.level && l.level <= maxLevel)
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
   * @param maxMessages - 最大历史消息数量（默认 20），超出时截断并生成摘要
   */
  renderWithHistory(
    current: LayeredContext,
    history: MemoryItem[],
    budget: number,
    maxMessages: number = 20,
  ): { text: string; economics: TokenEconomics } {
    const historyLines: string[] = []
    let historyTokens = 0

    // Task 2.5.1: Truncate history if it exceeds maxMessages, prepend summary of older ones
    let effectiveHistory = history
    if (history.length > maxMessages) {
      const olderCount = history.length - maxMessages
      // Summarize older messages: count and first line of each
      const olderMessages = history.slice(0, olderCount)
      const olderSummary = olderMessages
        .slice(0, 10) // Cap summary to avoid bloating
        .map((m, i) => `  ${i + 1}. ${this.memoryStore.toCompactSummary(m).split('\n')[0]}`)
        .join('\n')
      const truncationLine = olderCount > 10
        ? `[${olderCount} earlier messages omitted — first 10 shown]\n${olderSummary}`
        : `[${olderCount} earlier messages omitted]\n${olderSummary}`
      historyLines.push(truncationLine)
      historyTokens += estimateTokens(truncationLine)
      effectiveHistory = history.slice(olderCount)
    }

    // 自适应历史预算：根据可用历史数量动态分配 15-40%
    let historyBudgetPct = 0.15  // 基线
    if (effectiveHistory.length >= 3) historyBudgetPct = 0.25
    if (effectiveHistory.length >= 5) historyBudgetPct = 0.35
    historyBudgetPct = Math.min(historyBudgetPct, 0.4) // 上限 40%

    // 生成紧凑历史上下文
    if (effectiveHistory.length > 0) {
      historyLines.push('[Historical Context]')
      for (let i = 0; i < Math.min(effectiveHistory.length, 5); i++) {
        const line = `  ${i + 1}. ${this.memoryStore.toCompactSummary(effectiveHistory[i])}`
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

    const totalDiscovery = economics.discoveryTokens + historyTokens
    const totalRead = economics.readTokens + historyTokens
    const totalSavings = Math.max(0, totalDiscovery - totalRead)

    return {
      text: allParts.join('\n\n'),
      economics: {
        discoveryTokens: totalDiscovery,
        readTokens: totalRead,
        savings: totalSavings,
        savingsPct: totalDiscovery > 0
          ? Math.round((totalSavings / totalDiscovery) * 1000) / 10
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
    try {
      const layered = await this.compile(outputs, {
        sessionId: options?.sessionId,
        adapterName: options?.adapterName,
        commandDescription: options?.commandDescription,
        projectId: options?.projectId,
        nodeId: options?.nodeId,
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
    } catch {
      return {
        text: '',
        economics: {
          discoveryTokens: 0,
          readTokens: 0,
          savings: 0,
          savingsPct: 0,
        },
      }
    }
  }
}
