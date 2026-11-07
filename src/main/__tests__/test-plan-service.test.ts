/**
 * TestPlanService 真库回归(§6.2/§6.3/§6.5):
 * 创建(hash)/审批走网关 subject=test_plan(拒绝→cancelled)/执行回写
 * (items/run/results 汇总)/E3 资格判定(五条前置)。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { applyMapS8Schema } from '../map/schema'
import { applyAgentSchema } from '../agent/runtime/db/schema'
import { TestPlanService } from '../map/test-plan-service'
import type { TestCommandRunner } from '../map/test-plan-service'
import { ApprovalGateway } from '../agent/runtime/approval/gateway'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS8Schema(db)
  // agent_approvals(§7.1 subject 扩展后 DDL)——runtime schema 单一权威
  applyAgentSchema(db)
  return db
}

function fakeRunner(script: Array<{ exitCode: number; timedOut?: boolean }>): TestCommandRunner & { calls: Array<{ command: string; cwd?: string; timeoutMs: number }> } {
  let i = 0
  const calls: Array<{ command: string; cwd?: string; timeoutMs: number }> = []
  return {
    calls,
    async runCommand(input) {
      calls.push(input)
      const scriptItem = script[Math.min(i, script.length - 1)]
      i += 1
      return {
        exitCode: scriptItem?.exitCode ?? 0,
        durationMs: 5,
        outputRef: `out://${i}`,
        timedOut: scriptItem?.timedOut,
      }
    },
  }
}

function autoGateway(db: BetterSqlite3.Database): ApprovalGateway {
  const holder: { gateway?: ApprovalGateway } = {}
  const gateway = new ApprovalGateway({
    db,
    interactiveTimeoutMs: 60_000,
    notifier: {
      onRequest: (payload) => {
        queueMicrotask(() => {
          holder.gateway!.decide({ approvalId: payload.approvalId, decision: 'allow', argsHash: payload.argsHash })
        })
      },
      onResolved: () => {},
    },
  })
  holder.gateway = gateway
  return gateway
}

describe('TestPlanService(§6.2/§6.3)', () => {
  let db: BetterSqlite3.Database
  let svc: TestPlanService

  beforeEach(() => {
    db = setupDb()
    svc = new TestPlanService(db, fakeRunner([]), autoGateway(db))
  })

  it('创建:draft + items + plan_hash(内容哈希,可复算)', () => {
    const plan = svc.createPlan({
      projectPath: '/p',
      graphId: 'g1',
      workItemId: 'wi-1',
      items: [
        { command: 'npm test -- auth', cwd: '/p' },
        { command: 'npm test -- billing' },
      ],
      createdBy: 'u1',
    })
    expect(plan.status).toBe('draft')
    expect(plan.plan_hash).toBe(TestPlanService.hashPlan([
      { command: 'npm test -- auth', cwd: '/p' },
      { command: 'npm test -- billing' },
    ]))
    expect(svc.listItems(plan.id)).toHaveLength(2)
    // 相同内容 → 相同 hash;不同内容 → 不同 hash
    const plan2 = svc.createPlan({ projectPath: '/p', items: [{ command: 'npm test -- billing' }, { command: 'npm test -- auth', cwd: '/p' }] })
    expect(plan2.plan_hash).not.toBe(plan.plan_hash)
  })

  it('空计划拒绝(§6.2)', () => {
    expect(() => svc.createPlan({ projectPath: '/p', items: [] })).toThrow(/至少需要 1 条/)
  })

  it('网关审批:allow → approved;deny → cancelled + 拒绝错误', async () => {
    const gatewayAllow = { request: vi.fn().mockResolvedValue({ approvalId: 'appr-1', decision: 'allow', decidedBy: 'user', argsHash: 'x', decidedAt: 0 }) }
    const svcAllow = new TestPlanService(db, fakeRunner([]), gatewayAllow as never)
    const plan = svcAllow.createPlan({ projectPath: '/p', items: [{ command: 'npm t' }] })
    const approved = await svcAllow.submitForApproval(plan.id)
    expect(approved.status).toBe('approved')
    // §6.3：审批事实落 approval_id（不再是「本地无条件 approved」）
    expect(approved.approval_id).toBe('appr-1')
    // 网关以 subject=test_plan 被调用(不绕过网关,§6.3)
    expect(gatewayAllow.request).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'test_plan',
      subjectType: 'test_plan',
      subjectId: plan.id,
      args: expect.objectContaining({ planHash: plan.plan_hash }),
    }))

    const gatewayDeny = { request: vi.fn().mockResolvedValue({ approvalId: 'appr-2', decision: 'deny', decidedBy: 'user', argsHash: 'x', decidedAt: 0 }) }
    const svcDeny = new TestPlanService(db, fakeRunner([]), gatewayDeny as never)
    const plan2 = svcDeny.createPlan({ projectPath: '/p', items: [{ command: 'npm t' }] })
    await expect(svcDeny.submitForApproval(plan2.id)).rejects.toThrow(/审批未通过/)
    expect(svcDeny.getPlan(plan2.id)!.status).toBe('cancelled')
  })

  it('执行回写:全过 → run passed/results 落行/E3 eligible;有失败 → failed + E3 拒', async () => {
    const runner = fakeRunner([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 2 }])
    const svcRun = new TestPlanService(db, runner, autoGateway(db))
    const plan = svcRun.createPlan({
      projectPath: '/p',
      worktreePath: '/wt',
      items: [{ command: 't1', cwd: '/p' }, { command: 't2' }, { command: 't3' }],
    })
    await svcRun.approve(plan.id, 'u1')
    const { run, e3 } = await svcRun.execute(plan.id, { headCommit: 'abc123', codeDirty: false })

    expect(run.status).toBe('failed')
    expect(run.total).toBe(3)
    expect(run.passed).toBe(2)
    expect(run.failed).toBe(1)
    expect(run.head_commit).toBe('abc123')
    expect(runner.calls[0]).toMatchObject({ command: 't1', cwd: '/p', timeoutMs: 300_000 })
    // plan 终态 failed
    expect(svcRun.getPlan(plan.id)!.status).toBe('failed')
    // results 行 = 3
    expect((db.prepare('SELECT COUNT(*) AS c FROM test_results').get() as { c: number }).c).toBe(3)
    // E3:测试未全过 → 拒
    expect(e3.eligible).toBe(false)
    expect(e3.reason).toContain('未全部通过')
  })

  it('E3 资格:全过+HEAD+非 dirty+worktree → eligible;dirty → 拒(§6.2.1)', async () => {
    const runner = fakeRunner([{ exitCode: 0 }, { exitCode: 0 }])
    const svcRun = new TestPlanService(db, runner, autoGateway(db))
    const plan = svcRun.createPlan({
      projectPath: '/p',
      worktreePath: '/wt',
      items: [{ command: 't1' }, { command: 't2' }],
    })
    await svcRun.approve(plan.id, 'u1')
    const ok = await svcRun.execute(plan.id, { headCommit: 'abc', codeDirty: false })
    expect(ok.e3.eligible).toBe(true)
    expect(ok.e3.codeVersion).toBe('abc')

    const plan2 = svcRun.createPlan({ projectPath: '/p', worktreePath: '/wt', items: [{ command: 't1' }, { command: 't2' }] })
    await svcRun.approve(plan2.id, 'u1')
    const dirty = await svcRun.execute(plan2.id, { headCommit: 'def', codeDirty: true })
    expect(dirty.e3.eligible).toBe(false)
    expect(dirty.e3.reason).toContain('dirty')

    // 无 HEAD(非 git)→ 拒(§3.5:非 git 到不了 E3)
    const plan3 = svcRun.createPlan({ projectPath: '/p', worktreePath: '/wt', items: [{ command: 't1' }, { command: 't2' }] })
    await svcRun.approve(plan3.id, 'u1')
    const noGit = await svcRun.execute(plan3.id)
    expect(noGit.e3.eligible).toBe(false)
    expect(noGit.e3.reason).toContain('HEAD')
  })

  it('未批准不得执行(§6.2);runner 抛错 → item error/infra 不炸整个 run', async () => {
    const plan = svc.createPlan({ projectPath: '/p', items: [{ command: 't1' }] })
    await expect(svc.execute(plan.id)).rejects.toThrow(/未批准/)

    const throwing: TestCommandRunner = {
      async runCommand() {
        throw new Error('spawn ENOENT')
      },
    }
    const svcErr = new TestPlanService(db, throwing, autoGateway(db))
    const plan2 = svcErr.createPlan({ projectPath: '/p', items: [{ command: 't1' }, { command: 't2' }] })
    await svcErr.approve(plan2.id, 'u1')
    const { run } = await svcErr.execute(plan2.id)
    expect(run.status).toBe('failed')
    expect(run.failed).toBe(2)
    const errRow = db.prepare("SELECT failure_class FROM test_results WHERE status = 'error'").get() as { failure_class: string }
    expect(errRow.failure_class).toBe('infra')
  })

  it('P0-1:零执行(全 deny/skip)→ 未通过,不产出 E3', async () => {
    const plan = svc.createPlan({
      projectPath: '/p',
      worktreePath: '/wt',
      items: [{ command: 't1' }, { command: 't2' }],
    })
    await svc.approve(plan.id, 'u1')
    const { run, e3 } = await svc.execute(plan.id, {
      headCommit: 'abc',
      codeDirty: false,
      policyGate: () => ({ decision: 'deny', reason: 'test deny' }),
    })

    expect(run.status).toBe('failed')
    expect(run.passed).toBe(0)
    expect(run.skipped).toBe(2)
    expect(e3.eligible).toBe(false)
    expect(e3.reason).toContain('零执行')
    expect(svc.getPlan(plan.id)!.status).toBe('failed')
  })

  it('P0-1:部分 skip → 不算 passed(必须实际执行且全过)', async () => {
    const plan = svc.createPlan({
      projectPath: '/p',
      worktreePath: '/wt',
      items: [{ command: 't1' }, { command: 't2' }],
    })
    await svc.approve(plan.id, 'u1')
    let n = 0
    const { run, e3 } = await svc.execute(plan.id, {
      headCommit: 'abc',
      codeDirty: false,
      policyGate: () => (n++ === 0 ? { decision: 'allow' } : { decision: 'deny', reason: 'second denied' }),
    })
    expect(run.status).toBe('failed')
    expect(run.passed).toBe(1)
    expect(run.skipped).toBe(1)
    expect(e3.eligible).toBe(false)
  })

  it('P0-3:approve 走网关并写审批事实;非审批态拒绝', async () => {
    const plan = svc.createPlan({ projectPath: '/p', items: [{ command: 'npm t' }] })
    expect(plan.approval_id).toBeNull()
    const approved = await svc.approve(plan.id, 'u1')
    expect(approved.status).toBe('approved')
    expect(approved.approval_id).toBeTruthy()
    const row = db
      .prepare('SELECT subject_type, subject_id, status FROM agent_approvals WHERE id = ?')
      .get(approved.approval_id!) as { subject_type: string; subject_id: string; status: string }
    expect(row).toMatchObject({ subject_type: 'test_plan', subject_id: plan.id, status: 'allowed' })
    // 终态/已批准再批 → 拒绝（不再无条件 UPDATE）
    await expect(svc.approve(plan.id, 'u1')).rejects.toThrow(/不可批准/)
  })

  it('P0-3:execute 校验 approval_id 与 plan_hash,不满足拒绝执行', async () => {
    // 缺 approval_id（状态被绕过成 approved）
    const p1 = svc.createPlan({ projectPath: '/p', worktreePath: '/wt', items: [{ command: 't1' }] })
    db.prepare("UPDATE test_plans SET status = 'approved' WHERE id = ?").run(p1.id)
    await expect(svc.execute(p1.id, { headCommit: 'abc', codeDirty: false })).rejects.toThrow(/approval_id/)

    // 批准后命令被改 → plan_hash 不一致
    const p2 = svc.createPlan({ projectPath: '/p', worktreePath: '/wt', items: [{ command: 't1' }] })
    await svc.approve(p2.id, 'u1')
    db.prepare('UPDATE test_plan_items SET command = ? WHERE plan_id = ?').run('rm -rf /', p2.id)
    await expect(svc.execute(p2.id, { headCommit: 'abc', codeDirty: false })).rejects.toThrow(/plan_hash/)

    // 审批事实被撤/非 allowed → 拒绝
    const p3 = svc.createPlan({ projectPath: '/p', worktreePath: '/wt', items: [{ command: 't1' }] })
    const approved3 = await svc.approve(p3.id, 'u1')
    db.prepare("UPDATE agent_approvals SET status = 'denied' WHERE id = ?").run(approved3.approval_id!)
    await expect(svc.execute(p3.id, { headCommit: 'abc', codeDirty: false })).rejects.toThrow(/审批事实无效/)
  })
})

describe('agent_approvals subject 扩展(§7.1/D6)', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
  })

  it('subject 行直插+回填语义:subject_id 缺省 NULL;历史行回填=turn_id', () => {
    // 模拟历史行(带 turn_id,无 subject)
    const turnId = `turn-${randomUUID().slice(0, 8)}`
    db.exec(`
      CREATE TABLE turns_stub (id TEXT PRIMARY KEY);
    `)
    db.prepare(
      `INSERT INTO agent_approvals (id, run_id, turn_id, tool_name, args_json, args_hash, risk, policy_decision, status, expires_at, created_at)
       VALUES ('appr-old', 'run-1', ?, 'Bash', '{}', 'h', 'low', 'allow', 'allowed', 0, 0)`,
    ).run(turnId)
    // 回填(与 runIncrementalMigrations 同语句)
    db.prepare("UPDATE agent_approvals SET subject_id = turn_id WHERE subject_id IS NULL AND turn_id IS NOT NULL").run()
    const row = db.prepare('SELECT * FROM agent_approvals WHERE id = ?').get('appr-old') as Record<string, unknown>
    expect(row.subject_type).toBe('agent_turn')
    expect(row.subject_id).toBe(turnId)

    // subject 行(test_plan):run/turn 可空
    db.prepare(
      `INSERT INTO agent_approvals (id, tool_name, args_json, args_hash, risk, policy_decision, status, subject_type, subject_id, expires_at, created_at)
       VALUES ('appr-plan', 'test_plan', '{}', 'h', 'medium', 'allow', 'allowed', 'test_plan', 'tp-1', 0, 0)`,
    ).run()
    const planRow = db.prepare('SELECT * FROM agent_approvals WHERE id = ?').get('appr-plan') as Record<string, unknown>
    expect(planRow.run_id).toBeNull()
    expect(planRow.subject_type).toBe('test_plan')
    expect(planRow.subject_id).toBe('tp-1')
  })
})
