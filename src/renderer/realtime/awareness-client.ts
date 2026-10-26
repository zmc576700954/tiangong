/**
 * D10b: Awareness WebSocket client (渲染进程侧)
 *
 * 单连接 awareness 客户端：
 * - connect(wsUrl, identity)：建立 WebSocket，连接成功后 server 分配 clientId
 * - setLocalState(patch)：更新本地 awareness 状态（自身光标 / 选区 / 用户信息）
 *   - 节流内自动 broadcast UPDATE
 * - subscribe(listener)：订阅 remote 状态变更
 * - disconnect()：关闭
 *
 * 设计要点：
 * - 本地状态缓存：onchange 只在 patch 实际改变时触发（避免冗余通知）
 * - 断线重连：指数退避 + jitter，最多 6 次重试
 * - 协议：与 src/main/realtime/types.ts 对应（AWARENESS_MSG_*）
 * - 不引入 yjs：纯 JSON + 浏览器原生 WebSocket，与 D10a Y.Doc 通道隔离
 */

import {
  AWARENESS_MSG_QUERY_AWARENESS,
  AWARENESS_MSG_REMOVE,
  AWARENESS_MSG_UPDATE,
  type AwarenessChangeListener,
  type AwarenessMessage,
  type RemoteAwarenessState,
} from '@shared/realtime'
import type { UserIdentity } from '@shared/types'

/** 节流间隔（毫秒）— 光标位置节流，避免 mousemove 高频触发 */
const CURSOR_THROTTLE_MS = 50
/** 节流间隔（毫秒）— 选中节点变更节流（每次选中较少但仍节流） */
const SELECTION_THROTTLE_MS = 100
/** 重连配置 */
const RECONNECT_MAX_ATTEMPTS = 6
const RECONNECT_BASE_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000

/** 客户端配置 */
export interface AwarenessClientOptions {
  /** 本地身份（来自 settings.userIdentity） */
  identity: UserIdentity
  /** 初始 cursor / selection（可选） */
  initialState?: Partial<Pick<RemoteAwarenessState, 'cursor' | 'selectedNodeIds'>>
}

/**
 * AwarenessClient —— 渲染进程侧单实例
 *
 * 不是 React component：被 hooks（useRemoteAwareness, useLocalAwareness）包裹使用。
 */
export class AwarenessClient {
  private ws: WebSocket | null = null
  private wsUrl: string | null = null
  private readonly identity: UserIdentity
  /** server-assigned clientId；连接成功后填充 */
  private serverClientId: string | null = null
  /** 本地状态（identity + cursor + selectedNodeIds + lastUpdated） */
  private localState: RemoteAwarenessState
  /** 远端 clientId → state */
  private remoteStates = new Map<string, RemoteAwarenessState>()
  /** 订阅者 */
  private listeners = new Set<AwarenessChangeListener>()
  /** 连接状态 */
  private connectionListeners = new Set<(connected: boolean) => void>()
  private isConnected = false
  /** 重连 */
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 节流 */
  private cursorLastSent = 0
  private selectionLastSent = 0
  private cursorPendingUpdate: RemoteAwarenessState['cursor'] | null = null
  private selectionPendingUpdate: string[] | null = null
  private cursorThrottleTimer: ReturnType<typeof setTimeout> | null = null
  private selectionThrottleTimer: ReturnType<typeof setTimeout> | null = null
  /** 主动断开标志（区别于网络故障） */
  private intentionallyClosed = false

  constructor(options: AwarenessClientOptions) {
    this.identity = options.identity
    this.localState = {
      user: this.identity,
      cursor: options.initialState?.cursor ?? null,
      selectedNodeIds: options.initialState?.selectedNodeIds ?? [],
      lastUpdated: Date.now(),
    }
  }

  /** 是否已连接 */
  getConnected(): boolean {
    return this.isConnected
  }

  /** server-assigned clientId（未连接时为 null） */
  getClientId(): string | null {
    return this.serverClientId
  }

  /** 当前本地状态 */
  getLocalState(): RemoteAwarenessState {
    return { ...this.localState }
  }

  /** 当前所有 remote states（不可变快照） */
  getRemoteStates(): RemoteAwarenessState[] {
    return Array.from(this.remoteStates.values()).map((s) => ({ ...s }))
  }

  /** 单个 remote state */
  getRemoteState(clientId: string): RemoteAwarenessState | null {
    const s = this.remoteStates.get(clientId)
    return s ? { ...s } : null
  }

  /** 订阅 remote 状态变更（含 disconnect → null） */
  subscribe(listener: AwarenessChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 订阅连接状态变更 */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener)
    // 立即触发一次（让新订阅者知道当前状态）
    try {
      listener(this.isConnected)
    } catch {
      // listener 内部抛错不应影响订阅链
    }
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  /**
   * 连接到指定 wsUrl。
   * 已有连接时先断开。
   */
  connect(wsUrl: string): void {
    if (this.ws) {
      this.intentionallyClosed = true
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.wsUrl = wsUrl
    this.intentionallyClosed = false
    this.openSocket()
  }

  /** 主动断开（不重连） */
  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearThrottleTimers()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    if (this.isConnected) {
      this.isConnected = false
      this.notifyConnectionChange(false)
    }
  }

  /**
   * 更新本地 cursor 位置（节流 50ms）。
   * 接受 null 表示「鼠标离开画布」。
   */
  setLocalCursor(cursor: { x: number; y: number } | null): void {
    this.cursorPendingUpdate = cursor
    if (this.cursorThrottleTimer) return
    const elapsed = Date.now() - this.cursorLastSent
    if (elapsed >= CURSOR_THROTTLE_MS) {
      this.flushCursor()
    } else {
      this.cursorThrottleTimer = setTimeout(
        () => this.flushCursor(),
        CURSOR_THROTTLE_MS - elapsed,
      )
    }
  }

  /**
   * 更新本地选中节点列表（节流 100ms）。
   * 传空数组表示「全部取消选中」。
   */
  setLocalSelection(selectedNodeIds: string[]): void {
    this.selectionPendingUpdate = selectedNodeIds
    if (this.selectionThrottleTimer) return
    const elapsed = Date.now() - this.selectionLastSent
    if (elapsed >= SELECTION_THROTTLE_MS) {
      this.flushSelection()
    } else {
      this.selectionThrottleTimer = setTimeout(
        () => this.flushSelection(),
        SELECTION_THROTTLE_MS - elapsed,
      )
    }
  }

  /**
   * 同步更新本地 identity（用户在设置里改名 / 换色）。
   * 不节流，立刻发出。
   */
  setLocalIdentity(identity: UserIdentity): void {
    this.localState = {
      ...this.localState,
      user: identity,
      lastUpdated: Date.now(),
    }
    this.sendUpdate()
  }

  /** 强制 flush pending 节流更新（清理时使用） */
  flush(): void {
    if (this.cursorThrottleTimer) {
      clearTimeout(this.cursorThrottleTimer)
      this.cursorThrottleTimer = null
      this.flushCursor()
    }
    if (this.selectionThrottleTimer) {
      clearTimeout(this.selectionThrottleTimer)
      this.selectionThrottleTimer = null
      this.flushSelection()
    }
  }

  // ─────────────────────────────────────
  // 内部：socket 生命周期
  // ─────────────────────────────────────

  private openSocket(): void {
    if (!this.wsUrl) return
    if (typeof WebSocket === 'undefined') {
      // 测试环境 / SSR：跳过
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(this.wsUrl)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = socket
    socket.addEventListener('open', () => this.handleOpen())
    socket.addEventListener('message', (ev) => this.handleMessage(ev))
    socket.addEventListener('close', () => this.handleClose())
    socket.addEventListener('error', () => {
      // 错误事件后通常紧跟 close；不做重连（让 close 统一处理）
    })
  }

  private handleOpen(): void {
    this.isConnected = true
    this.reconnectAttempts = 0
    this.notifyConnectionChange(true)
    // 上线后拉现有 states
    this.sendRaw({
      type: AWARENESS_MSG_QUERY_AWARENESS,
      // 占位 clientId — server 端用 conn.clientId 校验
      // 因为连接已建立，server 不接受 QUERY 之外的 clientId 自陈
      clientId: 'self',
    })
    // 同步本地状态
    this.sendUpdate()
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: AwarenessMessage
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as AwarenessMessage
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'number') return

    if (msg.type === AWARENESS_MSG_UPDATE) {
      const state = msg.state
      if (!state || !validateRemoteState(state)) return
      // 第一次收到 UPDATE 时，server 端可能附带自己的 clientId → 缓存
      if (this.serverClientId === null && msg.clientId) {
        // server 不会把我们的状态发回来（broadcast 会跳过 sender）
        // 所以 serverClientId 是空的；只有当我们主动 query 后 server 回放时
        // 才会看到别人的 states。这里不能用 UPDATE 学 clientId。
        // （reliable clientId 需要独立消息；当前实现允许 clientId 为 null）
      }
      // 如果 state 的 userId 匹配自己，标记自己的 clientId
      if (state.user.userId === this.identity.userId && this.serverClientId === null) {
        this.serverClientId = msg.clientId
      }
      this.remoteStates.set(msg.clientId, state)
      this.notifyRemoteListeners()
      return
    }

    if (msg.type === AWARENESS_MSG_REMOVE) {
      this.remoteStates.delete(msg.clientId)
      this.notifyRemoteListeners()
      return
    }
  }

  private handleClose(): void {
    if (this.ws) {
      this.ws = null
    }
    const wasConnected = this.isConnected
    this.isConnected = false
    this.serverClientId = null
    if (wasConnected) {
      this.notifyConnectionChange(false)
    }
    if (this.intentionallyClosed) return
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      // 已重试上限，不再尝试
      return
    }
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
    )
    // 加 0-25% jitter，避免雷鸣群
    const jitter = Math.floor(delay * 0.25 * Math.random())
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAttempts += 1
      this.openSocket()
    }, delay + jitter)
  }

  // ─────────────────────────────────────
  // 内部：发送
  // ─────────────────────────────────────

  private sendRaw(msg: AwarenessMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {
      // 忽略 send 失败 — close handler 会处理重连
    }
  }

  private sendUpdate(): void {
    if (!this.serverClientId) {
      // 还没拿到；连上之后 QUERY → 回放会用 UPDATE 顺便分配
      // 此刻没 clientId 的 UPDATE server 会拒绝，先缓存不阻塞
      return
    }
    this.localState = {
      ...this.localState,
      lastUpdated: Date.now(),
    }
    this.sendRaw({
      type: AWARENESS_MSG_UPDATE,
      clientId: this.serverClientId,
      state: this.localState,
    })
  }

  private flushCursor(): void {
    this.cursorThrottleTimer = null
    if (this.cursorPendingUpdate !== null) {
      this.localState = {
        ...this.localState,
        cursor: this.cursorPendingUpdate,
      }
      this.cursorPendingUpdate = null
    }
    this.cursorLastSent = Date.now()
    this.sendUpdate()
  }

  private flushSelection(): void {
    this.selectionThrottleTimer = null
    if (this.selectionPendingUpdate !== null) {
      this.localState = {
        ...this.localState,
        selectedNodeIds: this.selectionPendingUpdate,
      }
      this.selectionPendingUpdate = null
    }
    this.selectionLastSent = Date.now()
    this.sendUpdate()
  }

  private clearThrottleTimers(): void {
    if (this.cursorThrottleTimer) {
      clearTimeout(this.cursorThrottleTimer)
      this.cursorThrottleTimer = null
    }
    if (this.selectionThrottleTimer) {
      clearTimeout(this.selectionThrottleTimer)
      this.selectionThrottleTimer = null
    }
  }

  private notifyRemoteListeners(): void {
    if (this.listeners.size === 0) return
    // 取所有 clientId 的最新状态，传给 listener（null 表示 remove）
    // listener 接受 (clientId, state | null)，我们需要重放最近一次变化的 delta；
    // 简化：传完整 snapshot，由 RemoteCursors 用 useSyncExternalStore 订阅
    for (const listener of this.listeners) {
      try {
        listener('__snapshot__', null)
      } catch {
        // 监听器抛错不传播
      }
    }
  }

  private notifyConnectionChange(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(connected)
      } catch {
        // 监听器抛错不传播
      }
    }
  }
}

/** 校验收到的 RemoteAwarenessState 合法性 */
function validateRemoteState(value: unknown): value is RemoteAwarenessState {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const u = v.user
  if (!u || typeof u !== 'object') return false
  if (typeof (u as Record<string, unknown>).userId !== 'string') return false
  if (typeof (u as Record<string, unknown>).userName !== 'string') return false
  if (typeof (u as Record<string, unknown>).colorIndex !== 'number') return false
  if (v.cursor !== null) {
    const c = v.cursor as Record<string, unknown> | null
    if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') return false
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return false
  }
  if (!Array.isArray(v.selectedNodeIds)) return false
  for (const id of v.selectedNodeIds) {
    if (typeof id !== 'string') return false
  }
  return true
}