export interface QueryCacheOptions {
  maxSize?: number
  ttlMs?: number
}

interface CacheEntry<T> {
  value: T
  createdAt: number
}

export class QueryCache<T> {
  private _cache = new Map<string, CacheEntry<T>>()
  private _maxSize: number
  private _ttlMs: number

  constructor(options: QueryCacheOptions = {}) {
    this._maxSize = options.maxSize ?? 100
    this._ttlMs = options.ttlMs ?? 5 * 60 * 1000
  }

  private _makeKey(nodeId: string, options: { depth?: number; relationFilter?: string[] }): string {
    const depth = options.depth ?? 2
    const relations = (options.relationFilter ?? []).sort().join(',')
    return `${nodeId}:d${depth}:r[${relations}]`
  }

  get(nodeId: string, options: { depth?: number; relationFilter?: string[] }): T | undefined {
    const key = this._makeKey(nodeId, options)
    const entry = this._cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._cache.delete(key)
      return undefined
    }
    return entry.value
  }

  set(nodeId: string, options: { depth?: number; relationFilter?: string[] }, value: T): void {
    const key = this._makeKey(nodeId, options)
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      const firstKey = this._cache.keys().next().value
      if (firstKey) this._cache.delete(firstKey)
    }
    this._cache.set(key, { value, createdAt: Date.now() })
  }

  invalidate(nodeId: string): void {
    for (const key of this._cache.keys()) {
      if (key.startsWith(`${nodeId}:`)) {
        this._cache.delete(key)
      }
    }
  }

  clear(): void {
    this._cache.clear()
  }

  get size(): number {
    return this._cache.size
  }
}
