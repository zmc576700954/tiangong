/**
 * IPC Utilities — 类型安全的 IPC 注册、频率限制
 */

import type { IpcMainInvokeEvent } from 'electron'
import { IpcError, ErrorCode } from '../errors'

/** 单个频率限制条目 */
interface RateLimitEntry {
  count: number
  resetAt: number
}

/** 频率限制跟踪表：key = `${channel}:${webContentsId}` */
const rateLimits = new Map<string, RateLimitEntry>()

/** 频率限制：每秒最多 20 次调用 */
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW = 1000 // 1 秒

/** 清理间隔：每 60 秒清理过期的频率限制条目，防止 Map 无限增长 */
const CLEANUP_INTERVAL = 60_000
let cleanupTimer: ReturnType<typeof setInterval> | null = null

/** 启动定期清理（幂等，多次调用只启动一个定时器） */
function startCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of rateLimits) {
      if (entry.resetAt < now) {
        rateLimits.delete(key)
      }
    }
  }, CLEANUP_INTERVAL)
  // 允许进程退出时不阻塞
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as ReturnType<typeof setInterval> & { unref(): void }).unref()
  }
}

// 启动清理定时器
startCleanup()

/** 检查频率限制 */
function checkRateLimit(channel: string, webContentsId: number): void {
  const key = `${channel}:${webContentsId}`
  const now = Date.now()
  const entry = rateLimits.get(key)

  if (!entry || entry.resetAt < now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return
  }

  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    throw new IpcError(`Rate limit exceeded for ${channel}`, ErrorCode.IPC_RATE_LIMITED)
  }
}

/**
 * 类型安全的 IPC handler 注册包装
 *
 * - 自动捕获异常并转换为 IpcError
 * - 自动频率限制
 */
export type TypedHandle = <K extends string>(
  channel: K,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
) => void

export function createTypedHandle(
  ipcMain: Electron.IpcMain,
): TypedHandle {
  return (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        checkRateLimit(channel, event.sender.id)
        return await handler(event, ...args)
      } catch (err) {
        if (err instanceof IpcError) throw err
        throw new IpcError(
          err instanceof Error ? err.message : String(err),
          ErrorCode.IPC_HANDLER_ERROR,
        )
      }
    })
  }
}
