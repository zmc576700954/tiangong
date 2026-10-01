/**
 * D10b: User Identity 工具 — 主进程侧
 *
 * 设计要点：
 * - userId 持久化在 userData/settings.json，重装不变（除非用户主动重置）
 * - 调色板 6 色循环（红/橙/黄/绿/蓝/紫），由 256-bit hash 取 mod
 * - 颜色由 IPC 层根据 colorIndex 解析为 CSS hex，避免主进程硬编码样式
 *
 * 共享常量（AWARENESS_COLOR_PALETTE / resolveAwarenessColor）从 shared/realtime.ts
 * re-export，方便主进程单点引用。
 */

import { randomUUID } from 'node:crypto'
import type { UserIdentity } from '@shared/types'
import { AWARENESS_COLOR_PALETTE } from '@shared/realtime'

// Re-export palette + color resolver from shared layer
export {
  AWARENESS_COLOR_PALETTE,
  resolveAwarenessColor,
} from '@shared/realtime'

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** 校验给定字符串是否为合法的 hex 颜色（D10b 不接受命名色） */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
}

/** 从任意 userId 字符串取稳定的 colorIndex（用于手工迁移旧数据） */
export function deriveColorIndex(seed: string): number {
  if (!seed) return 0
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return hash % AWARENESS_COLOR_PALETTE.length
}

/**
 * 为新安装生成默认身份：
 * - userId：node:crypto.randomUUID()（RFC 4122 v4）
 * - userName：操作系统用户名 + 短哈希后缀，避免本机多用户撞名
 * - colorIndex：基于 userId 的稳定 hash
 */
export function generateDefaultIdentity(): UserIdentity {
  const userId = randomUUID()
  const username = process.env.USERNAME ?? process.env.USER ?? 'BizGraph 用户'
  const short = userId.replace(/-/g, '').slice(0, 4)
  return {
    userId,
    userName: `${username}·${short}`,
    colorIndex: deriveColorIndex(userId),
  }
}

/** 校验给定对象是否符合 UserIdentity 结构（防止 settings.json 注入） */
export function isValidUserIdentity(value: unknown): value is UserIdentity {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.userId === 'string'
    && v.userId.length > 0
    && v.userId.length <= 128
    && typeof v.userName === 'string'
    && v.userName.length > 0
    && v.userName.length <= 64
    && typeof v.colorIndex === 'number'
    && Number.isInteger(v.colorIndex)
    && v.colorIndex >= 0
    && v.colorIndex < 6
  )
}