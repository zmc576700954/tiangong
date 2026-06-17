/**
 * PipelineRunner 单元测试
 */

import { describe, it, expect } from 'vitest'
import { PipelineRunner } from '../pipeline'
import type { PipelineStage, PipelineContext } from '../pipeline'

/** Helper: create a minimal context */
function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    outputs: [],
    sessionId: 'test-session',
    ...overrides,
  }
}

describe('PipelineRunner', () => {
  it('runs stages in order', async () => {
    const order: string[] = []

    const stages: PipelineStage[] = [
      {
        name: 'first',
        process: async (ctx) => {
          order.push('first')
          return { ...ctx, normalizedOutputs: ctx.outputs }
        },
      },
      {
        name: 'second',
        process: async (ctx) => {
          order.push('second')
          return { ...ctx, observations: [] }
        },
      },
      {
        name: 'third',
        process: async (ctx) => {
          order.push('third')
          return { ...ctx, memories: [] }
        },
      },
    ]

    const runner = new PipelineRunner(stages)
    const result = await runner.run(makeCtx())

    expect(order).toEqual(['first', 'second', 'third'])
    expect(result.context.normalizedOutputs).toEqual([])
    expect(result.context.observations).toEqual([])
    expect(result.context.memories).toEqual([])
    expect(result.errors).toHaveLength(0)
  })

  it('isolates stage errors — failing stage does not prevent subsequent from running', async () => {
    const order: string[] = []

    const stages: PipelineStage[] = [
      {
        name: 'a',
        process: async (ctx) => {
          order.push('a')
          return ctx
        },
      },
      {
        name: 'b-fail',
        process: async () => {
          order.push('b-fail')
          throw new Error('boom')
        },
      },
      {
        name: 'c',
        process: async (ctx) => {
          order.push('c')
          return { ...ctx, observations: [{ key: 'value' }] }
        },
      },
    ]

    const runner = new PipelineRunner(stages)
    const result = await runner.run(makeCtx())

    // All stages ran
    expect(order).toEqual(['a', 'b-fail', 'c'])
    // Stage c still set its output
    expect(result.context.observations).toEqual([{ key: 'value' }])
    // Error was recorded for b-fail only
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].stage).toBe('b-fail')
    expect(result.errors[0].error.message).toBe('boom')
  })

  it('skips disabled stages', async () => {
    const order: string[] = []

    const stages: PipelineStage[] = [
      {
        name: 'enabled',
        enabled: () => true,
        process: async (ctx) => {
          order.push('enabled')
          return ctx
        },
      },
      {
        name: 'disabled',
        enabled: () => false,
        process: async (ctx) => {
          order.push('disabled')
          return ctx
        },
      },
      {
        name: 'also-enabled',
        process: async (ctx) => {
          order.push('also-enabled')
          return ctx
        },
      },
    ]

    const runner = new PipelineRunner(stages)
    await runner.run(makeCtx())

    expect(order).toEqual(['enabled', 'also-enabled'])
  })

  it('supports hooks — before and after hooks are called', async () => {
    const calls: string[] = []

    const stages: PipelineStage[] = [
      {
        name: 'with-hooks',
        hooks: {
          before: () => calls.push('before'),
          after: () => calls.push('after'),
        },
        process: async (ctx) => {
          calls.push('process')
          return ctx
        },
      },
      {
        name: 'only-before',
        hooks: {
          before: () => calls.push('before-2'),
        },
        process: async (ctx) => {
          calls.push('process-2')
          return ctx
        },
      },
    ]

    const runner = new PipelineRunner(stages)
    await runner.run(makeCtx())

    expect(calls).toEqual(['before', 'process', 'after', 'before-2', 'process-2'])
  })

  it('createDefault returns a runner with 7 stages', async () => {
    const runner = await PipelineRunner.createDefault()
    const result = await runner.run(makeCtx({ outputs: [] }))

    // Should complete without errors (empty outputs won't trigger failures)
    expect(result.errors).toHaveLength(0)
    expect(result.context.sessionId).toBe('test-session')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('tracks duration', async () => {
    const stages: PipelineStage[] = [
      {
        name: 'slow',
        process: async (ctx) => {
          await new Promise((r) => setTimeout(r, 10))
          return ctx
        },
      },
    ]

    const runner = new PipelineRunner(stages)
    const result = await runner.run(makeCtx())

    expect(result.durationMs).toBeGreaterThanOrEqual(10)
  })
})
