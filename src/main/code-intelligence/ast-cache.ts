/**
 * AST 解析结果缓存
 * 基于 mtime 的 LRU 缓存，避免重复解析未修改的文件
 */

import type { ParseResult } from './ast-parser'
import { createLogger } from '../shared/logger'

const logger = createLogger('ast-cache')

interface CacheEntry {
  mtime: number
  result: ParseResult
  /** 插入顺序，用于 LRU 淘汰 */
  order: number
}

export class AstCache {
  private cache = new Map<string, CacheEntry>()
  private nextOrder = 0
  private readonly maxSize: number

  constructor(maxSize = 500) {
    this.maxSize = maxSize
  }

  /**
   * 获取缓存结果。仅当 mtime 匹配时返回，否则返回 null
   */
  get(filePath: string, mtime: number): ParseResult | null {
    const entry = this.cache.get(filePath)
    if (!entry) return null
    if (entry.mtime !== mtime) {
      // mtime 不匹配，缓存失效
      this.cache.delete(filePath)
      return null
    }
    // 更新访问顺序（LRU）
    entry.order = this.nextOrder++
    return entry.result
  }

  /**
   * 缓存解析结果。超过 maxSize 时淘汰最久未访问的条目
   */
  set(filePath: string, mtime: number, result: ParseResult): void {
    // 如果已存在，先删除再插入以更新顺序
    if (this.cache.has(filePath)) {
      this.cache.delete(filePath)
    }

    // LRU 淘汰
    while (this.cache.size >= this.maxSize) {
      const oldest = this.findOldestEntry()
      if (oldest) {
        this.cache.delete(oldest)
        logger.debug('LRU evicted:', oldest)
      }
    }

    this.cache.set(filePath, { mtime, result, order: this.nextOrder++ })
  }

  /**
   * 使指定文件的缓存失效
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear()
    this.nextOrder = 0
  }

  /**
   * 当前缓存条目数量
   */
  get size(): number {
    return this.cache.size
  }

  private findOldestEntry(): string | null {
    let oldestKey: string | null = null
    let oldestOrder = Infinity
    for (const [key, entry] of this.cache) {
      if (entry.order < oldestOrder) {
        oldestOrder = entry.order
        oldestKey = key
      }
    }
    return oldestKey
  }
}

/** 单例实例 */
let _instance: AstCache | null = null

export function getAstCache(): AstCache {
  if (!_instance) {
    _instance = new AstCache()
  }
  return _instance
}
