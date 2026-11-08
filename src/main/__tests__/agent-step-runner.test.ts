/**
 * M3 agent 步执行器回归（§5.9.7 / §5.9.11）。
 *
 * 覆盖：completed → 步/run 双成功；timeout（运行中与开跑前）→ timed_out；
 * cancelled → run/step cancelled；failed/orphaned → failed + failure_class；
 * pinned adapter 缺失/降级 → 开跑前 fail-closed；step_kind 非 agent → 拒绝；
 * routing_decisions 落 manual_override 并挂到 work_runs；
 * deadline_at（绝对）→ deadlineMs（相对）；终态写入发生在 terminate 之后。
 *
 * 不驱动真实 Agent：用 Fake AgentTurnRunner 校验编排语义。
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
  AgentStepRunner,
  AgentStepRunnerError,
  mapTurnFailureClass,
  type AgentTurnRunner,
  type AgentTurnSessionHandle,
  type AgentTurnSignal,
  type AgentTurnStartInput,
  type AgentTurnRunInput,
} from '../map/agent-step-runner'
import type { TerminationReason } from '@shared/types'

type TerminalCall = { sessionId: string; reason: TerminationReason }

class FakeTurns implements AgentTurnRunner {
  starts: AgentTurnStartInput[] = []
  runs: AgentTurnRunInput[] = []
  terminates: TerminalCall[] = []
  events: string[] = []
  startResult: (input: AgentTurnStartInput) => Promise<AgentTurnSessionHandle> = async () => ({
    sessionId: 'sess-1',
    adapterUsed: 'claude-code',
  })
  runResult: (input: AgentTurnRunInput) => Promise<AgentTurnSignal> = async () => ({ status: 'completed' })
  onTerminate?: () => void

  async startSession(input: AgentTurnStartInput): Promise<AgentTurnSessionHandle> {
    this.events.push('start')
    this.starts.push(input)
    return this.startResult(input)
  }

  async runTurn(input: AgentTurnRunInput): Promise<AgentTurnSignal> {
    this.events.push('turn')
    this.runs.push(input)
    return this.runResult(input)
  }

  async terminateSession(sessionId: string, reason: TerminationReason): Promise<void> {
    this.events.push('terminate')
    this.terminates.push({ sessionId, reason })
    this.onTerminate?.()
  }
}

describe('AgentStepRunner（M3）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let scheduler: WorkScheduler
  let turns: FakeTurns
  let runner: AgentStepRunner

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    applyMapS5aSchema(db)
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    scheduler = new WorkScheduler(db)
    turns = new FakeTurns()
    runner = new AgentStepRunner(db, turns)
  })

  function createItem(opts: {
    anchorNodeId?: string
    projectPath?: string
    stepKind?: 'agent' | 'test' | 'human'
  } = {}): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: opts.projectPath ?? '/p/a',
      anchorNodeId: opts.anchorNodeId,
      title: '任务标题',
      goal: '目标说明',
      scopeFiles: ['src/a.ts'],
      acceptance: [{ id: 'acc1', type: 'command', expected: 'npm test', text: '必须通过' }],
      steps: [{ title: '第一步', stepKind: opts.stepKind ?? 'agent', scopeFiles: ['src/a.ts'] }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  function claim(deadlineAt?: number) {
    const claimed = scheduler.claimNext({
      projectPath: '/p/a',
      adapterName: 'claude-code',
      deadlineAt,
    })
    expect(claimed).not.toBeNull()
    return claimed!
  }

  it('completed → run completed + step succeeded；routing 落 manual_override；会话与路由挂到 run', async () => {
    const itemId = createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    let statusAtTerminate: string | undefined
    turns.onTerminate = () => {
      statusAtTerminate = runs.get(c.run.id)?.status
    }

    const result = await runner.run(c, { adapterName: 'claude-code', threadId: 't1' })

    expect(result.status).toBe('succeeded')
    expect(runs.get(c.run.id)?.status).toBe('completed')
    expect(steps.get(c.step.id)?.status).toBe('succeeded')
    expect(runs.get(c.run.id)?.session_id).toBe('sess-1')
    expect(runs.get(c.run.id)?.thread_id).toBe('t1')
    // 终态写入必须在 terminate 之后：terminate 时 run 仍是 running。
    expect(statusAtTerminate).toBe('running')
    expect(turns.events).toEqual(['start', 'turn', 'terminate'])
    expect(turns.starts[0]).toMatchObject({
      adapterName: 'claude-code',
      workingDirectory: '/p/a',
      nodeId: 'node-1',
      allowedFiles: ['src/a.ts'],
      // D1：结构化 acceptance 渲染为 `[type] expected`（D1 裁决）。
      acceptance: ['[command] npm test（必须通过）'],
    })
    expect(turns.runs[0].prompt).toContain('任务标题')
    expect(turns.runs[0].prompt).toContain('第一步')
    expect(turns.runs[0].prompt).toContain('[command] npm test（必须通过）')

    const routing = db
      .prepare('SELECT * FROM routing_decisions WHERE work_run_id = ?')
      .get(c.run.id) as { id: string; policy: string; chosen_adapter: string } | undefined
    expect(routing).toBeDefined()
    expect(routing!.policy).toBe('manual_override')
    expect(routing!.chosen_adapter).toBe('claude-code')
    expect(runs.get(c.run.id)?.route_decision_id).toBe(routing!.id)
    expect(itemId).toBe(c.item.id)
  })

  it('turn 超时（failed + failureClass=timeout）→ run timed_out + step timed_out', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.runResult = async () => ({
      status: 'failed',
      failureClass: 'timeout',
      errorCode: 'DEADLINE_EXCEEDED',
    })

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('timed_out')
    expect(result.failureClass).toBe('timeout')
    expect(runs.get(c.run.id)?.status).toBe('timed_out')
    expect(runs.get(c.run.id)?.failure_class).toBe('timeout')
    expect(steps.get(c.step.id)?.status).toBe('timed_out')
    expect(turns.terminates[0].reason).toBe('error')
  })

  it('deadline_at 已过期：不启动会话，直接 timed_out', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim(Date.now() - 1000)

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('timed_out')
    expect(result.reason).toBe('deadline_expired_before_start')
    expect(turns.starts).toHaveLength(0)
    expect(turns.runs).toHaveLength(0)
    expect(runs.get(c.run.id)?.status).toBe('timed_out')
    expect(steps.get(c.step.id)?.status).toBe('timed_out')
  })

  it('deadline_at（绝对时刻）换算成相对 deadlineMs', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const deadlineAt = Date.now() + 60_000
    const c = claim(deadlineAt)

    await runner.run(c, { adapterName: 'claude-code' })

    const sent = turns.runs[0].deadlineMs
    expect(sent).toBeDefined()
    expect(sent!).toBeGreaterThan(55_000)
    expect(sent!).toBeLessThanOrEqual(60_000)
  })

  it('failed（非 timeout）→ run failed + failure_class=turn_fail', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    // 未识别的 agent 失败类：按 fail-closed 归到 turn_fail，不猜成成功。
    turns.runResult = async () => ({ status: 'failed', failureClass: 'unknown_turn_error' })

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('failed')
    expect(result.failureClass).toBe('turn_fail')
    expect(runs.get(c.run.id)?.failure_class).toBe('turn_fail')
    expect(steps.get(c.step.id)?.status).toBe('failed')
  })

  it('agent failure_class 映射：timeout→timeout，runtime/crash→infra，aborted→cancel', () => {
    expect(mapTurnFailureClass('timeout')).toBe('timeout')
    expect(mapTurnFailureClass('runtime')).toBe('infra')
    expect(mapTurnFailureClass('crash')).toBe('infra')
    expect(mapTurnFailureClass('aborted')).toBe('cancel')
    expect(mapTurnFailureClass(undefined)).toBe('turn_fail')
    expect(mapTurnFailureClass('verify_fail')).toBe('verify_fail')
  })

  it('cancelled → run cancelled(cancel_reason=user) + step cancelled', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.runResult = async () => ({ status: 'cancelled', failureClass: 'aborted' })

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('cancelled')
    expect(runs.get(c.run.id)?.status).toBe('cancelled')
    expect(runs.get(c.run.id)?.cancel_reason).toBe('user')
    expect(steps.get(c.step.id)?.status).toBe('cancelled')
  })

  it('orphaned 判不了成功 → failed(infra)，fail-closed', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.runResult = async () => ({ status: 'orphaned', failureClass: 'crash' })

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('failed')
    expect(result.failureClass).toBe('infra')
    expect(runs.get(c.run.id)?.status).toBe('failed')
  })

  it('pinned adapter 缺失：不启动会话，run/step 落 failed(infra)', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()

    const result = await runner.run(c, { adapterName: '   ' })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('ROUTE_MISSING')
    expect(turns.starts).toHaveLength(0)
    expect(runs.get(c.run.id)?.failure_class).toBe('infra')
    expect(steps.get(c.step.id)?.status).toBe('failed')
  })

  it('节点未挂载：不启动会话（不得用伪 node id 兜底）', async () => {
    createItem({ anchorNodeId: undefined })
    const c = claim()

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.reason).toBe('NODE_MISSING')
    expect(turns.starts).toHaveLength(0)
  })

  it('适配器回退（adapterUsed ≠ pinned）：终止会话并按 infra 失败，不发 turn', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.startResult = async () => ({ sessionId: 'sess-fallback', adapterUsed: 'codex' })

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('ADAPTER_DOWNGRADED')
    expect(turns.runs).toHaveLength(0)
    expect(turns.terminates).toEqual([{ sessionId: 'sess-fallback', reason: 'error' }])
  })

  it('startSession 抛错 → run failed(infra)，不误写成功', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.startResult = async () => {
      throw new Error('adapter unavailable')
    }

    const result = await runner.run(c, { adapterName: 'claude-code' })

    expect(result.status).toBe('failed')
    expect(runs.get(c.run.id)?.status).toBe('failed')
    expect(runs.get(c.run.id)?.failure_class).toBe('infra')
    expect(steps.get(c.step.id)?.status).toBe('failed')
  })

  it('非 agent 步（test/human）拒绝执行，不写任何终态', async () => {
    createItem({ anchorNodeId: 'node-1', stepKind: 'test' })
    const c = claim()

    await expect(runner.run(c, { adapterName: 'claude-code' })).rejects.toBeInstanceOf(
      AgentStepRunnerError,
    )
    expect(c.run.status).toBe('running')
    expect(steps.get(c.step.id)?.status).toBe('running')
    expect(turns.starts).toHaveLength(0)
  })

  // ---- D2 确定性验收接线（2026-11-08） ----

  it('D2：验收通过 → succeeded；验收发生在 terminate 之后', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    const inputs: Array<{ acceptanceJson?: string | null; projectPath?: string | null }> = []

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async (input) => {
        inputs.push(input)
        return { ok: true, missing: [], pending: [], checked: 1 }
      },
    })

    expect(result.status).toBe('succeeded')
    expect(runs.get(c.run.id)?.status).toBe('completed')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].projectPath).toBe('/p/a')
    expect(inputs[0].acceptanceJson).toContain('npm test')
    expect(turns.events).toEqual(['start', 'turn', 'terminate'])
  })

  it('D2：验收不通过 → run/step failed(verify_fail)，不落 succeeded', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => ({
        ok: false,
        missing: ['acceptance_command_exit:0:1'],
        pending: [],
        checked: 1,
      }),
    })

    expect(result.status).toBe('failed')
    expect(result.failureClass).toBe('verify_fail')
    expect(result.reason).toContain('acceptance_command_exit:0:1')
    expect(result.turnStatus).toBe('completed')
    expect(runs.get(c.run.id)?.status).toBe('failed')
    expect(runs.get(c.run.id)?.failure_class).toBe('verify_fail')
    expect(steps.get(c.step.id)?.status).toBe('failed')
    expect(steps.get(c.step.id)?.failure_class).toBe('verify_fail')
  })

  it('D2：manual 待确认 → verify_fail（不默认通过）', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => ({
        ok: false,
        missing: [],
        pending: ['acceptance_manual_pending:0'],
        checked: 0,
      }),
    })

    expect(result.status).toBe('failed')
    expect(result.failureClass).toBe('verify_fail')
    expect(result.reason).toContain('acceptance_manual_pending:0')
    expect(runs.get(c.run.id)?.status).toBe('failed')
  })

  it('D2：验收执行器抛异常 → verify_fail（fail-closed）', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => {
        throw new Error('verifier boom')
      },
    })

    expect(result.status).toBe('failed')
    expect(result.failureClass).toBe('verify_fail')
    expect(result.reason).toBe('ACCEPTANCE_VERIFIER_ERROR')
    expect(runs.get(c.run.id)?.failure_class).toBe('verify_fail')
  })

  it('D2：turn 非 completed 不触发验收（cancelled 保持原语义）', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.runResult = async () => ({ status: 'cancelled', failureClass: 'aborted' })
    let calls = 0

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => {
        calls += 1
        return { ok: true, missing: [], pending: [], checked: 0 }
      },
    })

    expect(result.status).toBe('cancelled')
    expect(calls).toBe(0)
    expect(runs.get(c.run.id)?.status).toBe('cancelled')
  })
})
