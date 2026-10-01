/**
 * D10b: 协作 awareness 的 Renderer-side singleton 管理
 *
 * 提供：
 * - getAwarenessClient(): 当前 renderer 的单例（懒创建）
 * - connectAwareness(identity, wsUrl): 建立连接
 * - subscribeToRemoteStates(listener): 订阅 remote awareness
 * - setLocalCursor / setLocalSelection: 写入本地状态
 * - setLocalIdentity: 同步新身份
 * - disconnectAwareness: 主动断开
 *
 * 与 useSyncExternalStore 兼容：listener 签名 () => void，每次数组变化都触发；
 * 渲染组件用 useSyncExternalStore(subscribe, getSnapshot) 订阅。
 */

import type { AwarenessClient } from './awareness-client'
import { AwarenessClient as AwarenessClientImpl } from './awareness-client'
import type { RemoteAwarenessState } from '@shared/realtime'
import type { UserIdentity } from '@shared/types'

/** 单例实例（仅一个 BrowserWindow 一个；多窗口由 Electron 多进程保证隔离） */
let _client: AwarenessClient | null = null

/** 渲染层订阅者：状态变化时触发（用于 useSyncExternalStore） */
const _stateSubscribers = new Set<() => void>()

/** 当前 snapshot 缓存（避免每次重新 array 分配导致 React 无限渲染） */
let _cachedRemoteStates: RemoteAwarenessState[] = []

function _emitStateChange(): void {
  // 刷新 snapshot 缓存：让 React 看到新引用
  _cachedRemoteStates = _client ? _client.getRemoteStates() : []
  for (const fn of _stateSubscribers) {
    try {
      fn()
    } catch {
      // 监听器抛错不传播
    }
  }
}

export function getAwarenessClient(): AwarenessClient | null {
  return _client
}

/**
 * 创建或复用 AwarenessClient。
 * - 已有但 identity 不同 → 重建
 * - 已有且 identity 相同 → 复用
 * - 不存在 → 新建
 *
 * @returns 是否真的新建了 client
 */
export function ensureAwarenessClient(identity: UserIdentity): AwarenessClient {
  if (_client) {
    const current = _client.getLocalState()
    if (current.user.userId === identity.userId) {
      return _client
    }
    // identity 变更（userId 改了）：必须重建（本地状态绑定旧 userId 的 server clientId）
    disconnectAwareness()
  }
  _client = new AwarenessClientImpl({ identity })
  _client.subscribe(() => _emitStateChange())
  _cachedRemoteStates = []
  return _client
}

/**
 * 建立 awareness WebSocket 连接。
 * 必须在 ensureAwarenessClient 之后调用（identity 已知）。
 */
export function connectAwareness(wsUrl: string): void {
  if (!_client) {
    throw new Error('connectAwareness called before ensureAwarenessClient')
  }
  _client.connect(wsUrl)
}

/** 订阅 remote states 变化（useSyncExternalStore 用） */
export function subscribeToRemoteStates(listener: () => void): () => void {
  _stateSubscribers.add(listener)
  return () => {
    _stateSubscribers.delete(listener)
  }
}

/** 获取当前 remote states 快照 */
export function getRemoteStatesSnapshot(): RemoteAwarenessState[] {
  return _cachedRemoteStates
}

/** 写入本地 cursor（节流由 client 内部处理） */
export function setLocalCursor(cursor: { x: number; y: number } | null): void {
  _client?.setLocalCursor(cursor)
}

/** 写入本地选中节点列表（节流由 client 内部处理） */
export function setLocalSelection(selectedNodeIds: string[]): void {
  _client?.setLocalSelection(selectedNodeIds)
}

/** 同步本地 identity（用户在设置中改名/换色后调用） */
export function setLocalIdentity(identity: UserIdentity): void {
  _client?.setLocalIdentity(identity)
}

/** 主动断开（关闭画布、卸载组件、退出时调用） */
export function disconnectAwareness(): void {
  if (!_client) return
  _client.disconnect()
  _client = null
  _cachedRemoteStates = []
  for (const fn of _stateSubscribers) {
    try {
      fn()
    } catch {
      // ignore
    }
  }
}