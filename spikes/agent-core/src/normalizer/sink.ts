import { createHash } from 'node:crypto'
import { mutation } from '../mutation'
import type {
  AgentEventEnvelope,
  AgentEventType,
  EventFidelity,
  EventPayload,
  EventSource,
  NormalizeMeta,
} from '../types'

export function hashArgs(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

export interface EmitInput {
  type: AgentEventType
  fidelity: EventFidelity
  source: EventSource
  payload?: EventPayload
  stepId?: string
  nativeType?: string
  backendSessionId?: string
  backendName: string
}

/**
 * 宿主侧 sink：seq 由宿主按 run 分配（新文档 §2.2）。
 * 不在这里校验连续性——校验属于 RunStore，这样 sabotaged sink 才能产出断号日志供测试抓到。
 */
export class EventSink {
  private seq = 0
  private readonly events: AgentEventEnvelope[] = []
  private readonly meta: NormalizeMeta
  private readonly baseTs: number

  constructor(meta: NormalizeMeta, baseTs = 1_760_000_000_000) {
    this.meta = meta
    this.baseTs = baseTs
  }

  emit(input: EmitInput): AgentEventEnvelope | undefined {
    if (
      mutation() === 'drop-tool-events' &&
      (input.type === 'tool.requested' || input.type === 'tool.result')
    ) {
      return undefined
    }

    let next = this.seq + 1
    if (mutation() === 'seq-gap' && this.seq === 2) next = this.seq + 2
    this.seq = next

    const event: AgentEventEnvelope = {
      eventId: `${this.meta.runId}#${this.meta.turnId}#${next}`,
      runId: this.meta.runId,
      seq: next,
      turnId: this.meta.turnId,
      stepId: input.stepId,
      type: input.type,
      ts: this.baseTs + next,
      payload: input.payload ?? {},
      source: input.source,
      fidelity: input.fidelity,
      backend: {
        name: input.backendName,
        sessionId: input.backendSessionId ?? this.meta.sessionId,
        nativeType: input.nativeType,
      },
    }
    this.events.push(event)
    return event
  }

  snapshot(): AgentEventEnvelope[] {
    return [...this.events]
  }
}
