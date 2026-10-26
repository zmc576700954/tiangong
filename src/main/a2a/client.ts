/**
 * A2A Client — 远端 Agent HTTP/SSE 客户端
 *
 * Phase D9 C5. 设计要点：
 *   - 每次 call() 通过 node:http(s).request 发起短连接 POST；
 *     不维护 keepalive socket（理由：远端 server 可能漂移，
 *     SSE 断开后通过 AbortSignal 主动终止比依赖 keepalive 更可控）
 *   - 透传 message.text 给远端 server（不注入 BizGraph memory / scope，
 *     CLAUDE.md Boundaries 第 3 条）
 *   - SSRF 防护：每次 call 前调用 assertSafeEndpoint（DNS 解析 + IP 黑名单）
 *   - 默认 30s timeout，AbortSignal.timeout 包装
 *   - testConnection() 仅 fetch /.well-known/agent-card.json 用于
 *     Settings 面板状态展示（不验证 bearer）
 */

import http from 'node:http'
import { performance } from 'node:perf_hooks'
import https from 'node:https'
import { URL } from 'node:url'
import type { Socket } from 'node:net'
import type { LookupFunction } from 'node:net'
import {
  encodeSendMessageRequest,
  decodeArtifact,
  decodeStatus,
} from './codec'
import type { A2AMessage, A2AStatus, A2AAgentCard, A2ARemoteAgent } from '@shared/types/a2a'
import { A2A_DEFAULT_TIMEOUT_MS, SSE_EVENT_ARTIFACT, SSE_EVENT_STATUS, SSE_EVENT_MESSAGE } from '@shared/types/a2a'
import { parseSseChunk } from './codec'
import { BizGraphError, ErrorCode } from '../errors'
import { assertSafeEndpoint } from './endpoint-guard'

/** IPv4 / IPv6 地址族。 */
function familyOf(ip: string): 4 | 6 {
  return ip.includes(':') ? 6 : 4
}

/**
 * 固定 DNS 解析结果的 lookup 覆盖。
 *
 * SSRF 校验（assertSafeEndpoint）与实际连接之间存在 TOCTOU 窗口：恶意 DNS
 * 可以先返回公网 IP 过检，再在连接时返回内网 IP（rebinding）。把已校验的
 * IP 钉进连接，连接就只可能落到刚验过的地址上。
 *
 * Node 20 的 autoSelectFamily 会以 all:true 调用 lookup（happy eyeballs），
 * 两种回调形态都要支持。
 */
function pinnedLookup(ips: string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === 'object' && options !== null && options.all === true
    if (wantsAll) {
      callback(null, ips.map((address) => ({ address, family: familyOf(address) })))
      return
    }
    const first = ips[0]
    if (first === undefined) {
      callback(new Error('No validated address available for endpoint'), '', 0)
      return
    }
    callback(null, first, familyOf(first))
  }
}

export interface A2ACallResult {
  /** 拼接所有 TextPart 的 resultText（与 SubagentResult.resultText 兼容） */
  resultText: string
  /** 收集到的 file_change artifacts（与 SubagentResult.resultFiles 兼容） */
  resultFiles: Array<{ filePath?: string; changeType?: string; payload: Record<string, unknown> }>
  /** 流结束时最终 status */
  finalStatus: A2AStatus
  /** 远端返回的 AgentCard（如远端在 header 中提供，可选） */
  card?: A2AAgentCard
}

export interface A2ACallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * 把多个 AbortSignal 合成一个：任一触发即 abort。
 *
 * 不用 `AbortSignal.any()`——它不在本项目的 TS lib（ES2022 + DOM）里，
 * 且 Electron 33 内置 Node 20.18 的实现细节也随版本变化。
 */
function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined)
  if (present.length === 0) return new AbortController().signal
  if (present.length === 1) return present[0]
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  for (const s of present) {
    if (s.aborted) { controller.abort(); break }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

export class A2AClient {
  private keepaliveSockets: Set<Socket> = new Set()

  constructor(private readonly agent: A2ARemoteAgent) {}

  /**
   * 远端 POST /v1/message:stream；解析 SSE 流式响应。
   * 任意失败抛 BizGraphError（A2A_REMOTE_UNREACHABLE / A2A_SSRF_BLOCKED / AgentError）。
   */
  async call(message: A2AMessage, options: A2ACallOptions = {}): Promise<A2ACallResult> {
    // SSRF guard 在每次 call 时执行（不止 save 时）— 防止远端 DNS rebinding。
    // 必须 await：否则防护不生效，且 guard 的 rejection 会变成 unhandled rejection。
    // 返回值是已校验的 IP —— 必须钉进实际连接，否则校验与连接之间的
    // rebinding 窗口会让防护失效。
    const validatedIps = await assertSafeEndpoint(this.agent.endpoint, { devAllowLocalhost: this.agent.devAllowLocalhost })

    const timeoutMs = options.timeoutMs ?? this.agent.timeoutMs ?? A2A_DEFAULT_TIMEOUT_MS
    // 调用方的取消信号与本地超时必须同时生效——只用其一都会漏掉另一个。
    const signal = combineSignals([options.signal, AbortSignal.timeout(timeoutMs)])

    return new Promise<A2ACallResult>((resolve, reject) => {
      let url: URL
      try { url = new URL(this.agent.endpoint) } catch { reject(new BizGraphError('Invalid remote agent endpoint URL', ErrorCode.A2A_BAD_REQUEST)); return }
      url.pathname = (url.pathname.replace(/\/$/, '')) + '/v1/message:stream'

      const transport = url.protocol === 'https:' ? https : http
      const req = transport.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          // 连接地址钉死在校验过的 IP 上 —— 防止校验后 DNS rebinding。
          lookup: pinnedLookup(validatedIps),
          // signal 必须真正挂到 request 上 —— 只 new 一个 AbortSignal 而不传，
          // 超时和取消都不会生效，请求会一直挂着。
          signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(this.agent.apiKey ? { Authorization: `Bearer ${this.agent.apiKey}` } : {}),
          },
          rejectUnauthorized: this.agent.tlsVerify !== false,
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status === 401 || status === 403) {
            res.resume()
            reject(new BizGraphError(`Remote agent rejected auth (${status})`, ErrorCode.A2A_UNAUTHORIZED))
            return
          }
          if (status >= 400) {
            res.resume()
            reject(new BizGraphError(`Remote agent returned ${status}`, ErrorCode.A2A_REMOTE_UNREACHABLE))
            return
          }
          let buffer = ''
          const artifacts: A2ACallResult['resultFiles'] = []
          let resultText = ''
          let finalStatus: A2AStatus = { state: 'working' }
          res.setEncoding('utf-8')
          res.on('data', (chunk: string) => {
            const { events, rest } = parseSseChunk(buffer, chunk)
            buffer = rest
            for (const ev of events) {
              try {
                if (ev.event === SSE_EVENT_ARTIFACT) {
                  const a = decodeArtifact(ev.data)
                  if (a.name === 'file_change') {
                    const dataPart = a.parts.find((p) => p.type === 'data')
                    artifacts.push({
                      filePath: dataPart?.type === 'data' ? (dataPart.data.filePath as string | undefined) : undefined,
                      changeType: dataPart?.type === 'data' ? (dataPart.data.changeType as string | undefined) : undefined,
                      payload: dataPart?.type === 'data' ? dataPart.data : {},
                    })
                  } else {
                    const textPart = a.parts.find((p) => p.type === 'text')
                    if (textPart?.type === 'text') resultText += textPart.text
                  }
                } else if (ev.event === SSE_EVENT_STATUS) {
                  finalStatus = decodeStatus(ev.data)
                  if (finalStatus.state === 'failed') {
                    res.resume()
                    reject(new BizGraphError(`Remote agent failed: ${finalStatus.message?.parts.find((p) => p.type === 'text')?.type === 'text' ? (finalStatus.message.parts.find((p) => p.type === 'text') as { text: string }).text : 'unknown'}`, ErrorCode.AGENT_ADAPTER_ERROR))
                    return
                  }
                  if (finalStatus.state === 'canceled') {
                    res.resume()
                    reject(new BizGraphError('Remote agent canceled the task', ErrorCode.A2A_REMOTE_UNREACHABLE))
                    return
                  }
                  if (finalStatus.state === 'completed') {
                    res.resume()
                    resolve({ resultText, resultFiles: artifacts, finalStatus })
                    return
                  }
                  if (finalStatus.state === 'input-required') {
                    // 一次性调用无法回答远端的追问——立即失败，而不是挂到超时。
                    res.resume()
                    reject(new BizGraphError('Remote agent requires additional input, which one-shot A2A calls cannot provide', ErrorCode.A2A_BAD_REQUEST))
                    return
                  }
                } else if (ev.event === SSE_EVENT_MESSAGE) {
                  // agent-side message — append to resultText for visibility
                  try {
                    const msg = JSON.parse(ev.data) as A2AMessage
                    const txt = msg.parts.find((p) => p.type === 'text')
                    if (txt?.type === 'text') resultText += txt.text
                  } catch { /* malformed JSON in event — ignore */ }
                }
              } catch (err) {
                // Malformed artifact/status JSON — log via reject on terminal only
                if (ev.event === SSE_EVENT_STATUS) {
                  reject(new BizGraphError(`Malformed status event from remote: ${(err as Error).message}`, ErrorCode.A2A_BAD_REQUEST))
                  return
                }
              }
            }
          })
          res.on('end', () => {
            // 远端在给出终态事件前就结束流（进程被杀 / 连接中断）——
            // 这是一次失败的调用，不能按成功结算（Promise 已结算时此 reject 是 no-op）。
            reject(new BizGraphError('Remote agent stream ended without a terminal status event', ErrorCode.A2A_REMOTE_UNREACHABLE))
          })
          res.on('error', (err) => {
            reject(new BizGraphError(`Remote agent stream error: ${err.message}`, ErrorCode.A2A_REMOTE_UNREACHABLE))
          })
        },
      )

      // Track socket for rebuild() cleanup. Transport.request returns ClientRequest,
      // which exposes socket via .on('socket') / .socket property once assigned.
      req.on('socket', (socket) => {
        this.keepaliveSockets.add(socket)
        socket.on('close', () => { this.keepaliveSockets.delete(socket) })
      })

      req.on('error', (err) => {
        if (signal.aborted) {
          // 超时或调用方取消 —— 不是「远端不可达」，错误信息要能区分。
          reject(new BizGraphError('Remote agent request timed out or was cancelled', ErrorCode.A2A_REMOTE_UNREACHABLE))
        } else if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
          reject(new BizGraphError('Remote agent connection reset', ErrorCode.A2A_REMOTE_UNREACHABLE))
        } else {
          reject(new BizGraphError(`Remote agent unreachable: ${err.message}`, ErrorCode.A2A_REMOTE_UNREACHABLE))
        }
      })

      // AbortSignal handling: destroy the request to short-circuit the response.
      const onAbort = () => {
        req.destroy(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })

      req.write(encodeSendMessageRequest({ message }))
      req.end()
    })
  }

  /**
   * 测试与远端的连接：GET /.well-known/agent-card.json。
   * 不验证 bearer（spec 要求 discovery endpoint 必须开放）。
   */
  async testConnection(): Promise<{ ok: boolean; card?: A2AAgentCard; error?: string; latencyMs: number }> {
    // 同样必须 await —— 否则 guard 的 rejection 会逃逸成 unhandled rejection。
    let validatedIps: string[]
    try {
      validatedIps = await assertSafeEndpoint(this.agent.endpoint, { devAllowLocalhost: this.agent.devAllowLocalhost })
    } catch (err) {
      return { ok: false, error: (err as Error).message, latencyMs: 0 }
    }
    // 用高精度时钟：Date.now() 只有毫秒精度，loopback 往返常常不足 1ms，
    // 会把延迟测成 0（下游「延迟 > 0」的断言会随机挂）。
    const start = performance.now()
    const elapsed = (): number => Math.round((performance.now() - start) * 100) / 100
    return new Promise((resolve) => {
      let url: URL
      try { url = new URL(this.agent.endpoint) } catch { resolve({ ok: false, error: 'invalid endpoint URL', latencyMs: 0 }); return }
      url.pathname = (url.pathname.replace(/\/$/, '')) + '/.well-known/agent-card.json'
      const transport = url.protocol === 'https:' ? https : http
      // 连接测试同样要有上限 —— 否则远端挂住时这个 Promise 永远不 settle。
      const timeoutMs = this.agent.timeoutMs ?? A2A_DEFAULT_TIMEOUT_MS
      const req = transport.request(
        {
          method: 'GET',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          // 同 call()：连接地址钉死在校验过的 IP 上。
          lookup: pinnedLookup(validatedIps),
          signal: AbortSignal.timeout(timeoutMs),
          rejectUnauthorized: this.agent.tlsVerify !== false,
        },
        (res) => {
          const latencyMs = elapsed()
          if ((res.statusCode ?? 0) !== 200) {
            res.resume()
            resolve({ ok: false, error: `HTTP ${res.statusCode}`, latencyMs })
            return
          }
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            try {
              const card = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as A2AAgentCard
              resolve({ ok: true, card, latencyMs })
            } catch (err) {
              resolve({ ok: false, error: `Malformed agent card: ${(err as Error).message}`, latencyMs })
            }
          })
          res.on('error', (err) => {
            resolve({ ok: false, error: err.message, latencyMs: elapsed() })
          })
        },
      )
      req.on('error', (err) => {
        resolve({ ok: false, error: err.message, latencyMs: elapsed() })
      })
      req.end()
    })
  }

  /** 关闭所有 keepalive socket（hot-reload 调用）。 */
  destroy(): void {
    for (const s of this.keepaliveSockets) {
      try { s.destroy() } catch { /* already closed */ }
    }
    this.keepaliveSockets.clear()
  }

  /** 远端 agent 名（用于 SubagentManager 注册 'a2a:<name>'） */
  name(): string { return this.agent.name }
}
