/**
 * M5 执行触发回归：tick 六步 + 写通道（入队 / 取消）。
 *
 * 覆盖：
 * - tick 第 2 步真的重跑 gate（库里 gate_status=pass 但 stub 不通过 → blocked）；
 * - 生产默认 GateRecheck 为 fail-closed（gate_engine_unavailable，不伪造 pass）；
 * - 正常链路 claimNext → AgentStepRunner.run → 终态 → item 收敛；
 * - 孤儿回收（run 已 claim、step 未启动 → queued，不计 attempt）；
 * - 写通道开关关闭 / 无 kernel / 无审批 / 无 driver / 无 adapter 全部拒绝；
 * - 入队只建 queued run，不在 IPC 层跑 turn；
 * - 取消：in-flight 真结束会话 + run/step/item 收敛 + 下游未开始步 cancelled。
 *
 * 全部使用 fake AgentTurnRunner；不启动真实 Agent、不接 Electron。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMapS5aSchema } from '../map/schema'
import { WorkspaceLeaseRegistry } from '../agent/runtime/locks/workspace-lease'
import { WorkItemService } from '../map/work-item-service'
import { WorkStepService } from '../map/work-step-service'
import { WorkRunService } from '../map/work-run-service'
import { WorkScheduler } from '../map/work-scheduler'
import {
  AgentManagerTurnRunner,
  type AgentTurnRunner,
  type AgentTurnRunInput,
  type AgentTurnSessionHandle,
  type AgentTurnSignal,
  type AgentTurnStartInput,
} from '../map/agent-step-runner'
import {
  WorkExecutionService,
  WorkExecutionError,
  type KernelCapabilityProbe,
  type WorkExecutionEvent,
  type WorkExecutionOptions,
} from '../map/work-execution-service'
import type { GateRecheck } from '../map/gate-recheck'
import { GATE_ENGINE_UNAVAILABLE } from '../map/gate-recheck'
import { resetTierProbeCacheForTests } from '../map/tier-probe'
import type { TerminationReason } from '@shared/types'
import { registerMapHandlers } from '../ipc/map'
import { setWorkExecutionService } from '../map/work-execution-registry'
import type { TypedHandle } from '../ipc/utils'

class FakeTurns implements AgentTurnRunner {
  readonly starts: AgentTurnStartInput[] = []
  readonly commands: AgentTurnRunInput[] = []
  readonly terminated: Array<{ sessionId: string; reason: string }> = []
  /**
   * terminateSession 令挂起的 runTurn 以什么收尾。真机杀进程时 SDK 迭代器会异常退出，
   * 执行器通常以 infra/failed 收尾——用它验证这不会覆盖先落库的 cancelled。
   */
  terminateSignal: AgentTurnSignal = { status: 'cancelled', failureClass: 'cancel' }
  /** 'deferred'：runTurn 挂起，直到 terminateSession 被调用（模拟真杀进程）。 */
  constructor(private readonly mode: 'immediate' | 'deferred' = 'immediate') {}

  private pending: ((signal: AgentTurnSignal) => void) | null = null

  async startSession(input: AgentTurnStartInput): Promise<AgentTurnSessionHandle> {
    this.starts.push(input)
    return { sessionId: `s-${this.starts.length}`, adapterUsed: input.adapterName }
  }

  async runTurn(input: AgentTurnRunInput): Promise<AgentTurnSignal> {
    this.commands.push(input)
    if (this.mode === 'immediate') return { status: 'completed' }
    return new Promise<AgentTurnSignal>((resolve) => {
      this.pending = resolve
    })
  }

  async terminateSession(sessionId: string, reason: TerminationReason): Promise<void> {
    this.terminated.push({ sessionId, reason })
    this.pending?.(this.terminateSignal)
    this.pending = null
  }
}

const okGate: GateRecheck = { recheck: () => ({ ok: true, missing: [] }) }

const capableProbe: KernelCapabilityProbe = {
  kernel: true,
  runtime: true,
  driver: true,
  reason: 'test-capable',
}

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  return db
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('WorkExecutionService（M5 执行触发）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let scheduler: WorkScheduler
  let turns: FakeTurns

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    scheduler = new WorkScheduler(db)
    turns = new FakeTurns()
    resetTierProbeCacheForTests()
  })

  function confirmedItem(opts: { steps?: Array<{ title: string }> } = {}): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      anchorNodeId: 'node-1',
      title: '任务',
      steps: opts.steps,
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  function service(options: Partial<WorkExecutionOptions> = {}): WorkExecutionService {
    return new WorkExecutionService(db, turns, {
      isEnabled: () => true,
      probeKernel: () => capableProbe,
      gateRecheck: okGate,
      ...options,
    })
  }

  it('正常链路：tick 重跑 gate → claim → runner → completed → item done', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const exec = service()

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(true)
    expect(report.runId).toBeDefined()
    expect(report.outcome?.status).toBe('succeeded')
    expect(report.itemStatus).toBe('done')
    expect(turns.commands).toHaveLength(1)
    expect(turns.starts[0].adapterName).toBe('claude-code')

    const run = runs.get(report.runId!)!
    expect(run.status).toBe('completed')
    expect(run.attempt).toBe(1)
    expect(steps.get(stepId)?.status).toBe('succeeded')
    expect(items.get(itemId)?.status).toBe('done')
  })

  it('claim/start 阶段立即广播 running（界面不重载也能拿到取消入口）', async () => {
    const deferred = new FakeTurns('deferred')
    turns = deferred
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const events: WorkExecutionEvent[] = []
    const exec = service({ onEvent: (event) => events.push(event) })

    const ticking = exec.tick({ adapterName: 'claude-code' })
    await waitFor(() => events.some((e) => e.reason === 'run_started'))

    const started = events.find((e) => e.reason === 'run_started')!
    expect(started.workItemId).toBe(itemId)
    expect(started.stepId).toBe(stepId)
    expect(started.status).toBe('running')
    // 事件必须在结算前发出：此时 run 在库里就是 running，ended_at 仍为空。
    const [running] = runs.list({ workItemId: itemId })
    expect(running.status).toBe('running')
    expect(running.ended_at).toBeNull()
    expect(deferred.commands).toHaveLength(1)

    await exec.cancelRun(running.id)
    await ticking
  })

  it('G2-18：tick 内步级迁移发 work_step_changed（含 stepId，与库一致）', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const events: WorkExecutionEvent[] = []
    const exec = service({ onEvent: (event) => events.push(event) })

    await exec.tick({ adapterName: 'claude-code' })

    const stepEvents = events.filter((e) => e.type === 'work_step_changed')
    expect(stepEvents.map((e) => e.status)).toEqual(['running', 'succeeded'])
    for (const event of stepEvents) {
      expect(event.stepId).toBe(stepId)
      expect(event.workItemId).toBe(itemId)
      expect(event.lineageId).toBe(items.get(itemId)!.lineage_id)
    }
    // 事件出口与库内最终状态一致。
    expect(stepEvents.at(-1)?.status).toBe(steps.get(stepId)!.status)
  })

  it('tick 第 2 步真的重跑 gate：库里 pass、stub 不通过 → blocked 且不建 run', async () => {
    const itemId = confirmedItem()
    const events: WorkExecutionEvent[] = []
    const exec = service({
      gateRecheck: { recheck: () => ({ ok: false, missing: ['stub_missing'] }) },
      onEvent: (event) => events.push(event),
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(false)
    expect(report.gateBlockedItemIds).toEqual([itemId])
    const item = items.get(itemId)!
    expect(item.status).toBe('blocked')
    expect(JSON.parse(item.gate_missing_json ?? '[]')).toEqual(['stub_missing'])
    expect(runs.list({ workItemId: itemId })).toHaveLength(0)
    expect(turns.commands).toHaveLength(0)
    // gate 失败也是可见跃迁：必须广播 blocked，否则界面仍显示 queued。
    const blockedEvent = events.find((e) => e.reason === 'gate_blocked')
    expect(blockedEvent?.status).toBe('blocked')
  })

  it('生产默认 GateRecheck：fail-closed，不伪造 pass', async () => {
    const itemId = confirmedItem()
    const exec = new WorkExecutionService(db, turns, {
      isEnabled: () => true,
      probeKernel: () => capableProbe,
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(false)
    const item = items.get(itemId)!
    expect(item.status).toBe('blocked')
    expect(JSON.parse(item.gate_missing_json ?? '[]')).toEqual([GATE_ENGINE_UNAVAILABLE])
  })

  it('gate 引擎抛异常 → 与不可用同路径：blocked + gate_engine_unavailable（§14.6）', async () => {
    const itemId = confirmedItem()
    const exec = service({
      gateRecheck: {
        recheck: () => {
          throw new Error('engine boom')
        },
      },
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(false)
    expect(report.gateBlockedItemIds).toEqual([itemId])
    const item = items.get(itemId)!
    expect(item.status).toBe('blocked')
    expect(JSON.parse(item.gate_missing_json ?? '[]')).toEqual([GATE_ENGINE_UNAVAILABLE])
    expect(runs.list({ workItemId: itemId })).toHaveLength(0)
  })

  /**
   * 诊断载体复用 `map_migration_reports`（生产由 database.ts 建表）；测试库只需补齐该表
   * 以验证 tick 真的写入、且写入内容可回答「第几道没过」。
   */
  function addDiagnosticsTable(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS map_migration_reports (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        stage TEXT NOT NULL,
        schema_version INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        heartbeat_at TEXT,
        owner_pid INTEGER,
        status TEXT NOT NULL,
        stats_json TEXT NOT NULL DEFAULT '{}',
        details_json TEXT NOT NULL DEFAULT '{}'
      )
    `)
  }

  function diagnosticsRows(): Array<{ stage: string; status: string; stats_json: string; details_json: string }> {
    return db
      .prepare("SELECT stage, status, stats_json, details_json FROM map_migration_reports WHERE kind = 'integrity_check'")
      .all() as Array<{ stage: string; status: string; stats_json: string; details_json: string }>
  }

  it('逐道诊断落库：blocked 时六道结果 + 阈值快照可查（D12 修订）', async () => {
    addDiagnosticsTable()
    const itemId = confirmedItem()
    const exec = service({
      gateRecheck: {
        recheck: () => ({
          ok: false,
          missing: ['anchor_node_missing'],
          diagnostics: {
            evaluatorVersion: 'gate-engine@1',
            thresholds: { g4MaxFiles: 20, g4MaxLines: 800 },
            gates: [
              { gate: 'G1', ok: true, missing: [] },
              { gate: 'G2', ok: true, missing: [] },
              { gate: 'G3', ok: false, missing: ['anchor_node_missing'] },
              { gate: 'G4', ok: true, missing: [] },
              { gate: 'G5', ok: true, missing: [] },
              { gate: 'G6', ok: true, missing: [] },
            ],
          },
        }),
      },
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(false)
    const rows = diagnosticsRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].stage).toBe(`gate_eval:${itemId}`)
    expect(rows[0].status).toBe('ok')
    const stats = JSON.parse(rows[0].stats_json)
    expect(stats.verdict).toBe('incomplete')
    expect(stats.evaluator_version).toBe('gate-engine@1')
    expect(stats.thresholds).toEqual({ g4MaxFiles: 20, g4MaxLines: 800 })
    const details = JSON.parse(rows[0].details_json)
    expect(details.gate_status_before).toBe('pass')
    expect(details.gates).toHaveLength(6)
    expect(details.gates.find((gate: { gate: string }) => gate.gate === 'G3')).toMatchObject({
      ok: false,
      missing: ['anchor_node_missing'],
    })
    // 诊断是旁路：用户可见状态照旧由判定写入
    expect(items.get(itemId)!.gate_status).toBe('incomplete')
  })

  it('逐道诊断落库：引擎异常也留行并标注 engine_error（判定仍 fail-closed）', async () => {
    addDiagnosticsTable()
    const itemId = confirmedItem()
    const exec = service({
      gateRecheck: {
        recheck: () => {
          throw new Error('engine boom')
        },
      },
    })

    await exec.tick({ adapterName: 'claude-code' })

    const rows = diagnosticsRows()
    expect(rows).toHaveLength(1)
    expect(items.get(itemId)!.status).toBe('blocked')
    const stats = JSON.parse(rows[0].stats_json)
    expect(stats.verdict).toBe('incomplete')
    expect(stats.evaluator_version).toBe('gate_engine_unavailable')
    expect(String(stats.engine_error)).toContain('engine boom')
    expect(JSON.parse(rows[0].details_json).gates).toEqual([])
  })

  it('豁免视同通过：结果带 waived 时照常执行，且库内 waived 三字段不被改写', async () => {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      anchorNodeId: 'node-1',
      title: '任务',
      steps: [{ title: '步' }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'waived', { waivedBy: 'alice', waiveReason: '人工确认' })
    items.confirm(id)
    const stepId = steps.listByItem(id, 1)[0].id
    const exec = service({
      gateRecheck: {
        recheck: () => ({ ok: true, missing: [], waived: { by: 'alice', at: 123, reason: '人工确认' } }),
      },
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(true)
    expect(report.outcome?.status).toBe('succeeded')
    const item = items.get(id)!
    expect(item.gate_status).toBe('waived')
    expect(item.gate_waived_by).toBe('alice')
    expect(item.gate_waive_reason).toBe('人工确认')
    expect(steps.get(stepId)?.status).toBe('succeeded')
  })

  it('孤儿回收：run 已 claim、step 未启动 → running→queued，不计 attempt 后再执行', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const claimed = scheduler.startStep(stepId, { adapterName: 'claude-code' })!
    // 模拟 claim 与 startStep 之间崩溃：step 退回 pending，run 仍 running。
    db.prepare("UPDATE work_steps SET status='pending', started_at=NULL WHERE id=?").run(stepId)

    const events: WorkExecutionEvent[] = []
    const exec = service({ onEvent: (event) => events.push(event) })
    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.requeuedRunIds).toEqual([claimed.run.id])
    expect(report.ran).toBe(true)
    expect(report.outcome?.status).toBe('succeeded')
    expect(runs.get(claimed.run.id)?.attempt).toBe(1)
    expect(items.get(itemId)?.status).toBe('done')
    // running → queued 的回收同样是可见跃迁，不能等下一次 UI 手工刷新。
    expect(events.some((e) => e.reason === 'run_requeued')).toBe(true)
  })

  it('写通道闸：开关关闭 / 无 kernel / 无审批 / 无 driver / 无 adapter 全部拒绝', () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const expectCode = (fn: () => unknown, code: string): void => {
      try {
        fn()
      } catch (error) {
        expect(error).toMatchObject({ code })
        return
      }
      throw new Error(`期望抛出 ${code}，实际未抛`)
    }

    const disabled = service({ isEnabled: () => false })
    expectCode(() => disabled.enqueueStep({ stepId, adapterName: 'claude-code' }), 'EXECUTION_DISABLED')

    const noKernel = service({
      probeKernel: () => ({ kernel: false, runtime: true, driver: true, reason: 'no approval' }),
    })
    expectCode(() => noKernel.enqueueStep({ stepId, adapterName: 'claude-code' }), 'KERNEL_UNAVAILABLE')

    const noRuntime = service({
      probeKernel: () => ({ kernel: true, runtime: false, driver: true, reason: 'no runtime' }),
    })
    expectCode(() => noRuntime.enqueueStep({ stepId, adapterName: 'claude-code' }), 'APPROVAL_UNAVAILABLE')

    const noDriver = service({
      probeKernel: () => ({ kernel: true, runtime: true, driver: false, reason: 'no driver' }),
    })
    expectCode(() => noDriver.enqueueStep({ stepId, adapterName: 'claude-code' }), 'ADAPTER_DRIVER_MISSING')

    const noAdapter = service()
    expectCode(() => noAdapter.enqueueStep({ stepId, adapterName: '  ' }), 'ROUTE_MISSING')

    expect(runs.list({ workItemId: itemId })).toHaveLength(0)
    expect(new WorkExecutionError('EXECUTION_DISABLED', 'x').code).toBe('EXECUTION_DISABLED')
  })

  it('G3-1：非 Tier 1 后端（acp 缺续跑）不进入编排写路径', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const exec = service()

    expect(() => exec.enqueueStep({ stepId, adapterName: 'acp' })).toThrowError(
      expect.objectContaining({ code: 'TIER_UNSUPPORTED' }),
    )

    const report = await exec.tick({ adapterName: 'acp' })
    expect(report.ran).toBe(false)
    expect(report.routingFailedItemIds).toEqual([itemId])
    expect(runs.list({ workItemId: itemId })).toHaveLength(0)
    expect(turns.starts).toHaveLength(0)
  })

  it('G7-8：inspectRouting 只读返回能力票（Tier 1 通过 / 非 Tier 1 带缺项）', () => {
    const exec = service()
    const ok = exec.inspectRouting('claude-code')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.tier.tier).toBe(1)

    const denied = exec.inspectRouting('acp')
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.code).toBe('TIER_UNSUPPORTED')
      expect(denied.tier?.tier).toBe(3)
      expect(denied.reason).toContain('Tier 3')
    }
  })

  it('入队只建 queued run（不跑 turn）；随后的 tick 复用该 run 执行', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const exec = service()

    const enqueued = exec.enqueueStep({ stepId, adapterName: 'claude-code' })
    expect(enqueued.run.status).toBe('queued')
    expect(turns.commands).toHaveLength(0)
    expect(items.get(itemId)?.status).toBe('queued')

    const report = await exec.tick({ adapterName: 'claude-code' })
    expect(report.ran).toBe(true)
    expect(report.runId).toBe(enqueued.run.id)
    expect(runs.get(enqueued.run.id)?.attempt).toBe(1)
    expect(turns.commands).toHaveLength(1)
  })

  it('取消 in-flight run：结束会话，run/step/item 收敛，下游未开始步 cancelled', async () => {
    const deferred = new FakeTurns('deferred')
    turns = deferred
    const itemId = confirmedItem({ steps: [{ title: 'a' }, { title: 'b' }] })
    const [a, b] = steps.listByItem(itemId, 1)
    db.prepare('UPDATE work_steps SET depends_on_step_ids_json = ? WHERE id = ?').run(
      JSON.stringify([a.id]),
      b.id,
    )
    const exec = service()

    const ticking = exec.tick({ adapterName: 'claude-code' })
    await waitFor(() => deferred.commands.length === 1)

    const running = runs.list({ workItemId: itemId })[0]
    expect(running.status).toBe('running')
    expect(exec.isBusy()).toBe(true)

    const result = await exec.cancelRun(running.id)
    await ticking

    expect(deferred.terminated.length).toBeGreaterThanOrEqual(1)
    expect(result.run.status).toBe('cancelled')
    expect(steps.get(a.id)?.status).toBe('cancelled')
    expect(steps.get(b.id)?.status).toBe('cancelled')
    expect(items.get(itemId)?.status).toBe('cancelled')
    expect(items.get(itemId)?.cancel_reason).toBe('partial_cancel')
  })

  it('取消先落库再杀进程：执行器以 infra 失败收尾也不覆盖 cancelled', async () => {
    const deferred = new FakeTurns('deferred')
    deferred.terminateSignal = { status: 'failed', failureClass: 'infra', errorCode: 'ABORTED' }
    turns = deferred
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const exec = service()
    const ticking = exec.tick({ adapterName: 'claude-code' })
    await waitFor(() => deferred.commands.length === 1)

    const running = runs.list({ workItemId: itemId })[0]
    const result = await exec.cancelRun(running.id)
    await ticking

    expect(result.cancelled).toBe(true)
    expect(runs.get(running.id)?.status).toBe('cancelled')
    expect(steps.get(stepId)?.status).toBe('cancelled')
    expect(items.get(itemId)?.status).toBe('cancelled')
  })

  it('取消 queued run：条件更新为 cancelled，不触达会话，item 收敛', async () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const exec = service()
    const enqueued = exec.enqueueStep({ stepId, adapterName: 'claude-code' })

    const result = await exec.cancelRun(enqueued.run.id)

    expect(result.cancelled).toBe(true)
    expect(turns.terminated).toHaveLength(0)
    expect(turns.commands).toHaveLength(0)
    expect(steps.get(stepId)?.status).toBe('cancelled')
    expect(items.get(itemId)?.status).toBe('cancelled')

    // 幂等：再次取消按 alreadyTerminal 返回，不重复写。
    const again = await exec.cancelRun(enqueued.run.id)
    expect(again.alreadyTerminal).toBe(true)
  })

  it('AgentManagerTurnRunner 只依赖 kernel-only host（结构断言：无 legacy 入口）', () => {
    const host = {
      startSession: async () => ({ sessionId: 's', adapterUsed: 'claude-code' }),
      sendCommandKernelOnly: async () => ({
        status: 'completed' as const,
        runId: 'r1',
        turnId: 't1',
        reused: false,
      }),
      terminateSession: async () => undefined,
    }
    const runner = new AgentManagerTurnRunner(host)
    expect(typeof runner.runTurn).toBe('function')
    // 运行时对象上不存在 sendCommand/legacy 方法，编排层无从回落。
    expect('sendCommand' in runner).toBe(false)
  })
})

describe('G3-2 跨进程项目写闸', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let turns: FakeTurns
  let leaseDir: string

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    turns = new FakeTurns()
    leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-g32-'))
  })

  afterEach(() => {
    fs.rmSync(leaseDir, { recursive: true, force: true })
  })

  function confirmedItem(): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      anchorNodeId: 'node-1',
      title: '任务',
      steps: [{ title: '步一' }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  function service(lease: WorkspaceLeaseRegistry): WorkExecutionService {
    return new WorkExecutionService(db, turns, {
      isEnabled: () => true,
      probeKernel: () => capableProbe,
      gateRecheck: okGate,
      lease,
    })
  }

  it('另一进程持有项目租约：fail-fast 跳过，不 claim、不消耗 attempt、发 project_busy', async () => {
    const itemId = confirmedItem()
    // 第二个 registry = 另一个进程视角（同 pid 但不同 token，互不重入）。
    const other = new WorkspaceLeaseRegistry({ enabled: true, dir: leaseDir, ttlMs: 60_000 })
    expect(other.acquire('/p/a').acquired).toBe(true)

    const events: WorkExecutionEvent[] = []
    const exec = new WorkExecutionService(db, turns, {
      isEnabled: () => true,
      probeKernel: () => capableProbe,
      gateRecheck: okGate,
      lease: new WorkspaceLeaseRegistry({ enabled: true, dir: leaseDir, ttlMs: 60_000 }),
      onEvent: (event) => events.push(event),
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(false)
    expect(report.busy).toBe(false)
    expect(report.projectBusyItemIds).toEqual([itemId])
    expect(runs.list({ workItemId: itemId })).toHaveLength(0)
    expect(turns.commands).toHaveLength(0)
    const step = steps.listByItem(itemId, 1)[0]
    expect(step.status).toBe('pending')
    expect(step.attempt).toBe(1)
    expect(events.find((e) => e.reason?.startsWith('project_busy:'))?.status).toBe('queued')

    // 持有者释放后，同一 service 下一轮即可正常开跑。
    other.stop()
    const next = await exec.tick({ adapterName: 'claude-code' })
    expect(next.ran).toBe(true)
    expect(next.projectBusyItemIds).toEqual([])
  })

  it('同 registry 重入：runtime.runNode 已持有同一 key 时不阻塞 tick', async () => {
    confirmedItem()
    const lease = new WorkspaceLeaseRegistry({ enabled: true, dir: leaseDir, ttlMs: 60_000 })
    // 模拟 runtime 已按 workingDirectory 持有一层（同 registry 重入计数）。
    const runtimeLayer = lease.acquire('/p/a')
    expect(runtimeLayer.acquired).toBe(true)

    const report = await service(lease).tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(true)
    // tick 只释放自己那一层，runtime 的租约仍在。
    expect(lease.inspect('/p/a')).not.toBeNull()
    runtimeLayer.release()
    expect(lease.inspect('/p/a')).toBeNull()
  })

  it('run 级持有：执行中租约在，settle 后释放', async () => {
    const itemId = confirmedItem()
    const deferred = new FakeTurns('deferred')
    turns = deferred
    const lease = new WorkspaceLeaseRegistry({ enabled: true, dir: leaseDir, ttlMs: 60_000 })
    const exec = service(lease)

    const ticking = exec.tick({ adapterName: 'claude-code' })
    await waitFor(() => deferred.commands.length > 0)
    expect(lease.inspect('/p/a')).not.toBeNull()

    const [running] = runs.list({ workItemId: itemId })
    await exec.cancelRun(running.id)
    await ticking
    expect(lease.inspect('/p/a')).toBeNull()
  })

  it('默认关闭（未开启 env）：noop，不落任何 lease 文件，行为不变', async () => {
    confirmedItem()
    const lease = new WorkspaceLeaseRegistry({ enabled: false, dir: leaseDir })
    const report = await service(lease).tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(true)
    expect(fs.readdirSync(leaseDir)).toHaveLength(0)
  })
})

describe('IPC 执行写通道：默认关闭时拒绝执行', () => {
  it('开关关闭时 workitem:step:run / workitem:run:cancel 明确拒绝（不静默降级）', async () => {
    const db = setupDb()
    const turns = new FakeTurns()
    const exec = new WorkExecutionService(db, turns, {
      isEnabled: () => false,
      probeKernel: () => capableProbe,
      gateRecheck: okGate,
    })
    setWorkExecutionService(exec)
    try {
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
      registerMapHandlers(
        ((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
          handlers.set(channel, handler)) as unknown as TypedHandle,
        db,
      )
      await expect(
        handlers.get('workitem:step:run')!(null, { stepId: 's1', adapterName: 'claude-code' }),
      ).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' })
      await expect(handlers.get('workitem:run:cancel')!(null, 'r1')).rejects.toMatchObject({
        code: 'EXECUTION_DISABLED',
      })
    } finally {
      setWorkExecutionService(null)
    }
  })
})
