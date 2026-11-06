import { appendEventRaw, RunRepository, type RunRow } from '../db/repository'
import { mutation } from '../mutation'
import { BACKEND_CAPABILITIES } from '../loop/capabilities'
import {
  type AgentEventEnvelope,
  type ApprovalDecisionValue,
  type ApprovalResolvedBy,
  type ApprovalRow,
  type DecideResult,
  type EventFidelity,
  type RiskLevel,
} from '../types'

export interface ApprovalRequestInput {
  approvalId: string
  runId: string
  turnId: string
  stepId?: string
  toolCallId: string
  toolName: string
  input: unknown
  risk: RiskLevel
  /** 测试可缩短；生产默认 60s（新文档 §5.2） */
  timeoutMs?: number
  expiresAt?: number
}

interface PendingResolver {
  resolve: (result: DecideResult) => void
}

function fidelityForBackend(repo: RunRepository, runId: string): EventFidelity {
  const run = repo.getRun(runId)
  if (!run) return 'token'
  return BACKEND_CAPABILITIES[run.backend as keyof typeof BACKEND_CAPABILITIES]?.eventFidelity ?? 'token'
}

/**
 * fail-closed 审批网关：
 * - 超时 → deny（resolved_by=timeout）
 * - 重复决定 → 返回首次结果，不重复落库/落事件
 * - 决定与事件在同一事务提交，避免「已批准但未记录」
 * - 未决定前 execute 永远不会被调用，避免「拒绝后仍执行」
 * - 待审批项落库，重启后通过 replayPending 重新推送（新文档 §5.2）
 */
export class ApprovalGateway {
  private readonly resolvers = new Map<string, PendingResolver>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private closed = false

  constructor(
    private readonly repo: RunRepository,
    private readonly defaultTimeoutMs = 60_000,
  ) {}

  request(input: ApprovalRequestInput): { approval: ApprovalRow; waitForDecision: Promise<DecideResult> } {
    const now = Date.now()
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs
    const expiresAt = input.expiresAt ?? now + timeoutMs
    const row: ApprovalRow = {
      approvalId: input.approvalId,
      runId: input.runId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
      risk: input.risk,
      decision: null,
      resolvedBy: null,
      expiresAt,
      createdAt: now,
      resolvedAt: null,
    }

    const tx = this.repo.db.transaction(() => {
      this.repo.insertApproval(row)
      this.appendApprovalEvent(input.runId, input.turnId, input.stepId, 'tool.approval_required', {
        approvalId: input.approvalId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input,
        risk: input.risk,
        blocking: true,
        expiresAt,
      })
    })
    tx()

    const waitForDecision = new Promise<DecideResult>((resolve) => {
      this.resolvers.set(input.approvalId, { resolve })
    })

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        try {
          this.decide(input.approvalId, 'deny', 'timeout')
        } catch {
          // DB 已关闭（测试清理）时静默
        }
      }, timeoutMs)
      timer.unref?.()
      this.timers.set(input.approvalId, timer)
    }

    return { approval: this.repo.getApproval(input.approvalId)!, waitForDecision }
  }

  decide(
    approvalId: string,
    decision: ApprovalDecisionValue,
    resolvedBy: ApprovalResolvedBy = 'user',
  ): DecideResult {
    const now = Date.now()
    const tx = this.repo.db.transaction((): DecideResult => {
      const row = this.repo.getApproval(approvalId)
      if (!row) throw new Error(`approval not found: ${approvalId}`)

      if (row.decision !== null && mutation() !== 'approval-overwrite') {
        // 幂等：重复决定返回首次结果
        return {
          approvalId,
          ok: true,
          decision: row.decision,
          resolvedBy: row.resolvedBy,
          idempotent: true,
        }
      }

      let effective: ApprovalDecisionValue = decision
      let effectiveBy: ApprovalResolvedBy = resolvedBy
      if (now >= row.expiresAt && row.decision === null) {
        effective = mutation() === 'approval-always-allow' ? 'allow' : 'deny'
        effectiveBy = 'timeout'
      }

      const changed = this.repo.db
        .prepare(
          `UPDATE agent_approvals
             SET decision = ?, resolved_by = ?, resolved_at = ?
           WHERE approval_id = ? AND (decision IS NULL OR ? = 1)`,
        )
        .run(effective, effectiveBy, now, approvalId, mutation() === 'approval-overwrite' ? 1 : 0)
        .changes

      if (changed === 0) {
        const existing = this.repo.getApproval(approvalId)!
        return {
          approvalId,
          ok: true,
          decision: existing.decision,
          resolvedBy: existing.resolvedBy,
          idempotent: true,
        }
      }

      this.appendApprovalEvent(
        row.runId,
        row.turnId,
        undefined,
        effective === 'allow' || effective === 'allow_session' ? 'tool.approved' : 'tool.denied',
        { approvalId, decision: effective, resolvedBy: effectiveBy },
      )

      return {
        approvalId,
        ok: true,
        decision: effective,
        resolvedBy: effectiveBy,
        idempotent: false,
      }
    })

    const result = tx()
    const timer = this.timers.get(approvalId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(approvalId)
    }
    const resolver = this.resolvers.get(approvalId)
    if (resolver) {
      resolver.resolve(result)
      this.resolvers.delete(approvalId)
    }
    return result
  }

  /** 只有真正完成状态迁移（非幂等重放）且结果为 allow 时才执行工具 */
  async decideAndExecute(
    approvalId: string,
    decision: ApprovalDecisionValue,
    execute: () => Promise<unknown>,
    resolvedBy: ApprovalResolvedBy = 'user',
  ): Promise<{ result: DecideResult; executed: boolean; value?: unknown }> {
    const result = this.decide(approvalId, decision, resolvedBy)
    if (!result.idempotent && (result.decision === 'allow' || result.decision === 'allow_session')) {
      const value = await execute()
      return { result, executed: true, value }
    }
    return { result, executed: false }
  }

  /** 重启后重新推送未决审批；不自动批准、不执行 */
  replayPending(runId?: string): ApprovalRow[] {
    return this.repo.listPendingApprovals(runId)
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const resolver of this.resolvers.values()) {
      resolver.resolve({
        approvalId: '',
        ok: false,
        decision: null,
        resolvedBy: null,
        idempotent: false,
      })
    }
    this.resolvers.clear()
  }

  get isClosed(): boolean {
    return this.closed
  }

  private appendApprovalEvent(
    runId: string,
    turnId: string,
    stepId: string | undefined,
    type: AgentEventEnvelope['type'],
    payload: Record<string, unknown>,
  ): void {
    const run: RunRow | undefined = this.repo.getRun(runId)
    const fidelity = fidelityForBackend(this.repo, runId)
    const seq = this.repo.nextSeq(runId)
    appendEventRaw(this.repo.db, {
      eventId: `${runId}#${turnId}#${seq}`,
      runId,
      seq,
      turnId,
      stepId,
      type,
      ts: Date.now(),
      payload,
      source: 'kernel',
      fidelity,
      backend: {
        name: run?.backend ?? 'unknown',
        sessionId: run?.backend_session_id ?? undefined,
      },
    })
  }
}
