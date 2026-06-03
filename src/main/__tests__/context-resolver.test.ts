import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextResolver, estimateTokens, truncateToBudget } from '../context-resolver'
import type { ContextRef, GraphNode } from '@shared/types'

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

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
})

describe('ContextResolver', () => {
  let resolver: ContextResolver

  beforeEach(() => {
    resolver = new ContextResolver()
    vi.clearAllMocks()
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
})
