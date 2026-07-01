import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  IpcMiddlewarePipeline,
  createLoggingMiddleware,
  createPerformanceMiddleware,
  createErrorMiddleware,
  createDefaultMiddlewarePipeline,
} from '../middleware'
import type { IpcMiddlewareContext } from '../middleware'

function makeCtx(overrides?: Partial<IpcMiddlewareContext>): IpcMiddlewareContext {
  return {
    channel: 'test:channel',
    event: { sender: { id: 1 } } as never,
    args: [],
    startTime: Date.now(),
    ...overrides,
  }
}

describe('IpcMiddlewarePipeline', () => {
  it('executes handler when no middleware', async () => {
    const pipeline = new IpcMiddlewarePipeline()
    const handler = vi.fn().mockResolvedValue('result')
    const result = await pipeline.execute(makeCtx(), handler)
    expect(result).toBe('result')
    expect(handler).toHaveBeenCalled()
  })

  it('executes middleware chain in order', async () => {
    const pipeline = new IpcMiddlewarePipeline()
    const order: number[] = []

    pipeline.use(async (ctx, next) => {
      order.push(1)
      const result = await next()
      order.push(3)
      return result
    })
    pipeline.use(async (ctx, next) => {
      order.push(2)
      return next()
    })

    const handler = vi.fn().mockResolvedValue('done')
    await pipeline.execute(makeCtx(), handler)

    expect(order).toEqual([1, 2, 3])
  })

  it('middleware can modify result', async () => {
    const pipeline = new IpcMiddlewarePipeline()
    pipeline.use(async (ctx, next) => {
      const result = await next()
      return `${result}-modified`
    })

    const handler = vi.fn().mockResolvedValue('original')
    const result = await pipeline.execute(makeCtx(), handler)
    expect(result).toBe('original-modified')
  })

  it('dispose clears all middleware and disposers', () => {
    const pipeline = new IpcMiddlewarePipeline()
    const disposer = vi.fn()
    pipeline.useDisposable({ middleware: async (ctx, next) => next(), dispose: disposer })
    pipeline.dispose()
    expect(disposer).toHaveBeenCalled()
  })
})

describe('createLoggingMiddleware', () => {
  it('calls next and returns result', async () => {
    const middleware = createLoggingMiddleware()
    const next = vi.fn().mockResolvedValue('ok')
    const result = await middleware(makeCtx(), next)
    expect(result).toBe('ok')
  })

  it('re-throws errors', async () => {
    const middleware = createLoggingMiddleware()
    const next = vi.fn().mockRejectedValue(new Error('fail'))
    await expect(middleware(makeCtx(), next)).rejects.toThrow('fail')
  })
})

describe('createPerformanceMiddleware', () => {
  it('tracks call statistics', async () => {
    const { middleware, dispose } = createPerformanceMiddleware()
    const next = vi.fn().mockResolvedValue('ok')

    await middleware(makeCtx({ channel: 'test:a' }), next)
    await middleware(makeCtx({ channel: 'test:a' }), next)
    await middleware(makeCtx({ channel: 'test:b' }), next)

    dispose()
  })

  it('dispose cleans up timer', () => {
    const { dispose } = createPerformanceMiddleware()
    expect(() => dispose()).not.toThrow()
  })
})

describe('createErrorMiddleware', () => {
  it('calls onError callback on error', async () => {
    const onError = vi.fn()
    const middleware = createErrorMiddleware({ onError })
    const next = vi.fn().mockRejectedValue(new Error('fail'))
    const ctx = makeCtx()

    await expect(middleware(ctx, next)).rejects.toThrow('fail')
    expect(onError).toHaveBeenCalledWith(ctx, expect.any(Error))
  })

  it('re-throws after calling onError', async () => {
    const middleware = createErrorMiddleware({ onError: vi.fn() })
    const next = vi.fn().mockRejectedValue(new Error('fail'))

    await expect(middleware(makeCtx(), next)).rejects.toThrow('fail')
  })
})

describe('createDefaultMiddlewarePipeline', () => {
  it('creates pipeline with all middleware', async () => {
    const pipeline = createDefaultMiddlewarePipeline()
    const handler = vi.fn().mockResolvedValue('result')
    const result = await pipeline.execute(makeCtx(), handler)
    expect(result).toBe('result')
  })
})
