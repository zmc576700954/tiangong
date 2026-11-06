/**
 * P0-2：agent_events 保留策略。
 *
 * 覆盖：终态 turn 过期删除、非终态/待审批/人工保留永不删、90 天边界、
 * 分批上限、stepOutcomes 不可对账时跳过留痕、存储统计与真实行数一致。
 */

import { describe, expect, it } from 'vitest'
import { AgentRuntime } from '../runtime'
import { AgentRepository } from '../db/repository'
import { UsageLedger } from '../cost/ledger'
import { openTestDb } from './helpers/test-db'
import type { NormalizedEventEnvelope } from '@shared/types/agent-runtime'

const DAY_MS = 24 * 60 * 60 * 1000

function seedTerminalTurn(
  repo: AgentRepository,
  options: {
    status?: 'completed' | 'failed' | 'cancelled' | 'orphaned' | 'running' | 'waiting_approval'
    eventCount?: number
    eventAgeMs?: number
    stepStatus?: 'done' | 'running' | 'unknown'
  } = {},
) {
  const run = repo.insertRun({ threadId: 't', nodeId: 'n', graphId: 'g', executor: 'claude-code' })
  const session = repo.insertSession({ executor: 'claude-code', status: 'active' })
  const turn = repo.insertTurn({
    runId: run.id,
    sessionId: session.id,
    nodeId: 'n',
    resumeMode: 'native',
    idempotencyKey: `k-${run.id}`,
    input: {},
  })
  repo.updateTurnStatus(turn.id, options.status ?? 'completed')

  if (options.stepStatus) {
    repo.upsertStep({
      id: `step-${turn.id}`,
      turnId: turn.id,
      kind: 'tool',
      toolName: 'Write',
      status: options.stepStatus,
      fidelity: 'turn',
    })
  }

  const age = options.eventAgeMs ?? 100 * DAY_MS
  const count = options.eventCount ?? 3
  const now = Date.now()
  const events: NormalizedEventEnvelope[] = Array.from({ length: count }, (_, index) => ({
    eventId: `evt-${turn.id}-${index}`,
    runId: run.id,
    turnId: turn.id,
    seq: index + 1,
    type: 'tool.result',
    source: 'kernel' as const,
    fidelity: 'turn' as const,
    payloadVersion: 1,
    payload: { index },
    timestamp: now - age,
  }))
  repo.appendEvents(events)
  return { run, session, turn }
}

function countRows(db: ReturnType<typeof openTestDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('agent_events 保留策略（P0-2）', () => {
  it('100 天前的终态 turn 事件被删；agent_usage / agent_approvals 行数不变', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const ledger = new UsageLedger(db, { version: 'test', entries: [] }, [])

    const old = seedTerminalTurn(repo)
    repo.insertApproval({
      runId: old.run.id,
      turnId: old.turn.id,
      toolName: 'Write',
      argsJson: '{}',
      argsHash: 'h1',
      risk: 'high',
      status: 'allowed',
      expiresAt: Date.now() + 1000,
      mode: 'interactive',
      timeoutMs: 1000,
    })
    ledger.record({
      turnId: old.turn.id,
      sessionId: old.session.id,
      executor: 'claude-code',
      source: 'provider',
      dedupeKey: `turn:${old.turn.id}`,
    })

    const beforeUsage = countRows(db, 'agent_usage')
    const beforeApprovals = countRows(db, 'agent_approvals')
    const beforeEvents = countRows(db, 'agent_events')

    const result = repo.runEventRetention()
    expect(result.deletedRows).toBe(3)
    expect(countRows(db, 'agent_events')).toBe(beforeEvents - 3)
    expect(countRows(db, 'agent_usage')).toBe(beforeUsage)
    expect(countRows(db, 'agent_approvals')).toBe(beforeApprovals)
  })

  it('未终态 turn 的事件即使超期也不删', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    seedTerminalTurn(repo, { status: 'running' })

    const result = repo.runEventRetention()
    expect(result.deletedRows).toBe(0)
    expect(result.skipped).toContainEqual(expect.objectContaining({ reason: 'not-terminal' }))
    expect(countRows(db, 'agent_events')).toBe(3)
  })

  it('有待审批准的 turn 事件即使超期也不删', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const seeded = seedTerminalTurn(repo, { status: 'completed' })
    repo.insertApproval({
      runId: seeded.run.id,
      turnId: seeded.turn.id,
      toolName: 'Bash',
      argsJson: '{}',
      argsHash: 'h2',
      risk: 'critical',
      status: 'pending',
      expiresAt: Date.now() + 1000,
      mode: 'interactive',
      timeoutMs: 1000,
    })

    const result = repo.runEventRetention()
    expect(result.deletedRows).toBe(0)
    expect(result.skipped).toContainEqual(expect.objectContaining({ reason: 'pending-approval' }))
  })

  it('续接锚点：run.started 永不清理，其余过期事件照常删除，backendSessionId 仍可读', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const seeded = seedTerminalTurn(repo, { eventAgeMs: 400 * DAY_MS })
    // 在过期事件里加入续接锚点（与真实 normalize 产出的一致）
    repo.appendEvents([
      {
        eventId: `anchor-${seeded.turn.id}`,
        runId: seeded.run.id,
        turnId: seeded.turn.id,
        seq: 99,
        type: 'run.started',
        source: 'backend',
        fidelity: 'turn',
        payloadVersion: 1,
        payload: { backendSessionId: 'claude-conversation-abc' },
        timestamp: Date.now() - 400 * DAY_MS,
      },
    ])

    const result = repo.runEventRetention()
    // 只删掉 3 条非锚点事件；run.started 保留
    expect(result.deletedRows).toBe(3)
    const remaining = repo.listTurnEvents(seeded.turn.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].type).toBe('run.started')
    expect(repo.getLatestBackendSessionId(seeded.session.id)).toBe('claude-conversation-abc')
  })

  it('90 天边界：89 天保留、91 天删除', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const keep = seedTerminalTurn(repo, { eventAgeMs: 89 * DAY_MS })
    const drop = seedTerminalTurn(repo, { eventAgeMs: 91 * DAY_MS })

    const result = repo.runEventRetention()
    expect(result.deletedRows).toBe(3)
    expect(repo.listTurnEvents(keep.turn.id)).toHaveLength(3)
    expect(repo.listTurnEvents(drop.turn.id)).toHaveLength(0)
  })

  it('分批删除：每批 ≤500 行，且不会一次性删除全部', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    seedTerminalTurn(repo, { eventCount: 1200 })

    // 配置 2000 也会被硬上限压到 500
    const result = repo.runEventRetention({ retentionDays: 90, batchSize: 2000 })
    expect(result.batchSize).toBe(500)
    expect(result.deletedRows).toBe(1200)
    expect(result.batches).toBe(3)
  })

  it('可对账的终态 turn 正常清理；stepOutcomes 不可对账的 turn 被跳过并留痕', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const reconcilable = seedTerminalTurn(repo, { stepStatus: 'done' })
    const unsettled = seedTerminalTurn(repo, { stepStatus: 'running' })

    const result = repo.runEventRetention()
    expect(result.deletedRows).toBe(3)
    expect(repo.listTurnEvents(reconcilable.turn.id)).toHaveLength(0)
    expect(repo.listTurnEvents(unsettled.turn.id)).toHaveLength(3)
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ turnId: unsettled.turn.id, reason: 'irreconcilable' }),
    )
  })

  it('getStorageStats 的行数与时间跨度与真实数据一致', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const seeded = seedTerminalTurn(repo, { eventCount: 3, eventAgeMs: 120 * DAY_MS })
    const seededEvents = repo.listTurnEvents(seeded.turn.id)
    const oldest = Math.min(...seededEvents.map((event) => event.created_at))
    const newest = Date.now() - 110 * DAY_MS
    // 追加一条较新事件，校验 MAX(created_at)
    repo.appendEvents([
      {
        eventId: `evt-${seeded.turn.id}-newest`,
        runId: seeded.run.id,
        turnId: seeded.turn.id,
        seq: 4,
        type: 'tool.result',
        source: 'kernel',
        fidelity: 'turn',
        payloadVersion: 1,
        payload: {},
        timestamp: newest,
      },
    ])

    const stats = repo.getEventStorageStats()
    expect(stats.eventRows).toBe(countRows(db, 'agent_events'))
    expect(stats.oldestEventAt).toBe(oldest)
    expect(stats.newestEventAt).toBe(newest)
    expect(stats.estimatedBytes).toBeGreaterThan(0)
    expect(['dbstat', 'payload']).toContain(stats.estimation)
  })

  it('运行时执行清理后写入一条 retention.cleanup 系统事件，且策略可透出', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    seedTerminalTurn(repo, { status: 'completed', eventCount: 2 })

    const runtime = new AgentRuntime({ db, repo, retention: { retentionDays: 90, batchSize: 500 } })
    const result = runtime.runEventRetentionNow()
    expect(result.deletedRows).toBe(2)

    const systemRows = db
      .prepare(`SELECT payload_json FROM agent_events WHERE type = 'retention.cleanup'`)
      .all() as Array<{ payload_json: string }>
    expect(systemRows).toHaveLength(1)
    expect(JSON.parse(systemRows[0].payload_json)).toMatchObject({ deletedRows: 2, retentionDays: 90 })

    const stats = runtime.getStorageStats()
    expect(stats.retentionDays).toBe(90)
    expect(stats.batchSize).toBe(500)
    expect(stats.eventRows).toBe(countRows(db, 'agent_events'))
    runtime.dispose()
  })
})
