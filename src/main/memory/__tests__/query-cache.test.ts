import { describe, test, expect, vi } from 'vitest'
import { QueryCache } from '../query-cache'

describe('QueryCache', () => {
  test('caches and retrieves results', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    cache.set('n1', { depth: 2 }, 'result1')
    expect(cache.get('n1', { depth: 2 })).toBe('result1')
  })

  test('returns undefined for cache miss', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    expect(cache.get('n1', { depth: 2 })).toBeUndefined()
  })

  test('returns undefined after TTL expires', () => {
    vi.useFakeTimers()
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 5000 })
    cache.set('n1', { depth: 2 }, 'result1')
    vi.advanceTimersByTime(6000)
    expect(cache.get('n1', { depth: 2 })).toBeUndefined()
    vi.useRealTimers()
  })

  test('evicts oldest entry when at capacity', () => {
    const cache = new QueryCache<string>({ maxSize: 2, ttlMs: 60000 })
    cache.set('n1', { depth: 1 }, 'r1')
    cache.set('n2', { depth: 1 }, 'r2')
    cache.set('n3', { depth: 1 }, 'r3')
    expect(cache.get('n1', { depth: 1 })).toBeUndefined()
    expect(cache.get('n3', { depth: 1 })).toBe('r3')
  })

  test('invalidate removes entries for a specific node', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    cache.set('n1', { depth: 1 }, 'r1')
    cache.set('n1', { depth: 2 }, 'r2')
    cache.set('n2', { depth: 1 }, 'r3')
    cache.invalidate('n1')
    expect(cache.get('n1', { depth: 1 })).toBeUndefined()
    expect(cache.get('n1', { depth: 2 })).toBeUndefined()
    expect(cache.get('n2', { depth: 1 })).toBe('r3')
  })

  test('different options produce different cache keys', () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60000 })
    cache.set('n1', { depth: 1 }, 'shallow')
    cache.set('n1', { depth: 3 }, 'deep')
    expect(cache.get('n1', { depth: 1 })).toBe('shallow')
    expect(cache.get('n1', { depth: 3 })).toBe('deep')
  })
})
