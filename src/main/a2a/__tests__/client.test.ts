/**
 * A2A Client + endpoint-guard — unit tests
 *
 * Phase D9 C5. Uses A2AServer (with mock MessageStream session) as the
 * "remote agent" — same proven pattern as server.test.ts. The previous
 * standalone http.createServer fixture had a Windows/vitest race in which
 * listen() callback fired before the socket was ready, producing
 * ECONNREFUSED on the first client call. A2AServer already exercises
 * that path successfully, so reusing it sidesteps the race.
 *
 * Coverage:
 *   - happy path: artifact stream → resultText
 *   - status=failed → AgentError
 *   - bearer injection on outgoing request (verified by auth round-trip)
 *   - AbortSignal mid-stream → terminates cleanly
 *   - testConnection: 200 → ok+card; non-200 → error
 *   - SSRF: RFC1918 endpoint rejected (sync + async)
 *   - DNS rebind: hostname resolves to private IP → blocked
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { A2AClient } from '../client'
import { isPrivateOrLoopbackIp, assertSafeEndpoint, assertSafeEndpointSync } from '../endpoint-guard'
import { A2AServer } from '../server'
import { A2ATaskStore } from '../task-store'
import type { A2ARemoteAgent, A2AServerConfig, A2AAgentCard } from '@shared/types/a2a'
import type { Logger } from '../server'
import type { MessageSendSessionStarter } from '../routes/message-send'
import type { MessageStreamSessionStarter } from '../routes/message-stream'
import type { AgentOutput } from '@shared/types/agent'

const logger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}

const sampleCard: A2AAgentCard = {
  a2aVersion: '0.3.0', name: 'remote', description: 'r', url: 'http://127.0.0.1:0',
  capabilities: ['streaming'], defaultInputModes: ['text'], defaultOutputModes: ['text'], skills: [],
}

const baseRemote: A2ARemoteAgent = {
  name: 'peer-1',
  endpoint: 'http://127.0.0.1:0', // overwritten per-test
  devAllowLocalhost: true,
  timeoutMs: 5000,
}

const apiKey = 'test-bearer-key-1234567890'

const baseServerConfig: A2AServerConfig = {
  enabled: true,
  port: 0,
  bindAddress: '127.0.0.1',
  apiKey,
  agentCard: sampleCard,
}

interface RemoteHandle {
  port: number
  server: A2AServer
  taskStore: A2ATaskStore
  emit: (output: AgentOutput) => void
}

/**
 * Boot an A2AServer whose mock session emits a fixed sequence of outputs
 * when sendCommand is called. Listener registration propagates via a
 * setImmediate so the stream-open event has been flushed to the client
 * before the first artifact is sent.
 */
async function setupRemote(
  outputsForText: (text: string) => AgentOutput[],
): Promise<RemoteHandle> {
  const taskStore = new A2ATaskStore()
  const listeners = new Set<(output: AgentOutput) => void>()
  let started = 0
  const session: MessageStreamSessionStarter = {
    startSession: vi.fn(async () => {
      started += 1
      return `session-${started}`
    }),
    sendCommand: vi.fn(async (_id, text) => {
      const outs = outputsForText(text)
      setImmediate(() => {
        for (const out of outs) {
          for (const l of listeners) l(out)
        }
      })
    }),
    subscribeOnSessionOutput: vi.fn((_id, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    terminateSession: vi.fn(async () => undefined),
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
    emit: (output) => { for (const l of listeners) l(output) },
  }
}

/** Minimal http server with TCP-probe ready wait — only used for the testConnection 500 case. */
function startErrorServer(status: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status).end()
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address()
      if (typeof addr !== 'object' || addr === null) {
        reject(new Error('No port'))
        return
      }
      // TCP probe: ensure kernel accept queue is up before resolving.
      const probe = () => new Promise<void>((res, rej) => {
        const sock = net.connect({ host: '127.0.0.1', port: addr.port })
        sock.once('connect', () => { sock.destroy(); res() })
        sock.once('error', rej)
      })
      for (let i = 0; i < 10; i++) {
        try { await probe(); break } catch { await new Promise(r => setTimeout(r, 25)) }
      }
      resolve({ port: addr.port, close: () => new Promise<void>(r => server.close(() => r())) })
    })
  })
}

describe('A2AClient — happy path', () => {
  let remote: RemoteHandle | null = null
  let errorServer: { port: number; close: () => Promise<void> } | null = null

  afterEach(async () => {
    if (remote) {
      await remote.server.destroy()
      remote.taskStore.destroy()
    }
    if (errorServer) await errorServer.close()
    remote = null
    errorServer = null
  })

  it('streams artifact → resultText and resolves with finalStatus=completed', async () => {
    remote = await setupRemote((text) => [
      { type: 'stdout', data: `echo:${text}`, timestamp: Date.now() },
      { type: 'complete', data: '', timestamp: Date.now() },
    ])
    const client = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
    })
    const result = await client.call({
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    })
    expect(result.resultText).toBe('echo:hello')
    expect(result.finalStatus.state).toBe('completed')
  })

  it('injects Bearer header when apiKey is set', async () => {
    // Verify bearer injection by checking the auth round-trip:
    // A2AServer's verifyBearer accepts only its configured apiKey. If the
    // client injects the wrong key, the server returns 401. With the
    // correct key, the request succeeds and the SSE stream completes.
    remote = await setupRemote((_text) => [
      { type: 'complete', data: '', timestamp: Date.now() },
    ])
    const wrong = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey: 'definitely-wrong-key-9999',
    })
    await expect(
      wrong.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrow(/auth/i)

    const right = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
    })
    const r = await right.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] })
    expect(r.finalStatus.state).toBe('completed')
  })

  it('returns error when remote responds with status=failed', async () => {
    remote = await setupRemote(() => [
      { type: 'error', data: 'remote exploded', timestamp: Date.now() },
    ])
    const client = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
    })
    await expect(client.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] }))
      .rejects.toThrow(/remote exploded/i)
  })

  it('returns A2A_REMOTE_UNREACHABLE on connection refused', async () => {
    // Port 1 is reserved and nothing listens on it
    const client = new A2AClient({ ...baseRemote, endpoint: 'http://127.0.0.1:1' })
    await expect(client.call({ role: 'user', parts: [{ type: 'text', text: 'x' }] }))
      .rejects.toThrow(/unreachable/i)
  })

  it('testConnection returns ok=true and card on 200', async () => {
    remote = await setupRemote(() => [])
    const client = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
    })
    const r = await client.testConnection()
    expect(r.ok).toBe(true)
    expect(r.card?.name).toBe('remote')
  })

  it('testConnection returns ok=false on non-200', async () => {
    errorServer = await startErrorServer(500)
    const client = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${errorServer.port}`,
    })
    const r = await client.testConnection()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('500')
  })

  it('destroy() does not throw with no active sockets', () => {
    const client = new A2AClient({ ...baseRemote, endpoint: 'http://127.0.0.1:1' })
    expect(() => client.destroy()).not.toThrow()
  })
})

describe('A2AClient — abort signal', () => {
  it('cancels in-flight request when AbortSignal fires', async () => {
    const remote = await setupRemote(() => {
      // Never send terminal status — just keep the stream open
      const out: AgentOutput[] = []
      return out
    })
    const client = new A2AClient({
      ...baseRemote,
      endpoint: `http://127.0.0.1:${remote.port}`,
      apiKey,
    })
    const controller = new AbortController()
    // Abort soon after the request begins
    setTimeout(() => controller.abort(), 80)
    await expect(
      client.call(
        { role: 'user', parts: [{ type: 'text', text: 'x' }] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow()
    await remote.server.destroy()
    remote.taskStore.destroy()
  })
})

describe('endpoint-guard — IP classification', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1',
    'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'ff00::1',
  ])('classifies %s as private/loopback', (ip) => {
    expect(isPrivateOrLoopbackIp(ip)).toBe(true)
  })

  it.each([
    '8.8.8.8', '1.1.1.1', '142.250.80.46', '2606:4700:4700::1111',
  ])('allows public IP %s', (ip) => {
    expect(isPrivateOrLoopbackIp(ip)).toBe(false)
  })
})

describe('endpoint-guard — URL validation', () => {
  it('rejects file:// scheme', async () => {
    await expect(assertSafeEndpoint('file:///etc/passwd')).rejects.toMatchObject({
      code: 'A2A_SSRF_BLOCKED',
    })
  })

  it('rejects ftp:// scheme', async () => {
    await expect(assertSafeEndpoint('ftp://example.com')).rejects.toMatchObject({
      code: 'A2A_SSRF_BLOCKED',
    })
  })

  it('rejects http://127.0.0.1 without devAllowLocalhost', async () => {
    await expect(assertSafeEndpoint('http://127.0.0.1:8089')).rejects.toMatchObject({
      code: 'A2A_SSRF_BLOCKED',
    })
  })

  it('allows http://127.0.0.1 with devAllowLocalhost=true', async () => {
    await expect(assertSafeEndpoint('http://127.0.0.1:8089', { devAllowLocalhost: true }))
      .resolves.toBeUndefined()
  })

  it('rejects malformed URL', async () => {
    await expect(assertSafeEndpoint('not-a-url')).rejects.toMatchObject({
      code: 'A2A_BAD_REQUEST',
    })
  })

  it('sync: rejects IP literal in private range', () => {
    expect(() => assertSafeEndpointSync('http://10.0.0.1')).toThrow(/private/i)
  })

  it('sync: allows hostname (DNS resolution deferred)', () => {
    expect(() => assertSafeEndpointSync('http://example.com')).not.toThrow()
  })
})

describe('endpoint-guard — DNS rebinding protection', () => {
  it('blocks hostname that resolves to a private IP', async () => {
    // 127.0.0.1 is in DNS as a literal, but as a hostname string it
    // requires devAllowLocalhost. Direct lookup of "localhost" resolves
    // to 127.0.0.1, which the guard blocks by default.
    await expect(assertSafeEndpoint('http://localhost:8089')).rejects.toMatchObject({
      code: 'A2A_SSRF_BLOCKED',
    })
  })
})