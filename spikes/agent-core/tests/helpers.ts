import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { RunRepository } from '../src/db/repository'
import {
  CHECKPOINT_TYPES,
  type AgentEventEnvelope,
  type AgentEventType,
  type EventFidelity,
  type RunStatus,
} from '../src/types'

export const SPIKE_ROOT = fileURLToPath(new URL('..', import.meta.url))

export function fixturePath(...parts: string[]): string {
  return path.join(SPIKE_ROOT, 'fixtures', ...parts)
}

export function loadJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function loadJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

export function loadText(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

export function checkpointTypes(events: AgentEventEnvelope[]): AgentEventType[] {
  return events.filter((event) => CHECKPOINT_TYPES.has(event.type)).map((event) => event.type)
}

/** 断言 seq 从 1 连续无断号；断号时抛出，便于 sabotage 运行变红 */
export function assertContiguousSeq(events: AgentEventEnvelope[]): void {
  const seqs = events.map((e) => e.seq)
  const expected = seqs.map((_, index) => index + 1)
  if (seqs.join(',') !== expected.join(',')) {
    throw new Error(`seq not contiguous: actual=[${seqs.join(',')}] expected=[${expected.join(',')}]`)
  }
}

export function assertOwnership(
  events: AgentEventEnvelope[],
  expected: { runId: string; turnId: string; backendName: string },
): void {
  for (const event of events) {
    if (
      event.runId !== expected.runId ||
      event.turnId !== expected.turnId ||
      event.backend.name !== expected.backendName
    ) {
      throw new Error(
        `ownership mismatch: event=${event.eventId} run=${event.runId} turn=${event.turnId} backend=${event.backend.name}`,
      )
    }
  }
}

export function fidelityOf(events: AgentEventEnvelope[]): Set<EventFidelity> {
  return new Set(events.map((event) => event.fidelity))
}

export function makeEnvelope(input: {
  runId: string
  turnId: string
  seq: number
  type: AgentEventType
  payload?: unknown
  fidelity?: EventFidelity
  backend?: string
  source?: AgentEventEnvelope['source']
}): AgentEventEnvelope {
  return {
    eventId: `${input.runId}#${input.turnId}#${input.seq}`,
    runId: input.runId,
    seq: input.seq,
    turnId: input.turnId,
    type: input.type,
    ts: 1_760_000_000_000 + input.seq,
    payload: input.payload ?? {},
    source: input.source ?? 'backend',
    fidelity: input.fidelity ?? 'token',
    backend: { name: input.backend ?? 'claude-code' },
  }
}

export function seedRun(
  repo: RunRepository,
  input: {
    runId: string
    nodeId?: string
    backend?: 'claude-code' | 'codex' | 'opencode'
    status?: RunStatus
    threadId?: string
    backendSessionId?: string
  },
): void {
  const backend = input.backend ?? 'claude-code'
  repo.createRun({
    id: input.runId,
    threadId: input.threadId ?? 'thread-1',
    nodeId: input.nodeId ?? 'node-1',
    backend,
    backendSessionId: input.backendSessionId,
    loopOwnership: backend === 'opencode' ? 'host' : 'backend',
    idempotencyKey: `idem-${input.runId}`,
    status: input.status ?? 'running',
  })
}

/** 写入 run.started → message.completed → tool.requested，返回下一个 seq */
export function seedRunEvents(
  repo: RunRepository,
  input: {
    runId: string
    turnId: string
    backend?: 'claude-code' | 'codex' | 'opencode'
    toolInput?: unknown
  },
): number {
  const backend = input.backend ?? 'claude-code'
  const fidelity: EventFidelity =
    backend === 'codex' ? 'turn' : backend === 'opencode' ? 'session' : 'token'
  const base = { runId: input.runId, turnId: input.turnId, backend, fidelity }
  repo.appendEvent(
    makeEnvelope({
      ...base,
      seq: 1,
      type: 'run.started',
      payload: { attempt: 1, resumeMode: 'fresh' },
    }),
  )
  repo.appendEvent(
    makeEnvelope({
      ...base,
      seq: 2,
      type: 'message.completed',
      payload: { role: 'assistant', text: 'I will write the file.', mode: 'block' },
    }),
  )
  repo.appendEvent(
    makeEnvelope({
      ...base,
      seq: 3,
      type: 'tool.requested',
      payload: {
        toolCallId: `call-${input.runId}`,
        toolName: 'Write',
        input: input.toolInput ?? { path: 'src/math.ts' },
        risk: 'high',
        blocking: true,
      },
    }),
  )
  return 4
}
