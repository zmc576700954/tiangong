/**
 * IPC 中间件机制
 * 支持日志、性能监控、错误处理中间件
 */

import { createLogger } from '../shared/logger'
import type { IpcMainInvokeEvent } from 'electron'

const logger = createLogger('IpcMiddleware')

/** IPC 中间件上下文 */
export interface IpcMiddlewareContext {
  channel: string
  event: IpcMainInvokeEvent
  args: unknown[]
  startTime: number
}

/** IPC 中间件函数签名 */
export type IpcMiddleware = (
  ctx: IpcMiddlewareContext,
  next: () => Promise<unknown>,
) => Promise<unknown>

/** 可清理资源的中间件（如内部定时器） */
export interface DisposableMiddleware {
  middleware: IpcMiddleware
  dispose(): void
}

/** IPC 中间件管道 */
export class IpcMiddlewarePipeline {
  private middlewares: IpcMiddleware[] = []
  private disposers: Array<() => void> = []

  /** 注册中间件（普通形式） */
  use(middleware: IpcMiddleware): void {
    this.middlewares.push(middleware)
  }

  /**
   * 注册带资源的中间件
   * pipeline.dispose() 时会自动调用所有 disposer
   */
  useDisposable(d: DisposableMiddleware): void {
    this.middlewares.push(d.middleware)
    this.disposers.push(d.dispose)
  }

  /** 执行管道 */
  async execute(ctx: IpcMiddlewareContext, handler: (...args: unknown[]) => Promise<unknown>): Promise<unknown> {
    let index = 0

    const next = async (): Promise<unknown> => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++]
        return middleware(ctx, next)
      }
      return handler(...ctx.args)
    }

    return next()
  }

  /** 释放所有中间件持有的资源（如 setInterval） */
  dispose(): void {
    for (const d of this.disposers) {
      try { d() } catch (err) { logger.warn('middleware dispose error:', err) }
    }
    this.disposers = []
    this.middlewares = []
  }
}

/** 日志中间件：记录 IPC 调用 */
export function createLoggingMiddleware(options?: { slowThresholdMs?: number }): IpcMiddleware {
  const slowThreshold = options?.slowThresholdMs ?? 1000
  return async (ctx, next) => {
    logger.debug(`IPC ${ctx.channel} called`, { sender: ctx.event.sender.id })
    try {
      const result = await next()
      const duration = Date.now() - ctx.startTime
      if (duration > slowThreshold) {
        logger.warn(`Slow IPC call: ${ctx.channel} took ${duration}ms`)
      } else {
        logger.debug(`IPC ${ctx.channel} completed in ${duration}ms`)
      }
      return result
    } catch (err) {
      const duration = Date.now() - ctx.startTime
      logger.error(`IPC ${ctx.channel} failed after ${duration}ms:`, err)
      throw err
    }
  }
}

/**
 * 性能监控中间件：记录调用耗时统计
 *
 * 返回 DisposableMiddleware 以便清理内部定时器——
 * 旧实现只返回函数闭包，调用方无法释放 setInterval，
 * 每次重建 pipeline（如测试、热重载）都会累积一个永不停止的 interval + stats Map。
 */
export function createPerformanceMiddleware(): DisposableMiddleware {
  const stats = new Map<string, { count: number; totalMs: number; maxMs: number; errors: number }>()

  const timer = setInterval(() => {
    for (const [channel, s] of stats) {
      if (s.count > 0) {
        logger.info(`IPC perf: ${channel} — calls=${s.count}, avg=${Math.round(s.totalMs / s.count)}ms, max=${s.maxMs}ms, errors=${s.errors}`)
      }
    }
  }, 60_000)
  if (timer.unref) timer.unref()

  const middleware: IpcMiddleware = async (ctx, next) => {
    let s = stats.get(ctx.channel)
    if (!s) {
      s = { count: 0, totalMs: 0, maxMs: 0, errors: 0 }
      stats.set(ctx.channel, s)
    }

    try {
      const result = await next()
      const duration = Date.now() - ctx.startTime
      s.count++
      s.totalMs += duration
      s.maxMs = Math.max(s.maxMs, duration)
      return result
    } catch (err) {
      s.count++
      s.errors++
      throw err
    }
  }

  return {
    middleware,
    dispose: () => {
      clearInterval(timer)
      stats.clear()
    },
  }
}

/** 错误处理中间件：统一包装 IPC 错误 */
export function createErrorMiddleware(options?: {
  onError?: (ctx: IpcMiddlewareContext, err: unknown) => void
}): IpcMiddleware {
  return async (ctx, next) => {
    try {
      return await next()
    } catch (err) {
      options?.onError?.(ctx, err)
      // 重新抛出，让上层 handler 继续处理
      throw err
    }
  }
}

/** 创建默认中间件管道（日志 + 性能 + 错误处理） */
export function createDefaultMiddlewarePipeline(options?: {
  logSlowThresholdMs?: number
  onError?: (ctx: IpcMiddlewareContext, err: unknown) => void
}): IpcMiddlewarePipeline {
  const pipeline = new IpcMiddlewarePipeline()
  pipeline.use(createLoggingMiddleware({ slowThresholdMs: options?.logSlowThresholdMs }))
  pipeline.useDisposable(createPerformanceMiddleware())
  pipeline.use(createErrorMiddleware({ onError: options?.onError }))
  return pipeline
}
