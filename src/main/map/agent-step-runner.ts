/**
 * M3：agent 步执行器（session-map 蓝图 §5.9.7 / §5.9.11）。
 *
 * 职责：把 WorkScheduler.startStep 产出的 (item, step, run) 驱动成一次真实 Agent turn，
 * 并按 TurnOutcome 把 run/step 落到终态。审批不在本文件实现——kernel 路径的逐工具审批
 * 由 AgentRuntime → ApprovalGateway 完成（绑定 run/turn/step、argsHash 校验、pending 冻结
 * deadline），本层只调用 kernel-only 发送入口，不做任何"本地置位即批准"。
 *
 * 本轮边界（与拍板一致）：
 * - needs_input：仅由结构化 acceptance 的 manual 待确认触发（2026-11-08）。
 *   仍不解析 finalText 中的 INPUT_REQUIRED；非 manual 的判定不出按失败处理（fail-closed）。
 * - 路由只写 pinned adapter（policy='manual_override'），不补 Tier 能力探测——这是对
 *   §5.9.10 的明确偏离，不得在文档里记为"已实现"。
 * - 不接 IPC：本文件不注册任何外部入口，只提供可被后续里程碑装配的执行器。
 * - D2 验收（2026-11-08）：completed 后若注入 `verifyAcceptance`，硬失败落 `verify_fail`；
 *   仅 manual 待确认落 `needs_input`（run 仍 completed，等待人工确认）；其余判通过才 succeeded。
 * - v34：失败分类同时写 `work_runs.failure_class` 与 `work_steps.failure_class`（同值域）；
 *   step 级失败不再只能跨表查最近 run。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { AgentCommand, AgentSessionConfig, TerminationReason } from '@shared/types'
import type { TurnOutcome } from '@shared/types/agent-runtime'
import { createLogger } from '../shared/logger'
import type { AcceptancePendingItem, AcceptanceVerdict } from './acceptance-executor'
import { WorkItemService, type WorkItemRow, type WorkStepRow } from './work-item-service'
import { WorkRunService, RoutingDecisionRepository, type FailureClass, type WorkRunRow } from './work-run-service'
import { WorkStepService } from './work-step-service'
import type { ClaimedStep } from './work-scheduler'

const logger = createLogger('AgentStepRunner')

/** 执行期前置不满足 / 并发冲突（调用方不应重试写）。 */
export class AgentStepRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AgentStepRunnerError'
  }
}

/** 一次 Agent 会话的启动结果（adapterUsed 用于 pinned adapter 校验）。 */
export interface AgentTurnSessionHandle {
  sessionId: string
  adapterUsed: string
}

export interface AgentTurnStartInput {
  adapterName: string
  workingDirectory: string
  nodeId: string
  threadId?: string
  allowedFiles: string[]
  acceptance: string[]
}

export interface AgentTurnRunInput {
  sessionId: string
  prompt: string
  nodeId: string
  /** 由 work_runs.deadline_at 换算出的剩余时长；缺省交给 kernel 的默认 turn 超时。 */
  deadlineMs?: number
}

/** TurnOutcome 的窄化（只保留本层用到的信号）。 */
export interface AgentTurnSignal {
  status: TurnOutcome['status']
  failureClass?: string
  errorCode?: string
  finalText?: string
}

/**
 * 编排层对 Agent 的最小依赖面。
 * 生产实现只允许接 kernel-only 发送（见 AgentManagerTurnRunner），不得回落到 legacy。
 */
export interface AgentTurnRunner {
  startSession(input: AgentTurnStartInput): Promise<AgentTurnSessionHandle>
  runTurn(input: AgentTurnRunInput): Promise<AgentTurnSignal>
  terminateSession(sessionId: string, reason: TerminationReason): Promise<void>
}

export type StepRunStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'needs_input'

export interface StepRunResult {
  status: StepRunStatus
  failureClass?: FailureClass
  reason?: string
  runId: string
  stepId: string
  sessionId?: string
  turnStatus?: TurnOutcome['status']
}

/**
 * D2 确定性验收端口。turn 报 completed 只代表 agent 自称完成；
 * 注入后必须再过一遍机器判定，`ok=false`（含 manual 待确认）一律不得通过。
 */
export type AcceptanceVerifier = (input: {
  acceptanceJson: string | null | undefined
  projectPath: string | null | undefined
}) => Promise<AcceptanceVerdict>

export interface AgentStepRunnerOptions {
  /** pinned adapter（必填）：没有它就没有路由结论，不得猜一个执行器。 */
  adapterName: string
  threadId?: string
  /**
   * 确定性验收执行器（生产由 work-execution-runtime 装配）。
   * 未注入时保持 M3 既有语义；生产路径必须注入，否则等于跳过验收。
   */
  verifyAcceptance?: AcceptanceVerifier
}

const AGENT_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'infra', 'busy', 'turn_fail', 'verify_fail', 'test_fail',
  'env_fail', 'timeout', 'cancel', 'denied',
])

/** agent_turns.failure_class → work_runs.failure_class；无法映射的一律按 turn_fail。 */
export function mapTurnFailureClass(raw: string | undefined): FailureClass {
  if (raw && AGENT_FAILURE_CLASSES.has(raw as FailureClass)) return raw as FailureClass
  switch (raw) {
    case 'timeout':
      return 'timeout'
    case 'crash':
    case 'runtime':
      return 'infra'
    case 'aborted':
    case 'cancel_timeout':
      return 'cancel'
    default:
      return 'turn_fail'
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * 结构化验收渲染（D1 裁决）：acceptance 条目为 {type, expected}，按
 * `- [command] npm test` 形式注入提示词/会话。新写入路径只产生结构化条目
 * （work-item-service 边界校验）；防御性跳过无法识别的形状，不猜语义。
 */
function renderAcceptance(raw: string | null | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const lines: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const { type, expected } = record
    if (typeof type !== 'string' || typeof expected !== 'string' || expected.trim() === '') continue
    const text = typeof record['text'] === 'string' && record['text'].trim() !== '' ? `（${record['text']}）` : ''
    lines.push(`[${type}] ${expected}${text}`)
  }
  return lines
}

/** 步骤提示词：只带本步目标/范围/验收，不注入兄弟分支产物或全图。 */
function buildStepPrompt(item: WorkItemRow, step: WorkStepRow): string {
  const acceptance = renderAcceptance(item.acceptance_json)
  const scope = parseStringArray(step.scope_files_json)
  const parts = [
    `任务：${item.title}`,
    item.goal ? `目标：${item.goal}` : '',
    `当前步骤（seq ${step.seq}）：${step.title}`,
    scope.length > 0 ? `允许修改的文件：\n- ${scope.join('\n- ')}` : '',
    acceptance.length > 0 ? `验收标准：\n- ${acceptance.join('\n- ')}` : '',
  ].filter((p) => p !== '')
  return parts.join('\n\n')
}

/**
 * 把一次 turn 的结果映射成 step/run 终态。
 *
 * 终态写入统一放在事务里，且必须在会话 terminate 之后（§5.9.8.1）；
 * 条件更新未命中的并发终态按冲突抛出，不覆盖既有事实。
 */
export class AgentStepRunner {
  private readonly runs: WorkRunService
  private readonly steps: WorkStepService
  private readonly items: WorkItemService
  private readonly routing: RoutingDecisionRepository

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly turns: AgentTurnRunner,
  ) {
    this.runs = new WorkRunService(db)
    this.steps = new WorkStepService(db)
    this.items = new WorkItemService(db)
    this.routing = new RoutingDecisionRepository(db)
  }

  async run(claim: ClaimedStep, options: AgentStepRunnerOptions): Promise<StepRunResult> {
    const { item, step, run } = claim
    if (step.step_kind !== 'agent') {
      // test/human 步必须交给各自执行器；在这里标记失败会伪造事实。
      throw new AgentStepRunnerError(
        'STEP_KIND_UNSUPPORTED',
        `step ${step.id} 的 step_kind=${step.step_kind}，不得由 AgentStepRunner 执行`,
      )
    }
    if (run.status !== 'running' || step.status !== 'running') {
      throw new AgentStepRunnerError(
        'STEP_NOT_RUNNING',
        `step=${step.status} run=${run.status}，执行器只接受已 claim 的 running 状态`,
      )
    }

    // 前置守卫：任一不满足都不启动会话（fail-closed，不降级、不伪造 node id）。
    if (!options.adapterName.trim()) {
      return this.finalizeFailure(claim, 'infra', 'ROUTE_MISSING')
    }
    if (!item.anchor_node_id) {
      return this.finalizeFailure(claim, 'infra', 'NODE_MISSING')
    }
    if (!item.project_path) {
      return this.finalizeFailure(claim, 'infra', 'PROJECT_PATH_MISSING')
    }

    // 路由行照写（§6.3 可追溯），但只有 pinned adapter + manual_override，不做 Tier 探测。
    const routeDecisionId = this.ensureRouting(item, run, options)

    // deadline：work_runs.deadline_at 是绝对时刻，kernel 要相对时长。
    const deadlineAt = run.deadline_at ?? step.deadline_at
    if (deadlineAt !== null && deadlineAt !== undefined && deadlineAt > 0 && deadlineAt <= Date.now()) {
      return this.finalizeTimeOut(claim, 'deadline_expired_before_start')
    }
    const deadlineMs =
      deadlineAt !== null && deadlineAt !== undefined && deadlineAt > 0
        ? Math.max(1, deadlineAt - Date.now())
        : undefined

    let session: AgentTurnSessionHandle | undefined
    try {
      session = await this.turns.startSession({
        adapterName: options.adapterName,
        workingDirectory: item.project_path,
        nodeId: item.anchor_node_id,
        threadId: options.threadId,
        allowedFiles: parseStringArray(item.scope_files),
        acceptance: renderAcceptance(item.acceptance_json),
      })
      // 适配器回退 = pinned 结论失效：立刻终止该会话并按 infra 失败。
      if (session.adapterUsed !== options.adapterName) {
        logger.warn(
          `[adapter-downgraded] step=${step.id}: 请求 ${options.adapterName}，实际 ${session.adapterUsed}；fail-closed`,
        )
        await this.safeTerminate(session.sessionId, 'error')
        return this.finalizeFailure(claim, 'infra', 'ADAPTER_DOWNGRADED', session.sessionId)
      }
      const attached = this.runs.attachExecution(run.id, {
        routeDecisionId,
        sessionId: session.sessionId,
        threadId: options.threadId,
      })
      if (!attached) {
        throw new AgentStepRunnerError('RUN_NOT_ATTACHABLE', `work_run ${run.id} 已终态，拒绝继续执行`)
      }

      const outcome = await this.turns.runTurn({
        sessionId: session.sessionId,
        prompt: buildStepPrompt(item, step),
        nodeId: item.anchor_node_id,
        deadlineMs,
      })
      // §5.9.8.1：终态写入必须在 session terminate 之后。
      await this.safeTerminate(session.sessionId, terminationReasonFor(outcome.status))
      if (outcome.status === 'completed') {
        // D2：agent 自称完成 ≠ 验收通过；注入执行器时以机器判定为准（fail-closed）。
        return await this.finalizeVerified(claim, outcome, session.sessionId, options)
      }
      return this.finalizeOutcome(claim, outcome, session.sessionId)
    } catch (error) {
      if (session) await this.safeTerminate(session.sessionId, 'error')
      return this.finalizeThrown(claim, error, session?.sessionId)
    }
  }

  /**
   * 路由决策：崩溃重放时复用既有 route_decision_id，不重复写行。
   * 只支持 pinned adapter（manual_override）；Tier 探测推迟（§5.9.10 偏离）。
   */
  private ensureRouting(item: WorkItemRow, run: WorkRunRow, options: AgentStepRunnerOptions): string {
    if (run.route_decision_id) return run.route_decision_id
    const decision = this.routing.record({
      workItemId: item.id,
      workRunId: run.id,
      chosenAdapter: options.adapterName,
      candidates: [
        {
          adapter: options.adapterName,
          score: 1,
          capabilities: [],
          gaps: ['tier_probe_deferred'],
        },
      ],
      policy: 'manual_override',
      reason: 'pinned adapter；Tier 能力探测推迟（§5.9.10 明确偏离）',
    })
    const attached = this.runs.attachExecution(run.id, {
      routeDecisionId: decision.id,
      threadId: options.threadId,
    })
    if (!attached) {
      throw new AgentStepRunnerError('RUN_NOT_ATTACHABLE', `work_run ${run.id} 不能挂载路由决策（已终态）`)
    }
    return decision.id
  }

  /**
   * D2：completed 后的确定性验收。判定不通过、判定不出（含 manual 待确认）、
   * 执行器抛异常，一律按 verify_fail 失败——不把「agent 说完成了」当验收通过。
   */
  private async finalizeVerified(
    claim: ClaimedStep,
    outcome: AgentTurnSignal,
    sessionId: string,
    options: AgentStepRunnerOptions,
  ): Promise<StepRunResult> {
    if (!options.verifyAcceptance) {
      return this.finalizeOutcome(claim, outcome, sessionId)
    }
    let verdict: AcceptanceVerdict
    try {
      verdict = await options.verifyAcceptance({
        acceptanceJson: claim.item.acceptance_json,
        projectPath: claim.item.project_path,
      })
    } catch (error) {
      logger.warn(
        `[verify] step=${claim.step.id} 验收执行器异常，按 verify_fail 收口：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return this.finalizeFailure(claim, 'verify_fail', 'ACCEPTANCE_VERIFIER_ERROR', sessionId, outcome.status)
    }
    // 硬失败优先：只要存在非 manual 的失败条目，就不得因 manual 待确认而变成"等待"。
    if (verdict.missing.length > 0) {
      const codes = [...verdict.missing, ...verdict.pending]
      return this.finalizeFailure(
        claim,
        'verify_fail',
        `ACCEPTANCE_VERIFY_FAILED:${codes.join(',')}`.slice(0, 200),
        sessionId,
        outcome.status,
      )
    }
    // 仅 manual 待确认：步落 needs_input（run 仍 completed），等待人工确认入口。
    if (verdict.pendingItems.length > 0) {
      return this.finalizeNeedsInput(claim, verdict.pendingItems, sessionId, outcome.status)
    }
    return this.finalizeOutcome(claim, outcome, sessionId)
  }

  /**
   * 步落 needs_input：run 记为 completed（turn 已正常结束，不是失败），
   * 步与 item 同事务迁到 needs_input，并把待确认条目写进 input_request_json。
   */
  private finalizeNeedsInput(
    claim: ClaimedStep,
    pendingItems: AcceptancePendingItem[],
    sessionId?: string,
    turnStatus?: TurnOutcome['status'],
  ): StepRunResult {
    const requestJson = JSON.stringify({
      kind: 'acceptance_manual_confirm',
      work_item_id: claim.item.id,
      step_id: claim.step.id,
      requested_at: Date.now(),
      entries: pendingItems.map((entry) => ({
        id: entry.id,
        expected: entry.expected,
        ...(entry.text !== undefined ? { text: entry.text } : {}),
      })),
    })
    const txn = this.db.transaction((): StepRunResult => {
      if (!this.runs.complete(claim.run.id)) {
        throw new AgentStepRunnerError(
          'TERMINAL_CONFLICT',
          `work_run ${claim.run.id} 已被并发置终态，拒绝覆盖`,
        )
      }
      this.items.needsInput(claim.item.id, claim.step.id, requestJson)
      return {
        status: 'needs_input',
        reason: 'ACCEPTANCE_MANUAL_PENDING',
        runId: claim.run.id,
        stepId: claim.step.id,
        sessionId,
        turnStatus,
      }
    })
    return txn()
  }

  private finalizeOutcome(
    claim: ClaimedStep,
    outcome: AgentTurnSignal,
    sessionId: string,
  ): StepRunResult {
    if (outcome.status === 'completed') {
      return this.finalize(claim, {
        status: 'succeeded',
        run: (id) => this.runs.complete(id),
        step: (id) => this.steps.complete(id, { status: 'succeeded' }),
        sessionId,
        turnStatus: outcome.status,
      })
    }
    if (isTimeout(outcome)) {
      return this.finalizeTimeOut(claim, 'turn_timeout', sessionId, outcome.status)
    }
    if (outcome.status === 'cancelled') {
      const failureClass = mapTurnFailureClass(outcome.failureClass)
      return this.finalize(claim, {
        status: 'cancelled',
        failureClass,
        run: (id) => this.runs.cancel(id, cancelReasonFor(outcome)),
        step: (id) => this.steps.cancel(id),
        sessionId,
        turnStatus: outcome.status,
      })
    }
    // failed / orphaned / 其余无法证明成功的终态：一律 failed（fail-closed）。
    const failureClass = mapTurnFailureClass(outcome.failureClass)
    return this.finalize(claim, {
      status: 'failed',
      failureClass,
      run: (id) => this.runs.fail(id, { failureClass, resultSummary: outcome.errorCode }),
      step: (id) => this.steps.fail(id, { status: 'failed', failureClass }),
      sessionId,
      turnStatus: outcome.status,
    })
  }

  private finalizeTimeOut(
    claim: ClaimedStep,
    reason: string,
    sessionId?: string,
    turnStatus?: TurnOutcome['status'],
  ): StepRunResult {
    return this.finalize(claim, {
      status: 'timed_out',
      failureClass: 'timeout',
      reason,
      run: (id) => this.runs.timeout(id),
      step: (id) => this.steps.fail(id, { status: 'timed_out', failureClass: 'timeout' }),
      sessionId,
      turnStatus,
    })
  }

  private finalizeFailure(
    claim: ClaimedStep,
    failureClass: FailureClass,
    reason: string,
    sessionId?: string,
    turnStatus?: TurnOutcome['status'],
  ): StepRunResult {
    return this.finalize(claim, {
      status: 'failed',
      failureClass,
      reason,
      run: (id) => this.runs.fail(id, { failureClass, resultSummary: reason }),
      step: (id) => this.steps.fail(id, { status: 'failed', failureClass }),
      sessionId,
      turnStatus,
    })
  }

  private finalizeThrown(claim: ClaimedStep, error: unknown, sessionId?: string): StepRunResult {
    const name = error instanceof Error ? error.name : ''
    const failureClass: FailureClass = name === 'SessionBusyError' || name === 'NodeBusyError' ? 'busy' : 'infra'
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[step-exec] step=${claim.step.id} 执行异常（${failureClass}）：${message}`)
    return this.finalizeFailure(claim, failureClass, message.slice(0, 200), sessionId)
  }

  private finalize(
    claim: ClaimedStep,
    input: {
      status: StepRunStatus
      failureClass?: FailureClass
      reason?: string
      sessionId?: string
      turnStatus?: TurnOutcome['status']
      run: (runId: string) => WorkRunRow | undefined
      step: (stepId: string) => WorkStepRow
    },
  ): StepRunResult {
    const txn = this.db.transaction((): StepRunResult => {
      if (!input.run(claim.run.id)) {
        throw new AgentStepRunnerError(
          'TERMINAL_CONFLICT',
          `work_run ${claim.run.id} 已被并发置终态，拒绝覆盖`,
        )
      }
      input.step(claim.step.id)
      return {
        status: input.status,
        failureClass: input.failureClass,
        reason: input.reason,
        runId: claim.run.id,
        stepId: claim.step.id,
        sessionId: input.sessionId,
        turnStatus: input.turnStatus,
      }
    })
    return txn()
  }

  private async safeTerminate(sessionId: string, reason: TerminationReason): Promise<void> {
    try {
      await this.turns.terminateSession(sessionId, reason)
    } catch (error) {
      // 终止失败不覆盖已有终态事实；记录后可走恢复/对账。
      logger.warn(
        `[step-exec] session=${sessionId} terminate(${reason}) 失败：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function isTimeout(outcome: AgentTurnSignal): boolean {
  return outcome.failureClass === 'timeout' || outcome.errorCode === 'DEADLINE_EXCEEDED'
}

function terminationReasonFor(status: TurnOutcome['status']): TerminationReason {
  if (status === 'completed') return 'idle'
  if (status === 'cancelled') return 'user'
  return 'error'
}

/**
 * 取消原因：只有 agent_turns 明确记为 aborted/cancel_timeout 才归用户取消；
 * 审批拒绝没有独立运行时信号（不解析 finalText 猜），统一按 user 记录，避免伪造。
 */
function cancelReasonFor(outcome: AgentTurnSignal): 'user' | 'approval_denied' {
  return outcome.failureClass === 'denied' ? 'approval_denied' : 'user'
}

/**
 * 生产实现：把编排层接到 kernel-only 发送入口。
 *
 * 只允许 `sendCommandKernelOnly`——它在 runtime 缺失 / 执行器不在白名单 / 节点未挂载 /
 * driver 缺失时直接抛错，不会静默回落到 legacy（旧路径对非 Claude 节点会话零审批）。
 */
export interface KernelOnlyTurnHost {
  startSession(adapterName: string | null, config: AgentSessionConfig): Promise<{ sessionId: string; adapterUsed: string }>
  sendCommandKernelOnly(
    sessionId: string,
    command: AgentCommand,
    options?: { contextAssembled?: boolean },
  ): Promise<TurnOutcome>
  terminateSession(sessionId: string, reason?: TerminationReason): Promise<void>
}

export class AgentManagerTurnRunner implements AgentTurnRunner {
  constructor(private readonly host: KernelOnlyTurnHost) {}

  async startSession(input: AgentTurnStartInput): Promise<AgentTurnSessionHandle> {
    const started = await this.host.startSession(input.adapterName, {
      workingDirectory: input.workingDirectory,
      allowedFiles: input.allowedFiles,
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: '',
      acceptanceCriteria: input.acceptance,
      nodeId: input.nodeId,
      threadId: input.threadId,
      commandType: 'implement',
    })
    return { sessionId: started.sessionId, adapterUsed: started.adapterUsed }
  }

  async runTurn(input: AgentTurnRunInput): Promise<AgentTurnSignal> {
    const outcome = await this.host.sendCommandKernelOnly(input.sessionId, {
      type: 'implement',
      description: input.prompt,
      targetNodeId: input.nodeId,
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    })
    return {
      status: outcome.status,
      failureClass: outcome.failureClass,
      errorCode: outcome.errorCode,
      finalText: outcome.finalText,
    }
  }

  async terminateSession(sessionId: string, reason: TerminationReason): Promise<void> {
    await this.host.terminateSession(sessionId, reason)
  }
}
