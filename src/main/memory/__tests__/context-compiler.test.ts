/**
 * ContextCompiler 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextCompiler } from '../context-compiler'
import type { AgentOutput, LayeredContext, MemoryItem } from '@shared/types'

// --- Module-level mocks ---

// Track what the mock store should return so tests can configure it
let mockGetRecentResult: MemoryItem[] = []
let mockGetByNodeResult: MemoryItem[] = []
let mockGetRecentError: Error | null = null

// Track what GraphMemory.inferRelations should return
let mockInferRelationsResult: any[] = []

vi.mock('../memory-store', () => ({
  getMemoryStore: vi.fn(() => ({
    getRecent: vi.fn(async () => {
      if (mockGetRecentError) throw mockGetRecentError
      return mockGetRecentResult
    }),
    getByNode: vi.fn(async () => mockGetByNodeResult),
    toCompactSummary: vi.fn((item: { kind: string; title: string }) => `[${item.kind}] ${item.title}`),
  })),
}))

vi.mock('../graph-memory', () => ({
  GraphMemory: vi.fn().mockImplementation(function(this: any, _store: any) {
    this.inferRelations = vi.fn(() => mockInferRelationsResult)
  }),
}))

// --- Helpers ---

/** Helper: create a memory item */
function mockMemory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 1,
    session_id: 'session-1',
    kind: 'investigation',
    project_id: 'proj-1',
    node_id: null,
    title: 'Test',
    narrative: 'Test narrative',
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    adapter_name: 'test',
    token_cost: 0,
    confidence: 0.8,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

/** Helper: create stdout outputs */
function stdoutOutputs(lines: string[]): AgentOutput[] {
  return lines.map((data) => ({
    type: 'stdout' as const,
    data,
    timestamp: Date.now(),
  }))
}

describe('ContextCompiler', () => {
  let compiler: ContextCompiler

  beforeEach(() => {
    // Reset mock state
    mockGetRecentResult = []
    mockGetByNodeResult = []
    mockGetRecentError = null
    mockInferRelationsResult = []
    compiler = new ContextCompiler()
  })

  it('compile produces layers (L1, L2, L3, optionally L4)', async () => {
    const outputs = stdoutOutputs([
      'Modified: src/main/foo.ts',
      'Tests: 5 passed, 0 failed, 5 total',
    ])
    const layered = await compiler.compile(outputs, {
      sessionId: 'session_001',
      adapterName: 'claude-code',
      commandDescription: 'Fix auth bug',
    })

    // Should have at least L1, L2, L3
    expect(layered.layers.length).toBeGreaterThanOrEqual(3)

    // L1
    const l1 = layered.layers.find((l) => l.level === 1)
    expect(l1).toBeDefined()
    expect(l1!.label).toBe('L1-Summary')
    expect(l1!.content).toContain('Fix auth bug')
    expect(l1!.content).toContain('[claude-code]')

    // L2
    const l2 = layered.layers.find((l) => l.level === 2)
    expect(l2).toBeDefined()
    expect(l2!.label).toBe('L2-KeyFacts')

    // L3
    const l3 = layered.layers.find((l) => l.level === 3)
    expect(l3).toBeDefined()
    expect(l3!.label).toBe('L3-FullOutput')

    // L4 may or may not be present depending on mock result
    // With the default mock returning [], L4 should not be present
    const l4 = layered.layers.find((l) => l.level === 4)
    expect(l4).toBeUndefined()
  })

  it('render respects budget and only includes affordable layers', () => {
    const context: LayeredContext = {
      layers: [
        { level: 1, label: 'L1-Summary', content: 'Short summary', estimatedTokens: 10 },
        { level: 2, label: 'L2-KeyFacts', content: 'Key facts here with more detail', estimatedTokens: 50 },
        { level: 3, label: 'L3-FullOutput', content: 'Full output content that is quite long and detailed', estimatedTokens: 200 },
      ],
    }

    // Budget only enough for L1
    const result = compiler.render(context, 15)
    expect(result.text).toContain('[Summary]')
    expect(result.text).not.toContain('[KeyFacts]')
    expect(result.economics.readTokens).toBe(10)
    expect(result.economics.discoveryTokens).toBe(260)
    expect(result.economics.savingsPct).toBeGreaterThan(0)

    // Budget enough for L1 + L2
    const result2 = compiler.render(context, 70)
    expect(result2.text).toContain('[Summary]')
    expect(result2.text).toContain('[KeyFacts]')
    expect(result2.text).not.toContain('[FullOutput]')
  })

  it('render strips L-prefix from labels using regex', () => {
    const context: LayeredContext = {
      layers: [
        { level: 1, label: 'L1-Summary', content: 'summary', estimatedTokens: 5 },
        { level: 4, label: 'L4-关联历史', content: 'history', estimatedTokens: 5 },
      ],
    }

    const result = compiler.render(context, 100)
    // Should strip L1- prefix
    expect(result.text).toContain('[Summary]')
    // Should strip L4- prefix (including non-ASCII label)
    expect(result.text).toContain('[关联历史]')
    // Should NOT contain raw label
    expect(result.text).not.toContain('L1-Summary')
    expect(result.text).not.toContain('L4-关联历史')
  })

  it('injectForDownstream does not throw on store errors', async () => {
    // Configure mock to throw on getRecent
    mockGetRecentError = new Error('DB connection lost')

    // Should not throw, should return a result (possibly empty or partial)
    const result = await compiler.injectForDownstream(
      stdoutOutputs(['some output']),
      500,
      { projectId: 'test-project' },
    )

    // The result should be a valid economics object (graceful degradation)
    expect(result.economics).toBeDefined()
    expect(typeof result.economics.discoveryTokens).toBe('number')
    expect(typeof result.economics.readTokens).toBe('number')
  })

  it('compile includes graph context in L3 when projectId provided', async () => {
    // Set up mock memories so _buildL3GraphContext has data
    mockGetRecentResult = [
      mockMemory({ id: 1, kind: 'investigation', title: 'Auth flow', concepts: ['auth'], files_modified: [] }),
      mockMemory({ id: 2, kind: 'fix', title: 'Fix auth', concepts: ['auth'], files_modified: ['auth.ts'] }),
    ]

    // Set up GraphMemory mock to return relations
    mockInferRelationsResult = [
      { relation: 'caused_by', sourceId: 1, targetId: 2, confidence: 0.7, reason: 'Fix was caused by investigation' },
      { relation: 'relates_to', sourceId: 2, targetId: 1, confidence: 0.3, reason: 'Low confidence edge' },
    ]

    const layered = await compiler.compile(
      stdoutOutputs(['some output']),
      { projectId: 'proj-1' },
    )

    const l3 = layered.layers.find((l) => l.level === 3)
    expect(l3).toBeDefined()
    // L3 should contain the high-confidence relation (0.7 > 0.5)
    expect(l3!.content).toContain('caused_by')
    // Should NOT contain the low-confidence relation (0.3 <= 0.5)
    expect(l3!.content).not.toContain('Low confidence edge')
  })

  it('compile skips graph context when fewer than 2 memories', async () => {
    mockGetRecentResult = [
      mockMemory({ id: 1, kind: 'fix', title: 'Only one' }),
    ]
    mockInferRelationsResult = [
      { relation: 'caused_by', sourceId: 1, targetId: 2, confidence: 0.9, reason: 'Should not appear' },
    ]

    const layered = await compiler.compile(
      stdoutOutputs(['some output']),
      { projectId: 'proj-1' },
    )

    const l3 = layered.layers.find((l) => l.level === 3)
    expect(l3).toBeDefined()
    // With < 2 memories, _buildL3GraphContext returns ''
    expect(l3!.content).not.toContain('caused_by')
  })

  it('compile includes node-related files in L4 when nodeId provided', async () => {
    mockGetRecentResult = [
      mockMemory({ id: 1, kind: 'fix', title: 'Fix A' }),
    ]
    mockGetByNodeResult = [
      mockMemory({ id: 10, kind: 'fix', title: 'Node fix', files_modified: ['file-a.ts', 'file-b.ts'] }),
    ]

    const layered = await compiler.compile(
      stdoutOutputs(['output']),
      { projectId: 'proj-1', nodeId: 'node-123' },
    )

    const l4 = layered.layers.find((l) => l.level === 4)
    expect(l4).toBeDefined()
    expect(l4!.content).toContain('Related files: file-a.ts, file-b.ts')
  })
})
