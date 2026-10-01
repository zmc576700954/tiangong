/**
 * A2A wire codec — 纯函数版 encode/decode + SSE framing
 *
 * Phase D9 C3. **不**做 I/O、不依赖 Node、不读 Settings：
 *   - 服务端 / 客户端共用同一组函数
 *   - 测试可在 Node + 浏览器两侧复用
 *   - 出错抛 `BizGraphError(ErrorCode.A2A_BAD_REQUEST)` 由 IPC 层透传
 *
 * SSE 协议要点（与 A2A spec 一致）：
 *   - event: <name>\n
 *   - data: <json>\n
 *   - \n
 *   - keepalive: ": <comment>\n\n"（不触发 onmessage）
 */

import type {
  A2AMessage,
  A2APart,
  A2AFilePart,
  A2AArtifact,
  A2AStatus,
  A2AStatusState,
  A2AAgentCard,
  A2ATask,
  A2ASendMessageRequest,
  A2ASendMessageResponse,
  A2ATaskListResponse,
} from '@shared/types/a2a'
import {
  SSE_EVENT_ARTIFACT,
  SSE_EVENT_STATUS,
  SSE_EVENT_MESSAGE,
} from '@shared/types/a2a'
import { BizGraphError, ErrorCode } from '../errors'

// ============================================
// JSON encode/decode（带 spec 合规校验）
// ============================================

export function encodeMessage(message: A2AMessage): string {
  return JSON.stringify(message)
}

export function decodeMessage(raw: string): A2AMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new BizGraphError(
      `Invalid JSON in A2A message body: ${(err as Error).message}`,
      ErrorCode.A2A_BAD_REQUEST,
    )
  }
  if (!isPlainObject(parsed)) {
    throw new BizGraphError('A2A message body must be an object', ErrorCode.A2A_BAD_REQUEST)
  }
  const role = parsed.role
  if (role !== 'user' && role !== 'agent') {
    throw new BizGraphError(`Invalid A2A message role: ${String(role)}`, ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.parts)) {
    throw new BizGraphError('A2A message parts must be an array', ErrorCode.A2A_BAD_REQUEST)
  }
  const parts: A2APart[] = []
  for (const p of parsed.parts) {
    parts.push(decodePart(p))
  }
  const msg: A2AMessage = {
    role,
    parts,
  }
  if (typeof parsed.contextId === 'string') msg.contextId = parsed.contextId
  if (typeof parsed.taskId === 'string') msg.taskId = parsed.taskId
  if (isPlainObject(parsed.metadata)) msg.metadata = parsed.metadata as Record<string, unknown>
  return msg
}

export function encodeArtifact(artifact: A2AArtifact): string {
  return JSON.stringify(artifact)
}

export function decodeArtifact(raw: string): A2AArtifact {
  const parsed = parseOrThrow(raw, 'A2A artifact')
  if (!isPlainObject(parsed)) {
    throw new BizGraphError('A2A artifact must be an object', ErrorCode.A2A_BAD_REQUEST)
  }
  if (typeof parsed.name !== 'string') {
    throw new BizGraphError('A2A artifact.name must be a string', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.parts)) {
    throw new BizGraphError('A2A artifact.parts must be an array', ErrorCode.A2A_BAD_REQUEST)
  }
  const artifact: A2AArtifact = {
    name: parsed.name,
    parts: parsed.parts.map((p) => decodePart(p)),
  }
  if (typeof parsed.fileName === 'string') artifact.fileName = parsed.fileName
  if (typeof parsed.mimeType === 'string') artifact.mimeType = parsed.mimeType
  if (typeof parsed.index === 'number') artifact.index = parsed.index
  if (typeof parsed.lastChunk === 'boolean') artifact.lastChunk = parsed.lastChunk
  if (isPlainObject(parsed.metadata)) artifact.metadata = parsed.metadata as Record<string, unknown>
  return artifact
}

export function encodeStatus(status: A2AStatus): string {
  return JSON.stringify(status)
}

export function decodeStatus(raw: string): A2AStatus {
  const parsed = parseOrThrow(raw, 'A2A status')
  if (!isPlainObject(parsed)) {
    throw new BizGraphError('A2A status must be an object', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!isValidStatusState(parsed.state)) {
    throw new BizGraphError(`Invalid A2A status state: ${String(parsed.state)}`, ErrorCode.A2A_BAD_REQUEST)
  }
  const status: A2AStatus = { state: parsed.state }
  if (isPlainObject(parsed.message)) {
    status.message = decodeMessage(JSON.stringify(parsed.message))
  }
  if (isPlainObject(parsed.metadata)) {
    status.metadata = parsed.metadata as Record<string, unknown>
  }
  return status
}

export function encodeAgentCard(card: A2AAgentCard): string {
  return JSON.stringify(card)
}

export function decodeAgentCard(raw: string): A2AAgentCard {
  const parsed = parseOrThrow(raw, 'A2A agent card')
  if (!isPlainObject(parsed)) {
    throw new BizGraphError('A2A agent card must be an object', ErrorCode.A2A_BAD_REQUEST)
  }
  if (typeof parsed.a2aVersion !== 'string') {
    throw new BizGraphError('A2A agent card missing a2aVersion', ErrorCode.A2A_BAD_REQUEST)
  }
  if (typeof parsed.name !== 'string') {
    throw new BizGraphError('A2A agent card missing name', ErrorCode.A2A_BAD_REQUEST)
  }
  if (typeof parsed.url !== 'string') {
    throw new BizGraphError('A2A agent card missing url', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.capabilities)) {
    throw new BizGraphError('A2A agent card capabilities must be an array', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.defaultInputModes) || !Array.isArray(parsed.defaultOutputModes)) {
    throw new BizGraphError('A2A agent card default input/output modes must be arrays', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.skills)) {
    throw new BizGraphError('A2A agent card skills must be an array', ErrorCode.A2A_BAD_REQUEST)
  }
  return parsed as unknown as A2AAgentCard
}

// ============================================
// RPC envelope
// ============================================

export function encodeSendMessageRequest(req: A2ASendMessageRequest): string {
  return JSON.stringify(req)
}

export function decodeSendMessageRequest(raw: string): A2ASendMessageRequest {
  const parsed = parseOrThrow(raw, 'A2A SendMessage request')
  if (!isPlainObject(parsed) || !isPlainObject(parsed.message)) {
    throw new BizGraphError('A2A SendMessage request missing message', ErrorCode.A2A_BAD_REQUEST)
  }
  const req: A2ASendMessageRequest = {
    message: decodeMessage(JSON.stringify(parsed.message)),
  }
  if (typeof parsed.contextId === 'string') req.contextId = parsed.contextId
  if (typeof parsed.taskId === 'string') req.taskId = parsed.taskId
  if (isPlainObject(parsed.metadata)) req.metadata = parsed.metadata as Record<string, unknown>
  return req
}

export function encodeSendMessageResponse(res: A2ASendMessageResponse): string {
  return JSON.stringify(res)
}

export function decodeSendMessageResponse(raw: string): A2ASendMessageResponse {
  const parsed = parseOrThrow(raw, 'A2A SendMessage response')
  if (!isPlainObject(parsed) || !isPlainObject(parsed.task)) {
    throw new BizGraphError('A2A SendMessage response missing task', ErrorCode.A2A_BAD_REQUEST)
  }
  return { task: decodeTask(JSON.stringify(parsed.task)) }
}

export function encodeTaskListResponse(res: A2ATaskListResponse): string {
  return JSON.stringify(res)
}

export function decodeTaskListResponse(raw: string): A2ATaskListResponse {
  const parsed = parseOrThrow(raw, 'A2A TaskList response')
  if (!isPlainObject(parsed) || !Array.isArray(parsed.tasks)) {
    throw new BizGraphError('A2A TaskList response missing tasks array', ErrorCode.A2A_BAD_REQUEST)
  }
  const res: A2ATaskListResponse = {
    tasks: parsed.tasks.map((t) => decodeTask(JSON.stringify(t))),
  }
  if (typeof parsed.nextPageToken === 'string') res.nextPageToken = parsed.nextPageToken
  return res
}

function decodeTask(raw: string): A2ATask {
  const parsed = parseOrThrow(raw, 'A2A task')
  if (!isPlainObject(parsed)) {
    throw new BizGraphError('A2A task must be an object', ErrorCode.A2A_BAD_REQUEST)
  }
  if (typeof parsed.id !== 'string') {
    throw new BizGraphError('A2A task missing id', ErrorCode.A2A_BAD_REQUEST)
  }
  if (typeof parsed.contextId !== 'string') {
    throw new BizGraphError('A2A task missing contextId', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!isPlainObject(parsed.status)) {
    throw new BizGraphError('A2A task missing status', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.artifacts)) {
    throw new BizGraphError('A2A task artifacts must be an array', ErrorCode.A2A_BAD_REQUEST)
  }
  if (!Array.isArray(parsed.history)) {
    throw new BizGraphError('A2A task history must be an array', ErrorCode.A2A_BAD_REQUEST)
  }
  const task: A2ATask = {
    id: parsed.id,
    contextId: parsed.contextId,
    status: decodeStatus(JSON.stringify(parsed.status)),
    artifacts: parsed.artifacts.map((a) => decodeArtifact(JSON.stringify(a))),
    history: parsed.history.map((m) => decodeMessage(JSON.stringify(m))),
  }
  if (typeof parsed.createdAt === 'number') task.createdAt = parsed.createdAt
  if (typeof parsed.updatedAt === 'number') task.updatedAt = parsed.updatedAt
  if (isPlainObject(parsed.metadata)) task.metadata = parsed.metadata as Record<string, unknown>
  return task
}

// ============================================
// SSE framing
// ============================================

export interface SseEvent {
  /** event name (e.g. 'artifact', 'status', 'message'); undefined = implicit 'message' */
  event?: string
  /** payload (already JSON-serialized for object events, raw text for non-JSON) */
  data: string
  /** optional event id (browser will replay on reconnect via Last-Event-Id) */
  id?: string
}

/** Serialize a single SSE event into wire bytes. */
export function formatSseEvent(event: SseEvent): string {
  let out = ''
  if (event.event !== undefined) {
    // SSE spec: field names cannot contain newlines/CR.
    out += `event: ${event.event.replace(/[\r\n]+/g, ' ')}\n`
  }
  // Always serialize multi-line data as one `data: ` line per fragment (per spec).
  for (const line of event.data.split(/\r?\n/)) {
    out += `data: ${line}\n`
  }
  if (event.id !== undefined) {
    out += `id: ${event.id.replace(/[\r\n]+/g, ' ')}\n`
  }
  out += '\n'
  return out
}

/** Convenience wrappers for the three A2A SSE event types. */
export function formatArtifactEvent(artifact: A2AArtifact, id?: string): string {
  return formatSseEvent({
    event: SSE_EVENT_ARTIFACT,
    data: encodeArtifact(artifact),
    ...(id !== undefined ? { id } : {}),
  })
}

export function formatStatusEvent(status: A2AStatus, id?: string): string {
  return formatSseEvent({
    event: SSE_EVENT_STATUS,
    data: encodeStatus(status),
    ...(id !== undefined ? { id } : {}),
  })
}

export function formatMessageEvent(message: A2AMessage, id?: string): string {
  return formatSseEvent({
    event: SSE_EVENT_MESSAGE,
    data: encodeMessage(message),
    ...(id !== undefined ? { id } : {}),
  })
}

export function formatSseKeepalive(comment = 'keepalive'): string {
  // SSE comment lines start with ':' and are ignored by EventSource.
  // Ensure the comment doesn't itself contain a newline.
  return `: ${comment.replace(/[\r\n]+/g, ' ')}\n\n`
}

/**
 * Streaming SSE parser. Buffers incoming bytes and yields complete events as
 * they arrive. Handles the partial-buffer case where a single `event:` /
 * `data:` line straddles two TCP reads (the classic SSE robustness issue).
 *
 * Returns the residual buffer (bytes after the last complete event) so the
 * caller can prepend it to the next read.
 */
export function parseSseChunk(
  buffer: string,
  chunk: string,
): { events: SseEvent[]; rest: string } {
  const combined = buffer + chunk
  const events: SseEvent[] = []
  // SSE records are separated by a blank line.
  let cursor = 0
  let recordStart = 0
  while (cursor < combined.length) {
    // Find the next double newline (record terminator).
    const terminator = findRecordEnd(combined, cursor)
    if (terminator === -1) break
    const record = combined.slice(recordStart, terminator)
    const ev = parseSseRecord(record)
    if (ev !== null) events.push(ev)
    cursor = terminator + 2 // skip '\n\n'
    recordStart = cursor
  }
  return { events, rest: combined.slice(recordStart) }
}

function findRecordEnd(haystack: string, from: number): number {
  // Search for either '\n\n' or '\r\n\r\n'.
  let idx = haystack.indexOf('\n\n', from)
  if (idx === -1) {
    idx = haystack.indexOf('\r\n\r\n', from)
  }
  return idx
}

function parseSseRecord(record: string): SseEvent | null {
  // Skip comments and blanks.
  const lines = record.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith(':'))
  if (lines.length === 0) return null
  let event: string | undefined
  const dataLines: string[] = []
  let id: string | undefined
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      // Malformed line; per spec we silently ignore (do not throw — network is best-effort).
      continue
    }
    const field = line.slice(0, colonIdx)
    let value = line.slice(colonIdx + 1)
    // Per spec: a single leading space after the colon is consumed.
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      dataLines.push(value)
    } else if (field === 'id') {
      id = value
    }
    // 'retry' and other fields ignored for now.
  }
  if (dataLines.length === 0) return null
  const ev: SseEvent = { data: dataLines.join('\n') }
  if (event !== undefined) ev.event = event
  if (id !== undefined) ev.id = id
  return ev
}

// ============================================
// 内部辅助
// ============================================

function parseOrThrow(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new BizGraphError(
      `Invalid JSON in ${label}: ${(err as Error).message}`,
      ErrorCode.A2A_BAD_REQUEST,
    )
  }
}

function decodePart(value: unknown): A2APart {
  if (!isPlainObject(value)) {
    throw new BizGraphError('A2A part must be an object', ErrorCode.A2A_BAD_REQUEST)
  }
  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      throw new BizGraphError('A2A TextPart.text must be a string', ErrorCode.A2A_BAD_REQUEST)
    }
    return { type: 'text', text: value.text }
  }
  if (value.type === 'file') {
    if (typeof value.mimeType !== 'string') {
      throw new BizGraphError('A2A FilePart.mimeType must be a string', ErrorCode.A2A_BAD_REQUEST)
    }
    const part: A2APart = { type: 'file', mimeType: value.mimeType }
    if (typeof value.name === 'string') (part as A2AFilePart).name = value.name
    if (typeof value.bytes === 'string') (part as A2AFilePart).bytes = value.bytes
    if (typeof value.uri === 'string') (part as A2AFilePart).uri = value.uri
    return part
  }
  if (value.type === 'data') {
    if (!isPlainObject(value.data)) {
      throw new BizGraphError('A2A DataPart.data must be an object', ErrorCode.A2A_BAD_REQUEST)
    }
    return { type: 'data', data: value.data as Record<string, unknown> }
  }
  throw new BizGraphError(`Unknown A2A part type: ${String(value.type)}`, ErrorCode.A2A_BAD_REQUEST)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isValidStatusState(value: unknown): value is A2AStatusState {
  return (
    value === 'working' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'canceled' ||
    value === 'input-required'
  )
}
