/**
 * AstCache 单元测试
 */

import { describe, it, expect } from 'vitest'
import { AstCache } from '../ast-cache'
import type { ParseResult } from '../ast-parser'

function makeResult(name: string): ParseResult {
  return {
    symbols: [{
      id: `symbol_${name}`,
      name,
      kind: 'class',
      filePath: `/project/${name}.ts`,
      line: 1,
      column: 0,
      isExported: true,
    }],
    imports: [],
    exports: [name],
  }
}

describe('AstCache', () => {
  it('caches and retrieves parse results', () => {
    const cache = new AstCache()
    const result = makeResult('Foo')

    cache.set('/project/Foo.ts', 1000, result)

    expect(cache.size).toBe(1)
    const cached = cache.get('/project/Foo.ts', 1000)
    expect(cached).not.toBeNull()
    expect(cached!.exports).toEqual(['Foo'])
  })

  it('returns null for stale entries (mtime mismatch)', () => {
    const cache = new AstCache()
    const result = makeResult('Bar')

    cache.set('/project/Bar.ts', 1000, result)
    expect(cache.get('/project/Bar.ts', 1000)).not.toBeNull()

    // mtime 不同应返回 null
    expect(cache.get('/project/Bar.ts', 2000)).toBeNull()
    // 缓存条目应已被删除
    expect(cache.size).toBe(0)
  })

  it('evicts oldest entry when at capacity', () => {
    const cache = new AstCache(3)

    cache.set('/a.ts', 100, makeResult('A'))
    cache.set('/b.ts', 100, makeResult('B'))
    cache.set('/c.ts', 100, makeResult('C'))

    expect(cache.size).toBe(3)

    // 插入第 4 个条目应触发 LRU 淘汰
    cache.set('/d.ts', 100, makeResult('D'))

    expect(cache.size).toBe(3)
    // 最早插入的 /a.ts 应被淘汰
    expect(cache.get('/a.ts', 100)).toBeNull()
    // 其余应仍在
    expect(cache.get('/b.ts', 100)).not.toBeNull()
    expect(cache.get('/c.ts', 100)).not.toBeNull()
    expect(cache.get('/d.ts', 100)).not.toBeNull()
  })

  it('invalidate removes specific entry', () => {
    const cache = new AstCache()

    cache.set('/x.ts', 100, makeResult('X'))
    cache.set('/y.ts', 100, makeResult('Y'))

    expect(cache.size).toBe(2)

    cache.invalidate('/x.ts')

    expect(cache.size).toBe(1)
    expect(cache.get('/x.ts', 100)).toBeNull()
    expect(cache.get('/y.ts', 100)).not.toBeNull()
  })
})
