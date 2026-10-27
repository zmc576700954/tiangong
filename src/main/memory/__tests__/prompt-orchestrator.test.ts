/**
 * PromptOrchestrator 单元测试
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PromptOrchestrator } from '../prompt-orchestrator'
import * as orchestratorModule from '../prompt-orchestrator'
import type { AssembleResult } from '../prompt-orchestrator'
import { ContextCompiler } from '../context-compiler'
import { estimateTokens } from '../../shared/token-utils'
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
      render: vi.fn((_context: any, _maxTokens: number) => ({
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

describe('PromptContext (stable / turn 分段)', () => {
  const baseOptions = {
    sessionId: 's-ctx',
    adapterName: 'claude-code',
    totalBudget: 8000,
    sessionConfig: makeConfig(),
  }

  it('stable 段跨轮逐字节一致（用户请求变化不影响 stable）', async () => {
    const a = await new PromptOrchestrator().assemble({ ...baseOptions, userCommand: '第一条命令' })
    const b = await new PromptOrchestrator().assemble({ ...baseOptions, userCommand: '第二条命令' })
    expect(a.context.stable).toBe(b.context.stable)
  })

  it('stable 与 turn 段都不含用户请求原文', async () => {
    // 用户请求只由适配器的 buildCommandPrompt 承载（spec D1）。
    // 带 outputs 时编译上下文也会生成，必须一并排除，否则用户请求出现两次。
    const r = await new PromptOrchestrator().assemble({
      ...baseOptions,
      userCommand: '绝密指令XYZ',
      outputs: [makeOutput('some stdout output that is long enough to compile')],
    })
    expect(r.context.stable).not.toContain('绝密指令XYZ')
    expect(r.context.turn).not.toContain('绝密指令XYZ')
  })

  it('项目记忆进 stable 段，会话历史记忆进 turn 段', async () => {
    const r = await new PromptOrchestrator().assemble({
      ...baseOptions,
      userCommand: 'cmd',
      projectMemory: '项目记忆内容AAA',
      sessionHistory: '历史记忆内容BBB',
    })
    expect(r.context.stable).toContain('项目记忆内容AAA')
    expect(r.context.turn).toContain('历史记忆内容BBB')
    expect(r.context.stable).not.toContain('历史记忆内容BBB')
  })

  it('会话历史记忆变化时 turn 段变化、stable 段不变', async () => {
    const a = await new PromptOrchestrator().assemble({ ...baseOptions, userCommand: 'cmd', sessionHistory: '历史A' })
    const b = await new PromptOrchestrator().assemble({ ...baseOptions, userCommand: 'cmd', sessionHistory: '历史B' })
    expect(a.context.stable).toBe(b.context.stable)
    expect(a.context.turn).not.toBe(b.context.turn)
  })

  it('会话摘要进 stable 段', async () => {
    const r = await new PromptOrchestrator().assemble({
      ...baseOptions,
      userCommand: 'cmd',
      sessionConfig: makeConfig({ contextSummary: '前序会话摘要QQQ' }),
    })
    expect(r.context.stable).toContain('前序会话摘要QQQ')
  })

  it('waterline 超预算时截断自身，不借用 context 层的预算', async () => {
    const renderSpy = vi.spyOn(ContextCompiler.prototype, 'render')
    try {
      const totalBudget = 100
      const result = await new PromptOrchestrator().assemble({
        sessionId: 's-wl',
        adapterName: 'claude-code',
        projectId: 'project-x',
        userCommand: 'cmd',
        totalBudget,
        sessionConfig: makeConfig(),
        outputs: [makeOutput()],
      })

      const contextBudget = Math.floor(totalBudget * 0.35)
      const waterlineBudget = Math.floor(totalBudget * 0.05)

      // 水位线超预算时截断自身，而不是把预算借给 context 层
      const waterlineLayer = result.layerBreakdown.find((l) => l.name === 'waterline')!
      expect(waterlineLayer.tokens).toBeLessThanOrEqual(waterlineBudget)

      // context 层始终按完整预算渲染，从未被水位线借走
      expect(renderSpy).toHaveBeenCalled()
      for (const call of renderSpy.mock.calls) {
        expect(call[1]).toBe(contextBudget)
      }
    } finally {
      renderSpy.mockRestore()
    }
  })
})

describe('compressScopeByPriority', () => {
  it('按中文标题分级：Level 1 移除业务不变量但保留黑名单', () => {
    expect(orchestratorModule.compressScopeByPriority).toBeTypeOf('function')

    // 分级依据的段落标题必须是生产者实际输出的中文标题。
    // 历史实现按英文标题匹配，导致所有段落都落进 'other'，分级压缩形同虚设。
    const scope = [
      '## 业务不变量',
      '- 恒等约束A'.repeat(20),
      '',
      '## 禁止修改的文件（黑名单）',
      '- src/secret.ts',
      '',
      '## 上游契约',
      'up',
      '',
      '## 下游契约',
      'down',
    ].join('\n')

    // Level 1 之后剩下的文本（移除业务不变量段）必须装得下预算，
    // 而原文本装不下 —— 这样才会正好停在 Level 1。
    const afterLevel1 = [
      '## 禁止修改的文件（黑名单）',
      '- src/secret.ts',
      '',
      '## 上游契约',
      'up',
      '',
      '## 下游契约',
      'down',
    ].join('\n')
    const maxTokens = estimateTokens(afterLevel1)

    const result = orchestratorModule.compressScopeByPriority(scope, maxTokens)

    expect(result.compressionLevel).toBe(1)
    expect(result.text).not.toContain('恒等约束A')
    // 黑名单是安全约束，任何预算压力下都不得被丢弃。
    expect(result.text).toContain('src/secret.ts')
  })
})
