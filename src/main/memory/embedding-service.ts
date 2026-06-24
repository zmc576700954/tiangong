/**
 * 本地向量生成服务
 *
 * 使用 @xenova/transformers 在本地运行 all-MiniLM-L6-v2 模型，
 * 生成 384 维语义向量用于记忆检索和相似度计算。
 *
 * 核心数据流:
 *   MemoryStore.store() → EmbeddingService.generateEmbedding() → 向量存入 embedding 字段
 *   HybridSearchEngine.search() → EmbeddingService.cosineSimilarity() → 向量重排序
 *
 * 设计要点:
 *   - 模型缓存在用户数据目录，避免每次启动重新下载
 *   - 单例初始化保证模型只加载一次
 *   - 条件导入 electron.app，测试环境降级到 HOME 目录
 */

import path from 'node:path'
import { pipeline } from '@xenova/transformers'
import { createLogger } from '../shared/logger'

const logger = createLogger('EmbeddingService')

/** 模型标识 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
/** 量化配置 */
const QUANTIZED = true
/** 向量维度 (all-MiniLM-L6-v2 输出 384 维) */
const EMBEDDING_DIM = 384

/**
 * 获取模型缓存目录
 *
 * 优先使用 Electron 的 userData 目录；
 * 测试或非 Electron 环境降级到 USERPROFILE/HOME/.bizgraph-models
 */
function getModelCacheDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    if (electron?.app?.getPath) {
      return path.join(electron.app.getPath('userData'), 'models')
    }
  } catch {
    // 非 Electron 环境
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '/tmp'
  return path.join(home, '.bizgraph-models')
}

export class EmbeddingService {
  private extractor: unknown = null
  private initPromise: Promise<void> | null = null
  /** Whether initialization has been attempted (regardless of outcome) */
  private _initAttempted: boolean = false
  /** Whether the last initialization attempt failed */
  private _initFailed: boolean = false
  /** Whether the last initialization attempt timed out */
  private _initTimedOut: boolean = false

  /**
   * 初始化特征提取 pipeline
   *
   * 首次调用会下载模型（~30MB），后续从本地缓存加载。
   * 使用 singleton init promise 防止并发初始化。
   */
  async initialize(): Promise<void> {
    if (this.extractor) return

    if (this.initPromise) {
      await this.initPromise
      return
    }

    this.initPromise = this._doInitialize()
    await this.initPromise
  }

  private async _doInitialize(): Promise<void> {
    try {
      const cacheDir = getModelCacheDir()
      logger.info(`Loading embedding model from cache: ${cacheDir}`)

      this.extractor = await pipeline('feature-extraction', MODEL_ID, {
        quantized: QUANTIZED,
        cache_dir: cacheDir,
      })

      this._initTimedOut = false
      logger.info(`Embedding model loaded successfully (dim=${EMBEDDING_DIM})`)
    } catch (err) {
      this.initPromise = null // 允许重试
      logger.error('Failed to load embedding model:', err)
      throw err
    }
  }

  /**
   * 检查 pipeline 是否已加载
   */
  isReady(): boolean {
    return this.extractor !== null
  }

  /**
   * 检查是否曾尝试过初始化（不论成功或失败）
   */
  isInitAttempted(): boolean {
    return this._initAttempted
  }

  /**
   * 检查上一次初始化尝试是否失败
   */
  isFailed(): boolean {
    return this._initFailed
  }

  /**
   * 检查上一次初始化尝试是否超时
   */
  isTimedOut(): boolean {
    return this._initTimedOut
  }

  /**
   * 带超时的初始化
   *
   * 防止模型下载阻塞启动流程。超时后标记为不可用，
   * HybridSearch 降级为纯关键词检索。
   */
  async initializeWithTimeout(timeoutMs = 60_000): Promise<boolean> {
    this._initFailed = false
    this._initTimedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.initialize(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('EmbeddingService init timeout')), timeoutMs)
        }),
      ])
      this._initAttempted = true
      return true
    } catch (err) {
      this._initFailed = true
      this._initAttempted = true
      if (err instanceof Error && err.message === 'EmbeddingService init timeout') {
        this._initTimedOut = true
        logger.warn('EmbeddingService initialization timed out, falling back to keyword-only search')
      } else {
        this.initPromise = null
        logger.warn('EmbeddingService initialization failed, falling back to keyword-only search:', err)
      }
      return false
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  /**
   * 生成单条文本的嵌入向量
   *
   * @param text - 输入文本
   * @returns 384 维浮点向量
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.extractor) {
      await this.initialize()
    }
    if (!this.extractor) {
      throw new Error('EmbeddingService not initialized: model not available')
    }

    const extractor = this.extractor as (text: string, options: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>
    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    })

    const data = output.data
    const vector = Array.from(data)

    if (vector.length !== EMBEDDING_DIM) {
      logger.warn(`Unexpected embedding dimension: ${vector.length} (expected ${EMBEDDING_DIM})`)
    }

    return vector
  }

  /**
   * 批量生成嵌入向量
   *
   * @param texts - 输入文本数组
   * @returns 嵌入向量数组的数组
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    // Generate in batches of 5 to balance throughput and memory
    const BATCH_SIZE = 5
    const results: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(batch.map(text => this.generateEmbedding(text)))
      results.push(...batchResults)
    }
    return results
  }

  /**
   * 计算两个向量的余弦相似度
   *
   * @param a - 向量 A
   * @param b - 向量 B
   * @returns 余弦相似度 [-1, 1]，归一化向量通常在 [0, 1]
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
    }
    if (a.length === 0) return 0

    let dotProduct = 0
    let magnitudeA = 0
    let magnitudeB = 0

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      magnitudeA += a[i] * a[i]
      magnitudeB += b[i] * b[i]
    }

    magnitudeA = Math.sqrt(magnitudeA)
    magnitudeB = Math.sqrt(magnitudeB)

    if (magnitudeA === 0 || magnitudeB === 0) return 0
    return dotProduct / (magnitudeA * magnitudeB)
  }
}

// ============================================
// 全局单例
// ============================================

let _instance: EmbeddingService | null = null

/** 获取全局 EmbeddingService 单例 */
export function getEmbeddingService(): EmbeddingService {
  if (!_instance) {
    _instance = new EmbeddingService()
  }
  return _instance
}

/** 测试用：替换全局实例 */
export function setEmbeddingServiceForTesting(service: EmbeddingService): void {
  _instance = service
}
