/**
 * A2A codec — unit tests
 *
 * Phase D9 C3. Covers:
 * - encode/decode round-trip for Message / Artifact / Status / AgentCard
 * - SSE framing: formatSseEvent / parseSseChunk / partial-buffer split
 * - Reject malformed payloads with BizGraphError(A2A_BAD_REQUEST)
 */

import { describe, it, expect } from 'vitest'
import {
  encodeMessage,
  decodeMessage,
  encodeArtifact,
  decodeArtifact,
  encodeStatus,
  decodeStatus,
  encodeAgentCard,
  decodeAgentCard,
  encodeSendMessageRequest,
  decodeSendMessageRequest,
  encodeSendMessageResponse,
  decodeSendMessageResponse,
  encodeTaskListResponse,
  decodeTaskListResponse,
  formatSseEvent,
  formatArtifactEvent,
  formatStatusEvent,
  formatMessageEvent,
  formatSseKeepalive,
  parseSseChunk,
} from '../codec'
import {
  SSE_EVENT_ARTIFACT,
  SSE_EVENT_STATUS,
  SSE_EVENT_MESSAGE,
} from '@shared/types/a2a'
import type { A2AMessage, A2AArtifact, A2AStatus, A2AAgentCard } from '@shared/types/a2a'
import { BizGraphError, ErrorCode } from '../../errors'

const sampleMessage: A2AMessage = {
  role: 'user',
  parts: [{ type: 'text', text: 'summarize the spec' }],
  contextId: 'ctx-1',
}

const sampleArtifact: A2AArtifact = {
  name: 'summary',
  parts: [{ type: 'text', text: 'result text' }],
  mimeType: 'text/plain',
  index: 0,
}

const sampleStatus: A2AStatus = {
  state: 'working',
}

const sampleCard: A2AAgentCard = {
  a2aVersion: '0.3.0',
  name: 'bizgraph',
  description: 'BizGraph agent',
  url: 'http://127.0.0.1:8089',
  capabilities: ['streaming'],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
}

describe('A2A codec — round-trip', () => {
  it('encodes and decodes Message', () => {
    const encoded = encodeMessage(sampleMessage)
    const decoded = decodeMessage(encoded)
    expect(decoded).toEqual(sampleMessage)
  })

  it('encodes and decodes Message with FilePart (bytes)', () => {
    const msg: A2AMessage = {
      role: 'user',
      parts: [{ type: 'file', mimeType: 'application/pdf', bytes: Buffer.from('pdfdata').toString('base64') }],
    }
    const decoded = decodeMessage(encodeMessage(msg))
    expect(decoded).toEqual(msg)
  })

  it('encodes and decodes Message with DataPart', () => {
    const msg: A2AMessage = {
      role: 'user',
      parts: [{ type: 'data', data: { foo: 1, nested: { bar: [1, 2] } } }],
    }
    const decoded = decodeMessage(encodeMessage(msg))
    expect(decoded).toEqual(msg)
  })

  it('encodes and decodes Artifact', () => {
    const decoded = decodeArtifact(encodeArtifact(sampleArtifact))
    expect(decoded).toEqual(sampleArtifact)
  })

  it('encodes and decodes Status with optional message', () => {
    const status: A2AStatus = {
      state: 'failed',
      message: { role: 'agent', parts: [{ type: 'text', text: 'upstream 503' }] },
    }
    const decoded = decodeStatus(encodeStatus(status))
    expect(decoded.state).toBe('failed')
    expect(decoded.message?.parts[0]).toEqual({ type: 'text', text: 'upstream 503' })
  })

  it('encodes and decodes AgentCard', () => {
    expect(decodeAgentCard(encodeAgentCard(sampleCard))).toEqual(sampleCard)
  })

  it('round-trips SendMessage request envelope', () => {
    const req = {
      message: sampleMessage,
      contextId: 'ctx-1',
      metadata: { traceId: 't-1' },
    }
    const decoded = decodeSendMessageRequest(encodeSendMessageRequest(req))
    expect(decoded.message).toEqual(sampleMessage)
    expect(decoded.contextId).toBe('ctx-1')
    expect(decoded.metadata).toEqual({ traceId: 't-1' })
  })

  it('round-trips SendMessage response envelope', () => {
    const res = {
      task: {
        id: 'task-1',
        contextId: 'ctx-1',
        status: sampleStatus,
        artifacts: [],
        history: [sampleMessage],
      },
    }
    const decoded = decodeSendMessageResponse(encodeSendMessageResponse(res))
    expect(decoded.task.id).toBe('task-1')
    expect(decoded.task.history).toHaveLength(1)
  })

  it('round-trips TaskList response with cursor', () => {
    const res = {
      tasks: [
        { id: 't1', contextId: 'c1', status: sampleStatus, artifacts: [], history: [] },
      ],
      nextPageToken: 'cursor-abc',
    }
    const decoded = decodeTaskListResponse(encodeTaskListResponse(res))
    expect(decoded.tasks[0].id).toBe('t1')
    expect(decoded.nextPageToken).toBe('cursor-abc')
  })
})

describe('A2A codec — validation rejection', () => {
  it('rejects non-JSON message body', () => {
    expect(() => decodeMessage('not-json{')).toThrow(BizGraphError)
    try {
      decodeMessage('not-json{')
    } catch (err) {
      expect((err as BizGraphError).code).toBe(ErrorCode.A2A_BAD_REQUEST)
    }
  })

  it('rejects message with missing role', () => {
    expect(() => decodeMessage(JSON.stringify({ parts: [] }))).toThrow(/role/)
  })

  it('rejects message with invalid role', () => {
    expect(() => decodeMessage(JSON.stringify({ role: 'system', parts: [] }))).toThrow(/role/)
  })

  it('rejects message with non-array parts', () => {
    expect(() => decodeMessage(JSON.stringify({ role: 'user', parts: 'oops' }))).toThrow(/parts/)
  })

  it('rejects part with unknown type', () => {
    expect(() =>
      decodeMessage(JSON.stringify({ role: 'user', parts: [{ type: 'video', url: 'x' }] })),
    ).toThrow(/part type/)
  })

  it('rejects TextPart with non-string text', () => {
    expect(() =>
      decodeMessage(JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 42 }] })),
    ).toThrow(/text/)
  })

  it('rejects FilePart with missing mimeType', () => {
    expect(() =>
      decodeMessage(JSON.stringify({ role: 'user', parts: [{ type: 'file' }] })),
    ).toThrow(/mimeType/)
  })

  it('rejects DataPart with non-object data', () => {
    expect(() =>
      decodeMessage(JSON.stringify({ role: 'user', parts: [{ type: 'data', data: 'no' }] })),
    ).toThrow(/data/)
  })

  it('rejects status with invalid state', () => {
    expect(() => decodeStatus(JSON.stringify({ state: 'nope' }))).toThrow(/state/)
  })

  it('rejects agent card missing a2aVersion', () => {
    const card = { ...sampleCard, a2aVersion: undefined as never }
    expect(() => decodeAgentCard(JSON.stringify(card))).toThrow(/a2aVersion/)
  })

  it('rejects artifact missing name', () => {
    expect(() => decodeArtifact(JSON.stringify({ parts: [] }))).toThrow(/name/)
  })

  it('rejects task list missing tasks array', () => {
    expect(() => decodeTaskListResponse('{}')).toThrow(/tasks/)
  })
})

describe('A2A codec — SSE framing', () => {
  it('formatSseEvent produces spec-compliant wire bytes', () => {
    const ev = {
      event: 'artifact',
      data: JSON.stringify({ hello: 'world' }),
      id: '42',
    }
    const out = formatSseEvent(ev)
    // Field order is implementation-defined; SSE spec permits any order.
    expect(out).toContain('event: artifact\n')
    expect(out).toContain('id: 42\n')
    expect(out).toContain('data: {"hello":"world"}\n')
    expect(out.endsWith('\n\n')).toBe(true)
  })

  it('formatSseEvent splits multi-line data into multiple data: lines', () => {
    const out = formatSseEvent({ data: 'line1\nline2\nline3' })
    expect(out).toBe('data: line1\ndata: line2\ndata: line3\n\n')
  })

  it('formatArtifactEvent uses SSE_EVENT_ARTIFACT', () => {
    const out = formatArtifactEvent(sampleArtifact)
    expect(out.startsWith(`event: ${SSE_EVENT_ARTIFACT}\n`)).toBe(true)
    expect(out.endsWith('\n\n')).toBe(true)
    expect(out).toContain('data: {"name":"summary"')
  })

  it('formatStatusEvent uses SSE_EVENT_STATUS', () => {
    const out = formatStatusEvent(sampleStatus)
    expect(out.startsWith(`event: ${SSE_EVENT_STATUS}\n`)).toBe(true)
    expect(out).toContain('"state":"working"')
  })

  it('formatMessageEvent uses SSE_EVENT_MESSAGE', () => {
    const out = formatMessageEvent(sampleMessage)
    expect(out.startsWith(`event: ${SSE_EVENT_MESSAGE}\n`)).toBe(true)
  })

  it('formatSseKeepalive produces a comment line', () => {
    const out = formatSseKeepalive()
    expect(out).toBe(': keepalive\n\n')
  })

  it('parseSseChunk extracts a single event', () => {
    const wire = formatArtifactEvent(sampleArtifact)
    const { events, rest } = parseSseChunk('', wire)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe(SSE_EVENT_ARTIFACT)
    expect(rest).toBe('')
  })

  it('parseSseChunk extracts multiple events from concatenated stream', () => {
    const wire =
      formatStatusEvent(sampleStatus) +
      formatArtifactEvent(sampleArtifact) +
      formatStatusEvent({ state: 'completed' })
    const { events } = parseSseChunk('', wire)
    expect(events).toHaveLength(3)
    expect(events[0].event).toBe(SSE_EVENT_STATUS)
    expect(events[1].event).toBe(SSE_EVENT_ARTIFACT)
    expect(events[2].event).toBe(SSE_EVENT_STATUS)
  })

  it('parseSseChunk handles partial buffer split (event: line straddles two reads)', () => {
    // First read: arrives mid-record. Second read: completes it.
    const wire = formatArtifactEvent(sampleArtifact)
    // Split between 'data:' and the actual JSON content
    const splitPoint = wire.indexOf('data: ') + 'data: '.length
    const first = wire.slice(0, splitPoint)
    const second = wire.slice(splitPoint)

    const r1 = parseSseChunk('', first)
    expect(r1.events).toHaveLength(0)
    expect(r1.rest).toBe(first) // still buffered

    const r2 = parseSseChunk(r1.rest, second)
    expect(r2.events).toHaveLength(1)
    expect(r2.rest).toBe('')
  })

  it('parseSseChunk returns residual bytes after last record', () => {
    const partial = 'event: artifact\ndata: {"name":"x"}\n'
    // No trailing '\n\n' yet — incomplete record.
    const { events, rest } = parseSseChunk('', partial)
    expect(events).toHaveLength(0)
    expect(rest).toBe(partial)
  })

  it('parseSseChunk tolerates CRLF line endings', () => {
    const wire = formatArtifactEvent(sampleArtifact).replace(/\n/g, '\r\n')
    const { events } = parseSseChunk('', wire)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe(SSE_EVENT_ARTIFACT)
  })

  it('parseSseChunk skips comment lines without yielding an event', () => {
    const wire = formatSseKeepalive() + formatArtifactEvent(sampleArtifact)
    const { events } = parseSseChunk('', wire)
    // keepalive produces no event (no `data:` field)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe(SSE_EVENT_ARTIFACT)
  })

  it('parseSseChunk strips one leading space from value (SSE spec rule)', () => {
    const wire = 'event: status\ndata: {"state":"working"}\n\n'
    const { events } = parseSseChunk('', wire)
    expect(events[0].data).toBe('{"state":"working"}')
  })
})
