/**
 * GraphMemory 单元测试
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GraphMemory, formatEdgeLabel, getEdgeStyle } from '../graph-memory'
import type { MemoryItem, MemoryKind } from '@shared/types'

/** Helper: create a memory item */
function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const id = overrides.id ?? Math.floor(Math.random() * 10000)
  return {
    id,
    session_id: 'session-1',
    kind: 'investigation' as MemoryKind,
    project_id: 'project-x',
    node_id: null,
    title: 'Test memory',
    narrative: 'Test narrative',
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    adapter_name: 'claude-code',
    token_cost: 100,
    confidence: 0.8,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

/** Mock MemoryStore */
function mockMemoryStore(memories: MemoryItem[] = []) {
  return {
    getRecent: vi.fn().mockResolvedValue(memories),
    getBySession: vi.fn().mockResolvedValue(memories),
    search: vi.fn().mockResolvedValue([]),
    getByNode: vi.fn().mockResolvedValue([]),
    getCrossAdapter: vi.fn().mockResolvedValue([]),
    store: vi.fn().mockResolvedValue(1),
    storeMany: vi.fn().mockResolvedValue([1]),
    deleteBySession: vi.fn().mockResolvedValue(0),
    pruneStale: vi.fn().mockResolvedValue(0),
    getStats: vi.fn().mockResolvedValue([]),
    toCompactSummary: vi.fn((item: MemoryItem) => `${item.id} ${item.title}`),
  } as any
}

describe('GraphMemory', () => {
  let graph: GraphMemory
  let memStore: ReturnType<typeof mockMemoryStore>

  beforeEach(() => {
    memStore = mockMemoryStore()
    graph = new GraphMemory(memStore)
  })

  describe('wrapNode', () => {
    it('wraps a MemoryItem into a MemoryNode', () => {
      const item = memory({ id: 1, title: 'Test' })
      const node = graph.wrapNode(item)
      expect(node.id).toBe(1)
      expect(node.memory.title).toBe('Test')
      expect(node.incomingEdges).toHaveLength(0)
      expect(node.outgoingEdges).toHaveLength(0)
    })
  })

  describe('inferRelations', () => {
    it('infers caused_by: investigation → fix', () => {
      const investigation = memory({ id: 1, kind: 'investigation', title: 'Auth flow investigation', narrative: 'Found issues in login' })
      const fix = memory({ id: 2, kind: 'fix', title: 'Fixed login bug' })

      const edges = graph.inferRelations(fix, [investigation])
      const causedBy = edges.filter((e) => e.relation === 'caused_by')
      expect(causedBy.length).toBe(1)
      expect(causedBy[0].sourceId).toBe(1)
      expect(causedBy[0].targetId).toBe(2)
    })

    it('infers depends_on: shared modified files', () => {
      const fixA = memory({ id: 1, kind: 'fix', title: 'Fix A', files_modified: ['src/auth/login.ts'] })
      const fixB = memory({ id: 2, kind: 'fix', title: 'Fix B', files_modified: ['src/auth/login.ts', 'src/auth/session.ts'] })

      const edges = graph.inferRelations(fixB, [fixA])
      const dependsOn = edges.filter((e) => e.relation === 'depends_on')
      expect(dependsOn.length).toBeGreaterThan(0)
    })

    it('infers supersedes: newer fix on same file', () => {
      const now = new Date()
      const oldDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
      const newDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000) // 1 day ago
      const oldFix = memory({ id: 1, kind: 'fix', title: 'Old fix', files_modified: ['src/app.ts'], created_at: oldDate.toISOString() })
      const newFix = memory({ id: 2, kind: 'fix', title: 'New fix', files_modified: ['src/app.ts'], created_at: newDate.toISOString() })

      const edges = graph.inferRelations(newFix, [oldFix])
      const supersedes = edges.filter((e) => e.relation === 'supersedes')
      expect(supersedes.length).toBe(1)
      expect(supersedes[0].sourceId).toBe(2) // new supersedes old
      expect(supersedes[0].targetId).toBe(1)
    })

    it('infers relates_to: shared concepts', () => {
      const memA = memory({ id: 1, concepts: ['auth', 'security'] })
      const memB = memory({ id: 2, concepts: ['auth', 'session'] })

      const edges = graph.inferRelations(memB, [memA])
      const relatesTo = edges.filter((e) => e.relation === 'relates_to')
      expect(relatesTo.length).toBeGreaterThan(0)
    })

    it('infers contradicts: opposite findings', () => {
      const findingA = memory({ id: 1, kind: 'review_finding', title: 'Tests pass', narrative: 'All tests passing' })
      const findingB = memory({ id: 2, kind: 'review_finding', title: 'Tests fail', narrative: 'Tests are failing' })

      const edges = graph.inferRelations(findingB, [findingA])
      const contradicts = edges.filter((e) => e.relation === 'contradicts')
      expect(contradicts.length).toBe(1)
    })

    it('filters out low-confidence edges', () => {
      // Create edge with below-threshold confidence
      const memA = memory({ id: 1, concepts: [] })
      const memB = memory({ id: 2, concepts: [] })

      const edges = graph.inferRelations(memB, [memA])
      // Only relates_to and potential contradictions would be possible,
      // but without shared concepts, only the context share might apply
      // Either way, no edge should have confidence below threshold if no real relationship
      expect(edges.every((e) => e.confidence >= 0.3)).toBe(true)
    })

    it('applies time decay to confidence based on created_at', () => {
      // A memory created 180 days ago (2 half-lives) should have confidence decayed by ~75%
      const now = new Date()
      const oldDate = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000) // 180 days ago
      const oldInvestigation = memory({ id: 1, kind: 'investigation', title: 'Old investigation', created_at: oldDate.toISOString() })
      const newFix = memory({ id: 2, kind: 'fix', title: 'New fix' })

      const edges = graph.inferRelations(newFix, [oldInvestigation])
      const causedBy = edges.filter((e) => e.relation === 'caused_by')
      if (causedBy.length > 0) {
        // Raw confidence is 0.7; after 180 days (2 half-lives), should be ~0.7 * e^(-2) ≈ 0.095
        // which is below 0.3 threshold, so it gets filtered out
        expect(causedBy[0].confidence).toBeLessThan(0.7)
      }
      // The edge may be filtered by minRelationConfidence (0.3), so confidence should always be >= 0.3
      expect(edges.every((e) => e.confidence >= 0.3)).toBe(true)
    })

    it('skips decay when created_at is missing', () => {
      const investigation = memory({ id: 1, kind: 'investigation', title: 'Investigation', created_at: '' })
      const newFix = memory({ id: 2, kind: 'fix', title: 'Fix' })

      const edges = graph.inferRelations(newFix, [investigation])
      const causedBy = edges.filter((e) => e.relation === 'caused_by')
      if (causedBy.length > 0) {
        // No decay should be applied when created_at is empty
        expect(causedBy[0].confidence).toBe(0.7)
      }
    })
  })

  describe('traverse', () => {
    it('returns null for non-existent memory', async () => {
      memStore.getRecent.mockResolvedValue([])
      const result = await graph.traverse(99999)
      expect(result).toBeNull()
    })

    it('traverses with depth > 3 and many candidates without blocking', async () => {
      // Create 50+ memories so the candidate pool cap is hit
      const memories: MemoryItem[] = []
      for (let i = 1; i <= 55; i++) {
        memories.push(
          memory({
            id: i,
            kind: 'investigation',
            title: `Memory ${i}`,
            concepts: ['auth', 'security'],
            files_modified: ['src/auth.ts'],
          })
        )
      }

      memStore.getRecent.mockResolvedValue(memories)

      // Spy on setImmediate to verify yields occur
      const setImmediateSpy = vi.spyOn(global, 'setImmediate')

      const result = await graph.traverse(1, { depth: 4 })

      expect(result).not.toBeNull()
      if (result) {
        expect(result.root.id).toBe(1)
        expect(result.totalNodes).toBeGreaterThanOrEqual(1)
      }

      // With 50 candidates and YIELD_EVERY_N=10, we expect 5 yields (at 10, 20, 30, 40, 50)
      expect(setImmediateSpy).toHaveBeenCalledTimes(5)

      setImmediateSpy.mockRestore()
    })

    it('returns correct edges with capped candidate pool', async () => {
      const m1 = memory({ id: 1, kind: 'investigation', title: 'Root', concepts: ['auth'] })
      const m2 = memory({ id: 2, kind: 'fix', title: 'Fix', concepts: ['auth'], files_modified: ['src/auth.ts'] })

      memStore.getRecent.mockResolvedValue([m1, m2])

      const result = await graph.traverse(1, { depth: 4 })
      expect(result).not.toBeNull()
      if (result) {
        expect(result.root.id).toBe(1)
        expect(result.totalNodes).toBeGreaterThanOrEqual(1)
      }
    })
  })

  describe('getRelationGraph', () => {
    it('returns null for non-existent memory', async () => {
      memStore.getRecent.mockResolvedValue([])
      const result = await graph.getRelationGraph(99999)
      expect(result).toBeNull()
    })
  })

  describe('generateProjectMemoryGraph', () => {
    it('generates graph for project memories', async () => {
      const m1 = memory({ id: 1, kind: 'investigation', title: 'Auth' })
      const m2 = memory({ id: 2, kind: 'fix', title: 'Fix auth', files_modified: ['src/auth.ts'] })

      memStore.getRecent.mockResolvedValue([m1, m2])

      const result = await graph.generateProjectMemoryGraph('project-x')
      expect(result.nodes.length).toBe(2)
      // Should infer some relationships
      expect(result.edges.length).toBeGreaterThan(0)
    })
  })
})

describe('formatEdgeLabel', () => {
  it('returns labels for all relation types', () => {
    const labels: Record<string, string> = {
      caused_by: '→ cause of',
      depends_on: '→ depends on',
      supersedes: '→ supersedes',
      relates_to: '→ relates to',
      contradicts: '↯ contradicts',
    }
    for (const [relation, label] of Object.entries(labels)) {
      expect(formatEdgeLabel({ relation, sourceId: 1, targetId: 2, confidence: 0.5, reason: 'test' } as any)).toBe(label)
    }
  })
})

describe('getEdgeStyle', () => {
  it('returns styles for all relation types', () => {
    const types = ['caused_by', 'depends_on', 'supersedes', 'relates_to', 'contradicts'] as const
    for (const type of types) {
      const style = getEdgeStyle(type)
      expect(style.stroke).toBeDefined()
      expect(style.dash).toBeDefined()
    }
  })
})
