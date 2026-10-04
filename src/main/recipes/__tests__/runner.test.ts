import { describe, it, expect, vi } from 'vitest'
import { RecipeRunner } from '../runner'
import type { SubagentManager } from '../../agent/subagent-manager'
import type { RecipeWithSource } from '@shared/types'
import { BizGraphError, type ErrorCodeType } from '../../errors'

/**
 * RecipeRunner 测试 — SubagentManager.invoke 用 mock 替身。
 * 覆盖：参数替换、缺参留空、派发成功、派发失败填 error、注册失败抛错。
 */

function makeSubagentManagerMock(overrides: Partial<SubagentManager> = {}): SubagentManager {
  return {
    invoke: vi.fn(),
    registerType: vi.fn(),
    listTypes: vi.fn().mockReturnValue([]),
    getType: vi.fn(),
    cancel: vi.fn(),
    onProgress: vi.fn(),
    ...overrides,
  } as unknown as SubagentManager
}

function makeRecipe(over: Partial<RecipeWithSource> = {}): RecipeWithSource {
  return {
    version: '1.0.0',
    title: 'Test Recipe',
    description: 'For testing',
    instructions: 'Hello {{ name }}',
    prompt: 'Run for {{ name }}',
    parameters: [{ key: 'name', inputType: 'string', required: true }],
    scopeStrategy: 'subset',
    source: 'project',
    filePath: '/fake/test.yaml',
    ...over,
  }
}

describe('RecipeRunner.run', () => {
  it('renders parameters and invokes SubagentManager', async () => {
    const sm = makeSubagentManagerMock({
      invoke: vi.fn().mockResolvedValue({
        invocationId: 'inv-1',
        resultText: 'done',
        resultFiles: [],
        tokensUsed: 100,
        durationMs: 200,
      }),
    })
    const runner = new RecipeRunner(sm)
    const recipe = makeRecipe()

    const run = await runner.run({
      recipe,
      inputs: { name: 'world' },
      parentSessionId: 'session-1',
    })

    expect(run.status).toBe('completed')
    expect(run.resultText).toBe('done')
    expect(run.tokensUsed).toBe(100)
    expect(run.recipeId).toBe('test-recipe')

    // invoke 收到的 prompt 应是「Run for world」（prompt 优先）
    expect(sm.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Run for world',
        parentSessionId: 'session-1',
        agentType: 'recipe:test-recipe',
      }),
    )
  })

  it('renders missing optional values as empty string', async () => {
    const sm = makeSubagentManagerMock({
      invoke: vi.fn().mockResolvedValue({
        invocationId: 'inv-1', resultText: '', resultFiles: [], tokensUsed: 0, durationMs: 0,
      }),
    })
    const runner = new RecipeRunner(sm)
    const recipe = makeRecipe({
      prompt: 'Run for {{ name }} at {{ place }}',
      parameters: [
        { key: 'name', inputType: 'string', required: true },
        { key: 'place', inputType: 'string', required: false },
      ],
    })

    await runner.run({
      recipe,
      inputs: { name: 'world' },
      parentSessionId: 'session-1',
    })

    expect(sm.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Run for world at ' }),
    )
  })

  it('returns failed RecipeRun when SubagentManager.invoke rejects', async () => {
    const sm = makeSubagentManagerMock({
      invoke: vi.fn().mockRejectedValue(new BizGraphError('boom', 'BAD_EXEC' as ErrorCodeType)),
    })
    const runner = new RecipeRunner(sm)
    const recipe = makeRecipe()

    const run = await runner.run({
      recipe,
      inputs: { name: 'world' },
      parentSessionId: 'session-1',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('boom')
    expect(run.error).toContain('BAD_EXEC')
    expect(run.tokensUsed).toBe(0)
  })

  it('returns failed RecipeRun when required parameters missing', async () => {
    const sm = makeSubagentManagerMock()
    const runner = new RecipeRunner(sm)
    const recipe = makeRecipe({
      parameters: [
        { key: 'name', inputType: 'string', required: true },
        { key: 'count', inputType: 'number', required: true },
      ],
    })

    const run = await runner.run({
      recipe,
      inputs: { name: 'world' }, // count 缺失
      parentSessionId: 'session-1',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('count')
    expect(sm.invoke).not.toHaveBeenCalled()
  })

  it('falls back to instructions when prompt is missing', async () => {
    const sm = makeSubagentManagerMock({
      invoke: vi.fn().mockResolvedValue({
        invocationId: 'inv-1', resultText: '', resultFiles: [], tokensUsed: 0, durationMs: 0,
      }),
    })
    const runner = new RecipeRunner(sm)
    const recipe = makeRecipe({
      prompt: undefined,
      instructions: 'Only instructions {{ name }}',
    })

    await runner.run({
      recipe,
      inputs: { name: 'world' },
      parentSessionId: 'session-1',
    })

    expect(sm.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Only instructions world' }),
    )
  })

  it('wraps non-BizGraphError rejections with UNKNOWN code', async () => {
    const sm = makeSubagentManagerMock({
      invoke: vi.fn().mockRejectedValue(new Error('network down')),
    })
    const runner = new RecipeRunner(sm)
    const recipe = makeRecipe()

    const run = await runner.run({
      recipe,
      inputs: { name: 'world' },
      parentSessionId: 'session-1',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('UNKNOWN')
    expect(run.error).toContain('network down')
  })
})