/**
 * D10b: AwarenessServer 单元测试
 *
 * 使用真实 ws 库连接到 AwarenessServer 的 WebSocket。
 * 关键点：每个测试独立启停 server，使用随机空闲端口避免冲突。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import { AwarenessServer } from '../../realtime/awareness-server'
import {
  AWARENESS_MSG_QUERY_AWARENESS,
  AWARENESS_MSG_REMOVE,
  AWARENESS_MSG_UPDATE,
  type AwarenessMessage,
  type RemoteAwarenessState,
} from '../../realtime/types'

/** 等异步 — 带超时 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<void> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

function makeServer(): AwarenessServer {
  return new AwarenessServer({ port: 0, host: '127.0.0.1' })
}

async function startServer(): Promise<{ server: AwarenessServer; port: number }> {
  const server = makeServer()
  await server.start()
  return { server, port: server.getBoundPort() }
}

async function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 1000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** 收集器 — 累积接收到的 AwarenessMessage */
function makeCollector(socket: WebSocket): {
  messages: AwarenessMessage[]
  wait: (predicate: (m: AwarenessMessage) => boolean, timeoutMs?: number) => Promise<AwarenessMessage>
  close: () => void
} {
  const messages: AwarenessMessage[] = []
  socket.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()) as AwarenessMessage)
    } catch {
      // ignore
    }
  })
  return {
    messages,
    wait: async (predicate, timeoutMs = 1000) => {
      await waitFor(() => messages.some(predicate), timeoutMs)
      return messages.find(predicate)!
    },
    close: () => socket.close(),
  }
}

const baseState = (userId: string): RemoteAwarenessState => ({
  user: { userId, userName: `User-${userId}`, colorIndex: 0 },
  cursor: { x: 100, y: 200 },
  selectedNodeIds: ['node-1'],
  lastUpdated: 0,
})

/* ─────── 测试 ─────── */
describe('AwarenessServer — 启动与连接', () => {
  let server: AwarenessServer

  afterEach(async () => {
    if (server && server.isStarted()) {
      try {
        await server.stop()
      } catch {
        // ignore
      }
    }
  })

  it('start() 后 isStarted = true 且 getBoundPort > 0', async () => {
    server = makeServer()
    await server.start()
    expect(server.isStarted()).toBe(true)
    expect(server.getBoundPort()).toBeGreaterThan(0)
    expect(server.getClientIds()).toEqual([])
    expect(server.size()).toBe(0)
  })

  it('start() 是幂等的', async () => {
    server = makeServer()
    await server.start()
    const port = server.getBoundPort()
    await server.start() // 第二次调用应 no-op
    expect(server.getBoundPort()).toBe(port)
  })

  it('客户端连接后 getClientIds 包含它', async () => {
    const { server: s, port } = await startServer()
    server = s
    const socket = await connectClient(port)
    await waitFor(() => server.getClientIds().length === 1, 500)
    expect(server.getClientIds().length).toBe(1)
    socket.close()
  })

  it('客户端断开后 getClientIds 清空', async () => {
    const { server: s, port } = await startServer()
    server = s
    const socket = await connectClient(port)
    await waitFor(() => server.getClientIds().length === 1)
    socket.close()
    await waitFor(() => server.getClientIds().length === 0, 1000)
    expect(server.getClientIds().length).toBe(0)
  })
})

describe('AwarenessServer — 消息校验', () => {
  let server: AwarenessServer
  let port: number

  beforeEach(async () => {
    const s = await startServer()
    server = s.server
    port = s.port
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // ignore
    }
  })

  it('伪造 clientId → 服务器关闭连接', async () => {
    const socket = await connectClient(port)
    // 不通过正常 QUERY 流程，直接发 UPDATE 用伪造 clientId
    socket.send(JSON.stringify({
      type: AWARENESS_MSG_UPDATE,
      clientId: '00000000-0000-0000-0000-000000000000',
      state: baseState('attacker'),
    }))
    await waitFor(() => socket.readyState === WebSocket.CLOSED, 500)
  })

  it('state 缺字段 → 服务器忽略（不广播）', async () => {
    const socket = await connectClient(port)
    const c = makeCollector(socket)
    // cursor 缺 y
    socket.send(JSON.stringify({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'self',
      state: {
        user: { userId: 'u', userName: 'U', colorIndex: 0 },
        cursor: { x: 100 },
        selectedNodeIds: [],
        lastUpdated: 0,
      },
    }))
    await new Promise((r) => setTimeout(r, 50))
    expect(c.messages.filter((m) => m.type === AWARENESS_MSG_UPDATE)).toHaveLength(0)
    socket.close()
  })

  it('state.selectedNodeIds 不是数组 → 服务器忽略', async () => {
    const socket = await connectClient(port)
    const c = makeCollector(socket)
    socket.send(JSON.stringify({
      type: AWARENESS_MSG_UPDATE,
      clientId: 'self',
      state: {
        user: { userId: 'u', userName: 'U', colorIndex: 0 },
        cursor: null,
        selectedNodeIds: 'not-array' as unknown as [],
        lastUpdated: 0,
      },
    }))
    await new Promise((r) => setTimeout(r, 50))
    expect(c.messages.filter((m) => m.type === AWARENESS_MSG_UPDATE)).toHaveLength(0)
    socket.close()
  })

  it('非 JSON 消息 → 不崩', async () => {
    const socket = await connectClient(port)
    socket.send('this is not json {{{')
    socket.send('{"type":-99}')
    await new Promise((r) => setTimeout(r, 50))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it('QUERY_AWARENESS 在没有其它 client 时不返回任何 UPDATE', async () => {
    const socket = await connectClient(port)
    const c = makeCollector(socket)
    socket.send(JSON.stringify({ type: AWARENESS_MSG_QUERY_AWARENESS, clientId: 'self' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(c.messages).toEqual([])
    socket.close()
  })
})

describe('AwarenessServer — 监听器', () => {
  let server: AwarenessServer
  let port: number

  beforeEach(async () => {
    const s = await startServer()
    server = s.server
    port = s.port
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // ignore
    }
  })

  it('addListener 在客户端断开时收到 null state', async () => {
    const changes: Array<{ clientId: string; hasState: boolean }> = []
    server.addListener((clientId, state) => {
      changes.push({ clientId, hasState: state !== null })
    })

    const socket = await connectClient(port)
    await waitFor(() => server.getClientIds().length === 1)
    socket.close()
    await waitFor(() => changes.some((c) => !c.hasState), 500)
    expect(changes.some((c) => !c.hasState)).toBe(true)
  })

  it('removeListener 取消订阅', async () => {
    let callCount = 0
    const listener = (): void => {
      callCount++
    }
    server.addListener(listener)
    server.removeListener(listener)
    const socket = await connectClient(port)
    await waitFor(() => server.getClientIds().length === 1)
    socket.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(callCount).toBe(0)
  })
})

describe('AwarenessServer — REMOVE 广播', () => {
  it('客户端断开时其它客户端收到 REMOVE 消息', async () => {
    const { server, port } = await startServer()
    try {
      const socketA = await connectClient(port)
      const socketB = await connectClient(port)
      await waitFor(() => server.getClientIds().length === 2)

      const removePromise = new Promise<{ clientId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('REMOVE timeout')), 1000)
        socketB.on('message', (raw: Buffer) => {
          try {
            const msg = JSON.parse(raw.toString()) as AwarenessMessage
            if (msg.type === AWARENESS_MSG_REMOVE) {
              clearTimeout(timer)
              resolve(msg as { clientId: string })
            }
          } catch {
            // ignore
          }
        })
      })

      socketA.close()
      const msg = await removePromise
      expect(typeof msg.clientId).toBe('string')
      expect(msg.clientId.length).toBeGreaterThan(0)
      socketB.close()
    } finally {
      try {
        await server.stop()
      } catch {
        // ignore
      }
    }
  })
})

// Suppress console.warn during tests
const _warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
void _warn