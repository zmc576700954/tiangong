import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock hybrid search engine
const mockSearch = vi.fn().mockResolvedValue([])
vi.mock('../../memory/hybrid-search', () => ({
  getHybridSearchEngine: () => ({
    search: mockSearch,
  }),
}))

import { buildDevPrompt, augmentWithRagExamples } from '../synthesis/prompt-builder'
import type { GraphNode, GraphEdge } from '@shared/types'

function makeNode(overrides?: Partial<GraphNode>): GraphNode {
  return {
    id: 'n1',
    type: 'feature',
    title: 'Login Feature',
    description: 'User login functionality',
    status: 'developing',
    graphId: 'g1',
    graphType: 'dev',
    position: { x: 0, y: 0 },
    acceptanceCriteria: [],
    ...overrides,
  } as GraphNode
}

describe('buildDevPrompt', () => {
  it('builds a feature prompt', () => {
    const prompt = buildDevPrompt({
      node: makeNode(),
      taskType: 'feature',
      allNodes: [makeNode()],
      allEdges: [],
    })
    expect(prompt).toContain('# 业务上下文')
    expect(prompt).toContain('Login Feature')
  })

  it('builds a bugfix prompt', () => {
    const prompt = buildDevPrompt({
      node: makeNode({ title: 'Login Bug' }),
      taskType: 'bugfix',
      allNodes: [makeNode({ title: 'Login Bug' })],
      allEdges: [],
      bugDescription: 'App crashes on login',
    })
    expect(prompt).toContain('问题所在')
    expect(prompt).toContain('App crashes on login')
  })

  it('builds a refactor prompt', () => {
    const prompt = buildDevPrompt({
      node: makeNode({ title: 'Auth Refactor' }),
      taskType: 'refactor',
      allNodes: [makeNode({ title: 'Auth Refactor' })],
      allEdges: [],
      refactorGoal: 'Improve structure',
    })
    expect(prompt).toContain('重构目标')
    expect(prompt).toContain('Improve structure')
  })

  it('includes ancestor chain', () => {
    const parent = makeNode({ id: 'p1', type: 'process', title: 'Auth Process' })
    const child = makeNode({ id: 'c1', parentId: 'p1' })
    const prompt = buildDevPrompt({
      node: child,
      taskType: 'feature',
      allNodes: [parent, child],
      allEdges: [],
    })
    expect(prompt).toContain('Auth Process')
  })

  it('includes children', () => {
    const parent = makeNode()
    const child = makeNode({ id: 'c1', title: 'Token Validation', parentId: 'n1' })
    const prompt = buildDevPrompt({
      node: parent,
      taskType: 'feature',
      allNodes: [parent, child],
      allEdges: [],
    })
    expect(prompt).toContain('Token Validation')
  })

  it('includes related edges', () => {
    const n1 = makeNode({ id: 'n1' })
    const n2 = makeNode({ id: 'n2', title: 'User Service' })
    const edge: GraphEdge = { id: 'e1', source: 'n1', target: 'n2', type: 'depends_on', graphId: 'g1' }
    const prompt = buildDevPrompt({
      node: n1,
      taskType: 'feature',
      allNodes: [n1, n2],
      allEdges: [edge],
    })
    expect(prompt).toContain('User Service')
  })

  it('includes extra context', () => {
    const prompt = buildDevPrompt({
      node: makeNode(),
      taskType: 'feature',
      allNodes: [makeNode()],
      allEdges: [],
      extraContext: 'Important note',
    })
    expect(prompt).toContain('Important note')
  })
})

describe('augmentWithRagExamples', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns prompt unchanged when no RAG results', async () => {
    mockSearch.mockResolvedValueOnce([])
    const result = await augmentWithRagExamples('original prompt', makeNode(), [makeNode()], [])
    expect(result).toBe('original prompt')
  })

  it('appends RAG examples when results found', async () => {
    mockSearch.mockResolvedValueOnce([{
      score: 0.9,
      item: {
        title: 'Similar Feature',
        narrative: 'A similar login feature',
        facts: ['fact1', 'fact2'],
        concepts: ['auth'],
        files_modified: ['src/auth.ts'],
      },
    }])

    const result = await augmentWithRagExamples('original prompt', makeNode(), [makeNode()], [])
    expect(result).toContain('original prompt')
    expect(result).toContain('Similar Feature')
    expect(result).toContain('RAG few-shot examples')
  })

  it('handles RAG search errors gracefully', async () => {
    mockSearch.mockRejectedValueOnce(new Error('search failed'))
    const result = await augmentWithRagExamples('original prompt', makeNode(), [makeNode()], [])
    expect(result).toBe('original prompt')
  })
})
