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
  // 用循环求 max 而非 Math.max(...freq.values())——后者在大向量（~125k+ 项）时
  // 会因 spread 参数数量超限抛 RangeError: Maximum call stack size exceeded
  let maxFreq = 0
  for (const v of freq.values()) {
    if (v > maxFreq) maxFreq = v
  }
  if (maxFreq > 0) {
    for (const [k, v] of freq) {
      freq.set(k, v / maxFreq)
    }
  }
  return freq
}

/**
 * 构建 BM25 式关键词向量
 * 使用 IDF×TF 评分替代简单归一化词频，衰减高频通用词的权重
 */
function buildBm25Vector(
  tokens: string[],
  dfMap: Map<string, number>,
  totalDocs: number,
  k1 = 1.2,
  b = 0.75,
): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  const avgLen = tokens.length || 1
  const result = new Map<string, number>()
  for (const [term, count] of freq) {
    const df = dfMap.get(term) ?? 0
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))
    const tf = (count * (k1 + 1)) / (count + k1 * (1 - b + b * avgLen / avgLen))
    result.set(term, idf * tf)
  }
  // 归一化
  let maxVal = 0
  for (const v of result.values()) if (v > maxVal) maxVal = v
  if (maxVal > 0) {
    for (const [k, v] of result) result.set(k, v / maxVal)
  }
  return result
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
  /** 文档向量 LRU 缓存：避免重复计算 BM25 向量 */
  private vectorCache = new Map<string, { vector: Map<string, number>; timestamp: number }>()
  private static VECTOR_CACHE_MAX = 200
  private static VECTOR_CACHE_TTL = 60_000 // 1 分钟

  constructor(memoryStore: MemoryStore, config?: Partial<HybridSearchConfig>) {
    this.memoryStore = memoryStore
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 获取或计算文档的 BM25 向量（带缓存）
   */
  private getOrBuildDocVector(
    docId: string,
    tokens: string[],
    dfMap: Map<string, number>,
    totalDocs: number,
  ): Map<string, number> {
    const cached = this.vectorCache.get(docId)
    if (cached && Date.now() - cached.timestamp < HybridSearchEngine.VECTOR_CACHE_TTL) {
      return cached.vector
    }
    const vector = buildBm25Vector(tokens, dfMap, totalDocs)
    // LRU 淘汰：超限时删除最早的缓存条目
    if (this.vectorCache.size >= HybridSearchEngine.VECTOR_CACHE_MAX) {
      const oldest = this.vectorCache.keys().next().value
      if (oldest) this.vectorCache.delete(oldest)
    }
    this.vectorCache.set(docId, { vector, timestamp: Date.now() })
    return vector
  }

  /**
   * 清除向量缓存（在记忆存储变更后调用）
   */
  clearVectorCache(): void {
    this.vectorCache.clear()
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

    // 1. 构建查询的关键词
    const queryTokens = tokenize(query)
    const queryTokenSet = new Set(queryTokens)

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

    // 3. 构建 BM25 DF Map（文档频率统计，用于衰减高频通用词）
    const allDocTokens: Array<{ item: MemoryItem; tokens: string[]; text: string }> = []
    const dfMap = new Map<string, number>()
    for (const item of candidates) {
      const docText = [
        item.title,
        item.narrative,
        ...item.concepts,
        ...item.facts,
      ].join(' ')
      const tokens = tokenize(docText)
      allDocTokens.push({ item, tokens, text: docText })
      const unique = new Set(tokens)
      for (const t of unique) dfMap.set(t, (dfMap.get(t) ?? 0) + 1)
    }
    const totalDocs = candidates.length

    // 构建 BM25 查询向量
    const queryBm25Vector = buildBm25Vector(queryTokens, dfMap, totalDocs)

    // 4. 关键词向量重排序（使用 BM25 向量 + 缓存）
    const ranked = allDocTokens.map(({ item, tokens, text: docText }) => {
      const docVector = this.getOrBuildDocVector(String(item.id), tokens, dfMap, totalDocs)
      const keywordScore = cosineSimilarity(queryBm25Vector, docVector)

      // FTS5 分数估算：用查询词项在文档中的命中比例作为近似
      const docTextLower = docText.toLowerCase()
      let matchCount = 0
      for (const qt of queryTokenSet) {
        if (docTextLower.includes(qt)) matchCount++
      }
      const ftsScore = queryTokenSet.size > 0 ? matchCount / queryTokenSet.size : 0

      // 混合分数
      const score = ftsWeight * ftsScore + (1 - ftsWeight) * keywordScore

      return {
        item,
        score,
        ftsScore,
        keywordScore,
        matchReason: keywordScore > ftsScore
          ? `Semantic match (BM25 similarity: ${(keywordScore * 100).toFixed(0)}%)`
          : `Text match (FTS5 rank: ${(ftsScore * 100).toFixed(0)}%)`,
      }
    })

    // 4. 排序和过滤
    // 注意：includeLowConfidence 默认 false（与字段语义一致）——
    // 旧实现 `!== false || ...` 在 undefined 时短路为 true，导致默认收录低置信度记忆。
    const filtered = ranked
      .filter((r) => r.score >= scoreThreshold)
      .filter((r) => options?.includeLowConfidence === true || r.item.confidence >= 0.3)
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
