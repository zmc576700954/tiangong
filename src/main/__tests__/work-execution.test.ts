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

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
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
  type WorkExecutionOptions,
} from '../map/work-execution-service'
import type { GateRecheck } from '../map/gate-recheck'
import { GATE_ENGINE_UNAVAILABLE } from '../map/gate-recheck'
import type { TerminationReason } from '@shared/types'
import { registerMapHandlers } from '../ipc/map'
import { setWorkExecutionService } from '../map/work-execution-registry'
import type { TypedHandle } from '../ipc/utils'

class FakeTurns implements AgentTurnRunner {
  readonly starts: AgentTurnStartInput[] = []
  readonly commands: AgentTurnRunInput[] = []
  readonly terminated: Array<{ sessionId: string; reason: string }> = []
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
    this.pending?.({ status: 'cancelled', failureClass: 'cancel' })
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

  it('tick 第 2 步真的重跑 gate：库里 pass、stub 不通过 → blocked 且不建 run', async () => {
    const itemId = confirmedItem()
    const exec = service({
      gateRecheck: { recheck: () => ({ ok: false, missing: ['stub_missing'] }) },
    })

    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.ran).toBe(false)
    expect(report.gateBlockedItemIds).toEqual([itemId])
    const item = items.get(itemId)!
    expect(item.status).toBe('blocked')
    expect(JSON.parse(item.gate_missing_json ?? '[]')).toEqual(['stub_missing'])
    expect(runs.list({ workItemId: itemId })).toHaveLength(0)
    expect(turns.commands).toHaveLength(0)
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

    const exec = service()
    const report = await exec.tick({ adapterName: 'claude-code' })

    expect(report.requeuedRunIds).toEqual([claimed.run.id])
    expect(report.ran).toBe(true)
    expect(report.outcome?.status).toBe('succeeded')
    expect(runs.get(claimed.run.id)?.attempt).toBe(1)
    expect(items.get(itemId)?.status).toBe('done')
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
