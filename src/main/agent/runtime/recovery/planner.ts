/**
 * D5：启动对账。
 *
 * 承诺边界（agent-architecture.md §5.5/§7）：
 * - 只恢复到「最后一个已持久化事件 + stepOutcomes 对账」，不承诺任意步骤回放；
 * - 每条 step 都必须得到 completed / unknown-needs-rerun / needs-human 之一的确定处置，
 *   并真正写入 agent_steps.test_disposition；
 * - M0 的进程已随崩溃消失，因此所有非终态 turn 一律对账为 orphaned，不自动重放工具调用。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AgentRepository, AgentStepRow } from '../db/repository'
import { AgentRuntimeError } from '../errors'
import type { RecoveryPlan, StepOutcome } from '@shared/types/agent-runtime'

export interface RecoveryPlanResult {
  plans: RecoveryPlan[]
  interruptedRuns: number
  abortedTurns: number
  orphanedSessions: number
  pendingApprovals: number
}

export interface RecoveryPlannerOptions {
  /** 读取磁盘当前 hash；测试可注入。默认对文件做 sha256，读不到返回 null。 */
  readCurrentHash?: (path: string) => string | null
}

type SnapshotState = 'consistent' | 'inconsistent' | 'unknown'

/** 只读规划：不修改数据库。 */
export function planRecovery(repo: AgentRepository, options: RecoveryPlannerOptions = {}): RecoveryPlanResult {
  const plans: RecoveryPlan[] = []
  const activeTurns = repo.listAllNonTerminalTurns()
  const sessionIds = new Set<string>()
  const runs = new Set<string>()
  const readCurrentHash = options.readCurrentHash ?? readDiskHash

  for (const turn of activeTurns) {
    runs.add(turn.run_id)
    sessionIds.add(turn.session_id)
    const steps = repo.listSteps(turn.id)
    const artifactState = compareArtifacts(repo.listArtifacts(turn.id), readCurrentHash)
    // turn 级判定：非终态 turn 一律不自动重放，但终态语义按崩溃前阶段收敛。
    // - queued：从未启动，没有可执行的工具；
    // - running：执行中崩溃 → orphaned/crash；
    // - waiting_approval：等待审批时崩溃，审批决定未落定 → orphaned/crash；
    // - cancelling：取消过程中崩溃，用户意图已明确 → cancelled/aborted。
    const terminalStatus = turn.status === 'cancelling' ? 'cancelled' : 'orphaned'
    const phase = describeTurnPhase(turn.status)
    // 每条 step 都必须出现在 stepOutcomes（含 aborted / open / 已终态），
    // 因此这里对 listSteps 全量映射，而不是只挑 open step。
    const stepOutcomes = steps.map((step) => evaluateStepDisposition(step, artifactState))
    plans.push({
      runId: turn.run_id,
      turnId: turn.id,
      sessionId: turn.session_id,
      action: 'abort_turn',
      terminalStatus,
      reason: steps.length > 0
        ? `${phase} with ${steps.length} step(s): reconciled by stepOutcomes (no automatic replay)`
        : `${phase} with no step evidence: turn cannot be resumed`,
      stepOutcomes,
    })
  }

  for (const sessionId of sessionIds) {
    plans.push({
      runId: [...runs][0] ?? '',
      sessionId,
      action: 'mark_session_orphaned',
      reason: 'executor process is not owned by this process after restart',
    })
  }

  // 没有活跃 turn 但残留 active/starting 的 session 同样不可信
  for (const session of repo.listSessionsByStatus('active')) {
    if (sessionIds.has(session.id)) continue
    plans.push({
      runId: '',
      sessionId: session.id,
      action: 'mark_session_orphaned',
      reason: 'active session survived restart without an in-flight turn',
    })
  }
  for (const session of repo.listSessionsByStatus('starting')) {
    plans.push({
      runId: '',
      sessionId: session.id,
      action: 'mark_session_orphaned',
      reason: 'session was still starting when the process crashed',
    })
  }

  // 所有含非终态 turn 的 run 都先标 interrupted；随后可能被 completed 投影覆盖
  for (const runId of runs) {
    plans.push({ runId, action: 'mark_run_interrupted', reason: 'run had non-terminal turns at startup' })
  }

  // 已全部终态但 run 尚未投影的（例如上次崩溃发生在收尾阶段）。
  // 这里不做全库扫描：对活跃 turn 所属 run 已在上面标记 interrupted，
  // 其余终态 run 由后续 runNode projectRunStatus 负责。

  const pendingApprovals = repo.listPendingApprovals()
  for (const approval of pendingApprovals) {
    // S8/D6:subject 审批(test_plan/work_item)无 run/turn——保留为待决计划的
    // 审计锚点(runId/turnId 取锚点串;重启对账不重放它们,见 reason)。
    if (!approval.run_id || !approval.turn_id) continue
    plans.push({
      runId: approval.run_id,
      turnId: approval.turn_id,
      action: 'keep_pending_approval',
      reason: 'pending approvals survive restart for audit, then startup reconcile denies them (decided_by=startup); they are not re-emitted',
    })
  }

  // 计数必须与真正落库的 mark_session_orphaned 计划一致：
  // 除「有非终态 turn 的会话」外，两个兜底循环也会把无 in-flight turn 的
  // active/starting 会话标成 orphaned，漏计会让启动报告看起来「零误伤」。
  const orphanedSessionIds = new Set(
    plans
      .filter((plan) => plan.action === 'mark_session_orphaned' && plan.sessionId)
      .map((plan) => plan.sessionId as string),
  )

  return {
    plans,
    interruptedRuns: runs.size,
    abortedTurns: activeTurns.length,
    orphanedSessions: orphanedSessionIds.size,
    pendingApprovals: pendingApprovals.length,
  }
}

/** turn 崩溃前所处阶段的可读描述（只用于规划 reason，不改变动作）。 */
function describeTurnPhase(status: string): string {
  switch (status) {
    case 'queued':
      return 'crash while queued (never started)'
    case 'waiting_approval':
      return 'crash while waiting approval'
    case 'cancelling':
      return 'crash while cancelling'
    case 'running':
      return 'crash while running'
    default:
      return `crash with turn status ${status}`
  }
}

/**
 * §5.5 五行判定（逐 step）。
 * 已终态的 step 不重跑；未终态的严格落三选一。
 *
 * `aborted`/`unknown` 不是成功声明：仍按 approved_at/executing_at 与快照证据
 * 走下面的 2×2 + 行 4/5 判定，不能因为「已标 aborted」就跳过处置。
 */
export function evaluateStepDisposition(step: AgentStepRow, artifactState: SnapshotState): StepOutcome {
  switch (step.status) {
    case 'done':
      return { stepId: step.id, disposition: 'completed', action: 'keep', reason: 'terminal done: backend reported success' }
    case 'failed':
      return { stepId: step.id, disposition: 'needs-human', action: 'needs-human', reason: 'terminal failed: inspect before rerun' }
    case 'denied':
      return { stepId: step.id, disposition: 'unknown-needs-rerun', action: 'replay', reason: 'denied before execution: no side effect expected' }
    default:
      break
  }

  // 行 1：审批通过但写未落地（没有 executing_at）→ 可安全重跑
  if (step.approved_at && !step.executing_at) {
    return {
      stepId: step.id,
      disposition: 'unknown-needs-rerun',
      action: 'replay',
      reason: 'approved but not executing (row 1): write did not land, safe to replay',
    }
  }

  // 行 2/3：已进入执行阶段 → 只信起始快照 hash
  if (step.executing_at) {
    if (artifactState === 'consistent') {
      return {
        stepId: step.id,
        disposition: 'completed',
        action: 'keep',
        reason: 'executing and snapshot hash matches (row 2): side effect already landed, mark done without replay',
      }
    }
    return {
      stepId: step.id,
      disposition: 'needs-human',
      action: 'needs-human',
      reason: `executing with ${artifactState === 'unknown' ? 'unreadable' : 'mismatched'} snapshot (row 3): refuse automatic replay`,
    }
  }

  // 行 4/5：未审批且未执行 → 用 hash 判断是否可能已写
  if (artifactState === 'consistent') {
    return {
      stepId: step.id,
      disposition: 'unknown-needs-rerun',
      action: 'replay',
      reason: 'not approved or executed, snapshot consistent (row 4): safe to replay',
    }
  }
  return {
    stepId: step.id,
    disposition: 'needs-human',
    action: 'needs-human',
    reason: `not approved or executed, snapshot ${artifactState === 'unknown' ? 'unreadable' : 'mismatched'} (row 5): possible side effect, refuse automatic replay`,
  }
}

/**
 * 应用规划。可重复执行（幂等），因为所有动作都以当前状态为准。
 */
export function applyRecoveryPlan(repo: AgentRepository, result: RecoveryPlanResult): void {
  for (const plan of result.plans) {
    repo.applyRecoveryPlan(plan)
  }
}

/** 对账后断言：不存在悬空非终态。违反则 RECOVERY_FAILED。 */
export function assertNoDangling(repo: AgentRepository): void {
  const dangling = repo.listAllNonTerminalTurns()
  if (dangling.length > 0) {
    throw new AgentRuntimeError(
      'RECOVERY_FAILED',
      `RECOVERY_FAILED: recovery left ${dangling.length} non-terminal turn(s): ${dangling.map((t) => t.id).join(', ')}`,
    )
  }
  const activeSessions = repo.listSessionsByStatus('active')
  if (activeSessions.length > 0) {
    throw new AgentRuntimeError(
      'RECOVERY_FAILED',
      `RECOVERY_FAILED: recovery left ${activeSessions.length} active session(s): ${activeSessions.map((s) => s.id).join(', ')}`,
    )
  }
}

function compareArtifacts(
  artifacts: Array<Record<string, unknown>>,
  readCurrentHash: (path: string) => string | null,
): SnapshotState {
  const snapshots = artifacts.filter(
    (artifact) =>
      typeof artifact.path === 'string' &&
      typeof artifact.base_hash === 'string' &&
      artifact.base_hash.length > 0,
  )
  if (snapshots.length === 0) return 'unknown'

  let sawUnreadable = false
  for (const artifact of snapshots) {
    const path = artifact.path as string
    const baseHash = artifact.base_hash as string
    const current = readCurrentHash(path)
    if (!current) {
      sawUnreadable = true
      continue
    }
    if (current !== baseHash) return 'inconsistent'
  }
  return sawUnreadable ? 'unknown' : 'consistent'
}

function readDiskHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}
