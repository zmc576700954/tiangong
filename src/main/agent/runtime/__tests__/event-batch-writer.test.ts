/**
 * W5-A 定向：事件分级批写。
 *
 * 验收点：
 * - 语义关键事件同步落库（不经过缓冲）；
 * - `message.delta` 50ms 批量、单批封顶；
 * - 关键事件前先 flush，落库顺序 = 产生顺序；
 * - `shutdown()` 强制 flush（优雅退出零丢失）；
 * - 关闭开关回到全同步模式；
 * - seq 连续无乱序。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'
import { AgentRepository } from '../db/repository'
import { EventBatchWriter, isHighFrequencyEvent } from '../event-batch-writer'
import { openTestDb } from './helpers/test-db'

function makeEvent(
  runId: string,
  turnId: string,
  seq: number,
  type: NormalizedEventEnvelope['type'],
  fidelity: NormalizedEventEnvelope['fidelity'] = 'turn',
): NormalizedEventEnvelope {
  return {
    eventId: `${turnId}:${seq}`,
    runId,
    turnId,
    seq,
    type,
    source: 'kernel',
    fidelity,
    payloadVersion: 1,
    payload: { seq },
    timestamp: 1000 + seq,
  }
}

describe('EventBatchWriter', () => {
  let db: BetterSqlite3.Database
  let repo: AgentRepository

  beforeEach(() => {
    db = openTestDb()
    repo = new AgentRepository(db)
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  it('writes semantic events synchronously', () => {
    const writer = new EventBatchWriter({ repo, flushIntervalMs: 50 })
    writer.write([makeEvent('r1', 't1', 1, 'run.started')])
    expect(repo.listEvents('r1')).toHaveLength(1)
    expect(writer.pendingCount()).toBe(0)
    writer.shutdown()
  })

  it('batches message.delta and flushes after the interval', async () => {
    const writer = new EventBatchWriter({ repo, flushIntervalMs: 50 })
    writer.write([makeEvent('r1', 't1', 1, 'message.delta', 'token')])
    expect(repo.listEvents('r1')).toHaveLength(0)
    expect(writer.pendingCount()).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(repo.listEvents('r1')).toHaveLength(1)
    expect(writer.pendingCount()).toBe(0)
    writer.shutdown()
  })

  it('flushes immediately when a batch reaches the cap', () => {
    const writer = new EventBatchWriter({ repo, flushIntervalMs: 1000, maxBatchEvents: 3 })
    for (let seq = 1; seq <= 4; seq += 1) {
      writer.write([makeEvent('r1', 't1', seq, 'message.delta', 'token')])
    }
    // 前 3 条到达封顶立即落库，第 4 条仍在缓冲。
    expect(repo.listEvents('r1')).toHaveLength(3)
    expect(writer.pendingCount()).toBe(1)
    writer.shutdown()
    expect(repo.listEvents('r1')).toHaveLength(4)
  })

  it('flush() and shutdown() force pending events to disk', () => {
    const writer = new EventBatchWriter({ repo, flushIntervalMs: 1000 })
    writer.write([
      makeEvent('r1', 't1', 1, 'message.delta', 'token'),
      makeEvent('r1', 't1', 2, 'reasoning.delta', 'token'),
    ])
    expect(writer.pendingCount()).toBe(2)
    writer.shutdown()
    expect(writer.pendingCount()).toBe(0)
    expect(repo.listEvents('r1')).toHaveLength(2)
  })

  it('full-sync mode writes deltas immediately', () => {
    const writer = new EventBatchWriter({ repo, enabled: false })
    writer.write([makeEvent('r1', 't1', 1, 'message.delta', 'token')])
    expect(repo.listEvents('r1')).toHaveLength(1)
    expect(writer.isEnabled()).toBe(false)
    writer.shutdown()
  })

  it('critical events flush buffered deltas first and keep seq order', () => {
    const writer = new EventBatchWriter({ repo, flushIntervalMs: 1000 })
    writer.write([makeEvent('r1', 't1', 1, 'run.started')])
    for (let seq = 2; seq <= 6; seq += 1) {
      writer.write([makeEvent('r1', 't1', seq, 'message.delta', 'token')])
    }
    writer.write([makeEvent('r1', 't1', 7, 'turn.completed')])

    const events = repo.listEvents('r1')
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(events.map((event) => event.turn_seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(events[6].type).toBe('turn.completed')
    writer.shutdown()
  })

  it('graceful shutdown loses no events and keeps seq contiguous', () => {
    const writer = new EventBatchWriter({ repo, flushIntervalMs: 1000, maxBatchEvents: 1000 })
    const events: NormalizedEventEnvelope[] = [makeEvent('r1', 't1', 1, 'run.started')]
    for (let seq = 2; seq <= 101; seq += 1) {
      events.push(makeEvent('r1', 't1', seq, 'message.delta', 'token'))
    }
    writer.write(events)
    expect(repo.listEvents('r1')).toHaveLength(1)
    writer.shutdown()

    const stored = repo.listEvents('r1')
    expect(stored).toHaveLength(101)
    expect(stored.map((event) => event.seq)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1))
  })

  it('reports the written events to the realtime/turn callback', () => {
    const written: Array<{ type: string; seq: number }> = []
    const writer = new EventBatchWriter({
      repo,
      flushIntervalMs: 1000,
      onWritten: (events, assigned) => {
        events.forEach((event, index) => written.push({ type: event.type, seq: assigned[index] }))
      },
    })
    writer.write([
      makeEvent('r1', 't1', 1, 'run.started'),
      makeEvent('r1', 't1', 2, 'message.delta', 'token'),
      makeEvent('r1', 't1', 3, 'turn.completed'),
    ])
    expect(written.map((item) => item.type)).toEqual(['run.started', 'message.delta', 'turn.completed'])
    expect(written.map((item) => item.seq)).toEqual([1, 2, 3])
    writer.shutdown()
  })

  it('classifies only .delta events as high frequency', () => {
    expect(isHighFrequencyEvent(makeEvent('r1', 't1', 1, 'message.delta', 'token'))).toBe(true)
    expect(isHighFrequencyEvent(makeEvent('r1', 't1', 2, 'reasoning.delta', 'token'))).toBe(true)
    expect(isHighFrequencyEvent(makeEvent('r1', 't1', 3, 'turn.completed'))).toBe(false)
    expect(isHighFrequencyEvent(makeEvent('r1', 't1', 4, 'approval.resolved'))).toBe(false)
    expect(isHighFrequencyEvent(makeEvent('r1', 't1', 5, 'tool.requested'))).toBe(false)
  })
})
