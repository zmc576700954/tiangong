/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextResolver, truncateToBudget } from '../context-resolver'
import { estimateTokens } from '../shared/token-utils'
import type { ContextRef, GraphNode } from '@shared/types'

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}))

import { readFile, stat } from 'node:fs/promises'

describe('estimateTokens', () => {
  it('estimates ~4 chars per token for mixed content', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('truncateToBudget', () => {
  it('returns full text if within budget', () => {
    const text = 'short text'
    expect(truncateToBudget(text, 1000)).toBe(text)
  })

  it('truncates and appends marker when over budget', () => {
    const text = 'a'.repeat(1000)
    const result = truncateToBudget(text, 100) // 100 tokens = 400 chars
    expect(result.length).toBeLessThan(text.length)
    expect(result).toContain('[truncated]')
  })

  it('iteratively truncates until within token budget', () => {
    const text = 'a'.repeat(10000) // 2500 tokens
    const result = truncateToBudget(text, 100)
    expect(estimateTokens(result)).toBeLessThanOrEqual(100)
    expect(result).toContain('[truncated]')
  })
})

describe('ContextResolver', () => {
  let resolver: ContextResolver

  beforeEach(() => {
    resolver = new ContextResolver()
    vi.clearAllMocks()
    // Default stat mock for mtime validation
    vi.mocked(stat).mockResolvedValue({ mtimeMs: 1000 } as any)
  })

  it('returns empty array for empty refs', async () => {
    const result = await resolver.resolve([], 8000)
    expect(result).toEqual([])
  })

  it('resolves node ref by loading from provided node map', async () => {
    const nodes: GraphNode[] = [
      {
        id: 'node_1',
        type: 'feature',
        status: 'draft',
        title: 'Login Feature',
        description: 'User login flow',
        acceptanceCriteria: ['User can login with email'],
        graphId: 'graph_1',
        graphType: 'online',
        rules: [{ id: 'r1', title: 'Must validate email', description: '', condition: '', action: '' }],
        position: { x: 0, y: 0 },
        createdAt: '',
        updatedAt: '',
      },
    ]

    const refs: ContextRef[] = [{ type: 'node', id: 'node_1', label: 'Login Feature' }]
    const result = await resolver.resolve(refs, 8000, { nodes })

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('node')
    expect(result[0].content).toContain('Login Feature')
    expect(result[0].content).toContain('User login flow')
    expect(result[0].content).toContain('Must validate email')
    expect(result[0].content).toContain('User can login with email')
    expect(result[0].tokenEstimate).toBeGreaterThan(0)
  })

  it('resolves file ref by reading file content', async () => {
    vi.mocked(readFile).mockResolvedValue('const x = 1\nconsole.log(x)')
    vi.mocked(stat).mockResolvedValue({ mtimeMs: 1000 } as any)

    const refs: ContextRef[] = [{ type: 'file', id: 'src/main.ts', label: 'main.ts' }]
    const result = await resolver.resolve(refs, 8000, { basePath: '/project' })

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('file')
    expect(result[0].content).toContain('const x = 1')
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('main.ts'), 'utf-8')
  })

  it('handles file read errors gracefully', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'))

    const refs: ContextRef[] = [{ type: 'file', id: 'missing.ts', label: 'missing.ts' }]
    const result = await resolver.resolve(refs, 8000, { basePath: '/project' })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('无法读取')
  })

  it('truncates file content to respect token budget', async () => {
    const bigContent = 'x'.repeat(40000) // ~10000 tokens
    vi.mocked(readFile).mockResolvedValue(bigContent)

    const refs: ContextRef[] = [{ type: 'file', id: 'big.ts', label: 'big.ts' }]
    const result = await resolver.resolve(refs, 500, { basePath: '/project' }) // 500 tokens budget

    expect(result[0].tokenEstimate).toBeLessThanOrEqual(600) // budget + marker overhead
    expect(result[0].content.length).toBeLessThan(bigContent.length)
  })

  it('rejects file refs without basePath', async () => {
    const refs: ContextRef[] = [{ type: 'file', id: 'src/main.ts', label: 'main.ts' }]
    const result = await resolver.resolve(refs, 8000, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('未提供基础路径')
  })

  it('rejects absolute file paths', async () => {
    vi.mocked(readFile).mockResolvedValue('secret')

    const refs: ContextRef[] = [{ type: 'file', id: '/etc/passwd', label: 'passwd' }]
    const result = await resolver.resolve(refs, 8000, { basePath: '/project' })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('路径越界')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('skips unknown node id gracefully', async () => {
    const refs: ContextRef[] = [{ type: 'node', id: 'nonexistent', label: 'Ghost' }]
    const result = await resolver.resolve(refs, 8000, { nodes: [] })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('节点未找到')
  })

  it('respects priority: nodes before files when budget is tight', async () => {
    vi.mocked(readFile).mockResolvedValue('file content here')
    const nodes: GraphNode[] = [
      {
        id: 'node_1', type: 'feature', status: 'draft', title: 'Important',
        description: 'Critical context', graphId: 'g1', graphType: 'online',
        position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
      },
    ]

    const refs: ContextRef[] = [
      { type: 'file', id: 'a.ts', label: 'a.ts' },
      { type: 'node', id: 'node_1', label: 'Important' },
    ]

    const result = await resolver.resolve(refs, 8000, { nodes, basePath: '/project' })
    expect(result).toHaveLength(2)
    // Node should be first (higher priority)
    expect(result[0].type).toBe('node')
  })

  it('resolves text ref directly from content field', async () => {
    const refs: ContextRef[] = [
      { type: 'text', id: 't1', label: 'User Note', content: 'Important context from user' },
    ]
    const result = await resolver.resolve(refs, 8000)

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    expect(result[0].content).toBe('Important context from user')
    expect(result[0].label).toBe('User Note')
  })

  it('handles text ref with missing content', async () => {
    const refs: ContextRef[] = [{ type: 'text', id: 't2', label: 'Empty Note' }]
    const result = await resolver.resolve(refs, 8000)

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('无文本内容')
  })

  it('uses TTL cache for repeated file reads', async () => {
    vi.mocked(readFile).mockResolvedValue('cached content')
    vi.mocked(stat).mockResolvedValue({ mtimeMs: 1000 } as any)

    const refs: ContextRef[] = [{ type: 'file', id: 'cached.ts', label: 'cached.ts' }]
    await resolver.resolve(refs, 8000, { basePath: '/project' })
    await resolver.resolve(refs, 8000, { basePath: '/project' })

    // readFile should only be called once due to TTL cache
    expect(readFile).toHaveBeenCalledTimes(1)
    // stat may be called for mtime validation on cache hit
    expect(stat).toHaveBeenCalled()
  })

  it('invalidates TTL cache when stat fails (deleted file)', async () => {
    vi.mocked(readFile).mockResolvedValue('cached content')
    vi.mocked(stat)
      .mockResolvedValueOnce({ mtimeMs: 1000 } as any)
      .mockRejectedValueOnce(new Error('ENOENT'))

    const refs: ContextRef[] = [{ type: 'file', id: 'deleted.ts', label: 'deleted.ts' }]
    await resolver.resolve(refs, 8000, { basePath: '/project' })
    const result = await resolver.resolve(refs, 8000, { basePath: '/project' })

    // Cache should be invalidated and file re-read
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(result[0].content).toContain('cached content')
  })

  it('rejects path traversal via relative path escaping', async () => {
    vi.mocked(readFile).mockResolvedValue('secret')

    const refs: ContextRef[] = [{ type: 'file', id: '../../../etc/passwd', label: 'passwd' }]
    const result = await resolver.resolve(refs, 8000, { basePath: '/project/src' })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('路径越界')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('stops resolving when token budget is exhausted', async () => {
    const nodes: GraphNode[] = [
      {
        id: 'n1', type: 'feature', status: 'draft', title: 'Big Node',
        description: 'A'.repeat(1000), graphId: 'g1', graphType: 'online',
        position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
      },
      {
        id: 'n2', type: 'feature', status: 'draft', title: 'Skipped Node',
        description: 'Should not be resolved', graphId: 'g1', graphType: 'online',
        position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
      },
    ]

    const refs: ContextRef[] = [
      { type: 'node', id: 'n1', label: 'Big Node' },
      { type: 'node', id: 'n2', label: 'Skipped Node' },
    ]

    // Budget of 50 tokens (~200 chars) should fit first node but not second
    const result = await resolver.resolve(refs, 50, { nodes })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('n1')
  })

  it('resolves node with full metadata (rules, APIs, services, entities)', async () => {
    const nodes: GraphNode[] = [
      {
        id: 'n-rich', type: 'process', status: 'confirmed', title: 'Order Process',
        description: 'Handles order lifecycle',
        graphId: 'g1', graphType: 'online',
        rules: [
          { id: 'r1', title: 'Stock Check', description: 'Verify stock', condition: 'order placed', action: 'check inventory' },
        ],
        acceptanceCriteria: ['Order completes within 24h'],
        metadata: {
          apis: [{ name: 'createOrder', method: 'POST', path: '/api/orders' }],
          services: [{ name: 'OrderService' }],
          entities: [{ name: 'Order', fields: 'id, status, amount' }],
        },
        position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
      },
    ]

    const refs: ContextRef[] = [{ type: 'node', id: 'n-rich', label: 'Order Process' }]
    const result = await resolver.resolve(refs, 8000, { nodes })

    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('Stock Check')
    expect(result[0].content).toContain('Order completes within 24h')
    expect(result[0].content).toContain('createOrder')
    expect(result[0].content).toContain('OrderService')
    expect(result[0].content).toContain('Order')
  })
})
