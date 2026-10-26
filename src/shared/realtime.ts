/**
 * D10b: Realtime 共享类型 / 调色板常量 — 渲染进程可见
 *
 * 设计要点：
 * - 这里只放「主进程 + 渲染进程共享」的类型和纯函数
 * - 不放 Node-only 的逻辑（如 randomUUID、process.env）—— 那些归 src/main/realtime/
 * - 主进程对应：`src/main/realtime/types.ts` 和 `src/main/realtime/user-identity.ts`
 *   会 re-export 此处定义，保持 main 端用法不变
 *
 * 设计边界（CLAUDE.md Boundaries §「不污染可复用 KV-cache prefix」）：
 * Awareness 通道只用于实时协作展示，不进入 Y.Doc → SQLite 持久化链。
 */

import type { UserIdentity } from './types'

/** Awareness 消息类型（主进程与渲染进程协议） */
export const AWARENESS_MSG_QUERY_AWARENESS = 0
export const AWARENESS_MSG_UPDATE = 1
export const AWARENESS_MSG_REMOVE = 2

/**
 * 单个客户端的 awareness 状态。
 *
 * - `user` 来自 settings.userIdentity（持久化在 userData/settings.json）。
 * - `cursor` 来自渲染进程鼠标位置（节流 50ms）。
 * - `selectedNodeIds` 来自 graphStore.selectedNodeIds（节流 100ms）。
 */
export interface RemoteAwarenessState {
  /** 持久化用户身份 */
  user: UserIdentity
  /** 当前鼠标在画布世界坐标中的位置；null 表示鼠标不在画布 */
  cursor: { x: number; y: number } | null
  /** 当前选中的 node id 列表；空数组表示无选中 */
  selectedNodeIds: string[]
  /** 该状态最后更新时间戳（毫秒） */
  lastUpdated: number
}

/**
 * 主进程 / 渲染进程 Awareness 协议消息格式（基于 JSON 编码）。
 *
 * 选择 JSON 而非 y-protocols 二进制格式的原因：
 * 1. Awareness 通道不进入持久化 — 性能不敏感
 * 2. JSON 易于调试（两个浏览器窗口手动 wst 对比）
 * 3. 与 Y.Doc sync 协议隔离：D10a 用 y-protocols/sync 二进制，D10b 用 JSON
 */
export type AwarenessMessage =
  | { type: typeof AWARENESS_MSG_QUERY_AWARENESS; clientId: string }
  | {
    type: typeof AWARENESS_MSG_UPDATE
    clientId: string
    state: RemoteAwarenessState
  }
  | {
    type: typeof AWARENESS_MSG_REMOVE
    clientId: string
  }

/** Realtime server 公开给渲染进程的连接信息 */
export interface RealtimeConnectionInfo {
  /** WebSocket URL（含协议/host/port） */
  wsUrl: string
  /** 当前服务监听的端口 */
  port: number
  /** 是否已启动 */
  started: boolean
}

/** Awareness 状态变更订阅回调 */
export type AwarenessChangeListener = (
  clientId: string,
  state: RemoteAwarenessState | null,
) => void

/* ─────────────────── 调色板常量（纯函数） ─────────────────── */

/** 协作 awareness 调色板 — 6 色循环 */
export const AWARENESS_COLOR_PALETTE: readonly string[] = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#3b82f6', // blue-500
  '#a855f7', // purple-500
] as const

/** 根据 colorIndex 解析为 CSS hex（环形越界保护） */
export function resolveAwarenessColor(colorIndex: number): string {
  if (!Number.isFinite(colorIndex) || colorIndex < 0) {
    return AWARENESS_COLOR_PALETTE[0]!
  }
  const idx = Math.floor(colorIndex) % AWARENESS_COLOR_PALETTE.length
  return AWARENESS_COLOR_PALETTE[idx]!
}