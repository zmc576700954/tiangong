import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Db } from '../db/db'
import { RunRepository, type RunRow, type StepRow } from '../db/repository'
import { mutation } from '../mutation'
import {
  ACTIVE_RUN_STATUSES,
  type AgentEventEnvelope,
  type ArtifactChangedPayload,
  type RecoveryPlan,
  type RecoveryStrategy,
  type StepDisposition,
  type StepDispositionRecord,
} from '../types'

export interface SweepReport {
  runsMarkedInterrupted: number
  stepsMarkedUnknown: number
  pendingApprovalsRetained: number
}

export function hashFile(filePath: string): string {
  const content = readFileSync(filePath)
  return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 重启清扫：running/awaiting_approval 一律收敛到 interrupted，step running/approved → unknown。
 * 新文档要求待审批项保留并重新推送，因此 pending approval 不在这里 expire。
 * 不变量：清扫后不允许存在任何悬空的 running 状态。
 */
export function sweepInterrupted(db: Db): SweepReport {
  const repo = new RunRepository(db)
  const before = repo.listRunsByStatuses(ACTIVE_RUN_STATUSES)
  const runIds = before.filter((r) => r.status !== 'interrupted').map((r) => r.id)

  if (mutation() !== 'no-orphan-sweep') {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE agent_runs SET status = 'interrupted', updated_at = ?
         WHERE status IN ('created','running','awaiting_approval','cancelling')`,
      ).run(Date.now())
      db.prepare(
        `UPDATE agent_steps SET status = 'unknown'
         WHERE status IN ('requested','running','approved')`,
      ).run()
    })
    tx()
  }

  return {
    runsMarkedInterrupted: runIds.length,
    stepsMarkedUnknown: stepsUnknownCount(db, runIds),
    pendingApprovalsRetained: repo.listPendingApprovals().length,
  }
}

function stepsUnknownCount(db: Db, runIds: string[]): number {
  if (runIds.length === 0) return 0
  const placeholders = runIds.map(() => '?').join(',')
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_steps WHERE run_id IN (${placeholders}) AND status = 'unknown'`,
    )
    .get(...runIds) as { n: number }
  return row.n
}

/**
 * 恢复计划：以「最后一条已持久化事件」为边界（新文档 §6.2），
 * 不宣称恢复后端进程内的未上报中间态。
 */
export function planRecovery(db: Db, workspaceRoot: string): RecoveryPlan[] {
  const repo = new RunRepository(db)
  const runs = repo
    .listRunsByStatuses(['interrupted'])
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  return runs.map((run) => planOne(repo, run, workspaceRoot))
}

function planOne(repo: RunRepository, run: RunRow, workspaceRoot: string): RecoveryPlan {
  const steps = repo.listSteps(run.id)
  const events = repo.listEvents(run.id)
  const approvals = repo.listPendingApprovals(run.id)
  const pendingToolCallIds = new Set(approvals.map((a) => a.toolCallId))

  const outcomes: StepDispositionRecord[] = steps.map((step) =>
    classifyStep(step, events, pendingToolCallIds, workspaceRoot),
  )

  const hasNeedsHuman = outcomes.some((o) => o.disposition === 'needs-human')
  const hasUnknown = outcomes.some((o) => o.disposition === 'unknown-needs-rerun')
  const pendingApproval = approvals.length > 0

  let strategy: RecoveryStrategy
  let reason: string
  if (hasNeedsHuman && !pendingApproval) {
    strategy = 'abandon'
    reason = '存在无法与磁盘对账的副作用，必须转人工；不自动重跑'
  } else if (pendingApproval) {
    strategy = 'replay'
    reason = '待审批项已保留，重启后需重新推送并等待用户决定；未决定前禁止执行'
  } else if (hasUnknown) {
    strategy = 'replay'
    reason = '存在无法证明副作用的 step，只能从最后持久化事件重放'
  } else {
    strategy = run.backend_session_id ? 'resume-native' : 'replay'
    reason = run.backend_session_id
      ? '所有副作用已对账一致，可优先 native resume'
      : '所有副作用已对账一致，但无后端原生会话，只能 replay'
  }

  return {
    runId: run.id,
    nodeId: run.node_id,
    strategy,
    // 新文档 §6.2：由用户选择 resume / abandon，任何孤儿 run 都不静默续跑
    requiresUserConfirmation: true,
    stepOutcomes: outcomes,
    reason,
  }
}

function classifyStep(
  step: StepRow,
  events: AgentEventEnvelope[],
  pendingToolCallIds: Set<string>,
  workspaceRoot: string,
): StepDispositionRecord {
  const base = { stepId: step.id, seq: step.seq, toolName: step.tool_name }

  if (step.status === 'done') {
    return { ...base, disposition: 'completed', reason: '持久化 step 已标记 done' }
  }

  if (step.status === 'denied') {
    return { ...base, disposition: 'completed', reason: 'step 在执行前被 deny，无副作用' }
  }

  if (step.tool_call_id && pendingToolCallIds.has(step.tool_call_id)) {
    return { ...base, disposition: 'needs-human', reason: '待审批项未决，重启后须重新推送' }
  }

  const artifact = events.find(
    (e) => e.type === 'artifact.changed' && e.stepId === step.id,
  )
  if (artifact) {
    const payload = artifact.payload as ArtifactChangedPayload
    const absolute = path.resolve(workspaceRoot, payload.path ?? '')
    const diskHash = hashFile(absolute)
    if (diskHash === payload.afterHash) {
      return {
        ...base,
        disposition: 'completed',
        reason: 'artifact.changed 的 afterHash 与磁盘一致，副作用已确认',
      }
    }
    return {
      ...base,
      disposition: 'needs-human',
      reason: 'artifact.changed 的 afterHash 与磁盘不一致，无法判定实际写入',
    }
  }

  if (mutation() === 'optimistic-recovery') {
    return { ...base, disposition: 'completed', reason: 'optimistic: 假定已执行成功' }
  }

  return {
    ...base,
    disposition: 'unknown-needs-rerun',
    reason: '无 artifact 证据，无法证明副作用是否落地',
  }
}

/** 供测试断言「清扫后无悬空状态」 */
export function assertNoDangling(db: Db): void {
  const runs = db
    .prepare(
      `SELECT id, status FROM agent_runs
       WHERE status IN ('created','running','awaiting_approval','cancelling')`,
    )
    .all() as Array<{ id: string; status: string }>
  const steps = db
    .prepare(`SELECT id, status FROM agent_steps WHERE status IN ('requested','running','approved')`)
    .all() as Array<{ id: string; status: string }>
  if (runs.length > 0 || steps.length > 0) {
    throw new Error(
      `dangling state: runs=${JSON.stringify(runs)} steps=${JSON.stringify(steps)}`,
    )
  }
}

export function dispositionOf(plan: RecoveryPlan, stepId: string): StepDisposition | undefined {
  return plan.stepOutcomes.find((o) => o.stepId === stepId)?.disposition
}
