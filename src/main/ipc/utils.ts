/**
 * IPC Utilities — 类型安全的 IPC 注册、频率限制、路径安全校验
 */

import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { isPathWithinSync } from '../shared/path-utils'
import { IpcError, ErrorCode } from '../errors'
import { ipcContext } from './context'
import type { IpcMiddlewarePipeline } from './middleware'

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

/** 停止定期清理定时器（应用退出时调用，防止定时器泄漏） */
export function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
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
 *
 * 支持泛型参数指定：typedHandle<[string, number]>('channel', async (event, name, count) => ...)
 * 默认 Args 为 any[] 以兼容现有代码，新代码建议使用具体类型
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TypedHandle = <Args extends any[] = any[]>(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Promise<any>,
) => void

/**
 * 拒绝系统关键目录（Windows/Linux 通用）
 * 返回 true 表示路径在被阻止的系统目录下
 */
export function isBlockedSystemPath(normalizedPath: string): boolean {
  const blockedPrefixes = process.platform === 'win32'
    ? [
        path.resolve(process.env.SystemRoot || 'C:\\Windows'),
        path.resolve('C:\\Program Files'),
        path.resolve('C:\\Program Files (x86)'),
      ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
        '/opt', '/sys', '/proc', '/dev',
      ]

  for (const blocked of blockedPrefixes) {
    if (isPathWithinSync(path.resolve(blocked), normalizedPath)) {
      return true
    }
  }
  return false
}

/**
 * 校验项目路径安全性：拒绝路径遍历和系统关键目录
 *
 * 用于所有接受 projectPath 的 IPC 处理器，防止渲染进程
 * 通过 IPC 读取/写入系统关键目录。
 */
export function validateProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath)

  if (isBlockedSystemPath(resolved)) {
    throw new IpcError(`Access denied: cannot access system directory`, ErrorCode.IPC_ACCESS_DENIED)
  }

  // 确保路径不是 root 或 home 目录本身（只允许子目录）
  if (process.platform !== 'win32') {
    if (resolved === '/' || resolved === '/root' || resolved === process.env.HOME) {
      throw new IpcError('Access denied: cannot access root or home directory, please select a project subdirectory', ErrorCode.IPC_ACCESS_DENIED)
    }
  }

  return resolved
}

/**
 * 校验文件路径是否在项目目录内，防止路径遍历
 *
 * 用于校验从渲染进程传入的相对路径（如 relatedFiles），
 * 确保解析后的绝对路径不会逃逸出项目目录。
 */
export function isPathWithinProject(filePath: string, projectPath: string): boolean {
  const resolvedFile = path.resolve(projectPath, filePath)
  return isPathWithinSync(projectPath, resolvedFile)
}

/** 最大 ID 长度，用于 ensureString 的默认 maxLen */
export const MAX_ID_LEN = 64

/**
 * 共享的 IPC 参数校验：确保值是合法字符串
 * 抛出 IpcError(ErrorCode.IPC_INVALID_ARGUMENT)，而非裸 Error
 */
export function ensureString(label: string, val: unknown, maxLen = MAX_ID_LEN): string {
  if (typeof val !== 'string') throw new IpcError(`${label} must be a string`, ErrorCode.IPC_INVALID_ARGUMENT)
  if (val.length === 0) throw new IpcError(`${label} must not be empty`, ErrorCode.IPC_INVALID_ARGUMENT)
  if (val.length > maxLen) throw new IpcError(`${label} exceeds max length ${maxLen}`, ErrorCode.IPC_INVALID_ARGUMENT)
  return val
}

/**
 * 共享的 IPC 参数校验：确保值是 number 或 undefined/null
 * 抛出 IpcError(ErrorCode.IPC_INVALID_ARGUMENT)，而非裸 Error
 */
export function ensureOptionalNumber(label: string, val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined
  if (typeof val !== 'number') throw new IpcError(`${label} must be a number`, ErrorCode.IPC_INVALID_ARGUMENT)
  return val
}

export function createTypedHandle(
  ipcMain: Electron.IpcMain,
  pipeline?: IpcMiddlewarePipeline,
): TypedHandle {
  return (
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: any[]) => {
      try {
        checkRateLimit(channel, event.sender.id)
        if (pipeline) {
          return await pipeline.execute(
            { channel, event, args, startTime: Date.now() },
            async () => ipcContext.run({ senderId: event.sender.id }, () => handler(event, ...args)),
          )
        }
        return await ipcContext.run({ senderId: event.sender.id }, () =>
          handler(event, ...args),
        )
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
