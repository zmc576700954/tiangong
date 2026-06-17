/**
 * ContextCompiler 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContextCompiler } from '../context-compiler'
import type { AgentOutput, LayeredContext } from '@shared/types'

// Mock getMemoryStore to avoid real DB dependency
vi.mock('../memory-store', () => ({
  getMemoryStore: vi.fn(() => ({
    getRecent: vi.fn().mockResolvedValue([]),
    toCompactSummary: vi.fn((item: { kind: string; title: string }) => `[${item.kind}] ${item.title}`),
  })),
}))

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

  it('injectForDownstream handles errors gracefully', async () => {
    // Force getMemoryStore to return a store whose getRecent rejects
    const { getMemoryStore } = await import('../memory-store')
    vi.mocked(getMemoryStore).mockImplementationOnce(() => ({
      getRecent: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      toCompactSummary: vi.fn((item: { kind: string; title: string }) => `[${item.kind}] ${item.title}`),
    }) as any)

    // Use a fresh compiler that will trigger the mock
    const failingCompiler = new ContextCompiler()
    const result = await failingCompiler.injectForDownstream(
      stdoutOutputs(['some output']),
      500,
      { projectId: 'test-project' },
    )

    // Should return empty result, not throw
    expect(result.text).toBe('')
    expect(result.economics.discoveryTokens).toBe(0)
    expect(result.economics.readTokens).toBe(0)
    expect(result.economics.savingsPct).toBe(0)
  })
})
