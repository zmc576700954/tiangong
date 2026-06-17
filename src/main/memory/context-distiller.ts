/**
 * 上下文蒸馏器
 *
 * 对跨轮次上下文片段进行精炼：去冗余、密度排序、预算裁剪
 * 算法:
 *   1. 评分: density = unique words (length>2) / total tokens; priority = definition/error=3, decision=2, CamelCase=1, else=0
 *   2. 去重: Jaccard similarity > 0.85 → 保留后者（移除较早重复）
 *   3. 排序: priority desc, density desc
 *   4. 填充: 贪心添加直到 budget*1.1，剩余入 removed[]
 */

import { createLogger } from '../shared/logger'

const logger = createLogger('ContextDistiller')

/** 上下文片段 */
export interface ContextFragment {
  content: string
  source: string // 标识符 (e.g., 'memory-1', 'frag-0')
  tokens: number
  type?: 'definition' | 'error' | 'decision' | 'general'
}

/** 蒸馏结果 */
export interface DistillResult {
  kept: ContextFragment[]
  removed: ContextFragment[]
  totalTokens: number
  savingsPct: number
}

/** 片段内部评分 */
interface ScoredFragment {
  fragment: ContextFragment
  density: number
  priority: number
  index: number // 原始顺序，用于去重时保留后者
}

export class ContextDistiller {
  /**
   * 对上下文片段进行蒸馏：去冗余、密度排序、预算裁剪
   *
   * @param fragments - 待蒸馏的上下文片段
   * @param budget - Token 预算上限
   * @returns 蒸馏结果
   */
  async distill(fragments: ContextFragment[], budget: number): Promise<DistillResult> {
    if (fragments.length === 0) {
      return { kept: [], removed: [], totalTokens: 0, savingsPct: 0 }
    }

    const totalTokens = fragments.reduce((sum, f) => sum + f.tokens, 0)

    // Step 1: 评分
    const scored = fragments.map((f, index) => this.score(f, index))

    // Step 2: 去重 (Jaccard > 0.85 → 保留后者)
    const { kept: deduped, removed: dedupRemoved } = this.deduplicate(scored)

    // Step 3: 排序 (priority desc, density desc)
    const sorted = deduped.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return b.density - a.density
    })

    // Step 4: 预算填充 (贪心，允许 budget*1.1 溢出)
    const softBudget = Math.floor(budget * 1.1)
    const kept: ContextFragment[] = []
    const removed: ContextFragment[] = [...dedupRemoved]
    let usedTokens = 0

    for (const sf of sorted) {
      if (usedTokens + sf.fragment.tokens <= softBudget) {
        kept.push(sf.fragment)
        usedTokens += sf.fragment.tokens
      } else {
        removed.push(sf.fragment)
      }
    }

    const keptTokens = kept.reduce((sum, f) => sum + f.tokens, 0)
    const savings = totalTokens - keptTokens
    const savingsPct = totalTokens > 0
      ? Math.round((savings / totalTokens) * 1000) / 10
      : 0

    logger.debug(
      `Distilled ${fragments.length} fragments → ${kept.length} kept, ${removed.length} removed, ` +
      `${savingsPct}% savings`,
    )

    return { kept, removed, totalTokens, savingsPct }
  }

  /**
   * 为片段计算 density 和 priority 评分
   */
  private score(fragment: ContextFragment, index: number): ScoredFragment {
    const density = this.computeDensity(fragment)
    const priority = this.computePriority(fragment)
    return { fragment, density, priority, index }
  }

  /**
   * 计算信息密度: unique words (length>2) / total tokens
   */
  private computeDensity(fragment: ContextFragment): number {
    if (fragment.tokens <= 0) return 0
    const words = fragment.content
      .split(/\s+/)
      .filter((w) => w.length > 2)
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()))
    return uniqueWords.size / fragment.tokens
  }

  /**
   * 计算优先级:
   *   definition/error → 3
   *   decision → 2
   *   CamelCase content → 1
   *   else → 0
   */
  private computePriority(fragment: ContextFragment): number {
    if (fragment.type === 'definition' || fragment.type === 'error') return 3
    if (fragment.type === 'decision') return 2
    // 检测 CamelCase 内容（如类名、函数名等技术标识符）
    if (/[A-Z][a-z]+[A-Z]/.test(fragment.content)) return 1
    return 0
  }

  /**
   * Jaccard 去重: similarity > 0.85 → 保留后者（index 更大的）
   * 返回去重后的 ScoredFragment 数组和被移除的原始片段
   */
  private deduplicate(scored: ScoredFragment[]): {
    kept: ScoredFragment[]
    removed: ContextFragment[]
  } {
    const removedIndices = new Set<number>()

    for (let i = 0; i < scored.length; i++) {
      if (removedIndices.has(i)) continue
      for (let j = i + 1; j < scored.length; j++) {
        if (removedIndices.has(j)) continue
        const sim = this.jaccardSimilarity(
          scored[i].fragment.content,
          scored[j].fragment.content,
        )
        if (sim > 0.85) {
          // 保留后者 (index 更大)，移除前者
          removedIndices.add(i)
          logger.debug(
            `Dedup: removed '${scored[i].fragment.source}' (similar to '${scored[j].fragment.source}', sim=${sim.toFixed(3)})`,
          )
          break // i 已被移除，无需继续比较
        }
      }
    }

    const removed = scored
      .filter((_, idx) => removedIndices.has(idx))
      .map((sf) => sf.fragment)
    const kept = scored.filter((_, idx) => !removedIndices.has(idx))

    return { kept, removed }
  }

  /**
   * 计算 Jaccard 相似度: |A ∩ B| / |A ∪ B|
   * 基于 word-level (length>2) 集合
   */
  private jaccardSimilarity(a: string, b: string): number {
    const setA = this.wordSet(a)
    const setB = this.wordSet(b)
    if (setA.size === 0 && setB.size === 0) return 1
    if (setA.size === 0 || setB.size === 0) return 0

    let intersection = 0
    for (const word of setA) {
      if (setB.has(word)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  /**
   * 提取 word set (length>2, lowercase, 去除标点)
   */
  private wordSet(text: string): Set<string> {
    return new Set(
      text
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map((w) => w.toLowerCase()),
    )
  }
}
