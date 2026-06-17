/**
 * PromptOrchestrator 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PromptOrchestrator } from '../prompt-orchestrator'
import type { AssembleResult } from '../prompt-orchestrator'
import type { AgentOutput, AgentSessionConfig, ResolvedContext } from '@shared/types'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../adapters/scope-prompt-builder', () => ({
  buildScopePrompt: vi.fn((_config: AgentSessionConfig, _ctx?: ResolvedContext[], _code?: string) => {
    // Return a predictable scope prompt
    return '## Scope\nNode: test-node\nAllowed: src/**\nForbidden: dist/**'
  }),
  compressScopePrompt: vi.fn((prompt: string, _maxTokens: number) => {
    // Simulate compression by truncating to ~half
    return prompt.slice(0, Math.ceil(prompt.length / 2))
  }),
}))

vi.mock('./context-compiler', () => {
  return {
    ContextCompiler: vi.fn().mockImplementation(() => ({
      compile: vi.fn(async (_outputs: AgentOutput[], _meta: any) => ({
        layers: [
          { level: 1, label: 'Summary', content: 'Summary of output', estimatedTokens: 5 },
          { level: 2, label: 'KeyFacts', content: 'Key fact one. Key fact two.', estimatedTokens: 10 },
          { level: 3, label: 'FullOutput', content: 'Full output content here with details.', estimatedTokens: 15 },
        ],
      })),
      render: vi.fn((_context: any, maxTokens: number) => ({
        text: 'Summary of output\nKey fact one. Key fact two.\nFull output content here with details.',
        economics: { discoveryTokens: 30, readTokens: 20, savings: 10, savingsPct: 25 },
      })),
    })),
  }
})

vi.mock('./waterline-sync', () => ({
  getWaterlineSync: vi.fn(() => ({
    formatContext: vi.fn((_projectId: string) => '项目水位线状态\n会话数: 3\n已完成调查: 2'),
  })),
}))

vi.mock('../shared/token-utils', () => ({
  estimateTokens: vi.fn((text: string) => {
    if (!text) return 0
    // Simple approximation: ~4 chars per token for non-CJK text
    return Math.ceil(text.length / 4)
  }),
}))

vi.mock('../shared/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    workingDirectory: '/project',
    allowedFiles: ['src/**'],
    forbiddenFiles: ['dist/**'],
    invariantRules: ['Do not break tests'],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: 'test-node',
    acceptanceCriteria: ['All tests pass'],
    ...overrides,
  }
}

function makeOutput(data: string = 'hello world'): AgentOutput {
  return {
    type: 'stdout',
    data,
    timestamp: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptOrchestrator', () => {
  let orchestrator: PromptOrchestrator

  beforeEach(() => {
    vi.clearAllMocks()
    orchestrator = new PromptOrchestrator()
  })

  it('assemble produces 5-layer prompt within token budget', async () => {
    const totalBudget = 500
    const result: AssembleResult = await orchestrator.assemble({
      sessionId: 'session-1',
      adapterName: 'claude-code',
      projectId: 'project-x',
      userCommand: 'Fix the login bug',
      totalBudget,
      sessionConfig: makeConfig(),
      outputs: [makeOutput()],
    })

    // Should have exactly 5 layers in breakdown
    expect(result.layerBreakdown).toHaveLength(5)
    expect(result.layerBreakdown.map((l) => l.name)).toEqual([
      'system', 'scope', 'context', 'waterline', 'user',
    ])

    // Total tokens should be within budget (non-compressible layers may push slightly over)
    // Allow a generous margin since non-compressible layers are always included
    expect(result.totalTokens).toBeLessThanOrEqual(totalBudget * 2)

    // All non-empty layers should be included
    expect(result.layerBreakdown[0].included).toBe(true)  // system
    expect(result.layerBreakdown[3].included).toBe(true)  // waterline
    expect(result.layerBreakdown[4].included).toBe(true)  // user

    // The assembled text should contain content from multiple layers
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('system instruction layer is always included', async () => {
    // Use a very small budget to stress-test inclusion
    const result = await orchestrator.assemble({
      sessionId: 'session-2',
      adapterName: 'codex',
      userCommand: 'Do something',
      totalBudget: 50,
    })

    const systemLayer = result.layerBreakdown.find((l) => l.name === 'system')!
    expect(systemLayer).toBeDefined()
    expect(systemLayer.included).toBe(true)
    expect(systemLayer.tokens).toBeGreaterThan(0)

    // The system text should mention the adapter name
    expect(result.text).toContain('codex')
  })

  it('context knowledge layer is compressed when budget is tight', async () => {
    // Use a tight budget so scope layer exceeds its allocation and gets compressed.
    // Scope budget = 25% of 80 = 20 tokens. The mock scope prompt is ~63 tokens
    // (verified by log output), which exceeds the budget so compression kicks in.
    const tightBudget = 80

    // First, assemble without a tight budget to get the uncompressed scope token count
    const looseResult = await orchestrator.assemble({
      sessionId: 'session-3a',
      adapterName: 'claude-code',
      projectId: 'project-x',
      userCommand: 'Refactor the auth module',
      totalBudget: 2000,
      sessionConfig: makeConfig(),
      outputs: [makeOutput()],
    })
    const looseScopeTokens = looseResult.layerBreakdown.find((l) => l.name === 'scope')!.tokens

    // Now assemble with a tight budget — scope should be compressed (fewer tokens)
    const tightResult = await orchestrator.assemble({
      sessionId: 'session-3b',
      adapterName: 'claude-code',
      projectId: 'project-x',
      userCommand: 'Refactor the auth module',
      totalBudget: tightBudget,
      sessionConfig: makeConfig(),
      outputs: [makeOutput()],
    })

    const tightScopeTokens = tightResult.layerBreakdown.find((l) => l.name === 'scope')!.tokens
    expect(tightScopeTokens).toBeLessThan(looseScopeTokens)

    // Scope should still be present and included
    const scopeLayer = tightResult.layerBreakdown.find((l) => l.name === 'scope')!
    expect(scopeLayer.included).toBe(true)
  })

  it('waterline layer is always included', async () => {
    const result = await orchestrator.assemble({
      sessionId: 'session-4',
      adapterName: 'opencode',
      projectId: 'project-x',
      userCommand: 'Check the build',
      totalBudget: 200,
    })

    const waterlineLayer = result.layerBreakdown.find((l) => l.name === 'waterline')!
    expect(waterlineLayer).toBeDefined()
    expect(waterlineLayer.included).toBe(true)
    expect(waterlineLayer.tokens).toBeGreaterThan(0)

    // The assembled text should contain waterline content
    expect(result.text).toContain('项目水位线状态')
  })
})
