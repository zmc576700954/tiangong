/**
 * POST /v1/message:stream — SSE 流式 SendMessage
 *
 * Phase D9 C4. 实现要点：
 *   - 启动后立即返回 SSE headers (200 + text/event-stream)
 *   - 透传 message.text 给下游 Agent（不注入 BizGraph memory / scope）
 *   - 通过 MessageStreamSessionStarter.subscribeOnSessionOutput 订阅输出：
 *     - stdout / stderr  → artifact (TextPart)
 *     - file_change     → artifact (DataPart)
 *     - error           → status failed + cleanup
 *     - complete        → status completed + cleanup
 *   - 每 15s 发送 keepalive ':<comment>\n\n'（与 EventSource 兼容）
 *   - req.socket.on('close') → terminate session + status canceled
 *
 * **不**注入 BizGraph 内部 memory / scope 摘要到下游 prompt
 * （CLAUDE.md Boundaries 第 3 条）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { decodeSendMessageRequest } from '../codec'
import { formatArtifactEvent, formatStatusEvent, formatSseKeepalive } from '../codec'
import { BizGraphError, ErrorCode } from '../../errors'
import { A2A_SSE_KEEPALIVE_MS } from '@shared/types/a2a'
import type { AgentOutput } from '@shared/types/agent'
import type { A2ATaskStore } from '../task-store'
import type { A2AMessage } from '@shared/types/a2a'

export interface MessageStreamSessionStarter {
  startSession(message: A2AMessage, contextId: string): Promise<string>
  sendCommand(sessionId: string, text: string): Promise<void>
  /** 注册 listener；返回 unsubscribe 函数。listener 收到 'complete' / 'error' 时应自行 return。 */
  subscribeOnSessionOutput(
    sessionId: string,
    listener: (output: AgentOutput) => void,
  ): () => void
  terminateSession(sessionId: string, reason: string): Promise<void>
}

export interface MessageStreamDeps {
  session: MessageStreamSessionStarter
  taskStore: A2ATaskStore
}

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new BizGraphError('Request body exceeds 1MB limit', ErrorCode.A2A_BAD_REQUEST))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

export async function handleMessageStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MessageStreamDeps,
): Promise<void> {
  const body = await readBody(req)
  const request = decodeSendMessageRequest(body)
  const contextId = request.contextId ?? `ctx_${Date.now().toString(36)}`

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': stream-open\n\n')

  const sessionId = await deps.session.startSession(request.message, contextId)
  deps.taskStore.put({
    taskId: sessionId,
    contextId,
    sessionId,
    status: 'working',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    artifacts: [],
    history: [request.message],
  })

  let closed = false
  let unsubscribe: (() => void) | null = null

  const keepalive = setInterval(() => {
    if (closed) return
    try { res.write(formatSseKeepalive()) } catch { /* socket already gone */ }
  }, A2A_SSE_KEEPALIVE_MS)

  const cleanup = (reason: 'client-disconnect' | 'completed' | 'failed') => {
    if (closed) return
    closed = true
    clearInterval(keepalive)
    if (unsubscribe !== null) {
      try { unsubscribe() } catch { /* listener may have been removed already */ }
      unsubscribe = null
    }
    if (reason === 'client-disconnect') {
      deps.taskStore.setStatus(sessionId, 'canceled')
      void deps.session.terminateSession(sessionId, 'a2a-client-disconnect').catch(() => {})
      try {
        res.write(formatStatusEvent({ state: 'canceled' }))
      } catch { /* socket may be gone */ }
    }
    try { res.end() } catch { /* already ended */ }
  }

  const listener = (output: AgentOutput) => {
    if (closed) return
    try {
      if (output.type === 'stdout' || output.type === 'stderr') {
        deps.taskStore.appendArtifact(sessionId, {
          name: output.type,
          parts: [{ type: 'text', text: output.data }],
        })
        res.write(formatArtifactEvent({
          name: output.type,
          parts: [{ type: 'text', text: output.data }],
        }))
      } else if (output.type === 'file_change') {
        const filePayload = {
          filePath: output.filePath,
          changeType: output.changeType,
        }
        deps.taskStore.appendArtifact(sessionId, {
          name: 'file_change',
          parts: [{ type: 'data', data: filePayload }],
        })
        res.write(formatArtifactEvent({
          name: 'file_change',
          parts: [{ type: 'data', data: filePayload }],
        }))
      } else if (output.type === 'error') {
        deps.taskStore.setStatus(sessionId, 'failed')
        res.write(formatStatusEvent({
          state: 'failed',
          message: { role: 'agent', parts: [{ type: 'text', text: output.data }] },
        }))
        cleanup('failed')
      } else if (output.type === 'complete') {
        deps.taskStore.setStatus(sessionId, 'completed')
        res.write(formatStatusEvent({ state: 'completed' }))
        cleanup('completed')
      }
      // Other AgentOutput types (system/progress/thinking/tool_call/context_injection)
      // are intentionally ignored — A2A protocol has no equivalent event, and emitting
      // them would pollute the spec-defined stream.
    } catch {
      deps.taskStore.setStatus(sessionId, 'failed')
      cleanup('failed')
    }
  }

  unsubscribe = deps.session.subscribeOnSessionOutput(sessionId, listener)

  req.socket.on('close', () => {
    if (!closed) cleanup('client-disconnect')
  })

  const text = request.message.parts.find((p) => p.type === 'text')?.text ?? ''
  void deps.session.sendCommand(sessionId, text).catch((err) => {
    deps.taskStore.setStatus(sessionId, 'failed')
    if (!closed) {
      try {
        res.write(formatStatusEvent({
          state: 'failed',
          message: { role: 'agent', parts: [{ type: 'text', text: (err as Error).message }] },
        }))
      } catch { /* socket gone */ }
      cleanup('failed')
    }
  })
}
