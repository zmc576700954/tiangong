/**
 * W5-A：事件分级批写。
 *
 * 目标与边界（agent-architecture.md §W5）：
 * - 语义关键事件（run/turn 生命周期、审批决定、进度审计）**同步落库**，绝不进缓冲；
 * - `message.delta` / `reasoning.delta` 类高频事件按 50ms 批量、单批封顶；
 * - 关键事件写入前先 flush 已缓存的高频事件，保证「落库顺序 = 产生顺序」；
 * - `shutdown()` 强制 flush，退出路径不允许有未落盘事件；
 * - `enabled=false` 或环境变量 `BIZGRAPH_EVENT_BATCH_WRITER=0` 时切回全同步模式。
 *
 * 注意：seq 的 run 级分配仍在 `AgentRepository.appendEvents` 的单事务里完成，
 * 本模块只改变「何时写入」，不改变「如何分配 seq」。
 */

import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import type { AgentRepository } from './db/repository'
import { createLogger } from '../../shared/logger'

export const EVENT_BATCH_WRITER_ENV = 'BIZGRAPH_EVENT_BATCH_WRITER'
/** 高频事件默认批写间隔。 */
export const DEFAULT_EVENT_FLUSH_INTERVAL_MS = 50
/** 单批默认封顶（超过即立即 flush，不等定时器）。 */
export const DEFAULT_EVENT_MAX_BATCH = 200

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

/** 开关默认开启；显式关闭值回到全同步模式。 */
export function isEventBatchWriterEnabled(raw = process.env[EVENT_BATCH_WRITER_ENV]): boolean {
  if (raw === undefined || raw.trim() === '') return true
  const value = raw.trim().toLowerCase()
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  return true
}

/**
 * 高频事件判定：只有流式增量进入批处理。
 * 其它事件（含 tool.requested / usage.updated / 审批审计）一律同步。
 */
export function isHighFrequencyEvent(event: NormalizedEventEnvelope): boolean {
  return event.type.endsWith('.delta')
}

export interface EventBatchWriterOptions {
  repo: AgentRepository
  /** false = 全同步模式（回滚开关）。缺省读取环境变量，默认开启。 */
  enabled?: boolean
  /** 高频事件批写间隔（默认 50ms）。 */
  flushIntervalMs?: number
  /** 单批封顶（默认 200）。 */
  maxBatchEvents?: number
  /** 落库成功后回调（实时旁路 onEvent / step 投影）。 */
  onWritten?: (events: NormalizedEventEnvelope[], assignedSeqs: number[]) => void
  /** 测试注入时钟（不影响 appendEvents 内部）。 */
  now?: () => number
}

export class EventBatchWriter {
  private readonly repo: AgentRepository
  private readonly enabled: boolean
  private readonly flushIntervalMs: number
  private readonly maxBatchEvents: number
  private readonly onWritten:
    | ((events: NormalizedEventEnvelope[], assignedSeqs: number[]) => void)
    | undefined
  private readonly logger = createLogger('EventBatchWriter')
  private buffer: NormalizedEventEnvelope[] = []
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(options: EventBatchWriterOptions) {
    this.repo = options.repo
    this.enabled = options.enabled ?? isEventBatchWriterEnabled()
    this.flushIntervalMs =
      typeof options.flushIntervalMs === 'number' && options.flushIntervalMs >= 0
        ? options.flushIntervalMs
        : DEFAULT_EVENT_FLUSH_INTERVAL_MS
    this.maxBatchEvents =
      typeof options.maxBatchEvents === 'number' && options.maxBatchEvents > 0
        ? Math.floor(options.maxBatchEvents)
        : DEFAULT_EVENT_MAX_BATCH
    this.onWritten = options.onWritten
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 当前缓存但尚未落盘的事件数（诊断/测试用）。 */
  pendingCount(): number {
    return this.buffer.length
  }

  /**
   * 写入一批事件（保持入参顺序）。
   * 关键事件会先 flush 缓冲，再同步落库；高频事件进入缓冲。
   */
  write(events: NormalizedEventEnvelope[]): void {
    if (events.length === 0) return
    if (this.closed) {
      // shutdown 之后仍到达的写入不静默丢弃：同步落库是最安全的退化。
      this.writeBatch(events)
      return
    }
    for (const event of events) {
      if (this.enabled && isHighFrequencyEvent(event)) {
        this.buffer.push(event)
        if (this.buffer.length >= this.maxBatchEvents) {
          this.flush()
        } else {
          this.schedule()
        }
        continue
      }
      // 语义关键事件：先保证缓存里的高频事件按序落库，再写自己。
      this.flush()
      this.writeBatch([event])
    }
  }

  /** 立即落盘所有缓存事件（幂等）。 */
  flush(): void {
    this.clearTimer()
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    this.writeBatch(batch)
  }

  /**
   * 强制 flush 并停止定时器。退出路径调用；之后到达的事件退化为同步写。
   */
  shutdown(): void {
    this.flush()
    this.clearTimer()
    this.closed = true
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.flush()
      } catch (error) {
        this.logger.error(`event batch flush failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * `appendEvents` 要求单 runId 批；按连续同 run 分段写入，
   * 既满足约束又不打乱同一 run 内的顺序。
   */
  private writeBatch(batch: NormalizedEventEnvelope[]): void {
    if (batch.length === 0) return
    let start = 0
    for (let index = 1; index <= batch.length; index += 1) {
      if (index < batch.length && batch[index].runId === batch[start].runId) continue
      const segment = batch.slice(start, index)
      const assigned = this.repo.appendEvents(segment)
      this.onWritten?.(segment, assigned)
      start = index
    }
  }
}
