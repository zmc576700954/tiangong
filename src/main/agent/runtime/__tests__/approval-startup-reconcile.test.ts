/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P1-3 僵尸审批回归（不依赖 better-sqlite3）：
 *  - 重启对账把已无法兑现的 pending 落 denied + decided_by='startup' + note，且不推 UI；
 *  - 只有所属 turn 仍存活（running/waiting_approval/cancelling）才重推；
 *  - 对陈旧审批点「允许」必须明确失败（APPROVAL_STALE），不能静默写 allowed；
 *  - 活 turn 上「允许」确实会唤醒 waiter（批准 → 真的执行）。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalGateway } from '../approval/gateway'
import type { AgentApprovalRow } from '../db/repository'

class FakeApprovalRepo {
  approvals = new Map<string, AgentApprovalRow>()
  turns = new Map<string, { status: string }>()
  private seq = 0

  getApproval(id: string): AgentApprovalRow | null {
    return this.approvals.get(id) ?? null
  }

  listPendingApprovals(): AgentApprovalRow[] {
    return [...this.approvals.values()].filter((row) => row.status === 'pending')
  }

  listExpiredApprovals(): AgentApprovalRow[] {
    return []
  }

  getTurn(turnId: string): { id: string; session_id: string; status: string } | null {
    const turn = this.turns.get(turnId)
    return turn ? { id: turnId, session_id: 'sess-1', status: turn.status } : null
  }

  insertApproval(input: {
    id: string
    runId: string
    turnId: string
    stepId?: string
    toolName: string
    argsJson: string
    argsHash: string
    risk: AgentApprovalRow['risk']
    policyDecision: AgentApprovalRow['policy_decision']
    status: AgentApprovalRow['status']
    expiresAt: number
    mode: AgentApprovalRow['mode']
    timeoutMs: number
    cwd?: string
    grantSource?: string
    createdAt: number
  }): AgentApprovalRow {
    this.seq += 1
    const row: AgentApprovalRow = {
      id: input.id,
      run_id: input.runId,
      turn_id: input.turnId,
      step_id: input.stepId ?? null,
      tool_name: input.toolName,
      args_json: input.argsJson,
      args_hash: input.argsHash,
      risk: input.risk,
      policy_decision: input.policyDecision,
      status: input.status,
      decided_by: null,
      decided_at: null,
      decision_note: null,
      expires_at: input.expiresAt,
      mode: input.mode,
      timeout_ms: input.timeoutMs,
      cwd: input.cwd ?? null,
      grant_source: input.grantSource ?? null,
      created_at: input.createdAt,
    }
    this.approvals.set(row.id, row)
    return row
  }

  decideApproval(
    approvalId: string,
    decision: 'allow' | 'deny',
    decidedBy: AgentApprovalRow['decided_by'],
    now: number,
    note?: string,
  ): AgentApprovalRow | null {
    const row = this.approvals.get(approvalId)
    if (!row) return null
    if (row.status !== 'pending') return row
    row.status = decision === 'allow' ? 'allowed' : 'denied'
    row.decided_by = decidedBy
    row.decided_at = now
    row.decision_note = note ?? null
    return row
  }

  refreshApprovalExpiry(approvalId: string, expiresAt: number, timeoutMs: number): void {
    const row = this.approvals.get(approvalId)
    if (!row) return
    row.expires_at = expiresAt
    row.timeout_ms = timeoutMs
  }
}

function approvalRow(overrides: Partial<AgentApprovalRow> = {}): AgentApprovalRow {
  return {
    id: 'appr-1',
    run_id: 'run-1',
    turn_id: 'turn-1',
    step_id: null,
    tool_name: 'Write',
    args_json: JSON.stringify({ file_path: '/tmp/a.ts' }),
    args_hash: 'hash-1',
    risk: 'high',
    policy_decision: 'ask',
    status: 'pending',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    expires_at: 1_000_600_000,
    mode: 'interactive',
    timeout_ms: 120_000,
    cwd: '/tmp',
    grant_source: null,
    created_at: 1_000_000_000,
    ...overrides,
  }
}

function setup() {
  const repo = new FakeApprovalRepo()
  const notifier = { onRequest: vi.fn(), onResolved: vi.fn() }
  const gateway = new ApprovalGateway({
    db: {} as any,
    repo: repo as any,
    notifier,
    now: () => 1_000_500_000,
  })
  return { repo, notifier, gateway }
}

describe('僵尸审批：启动对账与决策（P1-3）', () => {
  it('重启后旧 pending 不弹窗、落 denied + decided_by=startup + note', () => {
    const { repo, notifier, gateway } = setup()
    repo.approvals.set('appr-1', approvalRow())
    repo.turns.set('turn-1', { status: 'orphaned' }) // startup planner 对账后的终态

    const result = gateway.reconcileStartup()

    expect(result.denied).toBe(1)
    expect(result.replayed).toHaveLength(0)
    expect(notifier.onRequest).not.toHaveBeenCalled() // 不再推 UI
    const row = repo.getApproval('appr-1')!
    expect(row.status).toBe('denied')
    expect(row.decided_by).toBe('startup')
    expect(row.decision_note).toContain('startup reconcile')
    expect(gateway.listPendingPayloads()).toHaveLength(0)
  })

  it('可兑现场景（turn 仍存活）才重推并重新计时', () => {
    const { repo, notifier, gateway } = setup()
    repo.approvals.set('appr-1', approvalRow())
    repo.turns.set('turn-1', { status: 'running' })

    const result = gateway.reconcileStartup()

    expect(result.denied).toBe(0)
    expect(result.replayed).toHaveLength(1)
    expect(notifier.onRequest).toHaveBeenCalledTimes(1)
    expect(repo.getApproval('appr-1')!.status).toBe('pending')
    expect(repo.getApproval('appr-1')!.expires_at).toBe(1_000_500_000 + 120_000)
  })

  it('对陈旧审批点「允许」：明确失败（APPROVAL_STALE），不静默写 allowed', () => {
    const { repo, notifier, gateway } = setup()
    repo.approvals.set('appr-1', approvalRow())
    repo.turns.set('turn-1', { status: 'completed' })

    expect(() =>
      gateway.decide({ approvalId: 'appr-1', decision: 'allow', argsHash: 'hash-1' }),
    ).toThrowError(/批准不会执行/)
    try {
      gateway.decide({ approvalId: 'appr-1', decision: 'allow', argsHash: 'hash-1' })
    } catch (err) {
      expect((err as { code?: string }).code).toBe('APPROVAL_STALE')
    }
    const row = repo.getApproval('appr-1')!
    expect(row.status).toBe('denied')
    expect(row.decided_by).toBe('system')
    expect(notifier.onResolved).toHaveBeenCalled()
  })

  it('活 turn 上「允许」会唤醒 waiter（批准 → 真的执行）', async () => {
    const { repo, gateway } = setup()
    repo.turns.set('turn-1', { status: 'running' })

    const pending = gateway.request({
      runId: 'run-1',
      turnId: 'turn-1',
      toolName: 'Write',
      args: { file_path: '/tmp/a.ts' },
      cwd: '/tmp',
    })
    const row = repo.listPendingApprovals()[0]
    gateway.decide({ approvalId: row.id, decision: 'allow', argsHash: row.args_hash })

    const outcome = await pending
    expect(outcome.decision).toBe('allow')
    expect(repo.getApproval(row.id)!.status).toBe('allowed')
  })
})
