/**
 * D10b: Realtime IPC handlers
 *
 * 暴露给渲染进程的 IPC 通道：
 * - 'realtime:getIdentity'  → 当前用户身份（首次启动自动分配）
 * - 'realtime:setIdentity'  → 更新用户身份（用户改名 / 换色）
 * - 'realtime:getConnectionInfo' → WebSocket URL + 端口（renderer 用以建立连接）
 *
 * 设计原则：
 * - IPC 端不持有 socket：renderer 通过 contextBridge 拿到 wsUrl 后自己连
 * - settings IPC 直连 settings.ts（加密路径相同）
 */

import type { TypedHandle } from './utils'
import { IpcError, ErrorCode } from '../errors'
import { readSettings, writeSettings } from '../settings'
import {
  generateDefaultIdentity,
  isValidUserIdentity,
  AWARENESS_COLOR_PALETTE,
} from '../realtime/user-identity'
import {
  ensureAwarenessServer,
  getRealtimeConnectionInfo,
} from '../realtime'
import type { UserIdentity } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('RealtimeIPC')

/**
 * 读取或生成用户身份。
 * - settings.json 已有合法 userIdentity → 直接返回
 * - 没有或非法 → 生成默认身份并持久化
 *
 * 始终保证 ctx 输入渲染进程的身份是合法的（userId / userName / colorIndex 三字段齐全）。
 */
async function loadOrCreateIdentity(): Promise<UserIdentity> {
  const settings = await readSettings()
  if (isValidUserIdentity(settings.userIdentity)) {
    return settings.userIdentity
  }
  const identity = generateDefaultIdentity()
  settings.userIdentity = identity
  await writeSettings(settings)
  logger.info(`Generated new user identity: ${identity.userId} (colorIndex=${identity.colorIndex})`)
  return identity
}

export function registerRealtimeHandlers(typedHandle: TypedHandle): void {
  typedHandle('realtime:getIdentity', async () => {
    return loadOrCreateIdentity()
  })

  typedHandle('realtime:setIdentity', async (_, patch) => {
    if (!patch || typeof patch !== 'object') {
      throw new IpcError('patch must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const p = patch as Record<string, unknown>

    const current = await loadOrCreateIdentity()
    const next: UserIdentity = { ...current }

    if (p.userName !== undefined) {
      if (typeof p.userName !== 'string') {
        throw new IpcError('userName must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      const trimmed = p.userName.trim()
      if (trimmed.length === 0 || trimmed.length > 64) {
        throw new IpcError('userName must be 1-64 chars', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      next.userName = trimmed
    }

    if (p.colorIndex !== undefined) {
      if (typeof p.colorIndex !== 'number' || !Number.isInteger(p.colorIndex) || p.colorIndex < 0) {
        throw new IpcError('colorIndex must be a non-negative integer', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      if (p.colorIndex >= AWARENESS_COLOR_PALETTE.length) {
        throw new IpcError(
          `colorIndex out of range (max ${AWARENESS_COLOR_PALETTE.length - 1})`,
          ErrorCode.IPC_INVALID_ARGUMENT,
        )
      }
      next.colorIndex = p.colorIndex
    }

    // userId 不允许修改（持久化的全局唯一身份）
    if (p.userId !== undefined && p.userId !== current.userId) {
      throw new IpcError('userId is read-only', ErrorCode.IPC_INVALID_ARGUMENT)
    }

    const settings = await readSettings()
    settings.userIdentity = next
    await writeSettings(settings)
    return next
  })

  typedHandle('realtime:getConnectionInfo', async () => {
    // 懒启动：第一次拉连接信息时确保 server 已起来
    await ensureAwarenessServer()
    return getRealtimeConnectionInfo()
  })
}