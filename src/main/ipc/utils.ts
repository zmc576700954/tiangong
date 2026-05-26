/**
 * IPC 工具函数
 * 类型安全的 typedHandle 包装器 + 频率限制
 */

import { ipcMain } from 'electron'
import type { IpcApi } from '@shared/types'
import { IpcError, ErrorCode } from '../errors'

export type TypedHandle = <K extends keyof IpcApi>(
  channel: K,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>,
) => void

// TG-012: IPC 调用频率限制
interface RateLimitEntry {
  count: number
  windowStart: number
}

const RATE_LIMIT_WINDOW_MS = 1000
const RATE_LIMIT_MAX_CALLS = 20
const rateLimits = new Map<string, RateLimitEntry>()

function checkRateLimit(channel: string): boolean {
  const now = Date.now()
  const entry = rateLimits.get(channel)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(channel, { count: 1, windowStart: now })
    return true
  }

  if (entry.count >= RATE_LIMIT_MAX_CALLS) {
    return false
  }

  entry.count++
  return true
}

/**
 * 创建类型安全的 IPC handle 包装器
 * 将 channel 名称和 listener 参数与 IpcApi 类型严格绑定
 */
export function createTypedHandle(): TypedHandle {
  const originalHandle = ipcMain.handle.bind(ipcMain)

  return <K extends keyof IpcApi>(
    channel: K,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>,
  ): void => {
    return originalHandle(channel, async (event, ...args) => {
      // TG-012: 频率限制检查
      if (!checkRateLimit(channel)) {
        console.warn(`[RateLimit] IPC channel '${channel}' rate limited`)
        throw new IpcError(
          `Rate limit exceeded for '${channel}'. Max ${RATE_LIMIT_MAX_CALLS} calls per ${RATE_LIMIT_WINDOW_MS}ms.`,
          ErrorCode.IPC_ACCESS_DENIED,
        )
      }

      try {
        return await (listener as any)(event, ...args)
      } catch (error) {
        console.error(`[IPC Error] ${channel}:`, error)
        if (error instanceof Error) {
          throw error
        }
        throw new Error(String(error))
      }
    })
  }
}
