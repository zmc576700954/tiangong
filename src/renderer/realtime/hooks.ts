/**
 * D10b: 协作 awareness 的 React hooks
 *
 * - useAwarenessConnection(): 在 App 挂载时建连、卸载时断开；通过 IPC 拿 wsUrl
 * - useRemoteAwareness(): useSyncExternalStore 订阅 remote states 数组
 * - useRemoteAwarenessConnection(): 订阅连接状态
 * - useBroadcastLocalCursor(): mousemove → 节流广播（throttle 50ms）
 * - useBroadcastLocalSelection(): 选中变化 → 节流广播（throttle 100ms）
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { RemoteAwarenessState } from '@shared/realtime'
import type { UserIdentity } from '@shared/types'
import {
  connectAwareness,
  disconnectAwareness,
  ensureAwarenessClient,
  getAwarenessClient,
  getRemoteStatesSnapshot,
  setLocalCursor,
  setLocalSelection,
  subscribeToRemoteStates,
} from './awareness-store'

/** 节流 50ms 的游标节流器（per-call 节流） */
function useCursorThrottle(): (cursor: { x: number; y: number } | null) => void {
  const lastSentRef = useRef(0)
  const pendingRef = useRef<{ x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (cursor: { x: number; y: number } | null) => {
    pendingRef.current = cursor
    const flush = () => {
      timerRef.current = null
      lastSentRef.current = Date.now()
      const next = pendingRef.current
      pendingRef.current = null
      setLocalCursor(next)
    }
    const elapsed = Date.now() - lastSentRef.current
    if (elapsed >= 50) {
      flush()
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(flush, 50 - elapsed)
    }
  }
}

/** 节流 100ms 的选区节流器 */
function useSelectionThrottle(): (selectedNodeIds: string[]) => void {
  const lastSentRef = useRef(0)
  const pendingRef = useRef<string[] | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (selectedNodeIds: string[]) => {
    pendingRef.current = selectedNodeIds
    const flush = () => {
      timerRef.current = null
      lastSentRef.current = Date.now()
      const next = pendingRef.current
      pendingRef.current = null
      if (next !== null) setLocalSelection(next)
    }
    const elapsed = Date.now() - lastSentRef.current
    if (elapsed >= 100) {
      flush()
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(flush, 100 - elapsed)
    }
  }
}

/**
 * useAwarenessConnection
 *
 * 在组件挂载时建连（前提：IPC 通道已 ready），卸载时断开。
 * identity 由 IPC realtime:getIdentity 提供；wsUrl 由 IPC realtime:getConnectionInfo 提供。
 *
 * 用法：
 * ```tsx
 * useAwarenessConnection() // 自动从 IPC 拉
 * ```
 */
export function useAwarenessConnection(): void {
  const connectedRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [identity, info] = await Promise.all([
          window.electronAPI['realtime:getIdentity'](),
          window.electronAPI['realtime:getConnectionInfo'](),
        ])
        if (cancelled) return
        if (!info.started) {
          // server 没起来（不应该发生，因为 IPC 会自动 ensure）
          return
        }
        ensureAwarenessClient(identity)
        connectAwareness(info.wsUrl)
        connectedRef.current = true
      } catch (err) {
        // 连接失败静默：单用户场景 awareness 是增强能力，不能阻塞主流程
        console.warn('[awareness] connect failed:', err)
      }
    })()

    return () => {
      cancelled = true
      if (connectedRef.current) {
        disconnectAwareness()
        connectedRef.current = false
      }
    }
  }, [])
}

/**
 * useRemoteAwareness —— 订阅远端用户 awareness states 列表
 */
export function useRemoteAwareness(): RemoteAwarenessState[] {
  return useSyncExternalStore(
    subscribeToRemoteStates,
    getRemoteStatesSnapshot,
    getRemoteStatesSnapshot,
  )
}

/** useRemoteAwarenessConnection —— 订阅连接状态变化（true/false） */
export function useRemoteAwarenessConnection(): boolean {
  // 我们让 hooks 不为引用状态额外建模（useSyncExternalStore 可直接监听 connection）
  // 这里直接借 awarenessClient.onConnectionChange
  const getServerSnapshot = (): boolean => false

  return useSyncExternalStore(
    (cb) => {
      const client = getAwarenessClient()
      if (!client) {
        // 没 client：永远不触发；return noop
        return () => {}
      }
      const unsub = client.onConnectionChange(() => cb())
      return unsub
    },
    () => getAwarenessClient()?.getConnected() ?? false,
    getServerSnapshot,
  )
}

/**
 * useBroadcastLocalCursor —— 把本地鼠标位置广播到 awareness
 *
 * @param getCursor 返回当前 cursor（flow 坐标），或 null 表示离开
 */
export function useBroadcastLocalCursor(
  getCursor: () => { x: number; y: number } | null,
): void {
  const throttled = useCursorThrottle()
  const lastSentRef = useRef<{ x: number; y: number } | null | undefined>(undefined)

  useEffect(() => {
    // 周期性轮询 getCursor：避免在 mousemove 事件里调 React（性能差）
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const cursor = getCursor()
      // 仅在 cursor 真正变化时调用节流器（节流器内部会再次 dedup）
      if (!shallowEqualCursor(cursor, lastSentRef.current)) {
        lastSentRef.current = cursor
        throttled(cursor)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getCursor, throttled])
}

function shallowEqualCursor(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // 用 0.5 像素容差，避免不必要的浮点抖动
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
}

/**
 * useBroadcastLocalSelection —— 把本地选中节点列表广播到 awareness
 *
 * @param selectedNodeIdsGetter 返回当前选中节点 id 列表的 getter
 */
export function useBroadcastLocalSelection(
  selectedNodeIdsGetter: () => string[],
): void {
  const throttled = useSelectionThrottle()
  const lastSentRef = useRef<string[] | null>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const ids = selectedNodeIdsGetter()
      if (!shallowEqualStringArray(ids, lastSentRef.current)) {
        lastSentRef.current = ids
        throttled(ids)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [selectedNodeIdsGetter, throttled])
}

function shallowEqualStringArray(a: string[], b: string[] | null): boolean {
  if (a === b) return true
  if (!b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** 暴露原始 identity 更新通道（用户在设置中改身份时调用） */
export function useIdentityUpdater(): (identity: UserIdentity) => void {
  return (identity: UserIdentity) => {
    void import('./awareness-store').then(({ setLocalIdentity, ensureAwarenessClient }) => {
      ensureAwarenessClient(identity)
      setLocalIdentity(identity)
    })
  }
}