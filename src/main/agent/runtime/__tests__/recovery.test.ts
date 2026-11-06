/**
 * D5 验收：启动对账。
 *
 * 承诺边界：只恢复到「最后一个已持久化事件 + stepOutcomes 对账」，
 * 非终态 turn → orphaned，open step → aborted，pending 审批保留，不自动重放工具。
 */

import { describe, expect, it } from 'vitest'
import { AgentRepository } from '../db/repository'
import { applyRecoveryPlan, assertNoDangling, planRecovery } from '../recovery/planner'
import { openTestDb } from './helpers/test-db'

function seedCrashState() {
  const db = openTestDb()
  const repo = new AgentRepository(db)
  const session = repo.insertSession({ id: 'sess-crash', executor: 'claude-code', status: 'active', nodeId: 'n1', graphId: 'g1' })
  const run = repo.insertRun({ threadId: 't1', nodeId: 'n1', graphId: 'g1', executor: 'claude-code', status: 'running' })
  const turn = repo.insertTurn({
    runId: run.id,
    sessionId: session.id,
    nodeId: 'n1',
    graphId: 'g1',
    resumeMode: 'native',
    idempotencyKey: 'k-crash',
    input: {},
  })
  repo.upsertStep({ id: 'step-bash', turnId: turn.id, kind: 'tool', toolName: 'Bash', status: 'running', fidelity: 'turn' })
  repo.upsertStep({ id: 'step-read', turnId: turn.id, kind: 'tool', toolName: 'Read', status: 'done', fidelity: 'turn' })
  const approval = repo.insertApproval({
    runId: run.id,
    turnId: turn.id,
    stepId: 'step-write',
    toolName: 'Write',
    argsJson: '{"path":"a.txt"}',
    argsHash: 'hash-write',
    risk: 'high',
    policyDecision: 'ask',
    expiresAt: Date.now() + 120_000,
    mode: 'interactive',
    timeoutMs: 120_000,
  })
  return { db, repo, session, run, turn, approval }
}

describe('RecoveryPlan (D5)', () => {
  it('plans orphaned turn + aborted open step for a crashed running turn', () => {
    const { repo, session, run, turn } = seedCrashState()

    const plan = planRecovery(repo)
    expect(plan.abortedTurns).toBe(1)
    expect(plan.interruptedRuns).toBe(1)
    expect(plan.orphanedSessions).toBe(1)

    const turnPlan = plan.plans.find((p) => p.action === 'abort_turn' && p.turnId === turn.id)
    expect(turnPlan).toMatchObject({ runId: run.id, sessionId: session.id })
    expect(turnPlan?.reason).toContain('stepOutcomes')
    expect(plan.plans.some((p) => p.action === 'mark_session_orphaned' && p.sessionId === session.id)).toBe(true)
    expect(plan.plans.some((p) => p.action === 'mark_run_interrupted' && p.runId === run.id)).toBe(true)
  })

  it('leaves no dangling running turn or open step after apply', () => {
    const { repo, run, turn } = seedCrashState()
    const plan = planRecovery(repo)
    applyRecoveryPlan(repo, plan)

    expect(repo.listAllNonTerminalTurns()).toHaveLength(0)
    expect(repo.getTurn(turn.id)?.status).toBe('orphaned')
    expect(repo.getTurn(turn.id)?.failure_class).toBe('crash')
    expect(repo.listOpenSteps(turn.id)).toHaveLength(0)
    const steps = repo.listSteps(turn.id)
    expect(steps.find((s) => s.id === 'step-bash')?.status).toBe('aborted')
    // 已闭合步骤不被改写
    expect(steps.find((s) => s.id === 'step-read')?.status).toBe('done')
    expect(repo.getRun(run.id)?.status).toBe('interrupted')
    expect(repo.listSessionsByStatus('active')).toHaveLength(0)

    expect(() => assertNoDangling(repo)).not.toThrow()
  })

  it('writes a determinate stepOutcome for every persisted step (P0-2)', () => {
    const { repo, turn } = seedCrashState()
    const plan = planRecovery(repo)
    applyRecoveryPlan(repo, plan)

    const turnPlan = plan.plans.find((p) => p.action === 'abort_turn' && p.turnId === turn.id)
    expect(turnPlan?.stepOutcomes).toHaveLength(2)
    const steps = repo.listSteps(turn.id)
    for (const step of steps) {
      expect(['completed', 'unknown-needs-rerun', 'needs-human']).toContain(step.test_disposition)
    }
    expect(steps.find((s) => s.id === 'step-read')?.test_disposition).toBe('completed')
    expect(steps.find((s) => s.id === 'step-bash')?.test_disposition).toBe('needs-human')
  })

  it('covers all five §5.5 rows and persists each outcome (P0-2)', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    const readCurrentHash = (path: string): string | null => (path === '/proj/a.ts' ? 'h-match' : null)
    repo.insertSession({ id: 'sess-five', executor: 'claude-code', status: 'active' })

    const createTurn = (
      id: string,
      step: { id: string; status: 'running' | 'requested'; approvedAt?: number; executingAt?: number },
      artifact?: { baseHash: string },
    ) => {
      const run = repo.insertRun({ threadId: 't1', nodeId: `n-${id}`, graphId: 'g1', executor: 'claude-code' })
      const turn = repo.insertTurn({
        runId: run.id,
        sessionId: 'sess-five',
        nodeId: `n-${id}`,
        resumeMode: 'native',
        idempotencyKey: `k-${id}`,
        input: {},
      })
      repo.upsertStep({ id: step.id, turnId: turn.id, kind: 'tool', toolName: 'Write', status: step.status, fidelity: 'turn', approvedAt: step.approvedAt, executingAt: step.executingAt })
      if (artifact) {
        repo.insertArtifact({ turnId: turn.id, kind: 'file_snapshot', path: '/proj/a.ts', baseHash: artifact.baseHash, storage: 'inline' })
      }
      return turn
    }

    // row 1: approved but not executing
    createTurn('r1', { id: 's-row1', status: 'requested', approvedAt: 100 })
    // row 2: executing + hash consistent
    createTurn('r2', { id: 's-row2', status: 'running', approvedAt: 100, executingAt: 200 }, { baseHash: 'h-match' })
    // row 3: executing + hash mismatched
    createTurn('r3', { id: 's-row3', status: 'running', approvedAt: 100, executingAt: 200 }, { baseHash: 'h-old' })
    // row 4: not approved/executing + hash consistent
    createTurn('r4', { id: 's-row4', status: 'requested' }, { baseHash: 'h-match' })
    // row 5: not approved/executing + no readable snapshot
    createTurn('r5', { id: 's-row5', status: 'requested' })

    const plan = planRecovery(repo, { readCurrentHash })
    const outcomes = plan.plans.flatMap((p) => p.stepOutcomes ?? [])
    const byId = new Map(outcomes.map((o) => [o.stepId, o.disposition]))
    expect(byId.get('s-row1')).toBe('unknown-needs-rerun')
    expect(byId.get('s-row2')).toBe('completed')
    expect(byId.get('s-row3')).toBe('needs-human')
    expect(byId.get('s-row4')).toBe('unknown-needs-rerun')
    expect(byId.get('s-row5')).toBe('needs-human')

    applyRecoveryPlan(repo, plan)
    const persisted = repo.listAllNonTerminalTurns().length === 0
      ? db.prepare("SELECT id, test_disposition FROM agent_steps").all() as Array<{ id: string; test_disposition: string | null }>
      : []
    expect(persisted).toHaveLength(5)
    for (const row of persisted) expect(row.test_disposition).toBe(byId.get(row.id))
    db.close()
  })


  it('keeps pending approvals (re-emitted later, never auto-allowed)', () => {
    const { repo, approval } = seedCrashState()
    const plan = planRecovery(repo)
    applyRecoveryPlan(repo, plan)

    expect(plan.pendingApprovals).toBe(1)
    expect(plan.plans.some((p) => p.action === 'keep_pending_approval' && p.turnId === approval.turn_id)).toBe(true)
    expect(repo.getApproval(approval.id)?.status).toBe('pending')
    expect(repo.getApproval(approval.id)?.decided_at).toBeNull()
  })

  it('orphans a starting session that never produced a turn', () => {
    const db = openTestDb()
    const repo = new AgentRepository(db)
    repo.insertSession({ id: 'sess-starting', executor: 'codex', status: 'starting' })
    repo.insertSession({ id: 'sess-active', executor: 'codex', status: 'active' })

    const plan = planRecovery(repo)
    expect(plan.plans.some((p) => p.action === 'mark_session_orphaned' && p.sessionId === 'sess-starting')).toBe(true)
    expect(plan.plans.some((p) => p.action === 'mark_session_orphaned' && p.sessionId === 'sess-active')).toBe(true)

    applyRecoveryPlan(repo, plan)
    expect(() => assertNoDangling(repo)).not.toThrow()
    expect(repo.getSession('sess-starting')?.status).toBe('orphaned')
    expect(repo.getSession('sess-active')?.status).toBe('orphaned')
  })

  it('is idempotent: second pass plans nothing and can be re-applied', () => {
    const { repo } = seedCrashState()
    const first = planRecovery(repo)
    applyRecoveryPlan(repo, first)

    const second = planRecovery(repo)
    // 只剩「pending 审批保留」这一事实项；不应再产生任何修复动作
    expect(second.abortedTurns).toBe(0)
    expect(second.orphanedSessions).toBe(0)
    expect(second.plans.every((p) => p.action === 'keep_pending_approval')).toBe(true)
    expect(() => applyRecoveryPlan(repo, second)).not.toThrow()
    expect(() => assertNoDangling(repo)).not.toThrow()
  })

  it('does not touch already terminal turns and releases the node lock slot', () => {
    const { repo, turn } = seedCrashState()
    repo.updateTurnStatus(turn.id, 'completed', { endedAt: 1 })
    repo.updateSessionStatus('sess-crash', 'closed')

    const plan = planRecovery(repo)
    expect(plan.abortedTurns).toBe(0)
    expect(plan.plans.some((p) => p.action === 'abort_turn')).toBe(false)

    // 恢复后同一节点可以重新插入活跃 turn（部分唯一索引已释放）
    const run2 = repo.insertRun({ threadId: 't2', nodeId: 'n1', graphId: 'g1', executor: 'claude-code' })
    expect(() =>
      repo.insertTurn({ runId: run2.id, sessionId: 'sess-crash', nodeId: 'n1', resumeMode: 'fresh', idempotencyKey: 'k-after', input: {} }),
    ).not.toThrow()
  })

  it('assertNoDangling fails loudly when recovery was skipped', () => {
    const { repo } = seedCrashState()
    expect(() => assertNoDangling(repo)).toThrow(/RECOVERY_FAILED/)
  })
})
