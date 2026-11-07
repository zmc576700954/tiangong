/**
 * TestPlanService（S8 前置,session-map 蓝图 §6.2/§6.3/§6.5/§6.8）
 *
 * 流程（§6.2）：创建计划（specs 选取 → plan_hash）→ 提交审批（走 ApprovalGateway
 * subject_type='test_plan',不允许绕过网关直写 agent_approvals）→ 批准后执行
 * （命令执行器注入;worktree 管理由 runner 实现层负责）→ 逐条结果回写
 * （test_plan_items/test_runs/test_results）→ E3 资格判定（§6.2.1）。
 *
 * E3 判据（§6.2.1 五条）：passed + worktree/cwd 非空 + code_version=HEAD +
 * code_dirty=0 + git 可用;任一不成立只落 test_run 事实（最高 E2）,dirty_tree_hash
 * 不用于洗 E3。
 *
 * S4 未执行：test 图（GraphType='test'）值域未开——本服务不依赖 test 图,
 * 证据锚定走 node_entity_key（任意图）。
 */

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import type { ApprovalGateway } from '../agent/runtime/approval/gateway'
import type { ApprovalOutcome } from '@shared/types/agent-runtime'

const logger = createLogger('TestPlanService')

export interface TestSpecRow {
  id: string
  project_path: string
  graph_id: string | null
  test_node_entity_key: string
  test_node_id: string | null
  name: string
  kind: 'unit' | 'integration' | 'e2e' | 'flow'
  command: string
  cwd: string | null
  env_json: string | null
  timeout_ms: number
  runner: string | null
  file_globs_json: string | null
  steps_json: string | null
  created_at: string
  updated_at: string
}

export interface TestPlanRow {
  id: string
  project_path: string
  graph_id: string | null
  work_item_id: string | null
  work_run_id: string | null
  node_keys_json: string
  base_commit: string | null
  worktree_path: string | null
  plan_hash: string
  approval_id: string | null
  status: 'draft' | 'awaiting_approval' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired'
  created_by: string | null
  created_at: number
  approved_at: number | null
  started_at: number | null
  ended_at: number | null
}

export interface TestPlanItemRow {
  id: string
  plan_id: string
  spec_id: string | null
  seq: number
  command: string
  cwd: string | null
  selected_by: 'plan' | 'targeted' | 'rerun'
  targeted_reason: string | null
  policy_decision: 'allow' | 'deny' | 'ask' | null
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error' | 'timed_out'
  exit_code: number | null
  duration_ms: number | null
  output_ref: string | null
  started_at: number | null
  ended_at: number | null
}

export interface TestRunRow {
  id: string
  plan_id: string
  project_path: string
  graph_id: string | null
  work_item_id: string | null
  work_run_id: string | null
  base_commit: string | null
  head_commit: string | null
  worktree_commit: string | null
  dirty: number
  dirty_tree_hash: string | null
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled' | 'stale'
  total: number
  passed: number
  failed: number
  skipped: number
  report_ref: string | null
  started_at: number | null
  ended_at: number | null
  created_at: number
}

/** 命令执行器（依赖注入:worktree 创建/清理由实现层负责;测试用 fake）。 */
export interface TestCommandRunner {
  runCommand(input: { command: string; cwd?: string; timeoutMs: number }): Promise<{ exitCode: number; durationMs: number; outputRef?: string; timedOut?: boolean }>
}

/** 审批结果（网关 ApprovalOutcome 的窄化）。 */
export interface PlanApprovalResult {
  approvalId: string
  approved: boolean
}

export class TestPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TestPlanError'
  }
}

export class TestPlanService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly runner: TestCommandRunner,
    private readonly gateway?: ApprovalGateway,
  ) {}

  getPlan(id: string): TestPlanRow | undefined {
    return this.db.prepare('SELECT * FROM test_plans WHERE id = ?').get(id) as TestPlanRow | undefined
  }

  listItems(planId: string): TestPlanItemRow[] {
    return this.db.prepare('SELECT * FROM test_plan_items WHERE plan_id = ? ORDER BY seq ASC').all(planId) as TestPlanItemRow[]
  }

  getRun(id: string): TestRunRow | undefined {
    return this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as TestRunRow | undefined
  }

  /** plan_hash = 计划内容哈希（§6.3 C3 展示;args_hash 校验对齐）。 */
  static hashPlan(items: Array<{ command: string; cwd?: string }>): string {
    const canonical = JSON.stringify(items.map((i) => ({ command: i.command, cwd: i.cwd ?? null })))
    return createHash('sha256').update(canonical).digest('hex')
  }

  /** 创建计划（§6.2 Step 1-2）：draft + items + plan_hash。 */
  createPlan(input: {
    projectPath: string
    graphId?: string
    workItemId?: string
    workRunId?: string
    nodeKeys?: string[]
    baseCommit?: string
    worktreePath?: string
    items: Array<{ specId?: string; command: string; cwd?: string }>
    createdBy?: string
  }): TestPlanRow {
    if (!input.items || input.items.length === 0) {
      throw new TestPlanError('测试计划至少需要 1 条命令（§6.2）')
    }
    const id = `tp_${Date.now()}_${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const planHash = TestPlanService.hashPlan(input.items)
    const txn = this.db.transaction((): TestPlanRow => {
      this.db
        .prepare(
          `INSERT INTO test_plans (
             id, project_path, graph_id, work_item_id, work_run_id, node_keys_json,
             base_commit, worktree_path, plan_hash, status, created_by, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          id, input.projectPath, input.graphId ?? null, input.workItemId ?? null, input.workRunId ?? null,
          JSON.stringify(input.nodeKeys ?? []), input.baseCommit ?? null, input.worktreePath ?? null,
          planHash, input.createdBy ?? null, now,
        )
      const stmt = this.db.prepare(
        `INSERT INTO test_plan_items (id, plan_id, spec_id, seq, command, cwd, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      input.items.forEach((it, i) => {
        stmt.run(`tpi_${now}_${randomUUID().slice(0, 8)}`, id, it.specId ?? null, i + 1, it.command, it.cwd ?? null)
      })
      return this.getPlan(id)!
    })
    return txn()
  }

  /**
   * 提交审批（§6.2 Step 3;§6.3 subject 扩展）：走 ApprovalGateway
   * （subject_type='test_plan',toolName 同名）——不允许绕过网关直写。
   */
  async submitForApproval(planId: string, _opts?: { requestedBy?: string }): Promise<TestPlanRow> {
    const plan = this.getPlan(planId)
    if (!plan) throw new TestPlanError(`test_plan ${planId} 不存在`)
    if (plan.status !== 'draft') throw new TestPlanError(`plan ${planId} 状态 ${plan.status} 不可提交`)

    this.db.prepare("UPDATE test_plans SET status = 'awaiting_approval' WHERE id = ? AND status = 'draft'").run(planId)

    if (this.gateway) {
      const outcome: ApprovalOutcome = await this.gateway.request({
        toolName: 'test_plan',
        args: { planId, planHash: plan.plan_hash },
        subjectType: 'test_plan',
        subjectId: planId,
        risk: 'medium',
        policyDecision: 'ask',
        mode: 'interactive',
        cwd: plan.project_path,
      })
      if (outcome.decision !== 'allow') {
        this.db.prepare("UPDATE test_plans SET status = 'cancelled' WHERE id = ? AND status = 'awaiting_approval'").run(planId)
        throw new TestPlanError(`测试计划审批未通过（${outcome.decision}）`)
      }
      this.db
        .prepare("UPDATE test_plans SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'awaiting_approval'")
        .run(Date.now(), planId)
    }
    return this.getPlan(planId)!
  }

  /** 手动批准（宿主 UI 已有网关弹窗之外的显式路径;审计仍走 subject 行）。 */
  approve(planId: string, _approvedBy: string): TestPlanRow {
    const plan = this.getPlan(planId)
    if (!plan) throw new TestPlanError(`test_plan ${planId} 不存在`)
    if (plan.status !== 'awaiting_approval' && plan.status !== 'draft') {
      throw new TestPlanError(`plan ${planId} 状态 ${plan.status} 不可批准`)
    }
    this.db
      .prepare("UPDATE test_plans SET status = 'approved', approved_at = ? WHERE id = ?")
      .run(Date.now(), planId)
    return this.getPlan(planId)!
  }

  /**
   * 执行（§6.2 Step 4-6）：approved → running → 逐条命令（注入 runner）→
   * 汇总 test_runs + test_results。任一 failed → run failed（§6.2 失败分类）。
   * 返回 E3 资格判定（§6.2.1）——证据写入由调用方经 EvidenceService 执行。
   */
  async execute(planId: string, opts?: {
    headCommit?: string
    codeDirty?: boolean
    /** §6.8:策略门(evaluateBashPolicy+GitDirGuard,逐条调用;deny→skipped+后续停止) */
    cwdOverride?: string
    policyGate?: (command: string) => { decision: 'allow' | 'deny'; reason?: string }
  }): Promise<{
    run: TestRunRow
    e3: { eligible: boolean; reason: string; codeVersion: string | null }
  }> {
    const plan = this.getPlan(planId)
    if (!plan) throw new TestPlanError(`test_plan ${planId} 不存在`)
    if (plan.status !== 'approved') throw new TestPlanError(`plan ${planId} 未批准,不得执行（§6.2）`)

    const runId = `tr_${Date.now()}_${randomUUID().slice(0, 8)}`
    const startedAt = Date.now()
    this.db.prepare("UPDATE test_plans SET status = 'running', started_at = ? WHERE id = ?").run(startedAt, planId)
    this.db
      .prepare(
        `INSERT INTO test_runs (id, plan_id, project_path, graph_id, work_item_id, work_run_id, base_commit, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(runId, planId, plan.project_path, plan.graph_id ?? null, plan.work_item_id ?? null, plan.work_run_id ?? null, plan.base_commit ?? null, startedAt)

    const items = this.listItems(planId)
    let passed = 0
    let failed = 0
    let skipped = 0

    let gateStopped = false
    for (const item of items) {
      // §6.8/§6.3:策略门逐条;deny → skipped+denied 记录,后续默认停止(continue_on_failure=false)
      if (opts?.policyGate) {
        const verdict = opts.policyGate(item.command)
        item.policy_decision = verdict.decision
        if (verdict.decision === 'deny') {
          gateStopped = true
          this.db
            .prepare("UPDATE test_plan_items SET status = 'skipped', policy_decision = 'deny', targeted_reason = ? WHERE id = ?")
            .run(`policy deny:${verdict.reason ?? ''}`, item.id)
          this.db
            .prepare(
              `INSERT INTO test_results (id, test_run_id, plan_item_id, status, failure_summary, created_at)
               VALUES (?, ?, ?, 'skipped', ?, ?)`,
            )
            .run(`tres_${Date.now()}_${randomUUID().slice(0, 8)}`, runId, item.id, `policy deny:${verdict.reason ?? ''}`, Date.now())
          continue
        }
        this.db.prepare('UPDATE test_plan_items SET policy_decision = ? WHERE id = ?').run('allow', item.id)
      }
      if (gateStopped && item.status === 'pending') {
        // 前序失败/deny 后默认停止:余项 skipped(§6.8.2 continue_on_failure=false)
        this.db.prepare("UPDATE test_plan_items SET status = 'skipped' WHERE id = ?").run(item.id)
        skipped += 1
        continue
      }
      const itemStarted = Date.now()
      this.db.prepare("UPDATE test_plan_items SET status = 'running', started_at = ? WHERE id = ?").run(itemStarted, item.id)
      try {
        const result = await this.runner.runCommand({
          command: item.command,
          cwd: opts?.cwdOverride ?? item.cwd ?? plan.project_path,
          timeoutMs: 300_000,
        })
        const status = result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed'
        if (status === 'passed') passed += 1
        else if (status === 'failed' || status === 'timed_out') failed += 1
        this.db
          .prepare(
            `UPDATE test_plan_items SET status = ?, exit_code = ?, duration_ms = ?, output_ref = ?, ended_at = ? WHERE id = ?`,
          )
          .run(status, result.exitCode, result.durationMs, result.outputRef ?? null, Date.now(), item.id)
        this.db
          .prepare(
            `INSERT INTO test_results (id, test_run_id, plan_item_id, spec_id, status, exit_code, duration_ms, failure_class, output_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `tres_${Date.now()}_${randomUUID().slice(0, 8)}`, runId, item.id, item.spec_id ?? null,
            status, result.exitCode, result.durationMs, status === 'timed_out' ? 'timeout' : 'assertion', result.outputRef ?? null, Date.now(),
          )
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        this.db
          .prepare(
            `UPDATE test_plan_items SET status = 'error', ended_at = ? WHERE id = ?`,
          )
          .run(Date.now(), item.id)
        this.db
          .prepare(
            `INSERT INTO test_results (id, test_run_id, plan_item_id, status, failure_summary, failure_class, created_at)
             VALUES (?, ?, ?, 'error', ?, 'infra', ?)`,
          )
          .run(`tres_${Date.now()}_${randomUUID().slice(0, 8)}`, runId, item.id, message, Date.now())
        logger.warn(`test plan item ${item.id} errored: ${message}`)
      }
    }

    const runStatus = failed > 0 ? 'failed' : 'passed'
    const endedAt = Date.now()
    this.db
      .prepare(
        `UPDATE test_runs SET status = ?, total = ?, passed = ?, failed = ?, skipped = ?, head_commit = ?, dirty = ?, ended_at = ? WHERE id = ?`,
      )
      .run(runStatus, items.length, passed, failed, skipped, opts?.headCommit ?? null, opts?.codeDirty ? 1 : 0, endedAt, runId)
    this.db
      .prepare("UPDATE test_plans SET status = ?, ended_at = ? WHERE id = ?")
      .run(runStatus === 'passed' ? 'completed' : 'failed', endedAt, planId)

    // E3 资格（§6.2.1 五条,骨架判前三;§6.8 网关 allow-list 已由 specs 配置承载）:
    // passed + cwd/worktree 非空 + HEAD 可得 + dirty=0
    const codeVersion = opts?.headCommit ?? null
    const dirty = opts?.codeDirty ?? false
    const hasCwd = Boolean(plan.worktree_path) || Boolean(items[0]?.cwd ?? plan.project_path)
    const eligible = runStatus === 'passed' && hasCwd && codeVersion != null && !dirty
    const reason = !eligible
      ? runStatus !== 'passed'
        ? '测试未全部通过'
        : !codeVersion
          ? '无 HEAD commit（非 git 项目到不了 E3,§3.5）'
          : dirty
            ? '工作区 dirty 不得产出 E3（§6.2.1）'
            : '缺 cwd/worktree'
      : '满足 §6.2.1 前置'

    const run = this.getRun(runId)!
    logger.info(`test run ${runId}: ${runStatus} (${passed}/${items.length}) — E3 ${eligible ? 'eligible' : `not eligible: ${reason}`}`)
    return { run, e3: { eligible, reason, codeVersion } }
  }
}
