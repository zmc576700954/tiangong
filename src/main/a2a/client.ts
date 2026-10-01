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
import https from 'node:https'
import { URL } from 'node:url'
import type { Socket } from 'node:net'
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

export class A2AClient {
  private keepaliveSockets: Set<Socket> = new Set()

  constructor(private readonly agent: A2ARemoteAgent) {}

  /**
   * 远端 POST /v1/message:stream；解析 SSE 流式响应。
   * 任意失败抛 BizGraphError（A2A_REMOTE_UNREACHABLE / A2A_SSRF_BLOCKED / AgentError）。
   */
  async call(message: A2AMessage, options: A2ACallOptions = {}): Promise<A2ACallResult> {
    // SSRF guard 在每次 call 时执行（不止 save 时）— 防止远端 DNS rebinding。
    assertSafeEndpoint(this.agent.endpoint, { devAllowLocalhost: this.agent.devAllowLocalhost })

    const timeoutMs = options.timeoutMs ?? this.agent.timeoutMs ?? A2A_DEFAULT_TIMEOUT_MS
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs)

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
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(this.agent.apiKey ? { Authorization: `Bearer ${this.agent.apiKey}` } : {}),
            ...(this.agent.tlsVerify === false ? {} : {}),
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
                  if (finalStatus.state === 'completed' || finalStatus.state === 'failed' || finalStatus.state === 'canceled') {
                    res.resume()
                    if (finalStatus.state === 'failed') {
                      reject(new BizGraphError(`Remote agent failed: ${finalStatus.message?.parts.find((p) => p.type === 'text')?.type === 'text' ? (finalStatus.message.parts.find((p) => p.type === 'text') as { text: string }).text : 'unknown'}`, ErrorCode.AGENT_ADAPTER_ERROR))
                    } else {
                      resolve({ resultText, resultFiles: artifacts, finalStatus })
                    }
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
            // stream ended without terminal status event
            if (finalStatus.state === 'working') {
              resolve({ resultText, resultFiles: artifacts, finalStatus: { state: 'completed' } })
            }
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
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
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
    assertSafeEndpoint(this.agent.endpoint, { devAllowLocalhost: this.agent.devAllowLocalhost })
    const start = Date.now()
    return new Promise((resolve) => {
      let url: URL
      try { url = new URL(this.agent.endpoint) } catch { resolve({ ok: false, error: 'invalid endpoint URL', latencyMs: 0 }); return }
      url.pathname = (url.pathname.replace(/\/$/, '')) + '/.well-known/agent-card.json'
      const transport = url.protocol === 'https:' ? https : http
      const req = transport.request(
        {
          method: 'GET',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          rejectUnauthorized: this.agent.tlsVerify !== false,
        },
        (res) => {
          const latencyMs = Date.now() - start
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
            resolve({ ok: false, error: err.message, latencyMs: Date.now() - start })
          })
        },
      )
      req.on('error', (err) => {
        resolve({ ok: false, error: err.message, latencyMs: Date.now() - start })
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
