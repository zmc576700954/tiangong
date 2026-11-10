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
import { applyMapS5aSchema, applyMapS6aSchema } from '../map/schema'
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
    acceptance?: Array<Record<string, unknown>>
  } = {}): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: opts.projectPath ?? '/p/a',
      anchorNodeId: opts.anchorNodeId,
      title: '任务标题',
      goal: '目标说明',
      scopeFiles: ['src/a.ts'],
      acceptance: opts.acceptance ?? [{ id: 'acc1', type: 'command', expected: 'npm test', text: '必须通过' }],
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
      .get(c.run.id) as { id: string; policy: string; chosen_adapter: string; mode_id: string | null } | undefined
    expect(routing).toBeDefined()
    expect(routing!.policy).toBe('manual_override')
    expect(routing!.chosen_adapter).toBe('claude-code')
    // G2-1：agent + pinned adapter → agent.implement
    expect(routing!.mode_id).toBe('agent.implement')
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
        return { ok: true, missing: [], pending: [], items: [], pendingItems: [], checked: 1 }
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
        items: [],
        pendingItems: [],
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

  it('D2：仅 manual 待确认 → step/item needs_input，run 仍 completed（不判负）', async () => {
    createItem({
      anchorNodeId: 'node-1',
      acceptance: [{ id: 'm1', type: 'manual', expected: '人工确认样式正确', text: '请人工核对' }],
    })
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => ({
        ok: false,
        missing: [],
        pending: ['acceptance_manual_pending:0'],
        items: [{ index: 0, id: 'm1', type: 'manual', outcome: 'pending', codes: ['acceptance_manual_pending:0'] }],
        pendingItems: [{ id: 'm1', expected: '人工确认样式正确', text: '请人工核对' }],
        checked: 0,
      }),
    })

    expect(result.status).toBe('needs_input')
    expect(result.reason).toBe('ACCEPTANCE_MANUAL_PENDING')
    expect(result.failureClass).toBeUndefined()
    expect(runs.get(c.run.id)?.status).toBe('completed')
    expect(runs.get(c.run.id)?.failure_class).toBeNull()
    const step = steps.get(c.step.id)
    expect(step?.status).toBe('needs_input')
    expect(step?.failure_class).toBeNull()
    expect(step?.input_request_json).toContain('acceptance_manual_confirm')
    expect(step?.input_request_json).toContain('"id":"m1"')
    expect(step?.input_request_json).toContain('人工确认样式正确')
    expect(items.get(c.item.id)?.status).toBe('needs_input')
  })

  it('D2：manual 与硬失败并存 → 仍 verify_fail（等待不能掩盖失败）', async () => {
    createItem({
      anchorNodeId: 'node-1',
      acceptance: [
        { id: 'c1', type: 'command', expected: 'npm test' },
        { id: 'm1', type: 'manual', expected: '人工确认' },
      ],
    })
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => ({
        ok: false,
        missing: ['acceptance_command_exit:0:1'],
        pending: ['acceptance_manual_pending:1'],
        items: [
          { index: 0, type: 'command', outcome: 'fail', codes: ['acceptance_command_exit:0:1'] },
          { index: 1, id: 'm1', type: 'manual', outcome: 'pending', codes: ['acceptance_manual_pending:1'] },
        ],
        pendingItems: [{ id: 'm1', expected: '人工确认' }],
        checked: 1,
      }),
    })

    expect(result.status).toBe('failed')
    expect(result.failureClass).toBe('verify_fail')
    expect(result.reason).toContain('acceptance_command_exit:0:1')
    expect(steps.get(c.step.id)?.status).toBe('failed')
    expect(items.get(c.item.id)?.status).not.toBe('needs_input')
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
        return { ok: true, missing: [], pending: [], items: [], pendingItems: [], checked: 0 }
      },
    })

    expect(result.status).toBe('cancelled')
    expect(calls).toBe(0)
    expect(runs.get(c.run.id)?.status).toBe('cancelled')
  })

  it('G1-7：有 output_schema 且 finalText 合法 → outputs_json + output_parse=ok', async () => {
    const itemId = createItem({ anchorNodeId: 'node-1' })
    const stepId = items.listSteps(itemId, 1)[0].id
    db.prepare('UPDATE work_steps SET output_schema_json = ? WHERE id = ?').run(
      JSON.stringify({ summary: 'string' }),
      stepId,
    )
    const c = claim()
    turns.runResult = async () => ({ status: 'completed', finalText: '{"summary":"done"}' })

    const result = await runner.run(c, { adapterName: 'claude-code', executedContent: () => null })

    expect(result.status).toBe('succeeded')
    const run = runs.get(c.run.id)!
    expect(run.output_parse).toBe('ok')
    expect(JSON.parse(run.outputs_json!)).toEqual({ summary: 'done' })
  })

  it('G1-7：有 schema 但 finalText 不是合法结构化输出 → output_parse=fallback，不伪造 outputs', async () => {
    const itemId = createItem({ anchorNodeId: 'node-1' })
    const stepId = items.listSteps(itemId, 1)[0].id
    db.prepare('UPDATE work_steps SET output_schema_json = ? WHERE id = ?').run(
      JSON.stringify({ summary: 'string' }),
      stepId,
    )
    const c = claim()
    turns.runResult = async () => ({ status: 'completed', finalText: '普通文本，不是 JSON' })

    const result = await runner.run(c, { adapterName: 'claude-code', executedContent: () => null })

    expect(result.status).toBe('succeeded')
    const run = runs.get(c.run.id)!
    expect(run.output_parse).toBe('fallback')
    expect(run.outputs_json).toBeNull()
  })

  it('G1-7：failed → partial_output_ref 写 stdout_tail/file_changes/errors（D-16 截断由服务统一）', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    turns.runResult = async () => ({
      status: 'failed',
      failureClass: 'turn_fail',
      finalText: '做到一半就失败了',
      errorCode: 'E_TURN',
    })

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      executedContent: () => ({ treeHash: 'tree-1', dirtyFiles: ['src/a.ts'], contentHash: 'hash-1' }),
    })

    expect(result.status).toBe('failed')
    const run = runs.get(c.run.id)!
    const partial = JSON.parse(run.partial_output_ref!) as Record<string, unknown>
    expect(partial['stdout_tail']).toContain('做到一半')
    expect(partial['file_changes']).toEqual(['src/a.ts'])
    expect(partial['errors']).toEqual(['E_TURN'])
  })

  it('G1-7：change_sets 接上生产调用方（base→head，文件/行数落库）', async () => {
    createItem({ anchorNodeId: 'node-1' })
    const c = claim()
    const fakeGit = {
      revParseHEAD: () => 'base-1',
      statusPorcelain: () => [] as string[],
    }
    const result = await runner.run(c, {
      adapterName: 'claude-code',
      changeSetGit: fakeGit,
      workspaceChanges: () => ({
        headCommit: 'base-1',
        dirty: true,
        files: [{ path: 'src/a.ts', change: 'modified', additions: 3, deletions: 1 }],
      }),
      executedContent: () => null,
    })

    expect(result.status).toBe('succeeded')
    const row = db.prepare('SELECT * FROM change_sets WHERE work_run_id = ?').get(c.run.id) as
      | Record<string, unknown>
      | undefined
    expect(row).toBeDefined()
    expect(row!['base_commit']).toBe('base-1')
    expect(row!['head_commit']).toBe('base-1')
    expect(row!['file_count']).toBe(1)
    expect(row!['line_additions']).toBe(3)
    expect(row!['line_deletions']).toBe(1)
    expect(JSON.parse(row!['files_json'] as string)).toEqual([
      { path: 'src/a.ts', change: 'modified', additions: 3, deletions: 1 },
    ])
  })
})

describe('AgentStepRunner 证据写入（E2 session_turn）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let scheduler: WorkScheduler
  let turns: FakeTurns
  let runner: AgentStepRunner

  const PASS_VERDICT = {
    ok: true,
    missing: [] as string[],
    pending: [] as string[],
    items: [{ index: 0, type: 'command', outcome: 'pass' as const, codes: [] }],
    pendingItems: [] as Array<{ id: string; expected: string }>,
    checked: 1,
  }

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    applyMapS5aSchema(db)
    applyMapS6aSchema(db)
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, entity_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE map_migration_reports (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
        started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
        status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
      );
    `)
    db.prepare(
      "INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES ('node-1', 'feature', '节点', 'g1', 'dev', 'key-1', 'x', 'x')",
    ).run()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    scheduler = new WorkScheduler(db)
    turns = new FakeTurns()
    runner = new AgentStepRunner(db, turns)
  })

  function createAnchoredItem(anchorEntityKey = 'key-1', acceptance: Array<Record<string, unknown>> = [
    { id: 'c1', type: 'command', expected: 'npm test' },
  ]): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      anchorNodeId: 'node-1',
      anchorEntityKey,
      title: '任务标题',
      goal: '目标说明',
      scopeFiles: ['src/a.ts'],
      acceptance,
      steps: [{ title: '第一步', stepKind: 'agent', scopeFiles: ['src/a.ts'] }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  function claim() {
    const claimed = scheduler.claimNext({ projectPath: '/p/a', adapterName: 'claude-code' })
    expect(claimed).not.toBeNull()
    return claimed!
  }

  it('机器验收全过 → 直接写 E2 session_turn 证据（produced_by=system，无建议）', async () => {
    createAnchoredItem()
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => PASS_VERDICT,
      executedContent: () => ({ treeHash: 'tree-1', dirtyFiles: ['src/a.ts'], contentHash: 'hash-abc' }),
    })

    expect(result.status).toBe('succeeded')
    // C 口径：全机器可判定且通过 → 直落证据，不走建议。
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get()).toEqual({ n: 0 })
    const rows = db.prepare('SELECT * FROM node_evidence').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    const ev = rows[0]
    expect(ev['evidence_level']).toBe('E2')
    expect(ev['evidence_type']).toBe('session_turn')
    expect(ev['version_binding']).toBe('content_hash')
    expect(ev['current_hash']).toBe('hash-abc')
    // 机器验收驱动，不是 agent 自称。
    expect(ev['produced_by']).toBe('system')
    expect(ev['graph_id']).toBe('g1')
    expect(ev['node_entity_key']).toBe('key-1')
    expect(ev['work_run_id']).toBe(c.run.id)
    expect(ev['work_item_id']).toBe(c.item.id)
    expect(ev['session_id']).toBe('sess-1')
    const ref = JSON.parse(ev['ref_json'] as string) as Record<string, unknown>
    expect(ref['sessionId']).toBe('sess-1')
    expect(ref['runId']).toBe(c.run.id)
    expect(ref['workItemId']).toBe(c.item.id)
    expect(ref['executionWorkspace']).toBe('project_worktree')
    expect(ref['executedContentHash']).toBe('hash-abc')
    const acceptance = ref['acceptance'] as Record<string, unknown>
    expect(acceptance['manualEntryCount']).toBe(0)
    expect((acceptance['items'] as Array<Record<string, unknown>>)[0]['outcome']).toBe('pass')
  })

  it('含 manual 待确认 → 只写 pending 建议，node_evidence 为 0', async () => {
    createAnchoredItem('key-1', [{ id: 'm1', type: 'manual', expected: '人工确认' }])
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => ({
        ...PASS_VERDICT,
        ok: false,
        pending: ['acceptance_manual_pending:0'],
        pendingItems: [{ id: 'm1', expected: '人工确认' }],
      }),
      executedContent: () => ({ treeHash: 'tree-2', dirtyFiles: [], contentHash: 'hash-def' }),
    })

    expect(result.status).toBe('needs_input')
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 0 })
    const rows = db.prepare('SELECT * FROM evidence_suggestions').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]['status']).toBe('pending')
    expect(rows[0]['confidence']).toBe(0.6)
    expect(rows[0]['rationale']).toContain('仅剩 1 条 manual 待确认')
    expect(rows[0]['produced_by_run_id']).toBe(c.run.id)
    const ref = JSON.parse(rows[0]['ref_json'] as string) as Record<string, unknown>
    expect(ref['acceptanceOutcome']).toBe('needs_input')
    expect(ref['executedContentHash']).toBe('hash-def')
    const acceptance = ref['acceptance'] as Record<string, unknown>
    expect(acceptance['manualEntryCount']).toBe(1)
    expect((acceptance['pendingItems'] as Array<Record<string, unknown>>)[0]['id']).toBe('m1')
  })

  it('验收失败 → 证据与建议都为 0', async () => {
    createAnchoredItem('key-1', [{ type: 'command', command: 'npm test', expected: '测试通过' }])
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => ({
        ...PASS_VERDICT,
        ok: false,
        missing: ['acceptance_command_failed:0'],
        items: [{ index: 0, type: 'command', outcome: 'fail' as const, codes: ['acceptance_command_failed:0'] }],
      }),
      executedContent: () => ({ treeHash: 'tree-fail', dirtyFiles: [], contentHash: 'hash-fail' }),
    })

    expect(result.status).toBe('failed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get()).toEqual({ n: 0 })
  })

  it('同一 run 重复收口不重复写证据', async () => {
    createAnchoredItem()
    const c = claim()
    const options = {
      adapterName: 'claude-code',
      verifyAcceptance: async () => PASS_VERDICT,
      executedContent: () => ({ treeHash: 'tree-1', dirtyFiles: [], contentHash: 'hash-abc' }),
    }

    const result = await runner.run(c, options)
    expect(result.status).toBe('succeeded')
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 1 })

    // 模拟终态已提交后重复收口：同 work_run_id 的唯一键返回既有行，不新增。
    type RunClaim = Parameters<AgentStepRunner['run']>[0]
    type RunResult = Awaited<ReturnType<AgentStepRunner['run']>>
    type RunOptions = Parameters<AgentStepRunner['run']>[1]
    ;(runner as unknown as {
      recordTurnEvidence: (c: RunClaim, r: RunResult, s: string, o: RunOptions) => void
    }).recordTurnEvidence(c, result, 'sess-1', options)

    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get()).toEqual({ n: 0 })
  })

  it('取不到执行内容 → 什么都不写，只留诊断；step 仍成功', async () => {
    createAnchoredItem()
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => PASS_VERDICT,
      executedContent: () => null,
    })

    expect(result.status).toBe('succeeded')
    expect(steps.get(c.step.id)?.status).toBe('succeeded')
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 0 })
    const diag = db
      .prepare('SELECT stats_json FROM map_migration_reports WHERE stage = ?')
      .all(`evidence_write:${c.step.id}`) as Array<{ stats_json: string }>
    expect(diag).toHaveLength(1)
    expect((JSON.parse(diag[0].stats_json) as Record<string, unknown>)['error']).toBe('EXECUTED_CONTENT_UNAVAILABLE')
  })

  it('证据写入失败（端点不可解析）→ 不回退 step，留下可查诊断', async () => {
    createAnchoredItem('key-missing')
    const c = claim()

    const result = await runner.run(c, {
      adapterName: 'claude-code',
      verifyAcceptance: async () => PASS_VERDICT,
      executedContent: () => ({ treeHash: 'tree-3', dirtyFiles: [], contentHash: 'hash-ghi' }),
    })

    expect(result.status).toBe('succeeded')
    expect(steps.get(c.step.id)?.status).toBe('succeeded')
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_suggestions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 0 })
    const diag = db
      .prepare('SELECT stats_json FROM map_migration_reports WHERE stage = ?')
      .all(`evidence_write:${c.step.id}`) as Array<{ stats_json: string }>
    expect(diag).toHaveLength(1)
    expect((JSON.parse(diag[0].stats_json) as Record<string, unknown>)['error']).toContain('端点不可解析')
  })
})
