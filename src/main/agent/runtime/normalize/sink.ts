/**
 * D3：归一化事件 sink。seq 由宿主角标分配（turn 内从 1 连续）。
 * 不在 sink 里校验连续性 —— 连续性由测试断言。
 */

import type {
  EventSource,
  Fidelity,
  NormalizedEventEnvelope,
  NormalizedEventType,
} from '@shared/types/agent-runtime'
import { eventIdFor } from '../util'

export interface NormalizeMeta {
  runId: string
  turnId: string
  sessionId: string
  /** 事件时间戳起点（测试可注入固定值） */
  baseTimestamp?: number
}

export interface EmitInput {
  type: NormalizedEventType
  fidelity: Fidelity
  source: EventSource
  payload?: Record<string, unknown>
  stepId?: string
}

export class EventSink {
  private seq = 0
  private readonly events: NormalizedEventEnvelope[] = []
  private readonly meta: NormalizeMeta
  /**
   * 只有测试显式注入 baseTimestamp 时才用固定时钟；运行时必须走真实时钟。
   * 之前的 `?? 1_760_000_000_000` 把测试夹具泄漏进了生产路径，导致事件时间戳被钉死。
   */
  private readonly baseTs: number | null

  constructor(meta: NormalizeMeta) {
    this.meta = meta
    this.baseTs = meta.baseTimestamp ?? null
  }

  emit(input: EmitInput): NormalizedEventEnvelope {
    this.seq += 1
    const event: NormalizedEventEnvelope = {
      eventId: eventIdFor(this.meta.turnId, this.seq),
      runId: this.meta.runId,
      turnId: this.meta.turnId,
      seq: this.seq,
      type: input.type,
      source: input.source,
      fidelity: input.fidelity,
      payloadVersion: 1,
      payload: input.payload ?? {},
      timestamp: this.baseTs === null ? Date.now() : this.baseTs + this.seq,
      stepId: input.stepId,
    }
    this.events.push(event)
    return event
  }

  snapshot(): NormalizedEventEnvelope[] {
    return [...this.events]
  }
}
