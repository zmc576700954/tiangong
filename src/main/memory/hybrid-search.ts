/**
 * 混合搜索引擎 —— FTS5 + 关键词向量相似度 + 嵌入向量的多层检索
 *
 * 检索策略:
 *   Layer 1 (FTS5): 精确/模糊文本匹配 → 召回候选集（高召回）
 *   Layer 2 (Keyword Vector): 基于 TF-IDF 启发式的关键词向量相似度 → 重排序（高精度）
 *   Layer 3 (Embedding): 嵌入向量余弦相似度 → 语义检索（深度语义）
 *   Layer 4 (Fallback): 当 FTS5 不可用时，使用 LIKE 搜索 + 关键词匹配
 *
 * 双路检索:
 *   - FTS+关键词路: 文本匹配 + BM25 向量重排序
 *   - 嵌入路: 语义向量相似度（需要 EmbeddingService 已启用）
 *   两路结果加权合并，提供更好的语义覆盖
 *
 * 用法:
 *   const searcher = new HybridSearchEngine(memoryStore)
 *   await searcher.enableEmbedding()  // 可选：启用嵌入检索
 *   const results = await searcher.search("authentication bug fix", { projectId: "x" })
 */

import type { MemoryItem, MemoryKind } from '@shared/types'
import type { MemoryStore } from './memory-store'
import { getEmbeddingService, EmbeddingService } from './embedding-service'
import { getAdaptiveConfig } from '../adaptive-config'
import { getClient } from '../database'
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
  /** 嵌入向量相似度 0-1（仅嵌入检索启用时有效） */
  embeddingScore: number
  /** 匹配的原因（调试用） */
  matchReason: string
  /** 同项目同概念但不同置信度的替代记忆项（按置信度降序） */
  alternatives?: MemoryItem[]
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
 *
 * 支持英文和中文（CJK）分词：
 * - 英文：按非字母数字字符拆分，去停用词
 * - 中文：提取连续 CJK 字符的 bigram（二元组），覆盖 Unicode 范围 一-鿿
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()

  // 英文分词：按非字母数字拆分
  const englishTokens = lower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))

  // CJK bigram 分词：提取连续 CJK 字符的相邻二元组
  const CJK_RANGE = /\p{Script=Han}/u
  const cjkChars: string[] = []
  for (const ch of lower) {
    if (CJK_RANGE.test(ch)) {
      cjkChars.push(ch)
    }
  }
  const cjkBigrams: string[] = []
  for (let i = 0; i < cjkChars.length - 1; i++) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1])
  }

  return [...englishTokens, ...cjkBigrams]
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
  avgDocLen: number,
  k1 = 1.2,
  b = 0.75,
): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  const docLen = tokens.length || 1
  const result = new Map<string, number>()
  for (const [term, count] of freq) {
    const df = dfMap.get(term) ?? 0
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5))
    const tf = (count * (k1 + 1)) / (count + k1 * (1 - b + b * docLen / (avgDocLen || docLen)))
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
  /** 嵌入服务实例（启用后非 null） */
  private _embeddingService: EmbeddingService | null = null
  /** 嵌入检索是否已启用 */
  private _embeddingEnabled: boolean = false
  /** 搜索计数器，用于定期触发 AdaptiveConfig 适配 */
  private searchCount = 0

  constructor(memoryStore: MemoryStore, config?: Partial<HybridSearchConfig>) {
    this.memoryStore = memoryStore
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 启用嵌入检索
   *
   * 初始化 EmbeddingService，成功后设置 _embeddingEnabled=true。
   * 失败时仅打印警告日志，不抛出异常——搜索降级到 FTS+关键词路。
   */
  async enableEmbedding(): Promise<void> {
    try {
      const service = getEmbeddingService()
      const ok = await service.initializeWithTimeout(60_000)
      if (!ok) {
        this._embeddingEnabled = false
        logger.warn('Embedding service initialization failed or timed out, falling back to FTS+keyword only')
        return
      }
      this._embeddingService = service
      this._embeddingEnabled = true
      logger.info('Embedding search enabled')
    } catch (err) {
      this._embeddingEnabled = false
      logger.warn('Embedding service initialization failed, falling back to FTS+keyword only:', err)
    }
  }

  /**
   * 尝试启用嵌入检索（幂等、安全）
   *
   * 如果已启用则直接返回 true；如果服务之前初始化失败则返回 false；
   * 否则调用 enableEmbedding() 尝试初始化。
   */
  async tryEnableEmbedding(): Promise<boolean> {
    if (this._embeddingEnabled) return true
    const service = getEmbeddingService()
    if (service.isFailed()) return false
    await this.enableEmbedding()
    return this._embeddingEnabled
  }

  /**
   * 为记忆项生成嵌入向量并存入数据库
   *
   * 将 title + narrative + facts 拼接后生成 384 维向量，
   * 写入 memory_items.embedding 字段。
   */
  async indexEmbedding(item: MemoryItem): Promise<void> {
    if (!this._embeddingEnabled || !this._embeddingService) return

    const text = [item.title, item.narrative, ...item.facts].join(' ')
    if (!text.trim()) return

    try {
      const vector = await this._embeddingService.generateEmbedding(text)
      const db = getClient()
      await db.execute({
        sql: 'UPDATE memory_items SET embedding = ? WHERE id = ?',
        args: [JSON.stringify(vector), item.id],
      })
    } catch (err) {
      logger.warn(`Failed to index embedding for item ${item.id}:`, err)
    }
  }

  /**
   * 嵌入检索是否已启用
   */
  isEmbeddingEnabled(): boolean {
    return this._embeddingEnabled
  }

  /**
   * 获取或计算文档的 BM25 向量（带缓存）
   */
  private getOrBuildDocVector(
    docId: string,
    tokens: string[],
    dfMap: Map<string, number>,
    totalDocs: number,
    avgDocLen: number,
  ): Map<string, number> {
    const cached = this.vectorCache.get(docId)
    if (cached && Date.now() - cached.timestamp < HybridSearchEngine.VECTOR_CACHE_TTL) {
      return cached.vector
    }
    const vector = buildBm25Vector(tokens, dfMap, totalDocs, avgDocLen)
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
   * 混合搜索：FTS5 召回 + 关键词向量重排序 + 嵌入向量检索
   *
   * 双路检索流程:
   *   1. FTS+关键词路: FTS5 召回 → BM25 向量重排序
   *   2. 嵌入路（可选）: 查询嵌入 → 向量相似度检索
   *   3. 两路结果加权合并
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
    // AdaptiveConfig: use adaptive ftsWeight when no explicit override provided
    const adaptiveFtsWeight = options?.ftsWeight !== undefined ? options.ftsWeight : getAdaptiveConfig().get('ftsWeight')
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
    const avgDocLen = allDocTokens.reduce((sum, t) => sum + t.tokens.length, 0) / (totalDocs || 1)

    // 构建 BM25 查询向量
    const queryBm25Vector = buildBm25Vector(queryTokens, dfMap, totalDocs, avgDocLen)

    // 4. 关键词向量重排序（使用 BM25 向量 + 缓存）
    const ftsResults = allDocTokens.map(({ item, tokens, text: docText }) => {
      const docVector = this.getOrBuildDocVector(String(item.id), tokens, dfMap, totalDocs, avgDocLen)
      const keywordScore = cosineSimilarity(queryBm25Vector, docVector)

      // FTS5 分数估算：用查询词项在文档中的命中比例作为近似
      const docTextLower = docText.toLowerCase()
      let matchCount = 0
      for (const qt of queryTokenSet) {
        if (docTextLower.includes(qt)) matchCount++
      }
      const ftsScore = queryTokenSet.size > 0 ? matchCount / queryTokenSet.size : 0

      // 混合分数
      const score = adaptiveFtsWeight * ftsScore + (1 - adaptiveFtsWeight) * keywordScore

      return {
        item,
        score,
        ftsScore,
        keywordScore,
        embeddingScore: 0,
        matchReason: keywordScore > ftsScore
          ? `Semantic match (BM25 similarity: ${(keywordScore * 100).toFixed(0)}%)`
          : `Text match (FTS5 rank: ${(ftsScore * 100).toFixed(0)}%)`,
      }
    })

    // 5. 嵌入检索（双路检索的第二路）
    let embeddingResults: RankedSearchResult[] = []
    if (this._embeddingEnabled) {
      embeddingResults = await this._embeddingSearch(query, options)
    }

    // 6. 合并两路结果
    const merged = this._mergeResults(ftsResults, embeddingResults, adaptiveFtsWeight)

    // 6.5 Record "memoryUseful" signal to AdaptiveConfig
    // If top result scores above 0.5, the memory system is working well —
    // signal pruneHalfLifeDays=0 so the adaptFn sees the mix of 0s and 1s
    // and adjusts pruning aggressiveness accordingly.
    if (merged.length > 0 && merged[0].score > 0.5) {
      getAdaptiveConfig().recordMetric('pruneHalfLifeDays', 0)
    }

    // 6.6 Record FTS/embedding quality metrics to AdaptiveConfig
    if (merged.length > 0) {
      const avgFts = merged.reduce((s, r) => s + r.ftsScore, 0) / merged.length
      const avgEmb = merged.reduce((s, r) => s + r.embeddingScore, 0) / merged.length
      getAdaptiveConfig().recordMetric('ftsWeight', { ftsScore: avgFts, embeddingScore: avgEmb })
    }

    // 6.7 递增搜索计数，每 50 次触发自适应适配
    this.searchCount++
    if (this.searchCount % 50 === 0) {
      getAdaptiveConfig().adapt()
    }

    // 7. 排序和过滤
    const filtered = merged
      .filter((r) => r.score >= scoreThreshold)
      .filter((r) => options?.includeLowConfidence === true || r.item.confidence >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    // 8. 为每个结果填充 alternatives：同项目、概念重叠但置信度较低的记忆项
    this._attachAlternatives(filtered, allDocTokens)

    logger.debug(`Hybrid search "${query}": ${candidates.length} FTS candidates, ${embeddingResults.length} embedding results → ${filtered.length} merged results (top score: ${filtered[0]?.score.toFixed(3) ?? 'N/A'})`)

    return filtered
  }

  /**
   * 为搜索结果填充 alternatives 字段
   *
   * 对于同 project_id 且概念有重叠的记忆项，将置信度较低的项
   * 作为置信度最高项的 alternatives，按置信度降序排列。
   *
   * 算法：
   *   1. 收集所有候选记忆项（含未出现在最终结果中的 FTS 候选）
   *   2. 按 project_id 分组
   *   3. 在同组内，对概念有重叠（交集 >= 1）的项，选置信度最高的为"主项"
   *   4. 其余作为主项的 alternatives
   */
  private _attachAlternatives(
    results: RankedSearchResult[],
    allDocTokens: Array<{ item: MemoryItem; tokens: string[]; text: string }>,
  ): void {
    if (results.length === 0) return

    // 收集所有候选项的 ID → MemoryItem 映射（用于查找 alternatives 来源）
    const allItemsMap = new Map<number, MemoryItem>()
    for (const { item } of allDocTokens) {
      allItemsMap.set(item.id, item)
    }

    // 已在 results 中出现的 ID 集合（主结果和 alternatives 不重复）
    const resultIds = new Set(results.map((r) => r.item.id))

    // 按 project_id 分组候选项（仅不在 results 中的项才有资格做 alternative）
    const byProject = new Map<string, MemoryItem[]>()
    for (const [, item] of allItemsMap) {
      if (resultIds.has(item.id)) continue
      const pid = item.project_id
      if (!pid) continue
      let group = byProject.get(pid)
      if (!group) {
        group = []
        byProject.set(pid, group)
      }
      group.push(item)
    }

    // 为每个 result 查找同项目、概念重叠的 alternatives
    for (const r of results) {
      const pid = r.item.project_id
      if (!pid) continue

      const candidates = byProject.get(pid)
      if (!candidates || candidates.length === 0) continue

      const resultConcepts = new Set(r.item.concepts)
      if (resultConcepts.size === 0) continue

      // 筛选：概念至少有一个重叠，且与主项不是同一个
      const alts = candidates
        .filter((c) => c.id !== r.item.id && c.concepts.some((concept) => resultConcepts.has(concept)))
        // 按置信度降序
        .sort((a, b) => b.confidence - a.confidence)
        // 最多 5 个 alternatives
        .slice(0, 5)

      if (alts.length > 0) {
        r.alternatives = alts
      }
    }
  }

  /**
   * 嵌入向量检索（双路检索的第二路）
   *
   * 生成查询嵌入，从数据库获取有嵌入的记忆项，
   * 计算余弦相似度，过滤低分结果。
   */
  private async _embeddingSearch(
    query: string,
    opts?: HybridSearchOptions,
  ): Promise<RankedSearchResult[]> {
    if (!this._embeddingService) return []
    if (!this._embeddingService.isReady()) return []

    try {
      const queryVector = await this._embeddingService.generateEmbedding(query)

      // projectId is required for embedding search to avoid full table scan
      if (!opts?.projectId) return []

      const db = getClient()
      let sql = 'SELECT * FROM memory_items WHERE embedding IS NOT NULL AND project_id = ?'
      const args: (string | number)[] = [opts.projectId]
      if (opts?.kind) {
        sql += ' AND kind = ?'
        args.push(opts.kind)
      }

      sql += ' ORDER BY created_at DESC LIMIT 200'

      const result = await db.execute({ sql, args })
      const items: MemoryItem[] = result.rows.map((row) => this._rowToMemoryItem(row))

      // 计算余弦相似度
      const scored = items
        .map((item) => {
          const itemEmbedding = item.embedding
          if (!itemEmbedding || itemEmbedding.length === 0) return null

          const score = EmbeddingService.cosineSimilarity(queryVector, itemEmbedding)
          return {
            item,
            score,
            ftsScore: 0,
            keywordScore: 0,
            embeddingScore: score,
            matchReason: `Embedding similarity: ${(score * 100).toFixed(0)}%`,
          } as RankedSearchResult
        })
        .filter((r): r is RankedSearchResult => r !== null && r.embeddingScore > 0.3)

      return scored
    } catch (err) {
      logger.warn('Embedding search failed:', err)
      return []
    }
  }

  /**
   * 合并 FTS+关键词路和嵌入路的结果
   *
   * 同一 item ID 的结果加权合并分数，不同 ID 的直接合并。
   * ftsWeight 控制 FTS+关键词路的权重，嵌入路权重为 (1 - ftsWeight)。
   */
  private _mergeResults(
    ftsResults: RankedSearchResult[],
    embeddingResults: RankedSearchResult[],
    ftsWeight: number,
  ): RankedSearchResult[] {
    if (embeddingResults.length === 0) return ftsResults
    if (ftsResults.length === 0) return embeddingResults

    const embeddingWeight = 1 - ftsWeight
    const mergedMap = new Map<number, RankedSearchResult>()

    // 加入 FTS+关键词路结果
    for (const r of ftsResults) {
      mergedMap.set(r.item.id, { ...r })
    }

    // 合并嵌入路结果
    for (const r of embeddingResults) {
      const existing = mergedMap.get(r.item.id)
      if (existing) {
        // 同 ID：加权合并分数
        existing.score = ftsWeight * existing.ftsScore + (1 - ftsWeight) * existing.keywordScore + embeddingWeight * r.embeddingScore
        existing.embeddingScore = r.embeddingScore
        // 更新 matchReason 以反映双路匹配
        existing.matchReason = existing.matchReason.includes('Embedding')
          ? existing.matchReason
          : `${existing.matchReason} + Embedding: ${(r.embeddingScore * 100).toFixed(0)}%`
      } else {
        // 新 ID：嵌入路独立结果，分数按权重缩放
        mergedMap.set(r.item.id, {
          ...r,
          score: embeddingWeight * r.embeddingScore,
        })
      }
    }

    return Array.from(mergedMap.values())
  }

  /**
   * 将数据库行转换为 MemoryItem
   */
  private _rowToMemoryItem(row: Record<string, unknown>): MemoryItem {
    const safeParse = (val: unknown, fallback: string[] = []): string[] => {
      if (!val) return fallback
      try { const parsed = JSON.parse(val as string); return Array.isArray(parsed) ? parsed : fallback } catch { return fallback }
    }
    const safeParseEmbedding = (val: unknown): number[] | null => {
      if (!val) return null
      try { return JSON.parse(val as string) } catch { return null }
    }
    return {
      id: row.id as number,
      session_id: row.session_id as string,
      kind: row.kind as MemoryKind,
      project_id: (row.project_id as string) ?? '',
      node_id: (row.node_id as string) ?? null,
      title: row.title as string,
      narrative: (row.narrative as string) ?? '',
      facts: safeParse(row.facts),
      concepts: safeParse(row.concepts),
      files_read: safeParse(row.files_read),
      files_modified: safeParse(row.files_modified),
      adapter_name: (row.adapter_name as string) ?? '',
      token_cost: (row.token_cost as number) ?? 0,
      confidence: (row.confidence as number) ?? 0,
      created_at: row.created_at as string,
      version: (row.version as number) ?? 1,
      parent_version: (row.parent_version as number) ?? null,
      embedding: safeParseEmbedding(row.embedding),
    }
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
        embeddingScore: 0,
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
          embeddingScore: 0,
          matchReason: `Similar to: ${item.title.substring(0, 60)}`,
        }
      })

    return similar
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * 获取搜索计数
   */
  getSearchCount(): number {
    return this.searchCount
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
