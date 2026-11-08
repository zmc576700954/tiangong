/**
 * v36 / W3 G3-6～G3-9：超时预算解析与执行消费点回归。
 *
 * 覆盖：默认值不变、sendWaitMs clamp ≥ turnMs+30s、stepMs 写 deadline_at、
 * tick 前置扫描把过期 run 收口为 timed_out、taskMs 以最早 started_at 起算。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import { WorkItemService } from '../map/work-item-service'
import { WorkStepService } from '../map/work-step-service'
import { WorkRunService } from '../map/work-run-service'
import { WorkScheduler } from '../map/work-scheduler'
import {
  type AgentTurnRunner,
  type AgentTurnRunInput,
  type AgentTurnSessionHandle,
  type AgentTurnSignal,
  type AgentTurnStartInput,
} from '../map/agent-step-runner'
import { WorkExecutionService } from '../map/work-execution-service'
import type { GateRecheck } from '../map/gate-recheck'
import { DEFAULT_AGENT_TIMEOUTS } from '@shared/types/agent-runtime'
import { resolveAgentTimeouts, SEND_WAIT_OVER_TURN_MS } from '../agent/timeout-config'

class FakeTurns implements AgentTurnRunner {
  async startSession(input: AgentTurnStartInput): Promise<AgentTurnSessionHandle> {
    return { sessionId: 's-1', adapterUsed: input.adapterName }
  }
  async runTurn(_input: AgentTurnRunInput): Promise<AgentTurnSignal> {
    return { status: 'completed' }
  }
  async terminateSession(): Promise<void> {
    /* no-op */
  }
}

const okGate: GateRecheck = { recheck: () => ({ ok: true, missing: [] }) }
const capableProbe = { kernel: true, runtime: true, driver: true, reason: 'test-capable' }

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  return db
}

describe('resolveAgentTimeouts（配置解析）', () => {
  it('未配置时四个键回落到 DEFAULT_AGENT_TIMEOUTS（升级后行为不变）', () => {
    expect(resolveAgentTimeouts()).toEqual({
      turnMs: DEFAULT_AGENT_TIMEOUTS.turnMs,
      stepMs: DEFAULT_AGENT_TIMEOUTS.stepMs,
      taskMs: DEFAULT_AGENT_TIMEOUTS.taskMs,
      // 历史常量 300s < 默认 turn 600s，按 clamp 规则抬到 turnMs + 30s。
      sendWaitMs: DEFAULT_AGENT_TIMEOUTS.turnMs + SEND_WAIT_OVER_TURN_MS,
    })
    expect(DEFAULT_AGENT_TIMEOUTS.sendWaitMs).toBe(300_000)
  })

  it('配置值生效；sendWaitMs clamp 到 turnMs + 30s；非法值回落默认', () => {
    const resolved = resolveAgentTimeouts({
      turnMs: 120_000,
      stepMs: 240_000,
      taskMs: 3_600_000,
      sendWaitMs: 60_000,
    })
    expect(resolved.turnMs).toBe(120_000)
    expect(resolved.stepMs).toBe(240_000)
    expect(resolved.taskMs).toBe(3_600_000)
    expect(resolved.sendWaitMs).toBe(120_000 + SEND_WAIT_OVER_TURN_MS)

    const invalid = resolveAgentTimeouts({ stepMs: -1, taskMs: Number.NaN, sendWaitMs: 0 })
    expect(invalid.stepMs).toBe(DEFAULT_AGENT_TIMEOUTS.stepMs)
    expect(invalid.taskMs).toBe(DEFAULT_AGENT_TIMEOUTS.taskMs)
    expect(invalid.sendWaitMs).toBe(
      DEFAULT_AGENT_TIMEOUTS.turnMs + SEND_WAIT_OVER_TURN_MS,
    )
  })

  it('turnMs 允许显式 0（关闭 turn deadline）', () => {
    expect(resolveAgentTimeouts({ turnMs: 0 }).turnMs).toBe(0)
  })
})

describe('WorkExecutionService 超时消费点（v36 / G3-7、G3-8）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let scheduler: WorkScheduler

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    scheduler = new WorkScheduler(db)
  })

  function confirmedItem(title = '任务'): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      anchorNodeId: 'node-1',
      title,
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  function service(timeouts: { stepMs?: number; taskMs?: number }): WorkExecutionService {
    return new WorkExecutionService(db, new FakeTurns(), {
      isEnabled: () => true,
      probeKernel: () => capableProbe,
      gateRecheck: okGate,
      timeouts,
    })
  }

  it('stepMs 写入 work_runs.deadline_at（真实消费点）', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const before = Date.now()
    const report = await service({ stepMs: 5_000 }).tick({ adapterName: 'claude-code' })

    const run = runs.get(report.runId!)!
    expect(run.status).toBe('completed')
    expect(run.deadline_at).toBeGreaterThanOrEqual(before + 5_000)
    expect(run.deadline_at).toBeLessThanOrEqual(Date.now() + 5_000)
    expect(steps.get(stepId)?.status).toBe('succeeded')
  })

  it('tick 前置扫描：deadline_at 已过期 → run timed_out、step timed_out', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const claimed = scheduler.startStep(stepId, {
      adapterName: 'claude-code',
      deadlineAt: Date.now() - 1_000,
    })
    expect(claimed.run.status).toBe('running')

    const report = await service({ stepMs: 600_000 }).tick({ adapterName: 'claude-code' })

    expect(report.timedOutRunIds).toEqual([claimed.run.id])
    expect(report.ran).toBe(false)
    expect(runs.get(claimed.run.id)!.status).toBe('timed_out')
    expect(steps.get(stepId)?.status).toBe('timed_out')
    expect(items.get(itemId)?.status).toBe('failed')
  })

  it('taskMs 从最早 started_at 起算（排队不计）：超出总预算 → timed_out', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const claimed = scheduler.startStep(stepId, { adapterName: 'claude-code' })
    // 模拟 61 分钟前已经开跑；step 预算还剩 10 分钟，只有 task 预算会命中。
    db.prepare('UPDATE work_runs SET started_at = ?, deadline_at = ? WHERE id = ?').run(
      Date.now() - 61 * 60 * 1000,
      Date.now() + 10 * 60 * 1000,
      claimed.run.id,
    )

    const report = await service({ stepMs: 600_000, taskMs: 3_600_000 }).tick({
      adapterName: 'claude-code',
    })

    expect(report.timedOutRunIds).toEqual([claimed.run.id])
    expect(runs.get(claimed.run.id)!.status).toBe('timed_out')
    expect(steps.get(stepId)?.status).toBe('timed_out')
  })
})
