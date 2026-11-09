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
import { recordAcceptanceEvaluation } from './acceptance-diagnostics'
import { recordEvidenceWriteFailure } from './evidence-write-diagnostics'
import { EvidenceService, EvidenceSuggestionService } from './evidence-service'
import { GitWorktreeManager, type ExecutedContent } from './test-executor'
import { WorkItemService, type WorkItemRow, type WorkStepRow } from './work-item-service'
import {
  ChangeSetService,
  RoutingDecisionRepository,
  WorkRunService,
  type FailureClass,
  type GitRunner,
  type WorkRunRow,
} from './work-run-service'
import { GitWorkspaceChangeRunner, collectWorkspaceChanges, type WorkspaceChangeSnapshot } from './workspace-change-stats'
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
  /** 本回合验收逐条结果（仅在注入 verifyAcceptance 且走到通过/待确认时有值）。 */
  acceptance?: AcceptanceVerdict
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
  /**
   * 执行后工作区内容指纹（E2 content_hash 来源）；缺省用受控 git 采集。
   * 取不到（非 git/异常）时调用方必须放弃写证据，不得用 null 或别处哈希顶替。
   */
  executedContent?: (projectPath: string) => ExecutedContent | null
  /**
   * change_sets 的 git 能力（测试注入）；缺省用受控 git（GitWorkspaceChangeRunner）。
   */
  changeSetGit?: GitRunner
  /**
   * 文件变更采集（测试注入）；缺省按 base_commit 采集项目工作区 diff。
   */
  workspaceChanges?: (projectPath: string, baseCommit: string | null) => WorkspaceChangeSnapshot | null
}

/** 受控 git 采集器（无状态，仅复用 executedContent 的 tree+dirty 内容绑定）。 */
const worktreeManager = new GitWorktreeManager()

/** G1-7：work_runs.outputs_json / output_parse 的生产端解析结果。 */
interface StepOutputParse {
  outputs?: Record<string, unknown>
  outputParse?: 'ok' | 'fallback'
}

/** G1-7：partial 输入（字段/总量截断由 WorkRunService.normalizePartial 统一处理，D-16）。 */
type PartialInput = {
  stdout_tail?: string
  stderr_tail?: string
  file_changes?: string[]
  errors?: string[]
  artifact_refs?: string[]
  captured_at?: number
}

/** G1-7：turn 结束后同一次采集的执行事实（输出解析 / partial / 文件变更共用）。 */
interface FinalizeContext {
  executed: ExecutedContent | null
  parsed: StepOutputParse
  partial?: PartialInput
}

/**
 * 按 step.output_schema_json 解析 turn 的 finalText。
 *
 * - 无 schema：不伪造 outputs，也不写 output_parse（当前生产步骤通常没有 schema）；
 * - 有 schema：finalText 必须是 JSON 对象且包含 schema 要求的键 → ok，否则 fallback；
 * - schema 本身不合法：fallback（fail-closed，不把原始文本当结构化结果）。
 */
function parseStepOutputs(step: WorkStepRow, outcome: AgentTurnSignal): StepOutputParse {
  const schemaRaw = step.output_schema_json?.trim()
  if (!schemaRaw) return {}
  const text = outcome.finalText?.trim()
  if (!text) return { outputParse: 'fallback' }
  let required: string[]
  try {
    const schema = JSON.parse(schemaRaw) as unknown
    if (Array.isArray(schema)) {
      required = schema.filter((key): key is string => typeof key === 'string')
    } else if (typeof schema === 'object' && schema !== null) {
      required = Object.keys(schema as Record<string, unknown>)
    } else {
      return { outputParse: 'fallback' }
    }
  } catch {
    return { outputParse: 'fallback' }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { outputParse: 'fallback' }
    }
    const record = parsed as Record<string, unknown>
    if (required.some((key) => !(key in record))) return { outputParse: 'fallback' }
    return { outputs: record, outputParse: 'ok' }
  } catch {
    return { outputParse: 'fallback' }
  }
}

/** 只把实际解析到的字段传给 WorkRunService.complete，避免 undefined 覆盖既有列。 */
function runOutputData(
  ctx: FinalizeContext | undefined,
): { outputs?: Record<string, unknown>; outputParse?: 'ok' | 'fallback' } | undefined {
  if (!ctx) return undefined
  const data: { outputs?: Record<string, unknown>; outputParse?: 'ok' | 'fallback' } = {}
  if (ctx.parsed.outputs !== undefined) data.outputs = ctx.parsed.outputs
  if (ctx.parsed.outputParse !== undefined) data.outputParse = ctx.parsed.outputParse
  return Object.keys(data).length > 0 ? data : undefined
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
  private readonly evidence: EvidenceService
  private readonly evidenceSuggestions: EvidenceSuggestionService
  private readonly changeSets: ChangeSetService

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly turns: AgentTurnRunner,
  ) {
    this.runs = new WorkRunService(db)
    this.steps = new WorkStepService(db)
    this.items = new WorkItemService(db)
    this.routing = new RoutingDecisionRepository(db)
    this.evidence = new EvidenceService(db)
    this.evidenceSuggestions = new EvidenceSuggestionService(db)
    this.changeSets = new ChangeSetService(db, new GitWorkspaceChangeRunner())
  }

  /** 测试可注入独立 git 能力；生产固定用受控 git 实现。 */
  private changeSetsFor(options: AgentStepRunnerOptions): ChangeSetService {
    return options.changeSetGit ? new ChangeSetService(this.db, options.changeSetGit) : this.changeSets
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
    let changeSetBase: string | null | undefined
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

      // G1-7：文件变更基线必须在 turn 开始前采集；失败不影响执行。
      changeSetBase = this.captureChangeBase(claim, session.sessionId, options)

      const outcome = await this.turns.runTurn({
        sessionId: session.sessionId,
        prompt: buildStepPrompt(item, step),
        nodeId: item.anchor_node_id,
        deadlineMs,
      })
      // §5.9.8.1：终态写入必须在 session terminate 之后。
      await this.safeTerminate(session.sessionId, terminationReasonFor(outcome.status))
      // G1-7：执行后内容指纹只采集一次，输出解析/partial/文件变更共用。
      const executed = this.collectExecuted(item, options)
      const parsed = parseStepOutputs(step, outcome)
      const partial = this.buildPartial(outcome, executed)
      const result =
        outcome.status === 'completed'
          ? // D2：agent 自称完成 ≠ 验收通过；注入执行器时以机器判定为准（fail-closed）。
            await this.finalizeVerified(claim, outcome, session.sessionId, options, { executed, parsed, partial })
          : this.finalizeOutcome(claim, outcome, session.sessionId, { executed, parsed, partial })
      // 终态已提交后再写证据/文件变更：写失败只留诊断，绝不把已完成的 step 改回失败。
      this.recordTurnEvidence(claim, result, session.sessionId, options)
      if (changeSetBase !== undefined) this.recordChangeHead(claim, changeSetBase, options)
      return result
    } catch (error) {
      if (session) await this.safeTerminate(session.sessionId, 'error')
      const result = this.finalizeThrown(claim, error, session?.sessionId)
      if (session && changeSetBase !== undefined) this.recordChangeHead(claim, changeSetBase, options)
      return result
    }
  }

  /** G1-7：记录 change_sets 基线；非 git/写失败只告警，不影响 turn。 */
  private captureChangeBase(
    claim: ClaimedStep,
    sessionId: string,
    options: AgentStepRunnerOptions,
  ): string | null | undefined {
    const projectPath = claim.item.project_path
    if (!projectPath) return undefined
    try {
      const base = this.changeSetsFor(options).captureBase({
        projectPath,
        graphId: claim.item.graph_id,
        workRunId: claim.run.id,
        sessionId,
      })
      return base ? base.base_commit : null
    } catch (error) {
      logger.warn(`[change-base] run=${claim.run.id} 基线采集失败（不影响执行）：${String(error)}`)
      return undefined
    }
  }

  /** G1-7：记录 change_sets 收口；失败只告警，终态已提交。 */
  private recordChangeHead(
    claim: ClaimedStep,
    baseCommit: string | null,
    options: AgentStepRunnerOptions,
  ): void {
    const projectPath = claim.item.project_path
    if (!projectPath) return
    try {
      const collect = options.workspaceChanges ?? collectWorkspaceChanges
      const snapshot = collect(projectPath, baseCommit)
      if (!snapshot) return
      this.changeSetsFor(options).captureHead(claim.run.id, snapshot)
    } catch (error) {
      logger.warn(`[change-head] run=${claim.run.id} 文件变更采集失败（不影响终态）：${String(error)}`)
    }
  }

  /** G1-7：执行后工作区内容指纹；失败返回 null（不伪造哈希）。 */
  private collectExecuted(item: WorkItemRow, options: AgentStepRunnerOptions): ExecutedContent | null {
    if (!item.project_path) return null
    try {
      return (options.executedContent ?? worktreeManager.executedContent)(item.project_path)
    } catch {
      return null
    }
  }

  /** G1-7：失败/超时 partial；字段缺失即不写，截断交给 WorkRunService（D-16）。 */
  private buildPartial(outcome: AgentTurnSignal, executed: ExecutedContent | null): PartialInput | undefined {
    const tail = outcome.finalText?.trim()
    const files = executed?.dirtyFiles ?? []
    if (!tail && files.length === 0 && !outcome.errorCode) return undefined
    return {
      ...(tail ? { stdout_tail: tail } : {}),
      ...(files.length > 0 ? { file_changes: files } : {}),
      ...(outcome.errorCode ? { errors: [outcome.errorCode] } : {}),
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
   * E2 session_turn 收口（C 口径，2026-11-09）：
   *
   * ① `succeeded` 且本回合验收**全部条目机器可判定且通过**（command 退出码 0 /
   *    file_check 命中；manual 条目数为 0）→ **直接写 `node_evidence`**。
   *    `produced_by='system'`：证据由机器验收驱动，不是 agent 自称；ref_json 记录
   *    逐条验收结果与执行内容指纹。
   * ② 存在 manual 待确认（`needs_input`）→ 只写 `pending` 建议，人工接受才转证据。
   * ③ 验收失败、未注入验收、缺 `anchor_entity_key`/`project_path`、取不到执行指纹
   *    → 什么都不写（保留告警/诊断）。
   *
   * 写入发生在 step/run 终态事务提交之后：失败只留诊断，不回滚、不改写 step 状态。
   */
  private recordTurnEvidence(
    claim: ClaimedStep,
    result: StepRunResult,
    sessionId: string,
    options: AgentStepRunnerOptions,
  ): void {
    // 没有机器验收就没有“完成事实”，什么都不写（避免 agent 自称完成直接变 implemented）。
    if (!options.verifyAcceptance) return
    if (result.status !== 'succeeded' && result.status !== 'needs_input') return
    const verdict = result.acceptance
    if (!verdict) return
    const machineAllPass = result.status === 'succeeded' && isMachineAllPass(verdict)
    const manualPending = result.status === 'needs_input' && verdict.pendingItems.length > 0
    // succeeded 但验收结果不满足“全机器可判定且通过”→ fail-closed，不落证据。
    if (!machineAllPass && !manualPending) return

    const { item, step, run } = claim
    if (!item.anchor_entity_key) {
      logger.warn(`[evidence] step=${step.id} 缺 anchor_entity_key，跳过 E2（不伪造节点）`)
      return
    }
    if (!item.project_path) {
      logger.warn(`[evidence] step=${step.id} 缺 project_path，跳过 E2`)
      return
    }

    let executed: ExecutedContent | null
    try {
      executed = (options.executedContent ?? worktreeManager.executedContent)(item.project_path)
    } catch (error) {
      logger.warn(
        `[evidence] step=${step.id} 内容指纹采集失败：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      executed = null
    }
    // 取不到执行后指纹（非 git / git 异常）→ 宁缺勿假：不写 null，也不拿别处内容顶替。
    if (!executed) {
      logger.warn(`[evidence] step=${step.id} 取不到执行后工作区指纹，跳过 E2`)
      recordEvidenceWriteFailure(this.db, {
        source: 'agent_turn',
        level: 'E2',
        evidenceType: 'session_turn',
        workItemId: item.id,
        stepId: step.id,
        workRunId: run.id,
        nodeEntityKey: item.anchor_entity_key,
        error: 'EXECUTED_CONTENT_UNAVAILABLE',
      })
      return
    }

    const turnId = latestTurnId(this.db, sessionId)
    const ref = {
      kind: 'agent_turn',
      sessionId,
      turnId,
      runId: run.id,
      workItemId: item.id,
      stepId: step.id,
      adapterName: options.adapterName,
      turnStatus: result.turnStatus ?? null,
      acceptanceOutcome: result.status,
      // 逐条验收事实：直落证据与建议共用，接受后可复核“凭什么通过/待确认”。
      acceptance: {
        ok: verdict.ok,
        checked: verdict.checked,
        items: verdict.items,
        missing: verdict.missing,
        pending: verdict.pending,
        manualEntryCount: verdict.pendingItems.length,
        pendingItems: verdict.pendingItems,
      },
      // agent 直接写在这个项目工作区，指纹即本次执行面（非 TestExecutor 的独立 worktree）。
      executionWorkspace: 'project_worktree',
      workspaceChangesIncluded: true,
      worktreeTree: executed.treeHash,
      dirtyFiles: executed.dirtyFiles,
      executedContentHash: executed.contentHash,
    }

    try {
      if (machineAllPass) {
        const { row, reused } = this.evidence.create({
          level: 'E2',
          graphId: item.graph_id,
          nodeEntityKey: item.anchor_entity_key,
          nodeId: item.anchor_node_id ?? undefined,
          projectPath: item.project_path,
          evidenceType: 'session_turn',
          ref,
          summary:
            `agent 回合完成（机器验收通过：${verdict.checked}/${verdict.items.length} 条全过，manual 0 条）` +
            `(session_turn@${executed.contentHash.slice(0, 12)}` +
            `${executed.dirtyFiles.length > 0 ? `;${executed.dirtyFiles.length} 个未提交文件计入内容绑定` : ';工作区干净'})`,
          actor: 'system',
          producedBy: 'system',
          currentHash: executed.contentHash,
          workRunId: run.id,
          workItemId: item.id,
          sessionId,
          turnId: turnId ?? undefined,
        })
        logger.info(
          `[evidence] step=${step.id} E2 session_turn evidence ${reused ? 'reused' : 'created'} id=${row.id}`,
        )
        return
      }

      const { row, reused } = this.evidenceSuggestions.suggest({
        graphId: item.graph_id,
        nodeEntityKey: item.anchor_entity_key,
        nodeId: item.anchor_node_id ?? undefined,
        projectPath: item.project_path,
        level: 'E2',
        evidenceType: 'session_turn',
        ref,
        rationale:
          `agent 回合完成（仅剩 ${verdict.pendingItems.length} 条 manual 待确认）` +
          `(session_turn@${executed.contentHash.slice(0, 12)}` +
          `${executed.dirtyFiles.length > 0 ? `;${executed.dirtyFiles.length} 个未提交文件计入内容绑定` : ';工作区干净'})`,
        // 仅剩人工待确认的候选不替人做结论。
        confidence: 0.6,
        producedByRunId: run.id,
      })
      logger.info(
        `[evidence] step=${step.id} E2 session_turn suggestion ${reused ? 'reused' : 'created'} id=${row.id}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`[evidence] step=${step.id} E2 写入失败（不改变已完成终态）：${message}`)
      recordEvidenceWriteFailure(this.db, {
        source: 'agent_turn',
        level: 'E2',
        evidenceType: 'session_turn',
        workItemId: item.id,
        stepId: step.id,
        workRunId: run.id,
        nodeEntityKey: item.anchor_entity_key,
        error: message,
      })
    }
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
    ctx: FinalizeContext,
  ): Promise<StepRunResult> {
    if (!options.verifyAcceptance) {
      return this.finalizeOutcome(claim, outcome, sessionId, ctx)
    }
    let verdict: AcceptanceVerdict
    const verifyStartedAt = Date.now()
    try {
      verdict = await options.verifyAcceptance({
        acceptanceJson: claim.item.acceptance_json,
        projectPath: claim.item.project_path,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(
        `[verify] step=${claim.step.id} 验收执行器异常，按 verify_fail 收口：` +
          `${message}`,
      )
      // 逐条诊断（纯诊断）：执行器抛异常也留一条，便于区分「引擎坏了」与「确实没过」。
      recordAcceptanceEvaluation(this.db, {
        workItemId: claim.item.id,
        stepId: claim.step.id,
        source: 'verifier_error',
        durationMs: Date.now() - verifyStartedAt,
        verifierError: message,
      })
      return this.finalizeFailure(claim, 'verify_fail', 'ACCEPTANCE_VERIFIER_ERROR', sessionId, outcome.status, ctx.partial)
    }
    // 每次验收都留逐条结果；写失败不影响准入判定（record 内部只告警）。
    recordAcceptanceEvaluation(this.db, {
      workItemId: claim.item.id,
      stepId: claim.step.id,
      source: 'turn_completed',
      durationMs: Date.now() - verifyStartedAt,
      verdict,
    })
    // 硬失败优先：只要存在非 manual 的失败条目，就不得因 manual 待确认而变成"等待"。
    if (verdict.missing.length > 0) {
      const codes = [...verdict.missing, ...verdict.pending]
      return this.finalizeFailure(
        claim,
        'verify_fail',
        `ACCEPTANCE_VERIFY_FAILED:${codes.join(',')}`.slice(0, 200),
        sessionId,
        outcome.status,
        ctx.partial,
      )
    }
    // 仅 manual 待确认：步落 needs_input（run 仍 completed），等待人工确认入口。
    if (verdict.pendingItems.length > 0) {
      const result = this.finalizeNeedsInput(claim, verdict.pendingItems, sessionId, outcome.status, ctx)
      return { ...result, acceptance: verdict }
    }
    const result = this.finalizeOutcome(claim, outcome, sessionId, ctx)
    // 全部条目均为机器可判定且通过（manual 数为 0）→ 可直落 E2（C 口径）。
    return { ...result, acceptance: verdict }
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
    ctx?: FinalizeContext,
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
      if (!this.runs.complete(claim.run.id, runOutputData(ctx))) {
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
    ctx: FinalizeContext,
  ): StepRunResult {
    if (outcome.status === 'completed') {
      return this.finalize(claim, {
        status: 'succeeded',
        run: (id) => this.runs.complete(id, runOutputData(ctx)),
        step: (id) => this.steps.complete(id, { status: 'succeeded' }),
        sessionId,
        turnStatus: outcome.status,
      })
    }
    if (isTimeout(outcome)) {
      return this.finalizeTimeOut(claim, 'turn_timeout', sessionId, outcome.status, ctx.partial)
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
      run: (id) =>
        this.runs.fail(id, {
          failureClass,
          resultSummary: outcome.errorCode,
          ...(ctx.partial ? { partial: ctx.partial } : {}),
        }),
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
    partial?: PartialInput,
  ): StepRunResult {
    return this.finalize(claim, {
      status: 'timed_out',
      failureClass: 'timeout',
      reason,
      run: (id) => this.runs.timeout(id, partial),
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
    partial?: PartialInput,
  ): StepRunResult {
    return this.finalize(claim, {
      status: 'failed',
      failureClass,
      reason,
      run: (id) =>
        this.runs.fail(id, {
          failureClass,
          resultSummary: reason,
          ...(partial ? { partial } : {}),
        }),
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
    return this.finalizeFailure(claim, failureClass, message.slice(0, 200), sessionId, undefined, {
      errors: [message.slice(0, 400)],
    })
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

/**
 * C 口径：本回合验收是否「全部条目机器可判定且通过」。
 * 要求至少一条条目、无 missing/pending、无 manual 待确认，且每条都是
 * command/file_check 且 outcome='pass'——任一不满足都不得直落 E2。
 */
function isMachineAllPass(verdict: AcceptanceVerdict): boolean {
  return (
    verdict.ok &&
    verdict.missing.length === 0 &&
    verdict.pending.length === 0 &&
    verdict.pendingItems.length === 0 &&
    verdict.items.length > 0 &&
    verdict.items.every(
      (item) => (item.type === 'command' || item.type === 'file_check') && item.outcome === 'pass',
    )
  )
}

/** 会话最近一次 turn id（证据溯源用）；agent_turns 未建/无行时留空，不猜。 */
function latestTurnId(db: BetterSqlite3.Database, sessionId: string): string | null {
  try {
    const row = db
      .prepare('SELECT id FROM agent_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as { id?: string } | undefined
    return typeof row?.id === 'string' && row.id !== '' ? row.id : null
  } catch {
    return null
  }
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
