/**
 * POST /v1/message:send — 同步 SendMessage
 *
 * Phase D9 C4. 与 stream:send 不同：一次性返回完整 Task，不走 SSE。
 * 由调用方（父 agent）决定何时 disconnect；流式输出走 /v1/message:stream。
 *
 * **不**透传 prompt 中的本地 memory / scope 摘要（CLAUDE.md Boundaries 第 3 条）。
 * 文件改动由调用方提供的 startSession → ScopeGuard 兜底。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { decodeSendMessageRequest, encodeSendMessageResponse } from '../codec'
import { BizGraphError, ErrorCode } from '../../errors'
import type { AgentOutput } from '@shared/types/agent'
import type { A2ATaskStore } from '../task-store'
import type { A2AArtifact, A2AMessage, A2ATask } from '@shared/types/a2a'

export interface MessageSendSessionStarter {
  /** 启动新 Agent session，返回 sessionId。注入透传 prompt（不污染 KV-cache）。 */
  startSession(message: A2AMessage, contextId: string): Promise<string>
  /** 把 message.text 作为命令发出。 */
  sendCommand(sessionId: string, text: string): Promise<void>
  /** 注册输出 listener；handler 返回 'done' 时 resolve，'error' 时 reject。 */
  runToCompletion(
    sessionId: string,
    onOutput: (output: AgentOutput) => void,
  ): Promise<{ artifacts: A2AArtifact[]; history: A2AMessage[] }>
  /** 出错时回收。 */
  terminateSession(sessionId: string, reason: string): Promise<void>
}

export interface MessageSendDeps {
  session: MessageSendSessionStarter
  taskStore: A2ATaskStore
}

/** 读取 request body 全部字节（限制 1MB 防 DoS）。 */
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

export async function handleMessageSend(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MessageSendDeps,
): Promise<void> {
  const body = await readBody(req)
  const request = decodeSendMessageRequest(body)
  const contextId = request.contextId ?? `ctx_${Date.now().toString(36)}`

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

  try {
    const text = request.message.parts.find((p) => p.type === 'text')?.text ?? ''
    // Run to completion first (registers the listener, awaits 'complete' / 'error'),
    // THEN send the command so the listener is attached before any output arrives.
    const completionPromise = deps.session.runToCompletion(sessionId, () => {})
    await deps.session.sendCommand(sessionId, text)
    const { artifacts, history } = await completionPromise
    const task: A2ATask = {
      id: sessionId,
      contextId,
      status: { state: 'completed' },
      artifacts,
      history,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    deps.taskStore.setStatus(sessionId, 'completed', { artifacts, history })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(encodeSendMessageResponse({ task }))
  } catch (err) {
    deps.taskStore.setStatus(sessionId, 'failed')
    await deps.session.terminateSession(sessionId, 'a2a-error').catch(() => {})
    throw err
  }
}
