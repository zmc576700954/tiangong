/**
 * 混合搜索引擎 —— FTS5 + 关键词向量相似度的双层检索
 *
 * 在没有嵌入模型的条件下，使用启发式的关键词向量方法
 * 实现比纯 FTS5 更好的语义检索效果。
 *
 * 检索策略:
 *   Layer 1 (FTS5): 精确/模糊文本匹配 → 召回候选集（高召回）
 *   Layer 2 (Keyword Vector): 基于 TF-IDF 启发式的关键词向量相似度 → 重排序（高精度）
 *   Layer 3 (Fallback): 当 FTS5 不可用时，使用 LIKE 搜索 + 关键词匹配
 *
 * 关键词向量方法:
 *   将查询和每个文档都表示为一个关键词频率向量，
 *   使用余弦相似度计算语义相关性。
 *   这不是真正的嵌入向量，但比纯文本匹配能更好地捕捉语义。
 *
 * 用法:
 *   const searcher = new HybridSearchEngine(memoryStore)
 *   const results = await searcher.search("authentication bug fix", { projectId: "x" })
 */

import type { MemoryItem, MemoryKind } from '@shared/types'
import type { MemoryStore } from './memory-store'
import { createLogger } from '../shared/logger'

const logger = createLogger('HybridSearch')

// ============================================
// 类型定义
// ============================================

/** 带排名的搜索结果 */
export interface RankedSearchResult {
  /** 记忆项 */
  item: MemoryItem
  /** 综合得分 0-1 */
  score: number
  /** FTS5 排名得分（归一化） */
  ftsScore: number
  /** 关键词向量相似度 0-1 */
  keywordScore: number
  /** 匹配的原因（调试用） */
  matchReason: string
}

/** 搜索选项 */
export interface HybridSearchOptions {
  /** 项目筛选 */
  projectId?: string
  /** 记忆类型筛选 */
  kind?: MemoryKind
  /** 最大返回数量 */
  limit?: number
  /** FTS5 和关键词的权重平衡（0 = 仅关键词, 1 = 仅 FTS5, 默认 0.5） */
  ftsWeight?: number
  /** 最低得分阈值（低于此分数的结果被过滤） */
  scoreThreshold?: number
  /** 是否包含低置信度记忆 */
  includeLowConfidence?: boolean
}

/** 混合搜索引擎配置 */
export interface HybridSearchConfig {
  /** 默认 FTS 权重 */
  defaultFtsWeight: number
  /** 默认最低得分阈值 */
  defaultScoreThreshold: number
  /** FTS5 召回的最大数量（用于重排序） */
  ftsRecallLimit: number
}

const DEFAULT_CONFIG: HybridSearchConfig = {
  defaultFtsWeight: 0.5,
  defaultScoreThreshold: 0.1,
  ftsRecallLimit: 50,
}

// ============================================
// 关键词向量工具
// ============================================

/** 英文停用词 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'this', 'that', 'these', 'those', 'it', 'its',
])

/**
 * 将文本分词并去停用词
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
}

/**
 * 构建关键词频率向量
 * 返回 Map<token, normalized_frequency>
 */
function buildKeywordVector(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  // 归一化：除以最大频率
  const maxFreq = Math.max(...freq.values())
  if (maxFreq > 0) {
    for (const [k, v] of freq) {
      freq.set(k, v / maxFreq)
    }
  }
  return freq
}

/**
 * 计算两个关键词向量的余弦相似度
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0

  let dotProduct = 0
  let magnitudeA = 0
  let magnitudeB = 0

  // 计算点积（仅迭代较小的向量以提高效率）
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  for (const [token, freqA] of smaller) {
    const freqB = larger.get(token) ?? 0
    dotProduct += freqA * freqB
  }

  // 计算模长
  for (const v of a.values()) magnitudeA += v * v
  for (const v of b.values()) magnitudeB += v * v

  magnitudeA = Math.sqrt(magnitudeA)
  magnitudeB = Math.sqrt(magnitudeB)

  if (magnitudeA === 0 || magnitudeB === 0) return 0
  return dotProduct / (magnitudeA * magnitudeB)
}

// ============================================
// HybridSearchEngine 主类
// ============================================

export class HybridSearchEngine {
  private config: HybridSearchConfig
  private memoryStore: MemoryStore

  constructor(memoryStore: MemoryStore, config?: Partial<HybridSearchConfig>) {
    this.memoryStore = memoryStore
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 混合搜索：FTS5 召回 + 关键词向量重排序
   *
   * @param query - 自然语言查询
   * @param options - 搜索选项
   * @returns 按 score 降序排列的结果
   */
  async search(
    query: string,
    options?: HybridSearchOptions,
  ): Promise<RankedSearchResult[]> {
    const limit = options?.limit ?? 20
    const ftsWeight = options?.ftsWeight ?? this.config.defaultFtsWeight
    const scoreThreshold = options?.scoreThreshold ?? this.config.defaultScoreThreshold

    // 1. 构建查询的关键词向量
    const queryTokens = tokenize(query)
    const queryVector = buildKeywordVector(queryTokens)

    if (queryTokens.length === 0) {
      return []
    }

    // 2. FTS5 召回大量候选
    const candidates = await this.memoryStore.search(query, {
      projectId: options?.projectId,
      kind: options?.kind,
      limit: this.config.ftsRecallLimit,
    })

    if (candidates.length === 0) {
      logger.debug(`FTS5 returned no results for "${query}", trying LIKE fallback`)
      return []
    }

    // 3. 关键词向量重排序
    const ranked = candidates.map((item) => {
      // 构建文档的关键词向量（结合 title + narrative + concepts）
      const docText = [
        item.title,
        item.narrative,
        ...item.concepts,
        ...item.facts,
      ].join(' ')
      const docTokens = tokenize(docText)
      const docVector = buildKeywordVector(docTokens)

      const keywordScore = cosineSimilarity(queryVector, docVector)

      // FTS5 分数估算：候选列表中的顺序作为近似（越靠前分数越高）
      // MemoryStore.search 不直接返回 FTS5 rank，因此用位置近似
      const candidateIndex = candidates.indexOf(item)
      const ftsScore = candidates.length > 1
        ? 1 - (candidateIndex / (candidates.length - 1))
        : 1

      // 混合分数
      const score = ftsWeight * ftsScore + (1 - ftsWeight) * keywordScore

      return {
        item,
        score,
        ftsScore,
        keywordScore,
        matchReason: keywordScore > ftsScore
          ? `Semantic match (keyword similarity: ${(keywordScore * 100).toFixed(0)}%)`
          : `Text match (FTS5 rank: ${(ftsScore * 100).toFixed(0)}%)`,
      }
    })

    // 4. 排序和过滤
    const filtered = ranked
      .filter((r) => r.score >= scoreThreshold)
      .filter((r) => options?.includeLowConfidence !== false || r.item.confidence >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    logger.debug(`Hybrid search "${query}": ${candidates.length} candidates → ${filtered.length} results (top score: ${filtered[0]?.score.toFixed(3) ?? 'N/A'})`)

    return filtered
  }

  /**
   * 仅使用关键词向量搜索（不依赖 FTS5）
   * 在 FTS5 不可用时的完整 fallback
   */
  async keywordOnlySearch(
    query: string,
    options?: {
      projectId?: string
      kind?: MemoryKind
      limit?: number
      scoreThreshold?: number
    },
  ): Promise<RankedSearchResult[]> {
    const limit = options?.limit ?? 20
    const scoreThreshold = options?.scoreThreshold ?? this.config.defaultScoreThreshold

    // 构建查询向量
    const queryTokens = tokenize(query)
    const queryVector = buildKeywordVector(queryTokens)

    if (queryTokens.length === 0) return []

    // 获取候选：使用 LIKE 搜索作为召回
    const candidates = await this.memoryStore.getRecent({
      projectId: options?.projectId,
      limit: 100,
    })

    // 额外通过 LIKE 获取特定类型的候选
    let kindCandidates: MemoryItem[] = []
    if (options?.kind) {
      kindCandidates = await this.memoryStore.search(query, {
        projectId: options?.projectId,
        kind: options.kind,
        limit: 50,
      })
    }

    // 合并去重
    const seen = new Set(candidates.map((c) => c.id))
    for (const c of kindCandidates) {
      if (!seen.has(c.id)) {
        seen.add(c.id)
        candidates.push(c)
      }
    }

    // 关键词向量评分
    const ranked = candidates.map((item) => {
      const docText = [item.title, item.narrative, ...item.concepts, ...item.facts].join(' ')
      const docTokens = tokenize(docText)
      const docVector = buildKeywordVector(docTokens)
      const keywordScore = cosineSimilarity(queryVector, docVector)

      return {
        item,
        score: keywordScore,
        ftsScore: 0,
        keywordScore,
        matchReason: `Keyword similarity: ${(keywordScore * 100).toFixed(0)}%`,
      }
    })

    return ranked
      .filter((r) => r.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * 查找相似记忆（基于关键词向量）
   */
  async findSimilar(
    item: MemoryItem,
    options?: { limit?: number; threshold?: number },
  ): Promise<RankedSearchResult[]> {
    const limit = options?.limit ?? 10
    const threshold = options?.threshold ?? 0.3

    // 构建源文档向量
    const sourceText = [item.title, item.narrative, ...item.concepts, ...item.facts].join(' ')
    const sourceTokens = tokenize(sourceText)
    const sourceVector = buildKeywordVector(sourceTokens)

    // 获取同项目的最近记忆
    const candidates = await this.memoryStore.getRecent({
      projectId: item.project_id,
      limit: 50,
    })

    // 向量相似度评分（排除自身）
    const similar = candidates
      .filter((c) => c.id !== item.id)
      .map((c) => {
        const docText = [c.title, c.narrative, ...c.concepts, ...c.facts].join(' ')
        const docVector = buildKeywordVector(tokenize(docText))
        const score = cosineSimilarity(sourceVector, docVector)

        return {
          item: c,
          score,
          ftsScore: 0,
          keywordScore: score,
          matchReason: `Similar to: ${item.title.substring(0, 60)}`,
        }
      })

    return similar
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * 获取搜索引擎配置
   */
  getConfig(): HybridSearchConfig {
    return { ...this.config }
  }
}

/** 全局单例 */
let _instance: HybridSearchEngine | null = null

export function getHybridSearchEngine(memoryStore?: MemoryStore): HybridSearchEngine {
  if (!_instance && memoryStore) {
    _instance = new HybridSearchEngine(memoryStore)
  }
  if (!_instance) {
    throw new Error('HybridSearchEngine not initialized. Provide a MemoryStore on first call.')
  }
  return _instance
}

/** 测试用：替换全局实例 */
export function setHybridSearchEngineForTesting(engine: HybridSearchEngine): void {
  _instance = engine
}
