/**
 * D10b: AwarenessClient 单元测试（mock 浏览器 WebSocket）
 *
 * 不依赖真实服务器或 socket.io；用轻量 mock WS 验证：
 * - 连接生命周期（open → message → close）
 * - throttle 不爆炸（多次调用合并到最少发送次数）
 * - 远端 state 校验（invalid 状态被丢弃）
 * - 断开 → REMOVE 事件回流
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { AwarenessClient } from '../awareness-client'
import {
  AWARENESS_MSG_QUERY_AWARENESS,
  AWARENESS_MSG_REMOVE,
  AWARENESS_MSG_UPDATE,
  type AwarenessMessage,
  type RemoteAwarenessState,
} from '@shared/realtime'
import type { UserIdentity } from '@shared/types'

/* ─────── Mock WebSocket ─────── */
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  readyState = 0
  url: string
  sent: string[] = []
  listeners: Record<string, Array<(ev: unknown) => void>> = {}

  constructor(url: string) {
    this.url = url
    queueMicrotask(() => this.fireOpen())
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.fire('close')
  }

  addEventListener(event: string, fn: (ev: unknown) => void): void {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(fn)
  }

  fire(event: string): void {
    for (const fn of this.listeners[event] ?? []) fn({})
  }

  fireOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.fire('open')
  }

  /** 测试工具：模拟服务器发消息给客户端 */
  receiveMessage(msg: AwarenessMessage): void {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(msg) })
  }

  receiveRaw(text: string): void {
    for (const fn of this.listeners.message ?? []) fn({ data: text })
  }
}

let lastMockSocket: MockWebSocket | null = null

/* 用 vi.stubGlobal 注入全局 WebSocket —— 在 Node 22+ 上原生 WebSocket 存在，必须 stub */
vi.stubGlobal('WebSocket', function (url: string) {
  const m = new MockWebSocket(url)
  lastMockSocket = m
  return m as unknown as WebSocket
}) as unknown as typeof WebSocket

// 给 factory 加上静态属性
Object.assign(
  (globalThis as unknown as { WebSocket: unknown }).WebSocket as object,
  { OPEN: 1, CLOSED: 3, CONNECTING: 0 },
)

/* ─────── 夹具 ─────── */
const identity: UserIdentity = {
  userId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  userName: 'Test User',
  colorIndex: 2,
}

const sampleState = (over: Partial<RemoteAwarenessState> = {}): RemoteAwarenessState => ({
  user: {
    userId: 'other-user',
    userName: 'Other',
    colorIndex: 1,
  },
  cursor: { x: 100, y: 200 },
  selectedNodeIds: ['node-a'],
  lastUpdated: 0,
  ...over,
})

/** 等异步 microtask flush + macrotask */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 5))
}

/* ─────── 测试 ─────── */
describe('AwarenessClient', () => {
  const clients: AwarenessClient[] = []

  afterEach(() => {
    for (const c of clients) {
      c.disconnect()
    }
    clients.length = 0
    lastMockSocket = null
  })

  it('starts in disconnected state', () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    expect(client.getConnected()).toBe(false)
    expect(client.getClientId()).toBeNull()
    expect(client.getRemoteStates()).toEqual([])
  })

  it('connects to wsUrl and sends QUERY on open', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    expect(client.getConnected()).toBe(true)
    expect(lastMockSocket).toBeTruthy()
    const sentMsgs = lastMockSocket!.sent.map((s) => JSON.parse(s) as AwarenessMessage)
    expect(sentMsgs.some((m) => m.type === AWARENESS_MSG_QUERY_AWARENESS)).toBe(true)
  })

  it('keeps local state in identity', () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    const state = client.getLocalState()
    expect(state.user.userId).toBe(identity.userId)
    expect(state.user.colorIndex).toBe(identity.colorIndex)
  })

  it('updates identity immediately (no throttle)', () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    const newIdentity: UserIdentity = { ...identity, userName: 'New Name' }
    client.setLocalIdentity(newIdentity)
    expect(client.getLocalState().user.userName).toBe('New Name')
  })

  it('throttle coalesces burst cursor updates', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const before = lastMockSocket!.sent.length
    // 100 次连续调用
    for (let i = 0; i < 100; i++) {
      client.setLocalCursor({ x: i, y: i * 2 })
    }
    const after = lastMockSocket!.sent.length
    // 节流严格：远小于 100 次
    expect(after - before).toBeLessThan(5)
  })

  it('drops invalid remote state (missing cursor.y)', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.receiveMessage({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'remote-1',
      state: {
        user: { userId: 'remote', userName: 'R', colorIndex: 0 },
        cursor: { x: 1 } as unknown as { x: number; y: number },
        selectedNodeIds: [],
        lastUpdated: 0,
      },
    })
    expect(client.getRemoteStates()).toEqual([])
  })

  it('drops remote state with non-array selectedNodeIds', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.receiveMessage({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'remote-1',
      state: {
        user: { userId: 'remote', userName: 'R', colorIndex: 0 },
        cursor: null,
        selectedNodeIds: 'not-array' as unknown as string[],
        lastUpdated: 0,
      },
    })
    expect(client.getRemoteStates()).toEqual([])
  })

  it('drops remote state with non-string nodeId', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.receiveMessage({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'remote-1',
      state: {
        user: { userId: 'remote', userName: 'R', colorIndex: 0 },
        cursor: null,
        selectedNodeIds: [42] as unknown as string[],
        lastUpdated: 0,
      },
    })
    expect(client.getRemoteStates()).toEqual([])
  })

  it('removes remote state on REMOVE message', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.receiveMessage({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'remote-1',
      state: sampleState({ user: { userId: 'remote', userName: 'R', colorIndex: 0 } }),
    })
    expect(client.getRemoteStates().length).toBe(1)
    sock.receiveMessage({
      type: AWARENESS_MSG_REMOVE,
      clientId: 'remote-1',
    })
    expect(client.getRemoteStates().length).toBe(0)
  })

  it('subscribe fires when remote state arrives', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    const received: number[] = []
    client.subscribe(() => {
      received.push(client.getRemoteStates().length)
    })
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.receiveMessage({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'remote-1',
      state: sampleState({ user: { userId: 'remote', userName: 'R', colorIndex: 0 } }),
    })
    await tick()
    expect(received.some((n) => n === 1)).toBe(true)
  })

  it('onConnectionChange fires on open + close', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    const events: boolean[] = []
    client.onConnectionChange((c) => events.push(c))
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.close()
    await tick()
    expect(events).toContain(true)
    expect(events).toContain(false)
  })

  it('disconnect stops reconnection attempts', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    sock.close()
    client.disconnect()
    await new Promise((r) => setTimeout(r, 50))
    expect(lastMockSocket).toBe(sock)
  })

  it('does not throw on invalid JSON message', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    const sock = lastMockSocket!
    expect(() => sock.receiveRaw('not-json')).not.toThrow()
    expect(() => sock.receiveRaw('{"type":99}')).not.toThrow()
  })

  it('flush clears pending throttle timers', async () => {
    const client = new AwarenessClient({ identity })
    clients.push(client)
    client.connect('ws://localhost:1235')
    await tick()
    client.setLocalCursor({ x: 5, y: 6 })
    client.flush()
    expect(client.getConnected()).toBe(true)
  })
})