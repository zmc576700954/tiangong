/**
 * A2A — 集成测试（loopback）
 *
 * Phase D9 C6. 把 A2AServer（mock session）作为远端，
 * A2AClient 直接调用它。覆盖：
 *   - 完整 stream roundtrip（artifact → status=completed）
 *   - bearer 注入（服务端拒绝错 token）
 *   - 并发流（两个 client 同 session 各自结束）
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import { A2AClient } from '../client'
import { A2AServer } from '../server'
import { A2ATaskStore } from '../task-store'
import type { A2AServerConfig, A2AAgentCard } from '@shared/types/a2a'
import type { Logger } from '../server'
import type { MessageSendSessionStarter } from '../routes/message-send'
import type { MessageStreamSessionStarter } from '../routes/message-stream'
import type { AgentOutput } from '@shared/types/agent'

const logger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}

const sampleCard: A2AAgentCard = {
  a2aVersion: '0.3.0', name: 'integration-target', description: 'it',
  url: 'http://127.0.0.1:0',
  capabilities: ['streaming'], defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [],
}

const apiKey = 'integration-bearer-key-1234567890'

const baseServerConfig: A2AServerConfig = {
  enabled: true, port: 0, bindAddress: '127.0.0.1', apiKey, agentCard: sampleCard,
}

interface RemoteHandle {
  port: number
  server: A2AServer
  taskStore: A2ATaskStore
  emit: (output: AgentOutput) => void
  receiveCommand: (cb: (text: string) => void) => void
  terminateCount: () => number
}

/**
 * 启动 A2AServer 作为远端 fixture。sendCommand 自动 emit 一组 outputs。
 * 由于 A2AServer 已经通过 server.test.ts 验证过 listen() 竞态问题，
 * 这里直接复用其 `boundPort()` 接口，不再裸 http.createServer。
 */
async function setupIntegrationRemote(
  outputsForText: (text: string) => AgentOutput[],
): Promise<RemoteHandle> {
  const taskStore = new A2ATaskStore()
  // Per-session listeners map: route outputs only to listeners of the
  // session that issued sendCommand. Without this, concurrent streams
  // cross-contaminate because every client subscribes to 'sess-1'.
  const listenersById = new Map<string, Set<(output: AgentOutput) => void>>()
  const commands: { text: string; cbs: Array<(t: string) => void> }[] = []
  let nextId = 0
  let terminateCount = 0
  const session: MessageStreamSessionStarter = {
    startSession: vi.fn(async () => {
      nextId += 1
      return `sess-${nextId}`
    }),
    sendCommand: vi.fn(async (sessionId: string, text: string) => {
      commands.push({ text, cbs: [] })
      const outs = outputsForText(text)
      const listeners = listenersById.get(sessionId)
      setImmediate(() => {
        if (listeners) {
          for (const out of outs) {
            for (const l of listeners) l(out)
          }
        }
      })
    }),
    subscribeOnSessionOutput: vi.fn((sessionId: string, listener: (output: AgentOutput) => void) => {
      let set = listenersById.get(sessionId)
      if (!set) {
        set = new Set()
        listenersById.set(sessionId, set)
      }
      set.add(listener)
      return () => { set?.delete(listener) }
    }),
    terminateSession: vi.fn(async () => {
      terminateCount += 1
    }),
  }
  const messageSendSession: MessageSendSessionStarter = {
    startSession: session.startSession,
    sendCommand: session.sendCommand,
    runToCompletion: vi.fn(async () => ({ artifacts: [], history: [] })),
    terminateSession: session.terminateSession,
  }
  const server = new A2AServer({
    config: baseServerConfig,
    messageSendSession,
    messageStreamSession: session,
    taskStore,
    logger,
    buildTask: async (taskId) => {
      const rec = taskStore.get(taskId)
      if (!rec) return null
      return {
        id: taskId,
        contextId: rec.contextId,
        status: { state: rec.status },
        artifacts: rec.artifacts,
        history: rec.history,
      }
    },
  })
  await server.start()
  return {
    port: server.boundPort()!,
    server,
    taskStore,
    // emit fires on ALL listeners across sessions (rare; debug helper).
    emit: (output) => {
      for (const set of listenersById.values()) {
        for (const l of set) l(output)
      }
    },
    receiveCommand: (cb) => {
      const last = commands[commands.length - 1]
      if (last) last.cbs.push(cb)
    },
    terminateCount: () => terminateCount,
  }
}

describe('A2A integration — loopback', () => {
  let remote: RemoteHandle | null = null

  afterEach(async () => {
    if (remote) {
      await remote.server.destroy()
      remote.taskStore.destroy()
    }
    remote = null
  })

  it('completes a full stream roundtrip: artifact → status=completed', async () => {
    remote = await setupIntegrationRemote((text) => [
      { type: 'stdout', data: `recv:${text}`, timestamp: Date.now() },
      { type: 'complete', data: '', timestamp: Date.now() },
    ])
    const client = new A2AClient({
      name: 'peer',
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
      devAllowLocalhost: true,
    })
    const r = await client.call({
      role: 'user',
      parts: [{ type: 'text', text: 'integration-hello' }],
    })
    expect(r.resultText).toBe('recv:integration-hello')
    expect(r.finalStatus.state).toBe('completed')
  })

  it('rejects requests with wrong bearer (server-side 401 → client AgentError)', async () => {
    remote = await setupIntegrationRemote(() => [
      { type: 'complete', data: '', timestamp: Date.now() },
    ])
    const client = new A2AClient({
      name: 'peer',
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey: 'wrong-bearer-key-1234567890',
      devAllowLocalhost: true,
    })
    await expect(
      client.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/auth/i)
  })

  it('handles concurrent streams to the same server without interfering', async () => {
    remote = await setupIntegrationRemote((text) => [
      { type: 'stdout', data: `${text}::out`, timestamp: Date.now() },
      { type: 'complete', data: '', timestamp: Date.now() },
    ])
    const client = new A2AClient({
      name: 'peer',
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
      devAllowLocalhost: true,
    })
    const [a, b, c] = await Promise.all([
      client.call({ role: 'user', parts: [{ type: 'text', text: 'a' }] }),
      client.call({ role: 'user', parts: [{ type: 'text', text: 'b' }] }),
      client.call({ role: 'user', parts: [{ type: 'text', text: 'c' }] }),
    ])
    expect(a.resultText).toBe('a::out')
    expect(b.resultText).toBe('b::out')
    expect(c.resultText).toBe('c::out')
    for (const r of [a, b, c]) expect(r.finalStatus.state).toBe('completed')
  })

  it('testConnection roundtrips and returns the remote agent card', async () => {
    remote = await setupIntegrationRemote(() => [])
    const client = new A2AClient({
      name: 'peer',
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
      devAllowLocalhost: true,
    })
    const r = await client.testConnection()
    expect(r.ok).toBe(true)
    expect(r.card?.name).toBe('integration-target')
    expect(r.latencyMs).toBeGreaterThan(0)
  })

  it('non-existent port returns A2A_REMOTE_UNREACHABLE', async () => {
    // 端口 1 是保留端口，无人监听 — 等价于「远端离线」。
    const client = new A2AClient({
      name: 'peer',
      endpoint: 'http://127.0.0.1:1',
      apiKey,
      devAllowLocalhost: true,
    })
    await expect(
      client.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/unreachable/i)
  })

  it('connect to plain http server (not A2A) → non-2xx → A2A_REMOTE_UNREACHABLE', async () => {
    // 启动一个最小的 http server（非 A2A） — 验证 client 错误传播路径。
    const stub = http.createServer((_req, res) => {
      res.writeHead(503).end('not a2a')
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const port = (stub.address() as { port: number }).port
    try {
      const client = new A2AClient({
        name: 'peer',
        endpoint: `http://127.0.0.1:${port}`,
        devAllowLocalhost: true,
      })
      await expect(
        client.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] }),
      ).rejects.toThrow(/unreachable|503/i)
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()))
    }
  })
})