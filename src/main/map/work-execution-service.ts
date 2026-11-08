/**
 * L2 执行触发（session-map 蓝图 §5.9.9）：单实例串行 tick + 写通道入队/取消。
 *
 * 六步 tick（每轮只 claim 一个步）：
 * 1. 取候选 item（queued 优先，created_at ASC；无 priority 列）；
 * 2. **重跑 gate**（GateRecheck，不信任 work_items.gate_status）→ 不通过落 blocked；
 * 3. 校验依赖：级联阻断未开始的依赖步，再找第一个就绪步；
 * 4. 路由：只接受 pinned adapter + 具备写前审批的 kernel 后端；否则保持 queued，
 *    发 routing_failed 事件，不建 run；
 * 5. 写闸：本进程同时只允许一个 turn（单实例串行），busy 时本轮跳过；
 * 6. 幂等创建/claim run → startStep → AgentStepRunner.run → 收敛 item。
 *
 * 孤儿回收在每轮 tick 最前：run 已 claim 但 step 仍 pending → running → queued，
 * 不计 attempt。
 *
 * 硬约束：
 * - 只通过 AgentTurnRunner（生产 = AgentManagerTurnRunner → sendCommandKernelOnly）
 *   发送，绝不回落 legacy；
 * - 逐工具审批由 kernel 的 ApprovalGateway 完成；runtime 缺失 / 后端无审批能力 /
 *   UNSAFE 降级一律在开跑前拒绝（fail-closed）；
 * - 不做 DAG 并行、不做多 agent 并发。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import {
  AgentStepRunner,
  type AcceptanceVerifier,
  type AgentTurnRunner,
  type StepRunResult,
  type StepRunStatus,
} from './agent-step-runner'
import { isMapExecutionEnabled, MAP_EXECUTION_DISABLED_REASON } from './execution-flags'
import { recordGateEvaluation } from './gate-diagnostics'
import {
  GATE_ENGINE_UNAVAILABLE,
  unavailableGateRecheck,
  type GateRecheck,
  type GateRecheckResult,
} from './gate-recheck'
import {
  WorkItemService,
  type WorkItemRow,
  type WorkItemStatus,
} from './work-item-service'
import { WorkRunService, type WorkRunRow, type WorkRunStatus } from './work-run-service'
import { WorkScheduler, type ClaimedStep } from './work-scheduler'
import { WorkStepService, isTerminalStepStatus, type WorkStepStatus } from './work-step-service'
import { resolveAgentTimeouts, type ResolvedAgentTimeouts } from '../agent/timeout-config'

const logger = createLogger('WorkExecutionService')

export type WorkExecutionErrorCode =
  | 'EXECUTION_DISABLED'
  | 'ROUTE_MISSING'
  | 'KERNEL_UNAVAILABLE'
  | 'APPROVAL_UNAVAILABLE'
  | 'ADAPTER_DRIVER_MISSING'
  | 'RUN_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'STEP_NOT_FOUND'
  | 'STEP_KIND_UNSUPPORTED'
  | 'TICK_BUSY'

export class WorkExecutionError extends Error {
  constructor(
    readonly code: WorkExecutionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkExecutionError'
  }
}

/**
 * kernel 开跑前能力探测（只读）。三项缺一不可：
 * - `kernel`：后端具备写前强制审批，且未被 UNSAFE 降级；
 * - `runtime`：AgentRuntime 已装配（审批网关经 runtime 提供）；
 * - `driver`：该 adapter 的 kernel driver 已注册。
 */
export interface KernelCapabilityProbe {
  kernel: boolean
  runtime: boolean
  driver: boolean
  reason?: string
}

export interface WorkExecutionEvent {
  type: 'work_item_changed' | 'work_step_changed'
  workItemId: string
  stepId?: string
  lineageId: string
  revision: number
  status: string
  reason?: string
}

export interface WorkExecutionOptions {
  /** 生产默认 = BIZGRAPH_MAP_EXECUTION（默认关闭）。 */
  isEnabled?: () => boolean
  /** 开跑前能力探测；不提供则一律拒绝（fail-closed）。 */
  probeKernel?: (adapterName: string) => KernelCapabilityProbe
  /**
   * tick 第 2 步 gate 评估。服务级默认 fail-closed（gate_engine_unavailable）；
   * 生产由 work-execution-runtime 装配 G1–G6 引擎（gate-engine.ts）。
   */
  gateRecheck?: GateRecheck
  /**
   * D2 确定性验收执行器。生产由 runtime 装配；缺省时保持 M3 既有语义，
   * 但生产执行路径必须注入，否则等于跳过验收（fail-open）。
   */
  verifyAcceptance?: AcceptanceVerifier
  /** 事件出口（生产接 renderer 广播；测试可断言）。 */
  onEvent?: (event: WorkExecutionEvent) => void
  /**
   * v36 / G3-7/G3-8：执行超时预算（`agentRuntime.timeouts` 的 stepMs/taskMs）。
   * 未配置时回落 DEFAULT_AGENT_TIMEOUTS（=升级前常量，行为不变）。
   */
  timeouts?: { stepMs?: number; taskMs?: number }
}

export interface EnqueueStepInput {
  stepId: string
  adapterName: string
  /** 可选：断言 step 属于该 item。 */
  workItemId?: string
  deadlineAt?: number | null
}

export interface EnqueueStepResult {
  run: WorkRunRow
  reused: boolean
}

export interface CancelRunResult {
  alreadyTerminal: boolean
  cancelled: boolean
  run: WorkRunRow
  itemStatus?: WorkItemStatus
}

export interface WorkTickReport {
  /** 本轮是否真的跑了 run。 */
  ran: boolean
  /** 已有 turn 在跑：本轮跳过（不写 run、不加 attempt）。 */
  busy: boolean
  itemId?: string
  stepId?: string
  runId?: string
  itemStatus?: WorkItemStatus
  outcome?: StepRunResult
  requeuedRunIds: string[]
  /** v36 / G3-7/G3-8：本轮被 deadline 扫描收口为 timed_out 的 run。 */
  timedOutRunIds: string[]
  gateBlockedItemIds: string[]
  routingFailedItemIds: string[]
  skippedStepIds: string[]
}

export interface WorkTickOptions {
  /** pinned adapter；未配置即无路由结论，不得猜一个执行器。 */
  adapterName?: string
  projectPath?: string
  graphId?: string
  deadlineAt?: number | null
}

const RUN_TERMINAL: ReadonlySet<WorkRunStatus> = new Set<WorkRunStatus>([
  'completed', 'failed', 'cancelled', 'superseded', 'interrupted', 'timed_out',
])

const STEP_BLOCKING: ReadonlySet<WorkStepStatus> = new Set<WorkStepStatus>([
  'failed', 'timed_out', 'cancelled',
])

export class WorkExecutionService {
  private readonly items: WorkItemService
  private readonly steps: WorkStepService
  private readonly runs: WorkRunService
  private readonly scheduler: WorkScheduler
  private readonly runner: AgentStepRunner
  private readonly isEnabled: () => boolean
  private readonly gateRecheck: GateRecheck
  /** v36 / G3-7/G3-8：生效的超时预算（stepMs 写 deadline、taskMs 任务总预算）。 */
  private readonly agentTimeouts: ResolvedAgentTimeouts
  /** 单进程串行：同一时刻只允许一个 turn（§5.9.9 写闸）。 */
  private inflightRunId: string | null = null

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly turns: AgentTurnRunner,
    private readonly options: WorkExecutionOptions = {},
  ) {
    this.items = new WorkItemService(db)
    this.steps = new WorkStepService(db)
    this.runs = new WorkRunService(db)
    this.scheduler = new WorkScheduler(db)
    this.runner = new AgentStepRunner(db, turns)
    this.isEnabled = options.isEnabled ?? isMapExecutionEnabled
    this.gateRecheck = options.gateRecheck ?? unavailableGateRecheck
    this.agentTimeouts = resolveAgentTimeouts(options.timeouts)
  }

  // ---------------------------------------------------------
  // 写通道：只入队 / 条件更新取消
  // ---------------------------------------------------------

  /**
   * 触发指定步执行：只入队（queued run），不在这里跑 turn。
   * 真正的执行由主进程 tick 异步驱动，避免 IPC handler 内联阻塞。
   */
  enqueueStep(input: EnqueueStepInput): EnqueueStepResult {
    this.assertEnabled()
    this.assertKernelReady(input.adapterName)
    const step = this.steps.get(input.stepId)
    if (!step) throw new WorkExecutionError('STEP_NOT_FOUND', `work_step ${input.stepId} 不存在`)
    if (input.workItemId && step.work_item_id !== input.workItemId) {
      throw new WorkExecutionError(
        'STEP_NOT_FOUND',
        `work_step ${input.stepId} 不属于 work_item ${input.workItemId}`,
      )
    }
    if (step.step_kind !== 'agent') {
      throw new WorkExecutionError(
        'STEP_KIND_UNSUPPORTED',
        `step_kind=${step.step_kind}，当前执行触发只接 agent 步`,
      )
    }
    const { run, reused } = this.scheduler.enqueueStep(input.stepId, {
      adapterName: input.adapterName,
      deadlineAt: input.deadlineAt ?? undefined,
    })
    return { run, reused }
  }

  /**
   * run 取消：条件更新（queued/running → cancelled，完成竞态失败方保留）。
   * 若该 run 正在本进程执行，先结束会话（真杀进程），再落库；下游未开始步落
   * cancelled，item 收敛（§5.9.7）。
   */
  async cancelRun(runId: string): Promise<CancelRunResult> {
    this.assertEnabled()
    const run = this.runs.get(runId)
    if (!run) throw new WorkExecutionError('RUN_NOT_FOUND', `work_run ${runId} 不存在`)
    if (RUN_TERMINAL.has(run.status)) {
      return {
        alreadyTerminal: true,
        cancelled: run.status === 'cancelled',
        run,
        itemStatus: this.items.get(run.work_item_id)?.status,
      }
    }

    // 真取消：本进程正在跑的 run 必须先结束会话，否则进程会继续写工作区。
    if (this.inflightRunId === runId && run.session_id) {
      try {
        await this.turns.terminateSession(run.session_id, 'user')
      } catch (error) {
        logger.warn(
          `[cancel] session=${run.session_id} terminate 失败（继续按条件更新收口）：` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    this.runs.cancel(runId, 'user')
    const finalRun = this.runs.get(runId)!
    const cancelledNow = finalRun.status === 'cancelled'
    if (cancelledNow) {
      const step = run.step_id ? this.steps.get(run.step_id) : undefined
      if (step && !isTerminalStepStatus(step.status)) {
        try {
          this.steps.cancel(step.id)
        } catch {
          // 并发下已被执行器置终态：保留既有事实。
        }
      }
      const item = this.items.get(run.work_item_id)
      if (item && item.is_current === 1) {
        // §5.9.7：下游未执行项落 cancelled（不是 blocked）；无关分支继续。
        this.cancelUnstartedDependents(item)
        this.items.convergeIfTerminal(item.id)
      }
    } else {
      // 取消输给完成/失败的竞态：不改写既有终态，只做 item 收敛。
      this.items.convergeIfTerminal(run.work_item_id)
    }
    const item = this.items.get(run.work_item_id)
    this.emit({
      type: 'work_item_changed',
      workItemId: run.work_item_id,
      lineageId: run.work_item_lineage_id,
      revision: run.work_item_revision,
      status: item?.status ?? finalRun.status,
      reason: 'run_cancelled',
    })
    return {
      alreadyTerminal: false,
      cancelled: cancelledNow,
      run: finalRun,
      itemStatus: item?.status,
    }
  }

  // ---------------------------------------------------------
  // tick（§5.9.9 六步，单实例串行）
  // ---------------------------------------------------------

  async tick(options: WorkTickOptions = {}): Promise<WorkTickReport> {
    const report: WorkTickReport = {
      ran: false,
      busy: false,
      requeuedRunIds: [],
      timedOutRunIds: [],
      gateBlockedItemIds: [],
      routingFailedItemIds: [],
      skippedStepIds: [],
    }
    if (!this.isEnabled()) return report
    if (this.inflightRunId !== null) {
      report.busy = true
      return report
    }

    // 第 6 步的前置清理：上一轮遗留的「已 claim、未启动」孤儿。
    report.requeuedRunIds = this.recoverOrphanedClaims()
    // v36 / G3-7/G3-8：先按 deadline 收口超时 run（step 预算 + task 总预算），
    // 再选候选——否则超时 run 会一直被当成 in-flight。
    report.timedOutRunIds = this.sweepDeadlines()

    const candidates = this.selectCandidates(options)
    for (const item of candidates) {
      // 第 2 步：重跑 gate（不信任库里的 gate_status）。评估器抛异常按
      // §14.6 与引擎不可用同路径：incomplete + gate_engine_unavailable（fail-closed）。
      let rechecked: GateRecheckResult
      let engineError: string | undefined
      try {
        rechecked = this.gateRecheck.recheck(item)
      } catch (error) {
        engineError = String(error)
        logger.warn(`[tick] gate 引擎异常 item=${item.id}，按不可用收口：${engineError}`)
        rechecked = { ok: false, missing: [GATE_ENGINE_UNAVAILABLE] }
      }
      // 逐道诊断（D12 修订）：每次评估都留 G1–G6 结果，写失败不影响准入判定。
      recordGateEvaluation(this.db, {
        itemId: item.id,
        lineageId: item.lineage_id,
        revision: item.revision,
        gateStatusBefore: item.gate_status,
        result: rechecked,
        engineError,
      })
      if (!rechecked.ok) {
        this.applyGateFailure(item, rechecked.missing)
        report.gateBlockedItemIds.push(item.id)
        continue
      }
      if (rechecked.waived) {
        // 人工豁免视同通过：保留库里的 waived 三字段，不改写成 pass（§14.6）。
        // 三字段由引擎已复核；若库内状态与三字段不一致（直接写库等），以
        // setGateResult 的守卫恢复 waived。
        if (item.gate_status !== 'waived') {
          try {
            this.items.setGateResult(item.id, 'waived', {
              waivedBy: rechecked.waived.by,
              waiveReason: rechecked.waived.reason,
            })
          } catch (error) {
            logger.warn(`[tick] item=${item.id} waived 落库未命中：${String(error)}`)
            continue
          }
        }
      } else if (item.gate_status === 'incomplete') {
        // 重跑通过但库里仍是旧值时，把重跑结论落库（否则 startStep 的只读复核会拒绝）。
        this.items.setGateResult(item.id, 'pass')
      }

      // 第 3 步：依赖校验 + 级联阻断。
      this.steps.blockUnstartedDependents(item.id, item.revision)
      const step = this.scheduler.peekNextReadyStep(item.id)
      if (!step) {
        // 还有非终态步 = 在等；全部终态才收敛。
        this.items.convergeIfTerminal(item.id)
        continue
      }
      if (step.step_kind !== 'agent') {
        // test/human 步由各自执行器负责；当前 tick 不接管，也不伪造执行。
        report.skippedStepIds.push(step.id)
        continue
      }

      // 第 4 步：路由（pinned adapter + 写前审批能力）。
      const adapterName = options.adapterName
      const routing = this.checkRouting(adapterName)
      if (!routing.ok) {
        report.routingFailedItemIds.push(item.id)
        this.emit({
          type: 'work_item_changed',
          workItemId: item.id,
          lineageId: item.lineage_id,
          revision: item.revision,
          status: item.status,
          reason: `routing_failed:${routing.code}`,
        })
        logger.warn(`[tick] item=${item.id} 路由失败（${routing.code}）：${routing.reason}`)
        continue
      }

      // 第 5 步已由 inflight 守卫在入口完成；第 6 步：claim → run。
      const claim = this.scheduler.startStep(step.id, {
        adapterName,
        // v36 / G3-7/G3-8：显式 deadline 优先；否则 stepMs，并 clamp 到 task 总预算。
        deadlineAt: this.resolveRunDeadline(item.id, options.deadlineAt),
      })
      this.inflightRunId = claim.run.id
      report.ran = true
      report.itemId = claim.item.id
      report.stepId = claim.step.id
      report.runId = claim.run.id
      let outcome: StepRunResult
      try {
        outcome = await this.runner.run(claim, {
          adapterName: adapterName!,
          verifyAcceptance: this.options.verifyAcceptance,
        })
      } catch (error) {
        // 取消与完成竞态：run 已被条件更新置终态时，以终态为事实，不覆盖。
        const latest = this.runs.get(claim.run.id)
        if (!latest || !RUN_TERMINAL.has(latest.status)) {
          // §5.9.9：tick 内不得留下 running 孤儿。执行器未落终态的异常按 infra 收口。
          this.abandonClaim(claim, error)
          throw error
        }
        outcome = {
          status: stepStatusOfRun(latest.status),
          runId: claim.run.id,
          stepId: claim.step.id,
        }
      } finally {
        this.inflightRunId = null
      }
      const converged = this.settle(claim)
      report.outcome = outcome
      report.itemStatus = converged?.status ?? this.items.get(claim.item.id)?.status
      this.emit({
        type: 'work_item_changed',
        workItemId: claim.item.id,
        lineageId: claim.item.lineage_id,
        revision: claim.item.revision,
        status: report.itemStatus ?? claim.item.status,
        reason: `run_${outcome.status}`,
      })
      return report
    }
    return report
  }

  /** 供外部（tick 循环/测试）观察是否有一个 turn 正在跑。 */
  isBusy(): boolean {
    return this.inflightRunId !== null
  }

  /**
   * v36 / G3-8：任务总预算的绝对 deadline。
   * 起点 = 该任务**最早一次 run 的 started_at**（队列等待不计；不新增列）。
   * 无 started_at / taskMs 非法 → undefined（不启用 task 预算）。
   */
  private taskDeadlineAt(workItemId: string): number | undefined {
    if (this.agentTimeouts.taskMs <= 0) return undefined
    const row = this.db
      .prepare(
        `SELECT MIN(started_at) AS startedAt FROM work_runs
          WHERE work_item_id = ? AND started_at IS NOT NULL`,
      )
      .get(workItemId) as { startedAt: number | null } | undefined
    const startedAt = row?.startedAt
    return typeof startedAt === 'number' && startedAt > 0
      ? startedAt + this.agentTimeouts.taskMs
      : undefined
  }

  /** 新 run 的 deadline：显式 > stepMs；两者都受 task 总预算上限约束。 */
  private resolveRunDeadline(
    workItemId: string,
    explicit?: number | null,
  ): number | undefined {
    const now = Date.now()
    const stepDeadline =
      typeof explicit === 'number' && explicit > 0
        ? explicit
        : now + this.agentTimeouts.stepMs
    const taskDeadline = this.taskDeadlineAt(workItemId)
    if (!taskDeadline) return stepDeadline
    return Math.min(stepDeadline, taskDeadline)
  }

  /**
   * v36 / G3-7/G3-8：tick 前置 deadline 扫描（只处理 running run）：
   *  - run.deadline_at 到期（step 预算）或 task 预算耗尽 → run → timed_out，
   *    对应步 running → timed_out，再收敛 item；
   *  - task 预算耗尽时，同一 item 的 queued run 一并按 cancel_reason='deadline'
   *    取消，避免下一轮继续开跑。
   * 不做抢占式中断线程：本 tick 与 runner 串行（inflight 守卫），到期的 run 一定
   * 不在本进程内跑，直接落终态是安全的（与现有 work-run-service.timeout 条件更新一致）。
   */
  private sweepDeadlines(): string[] {
    const now = Date.now()
    const timedOut: string[] = []
    for (const run of this.runs.listRunning()) {
      const stepExpired =
        typeof run.deadline_at === 'number' && run.deadline_at > 0 && run.deadline_at <= now
      const taskDeadline = this.taskDeadlineAt(run.work_item_id)
      const taskExpired = taskDeadline !== undefined && taskDeadline <= now
      if (!stepExpired && !taskExpired) continue
      const settled = this.runs.timeout(run.id)
      if (!settled) continue
      timedOut.push(run.id)
      const step = run.step_id ? this.steps.get(run.step_id) : undefined
      if (step && !isTerminalStepStatus(step.status)) {
        try {
          this.steps.fail(step.id, { status: 'timed_out', failureClass: 'timeout' })
        } catch (error) {
          // 并发下已被执行器置终态：保留既有事实（与 cancelRun 同口径）。
          logger.warn(`[tick] run=${run.id} 超时落步失败（保留既有终态）：${String(error)}`)
        }
      }
      if (taskExpired) {
        for (const queued of this.runs.list({
          workItemId: run.work_item_id,
          status: 'queued',
          limit: 100,
        })) {
          this.runs.cancel(queued.id, 'deadline')
        }
      }
      this.items.convergeIfTerminal(run.work_item_id)
      const item = this.items.get(run.work_item_id)
      this.emit({
        type: 'work_item_changed',
        workItemId: run.work_item_id,
        lineageId: run.work_item_lineage_id,
        revision: run.work_item_revision,
        status: item?.status ?? 'failed',
        reason: taskExpired ? 'task_deadline_exceeded' : 'step_deadline_exceeded',
      })
    }
    return timedOut
  }

  // ---------------------------------------------------------
  // 内部
  // ---------------------------------------------------------

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new WorkExecutionError('EXECUTION_DISABLED', MAP_EXECUTION_DISABLED_REASON)
    }
  }

  /** 写通道开跑前的能力闸：kernel → 审批网关（runtime）→ driver，任一不满足 fail-closed。 */
  private assertKernelReady(adapterName: string): void {
    const adapter = (adapterName ?? '').trim()
    if (!adapter) {
      throw new WorkExecutionError('ROUTE_MISSING', 'adapterName 必填：没有 pinned adapter 就没有路由结论')
    }
    const probe = this.options.probeKernel?.(adapter)
    if (!probe) {
      throw new WorkExecutionError(
        'APPROVAL_UNAVAILABLE',
        '未装配 kernel 能力探测：无法确认逐工具审批经网关，拒绝执行（fail-closed）',
      )
    }
    if (!probe.kernel) {
      throw new WorkExecutionError(
        'KERNEL_UNAVAILABLE',
        `adapter ${adapter} 不具备写前强制审批（或已被 UNSAFE 降级）：${probe.reason ?? 'kernel unavailable'}`,
      )
    }
    if (!probe.runtime) {
      throw new WorkExecutionError(
        'APPROVAL_UNAVAILABLE',
        `AgentRuntime 未装配：无法保证逐工具审批经 ApprovalGateway，拒绝执行（fail-closed）`,
      )
    }
    if (!probe.driver) {
      throw new WorkExecutionError(
        'ADAPTER_DRIVER_MISSING',
        `adapter ${adapter} 的 kernel driver 未注册，拒绝执行`,
      )
    }
  }

  private checkRouting(
    adapterName: string | undefined,
  ): { ok: true } | { ok: false; code: string; reason: string } {
    if (!adapterName || adapterName.trim() === '') {
      return {
        ok: false,
        code: 'TIER_UNSUPPORTED',
        reason: `未配置 pinned adapter（${'BIZGRAPH_MAP_EXECUTION_ADAPTER'}），无 Tier 1 候选`,
      }
    }
    const probe = this.options.probeKernel?.(adapterName)
    if (!probe) {
      return { ok: false, code: 'TIER_UNSUPPORTED', reason: 'kernel 能力探测未装配（fail-closed）' }
    }
    if (!probe.kernel || !probe.runtime || !probe.driver) {
      return {
        ok: false,
        code: 'TIER_UNSUPPORTED',
        reason: `adapter ${adapterName} 不具备 Tier 1 写前审批/运行时：${probe.reason ?? 'capability missing'}`,
      }
    }
    return { ok: true }
  }

  private selectCandidates(options: WorkTickOptions): WorkItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM work_items
          WHERE is_current = 1 AND archived_at IS NULL AND status IN ('queued','running')
            AND (? IS NULL OR project_path = ?)
            AND (? IS NULL OR graph_id = ?)
          ORDER BY
            CASE status WHEN 'queued' THEN 0 ELSE 1 END,
            -- v36 / G3-4：priority DESC NULLS LAST（CASE 兼容旧 SQLite）。
            CASE WHEN priority IS NULL THEN 1 ELSE 0 END,
            priority DESC,
            created_at ASC, revision ASC
          LIMIT 50`,
      )
      .all(
        options.projectPath ?? null,
        options.projectPath ?? null,
        options.graphId ?? null,
        options.graphId ?? null,
      ) as WorkItemRow[]
  }

  private recoverOrphanedClaims(): string[] {
    const ids: string[] = []
    for (const run of this.runs.listOrphanedClaims()) {
      if (this.runs.requeueOrphan(run.id)) ids.push(run.id)
    }
    return ids
  }

  /** 第 2 步不通过：queued → blocked；running 只能落 gate 失效（不改状态机）。 */
  private applyGateFailure(item: WorkItemRow, missing: string[]): void {
    if (item.status === 'queued') {
      try {
        this.items.markBlocked(item.id, missing)
      } catch (error) {
        logger.warn(`[tick] item=${item.id} markBlocked 未命中（并发终态）：${String(error)}`)
      }
    } else {
      this.items.setGateResult(item.id, 'incomplete', { missing })
    }
  }

  /** run 结束后：级联阻断失败上游的下游 + item 级收敛（§5.5.1）。 */
  private settle(claim: ClaimedStep): WorkItemRow | undefined {
    this.steps.blockUnstartedDependents(claim.item.id, claim.item.revision)
    return this.items.convergeIfTerminal(claim.item.id)
  }

  /** 执行器异常兜底：run/step 仍非终态时按 infra 收口，绝不留 running 孤儿。 */
  private abandonClaim(claim: ClaimedStep, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      this.runs.fail(claim.run.id, { failureClass: 'infra', resultSummary: message })
    } catch (e) {
      logger.warn(`[tick] run=${claim.run.id} 兜底 fail 未命中：${String(e)}`)
    }
    try {
      const step = this.steps.get(claim.step.id)
      if (step && !isTerminalStepStatus(step.status)) {
        this.steps.fail(claim.step.id, { status: 'failed', failureClass: 'infra' })
      }
    } catch (e) {
      logger.warn(`[tick] step=${claim.step.id} 兜底 fail 未命中：${String(e)}`)
    }
    this.settle(claim)
  }

  /** 取消传播：沿依赖链把未开始的步落 cancelled（§5.9.7，不是 blocked）。 */
  private cancelUnstartedDependents(item: WorkItemRow): string[] {
    const cancelled: string[] = []
    for (;;) {
      const list = this.steps.listByItem(item.id, item.revision)
      const byId = new Map(list.map((s) => [s.id, s]))
      const candidates = list.filter((s) => s.status === 'planning' || s.status === 'pending')
      const newly = candidates.filter((s) => {
        let deps: string[]
        try {
          const parsed = JSON.parse(s.depends_on_step_ids_json ?? '[]') as unknown
          deps = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
        } catch {
          return false
        }
        return deps.some((id) => {
          const dep = byId.get(id)
          return dep !== undefined && STEP_BLOCKING.has(dep.status)
        })
      })
      if (newly.length === 0) break
      for (const s of newly) {
        try {
          this.steps.cancel(s.id)
          cancelled.push(s.id)
        } catch {
          // 并发下已被启动：不改写 running。
        }
      }
    }
    return cancelled
  }

  private emit(event: WorkExecutionEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch (error) {
      logger.warn(`[event] 回调失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function stepStatusOfRun(status: WorkRunStatus): StepRunStatus {
  switch (status) {
    case 'completed':
      return 'succeeded'
    case 'timed_out':
      return 'timed_out'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}
