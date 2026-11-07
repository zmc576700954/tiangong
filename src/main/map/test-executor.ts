/**
 * TestExecutor（S8 完成,session-map 蓝图 §6.2/§6.4/§6.5/§6.6/§6.8）
 *
 * 编排 TestPlanService 的完整执行流程:
 *  1. 状态采集:git status --porcelain → dirty / dirty 文件清单（§6.2 Step 1）
 *  2. worktree:主进程受控 git 能力创建（不经 Bash 工具,§6.4）,从 base_commit;
 *     dirty 场景 fail-closed——测试照跑但 dirty=1,E3 被禁只落 E2（§6.2.1 主方案;
 *     「base+应用工作区 diff」增强留 L3,不影响 fail-closed 语义）
 *  3. 策略门（§6.8,逐条不可跳过,§6.4）:evaluateBashPolicy（allow/ask 经计划审批
 *     提升,空命令拒）+ evaluateGitDirWriteGuard（block=硬 deny,§6.3 不豁免）;
 *     deny → 该条 skipped+denied 结果,后续默认停止（continue_on_failure=false）
 *  4. 结果回写（§6.5）:verifies 目标节点写 E3（§6.2.1 五条:干净+全过+HEAD）或
 *     E2（dirty 事实,version_binding='content_hash',current_hash=dirty_tree_hash）;
 *     失败（非 env_fail）→ 自动建 bug 节点 + bug_nodes + 修复 work_item
 *     （draft 走 C2,§6.6-3）;bug 行可反查 test_run→plan_item（§6.6-6）
 *  5. 清理:全过删 worktree;失败保留现场（test_plans.worktree_path,清理随运维）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import { evaluateBashPolicy } from '../agent/runtime/approval/bash-readonly'
import { evaluateGitDirWriteGuard } from '../agent/runtime/approval/gitdir-write-guard'
import { type TestPlanService, TestPlanError } from './test-plan-service'
import type { TestPlanRow, TestPlanItemRow } from './test-plan-service'
import { normalizeTitle } from '../map-migration/entity-key-backfill'
import { type EvidenceService } from './evidence-service'
import { type WorkItemService } from './work-item-service'
import { scheduleExecutionRecompute } from './execution-state'

const logger = createLogger('TestExecutor')

export class WorktreeFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeFailedError'
  }
}

/**
 * bug 节点的派生稳定身份。规范与 entity-key-backfill.ts 一致：规范化文本 + `|`
 * 分隔组件 + sha256 hex（那里是 type|title|parent_chain|ordinal，这里是
 * bug|project|test_item|failure_signature）。同一 (项目, 测试项, 失败签名)
 * 反复失败复用同一实体，避免每次失败都新建 bug 节点。
 */
export function deriveBugEntityKey(
  projectPath: string,
  item: Pick<TestPlanItemRow, 'spec_id' | 'command' | 'status' | 'exit_code'>,
): string {
  const project = normalizeTitle(projectPath).replace(/\/+$/, '')
  const testItem = item.spec_id ? normalizeTitle(item.spec_id) : normalizeTitle(item.command)
  const failure = `${item.status}|exit=${item.exit_code ?? ''}`
  return createHash('sha256').update(`bug|${project}|${testItem}|${failure}`).digest('hex')
}

/** worktree 管理器（主进程受控 git 能力;测试可注入 fake）。 */
export interface WorktreeManagerLike {
  /** 从 base_commit 创建 detach worktree,返回路径;失败抛 WorktreeFailedError。 */
  create(projectPath: string, baseCommit: string): { path: string }
  remove(worktreePath: string): void
  /** HEAD + porcelain 状态采集（§6.2 Step 1）;非 git 返回 null。 */
  status(projectPath: string): { head: string; dirty: boolean; dirtyFiles: string[] } | null
}

export class GitWorktreeManager implements WorktreeManagerLike {
  create(projectPath: string, baseCommit: string): { path: string } {
    const wtPath = path.join(projectPath, '.bizgraph-worktrees', `wt-${Date.now()}-${randomUUID().slice(0, 6)}`)
    try {
      fs.mkdirSync(path.dirname(wtPath), { recursive: true })
      execFileSync('git', ['-C', projectPath, 'worktree', 'add', '--detach', wtPath, baseCommit], { stdio: 'pipe' })
      return { path: wtPath }
    } catch (err) {
      throw new WorktreeFailedError(
        `worktree 创建失败（WORKTREE_FAILED,env_fail——不建 bug,§6.8.2）: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  remove(worktreePath: string): void {
    try {
      const root = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktreePath], { stdio: 'pipe' })
    } catch (err) {
      logger.warn(`worktree remove failed (${worktreePath}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  status(projectPath: string): { head: string; dirty: boolean; dirtyFiles: string[] } | null {
    try {
      const head = execFileSync('git', ['-C', projectPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      const porcelain = execFileSync('git', ['-C', projectPath, 'status', '--porcelain'], { encoding: 'utf-8' })
      const dirtyFiles = porcelain.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
      return { head, dirty: dirtyFiles.length > 0, dirtyFiles }
    } catch {
      return null // 非 git 项目（§3.5:到不了 E3,只能 E4 人工签收）
    }
  }
}

export interface TestExecutorDeps {
  evidence?: EvidenceService
  workItems?: WorkItemService
  /** §6.6:失败自动建 bug+修复 work_item（draft 走 C2）;默认开;env_fail 不建。 */
  autoBug?: boolean
  /** 全过后删 worktree（默认 true）;失败现场始终保留（清理随运维）。 */
  cleanupOnPass?: boolean
}

export interface ExecuteTestPlanResult {
  testRunId: string
  status: 'passed' | 'failed'
  e3: { eligible: boolean; reason: string; codeVersion: string | null }
  evidenceWritten: Array<{ nodeEntityKey: string; level: 'E3' | 'E2' }> | null
  bugsCreated: Array<{ bugNodeId: string; workItemId: string | null; title: string }>
}

export class TestExecutor {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly plans: TestPlanService,
    private readonly worktrees: WorktreeManagerLike,
    private readonly deps: TestExecutorDeps = {},
  ) {}

  async executeTestPlan(
    planId: string,
    opts?: { headCommit?: string; derivationVersion?: string },
  ): Promise<ExecuteTestPlanResult> {
    const plan = this.plans.getPlan(planId)
    if (!plan) throw new TestPlanError(`test_plan ${planId} 不存在`)

    // ---- Step 1:状态采集 ----
    const statusInfo = this.worktrees.status(plan.project_path)
    const baseCommit = opts?.headCommit ?? statusInfo?.head ?? null
    const dirty = statusInfo?.dirty ?? true // 非 git → 按 dirty fail-closed（E3 禁）

    // ---- Step 2:worktree（WORKTREE_FAILED → env_fail 不建 bug,§6.8.2）----
    let worktreePath: string
    try {
      if (!baseCommit) throw new WorktreeFailedError('无 base_commit(非 git 项目)')
      worktreePath = this.worktrees.create(plan.project_path, baseCommit).path
    } catch (err) {
      if (err instanceof WorktreeFailedError) {
        this.db.prepare("UPDATE test_plans SET status = 'failed', ended_at = ? WHERE id = ?").run(Date.now(), planId)
        const runId = this.seedEnvFailedRun(plan, err.message)
        return {
          testRunId: runId,
          status: 'failed',
          e3: { eligible: false, reason: 'WORKTREE_FAILED(env_fail)', codeVersion: null },
          evidenceWritten: null,
          bugsCreated: [],
        }
      }
      throw err
    }
    this.db.prepare('UPDATE test_plans SET worktree_path = ?, base_commit = ? WHERE id = ?').run(worktreePath, baseCommit, planId)

    // ---- Step 3-4:执行(策略门逐条;cwd=worktree) ----
    const policyGate = (command: string): { decision: 'allow' | 'ask' | 'deny'; reason?: string } => {
      // 复用 Agent 同一套分级(§6.1)。P0-3：策略门的 ask 不再被「计划已批准」
      // 提升为 allow——ask 交回 execute(),由 ApprovalGateway 逐条真实放行;
      // 只有 allow 免审,critical 与 gitdir block 是硬 deny。
      const bash = evaluateBashPolicy(command, { cwd: worktreePath })
      if (bash.decision === 'blocked-empty') {
        return { decision: 'deny', reason: `bash-policy:空命令(${bash.rule})` }
      }
      if (bash.risk === 'critical') {
        return { decision: 'deny', reason: `bash-policy:critical 零审批写(${bash.rule}:${bash.reason})` }
      }
      const guard = evaluateGitDirWriteGuard('Bash', { command }, { cwd: worktreePath })
      if (guard.verdict === 'block') {
        return { decision: 'deny', reason: `gitdir-guard:${guard.reason}` }
      }
      if (bash.decision === 'ask') {
        return { decision: 'ask', reason: `bash-policy:${bash.rule}(${bash.reason})` }
      }
      return { decision: 'allow' }
    }

    let result: Awaited<ReturnType<TestPlanService['execute']>>
    try {
      result = await this.plans.execute(planId, {
        headCommit: baseCommit,
        codeDirty: dirty,
        cwdOverride: worktreePath,
        policyGate,
      })
    } catch (err) {
      this.worktrees.remove(worktreePath)
      throw err
    }

    // ---- Step 5:结果回写 + bug 闭环 ----
    const evidenceWritten = this.deps.evidence
      ? this.writeEvidence(plan, result.e3, dirtyFilesHash(statusInfo?.dirtyFiles, plan.project_path), baseCommit)
      : null
    const bugsCreated = this.deps.autoBug === false
      ? []
      : this.createBugsForFailures(plan, result.run.id)

    // ---- Step 6:清理(全过删;失败保留现场) ----
    if (result.run.status === 'passed' && this.deps.cleanupOnPass !== false) {
      this.worktrees.remove(worktreePath)
    }

    return {
      testRunId: result.run.id,
      status: result.run.status === 'passed' ? 'passed' : 'failed',
      e3: result.e3,
      evidenceWritten,
      bugsCreated,
    }
  }

  /** §6.5:verifies 目标节点(dev 侧)写 E3/E2;无 verifies 链 → 退化为 work_item 锚。 */
  private writeEvidence(
    plan: TestPlanRow,
    e3: { eligible: boolean; reason: string; codeVersion: string | null },
    dirtyTreeHash: string | null,
    baseCommit: string | null,
  ): Array<{ nodeEntityKey: string; level: 'E3' | 'E2' }> {
    const evidence = this.deps.evidence
    if (!evidence || !plan.work_item_id) return []
    const item = this.db
      .prepare('SELECT anchor_entity_key, graph_id FROM work_items WHERE id = ?')
      .get(plan.work_item_id) as { anchor_entity_key: string | null; graph_id: string } | undefined
    if (!item) return []

    const targets = this.resolveVerifyTargets(item.anchor_entity_key)
    const allPassed = this.plans.getPlan(plan.id)?.status === 'completed'
    const testRunId = this.latestTestRunId(plan.id)
    const written: Array<{ nodeEntityKey: string; level: 'E3' | 'E2' }> = []

    // §3.7.1:E3 必带 work_run_id——计划未关联 work_run(独立手工计划)时从严落 E2
    // (§6.2.1 五条之外的执行链要求;关联 run 由编排层创建,L2 流水线自然满足)
    const e3Allowed = e3.eligible && allPassed && Boolean(plan.work_run_id)

    for (const target of targets) {
      try {
        if (e3Allowed) {
          evidence.create({
            level: 'E3',
            graphId: item.graph_id,
            nodeEntityKey: target,
            evidenceType: 'test_run',
            ref: { testRunId, planId: plan.id },
            actor: 'test_executor',
            producedBy: 'test_executor',
            codeVersion: e3.codeVersion ?? baseCommit ?? undefined,
            codeDirty: 0,
            currentHash: undefined,
            workRunId: plan.work_run_id ?? undefined,
            workItemId: plan.work_item_id ?? undefined,
            summary: `测试通过(worktree@${(e3.codeVersion ?? '').slice(0, 8)})`,
          })
          written.push({ nodeEntityKey: target, level: 'E3' })
        } else {
          // dirty 事实:E2 content_hash 绑定 dirty_tree_hash(§6.2.1 表格第二行)
          evidence.create({
            level: 'E2',
            graphId: item.graph_id,
            nodeEntityKey: target,
            evidenceType: 'test_run',
            ref: { testRunId, planId: plan.id },
            actor: 'test_executor',
            producedBy: 'test_executor',
            currentHash: dirtyTreeHash ?? undefined,
            workRunId: plan.work_run_id ?? undefined,
            workItemId: plan.work_item_id ?? undefined,
            summary: `测试事实(dirty 工作区,不可复现)${e3.reason ? ':' + e3.reason : ''}`,
          })
          written.push({ nodeEntityKey: target, level: 'E2' })
        }
      } catch (err) {
        // 证据写入失败不阻塞测试终态(§3.7.1:由重试任务补写,补写前不展示 verified)
        logger.warn(`evidence write failed for ${target.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return written
  }

  /** verifies 目标(node_links:test→dev);无 → [work_item 锚](§6.5 结果回写)。 */
  private resolveVerifyTargets(anchorEntityKey: string | null): string[] {
    if (!anchorEntityKey) return []
    const rows = this.db
      .prepare(
        `SELECT DISTINCT to_entity_key AS target FROM node_links
          WHERE link_type = 'verifies' AND status = 'active' AND from_entity_key = ?
          UNION
          SELECT DISTINCT from_entity_key AS target FROM node_links
          WHERE link_type = 'verifies' AND status = 'active' AND to_entity_key = ?`,
      )
      .all(anchorEntityKey, anchorEntityKey) as Array<{ target: string }>
    const targets = rows.map((r) => r.target).filter(Boolean)
    return targets.length > 0 ? targets : [anchorEntityKey]
  }

  /** §6.6:失败(非 env_fail)→ 自动建 bug 节点+bug_nodes+修复 work_item(draft 走 C2)。 */
  private createBugsForFailures(plan: TestPlanRow, testRunId: string): Array<{ bugNodeId: string; workItemId: string | null; title: string }> {
    if (this.deps.autoBug === false) return []
    const failedItems = this.db
      .prepare("SELECT * FROM test_plan_items WHERE plan_id = ? AND status IN ('failed','timed_out')")
      .all(plan.id) as TestPlanItemRow[]
    if (failedItems.length === 0) return []

    const devGraph = this.db
      .prepare("SELECT id FROM graphs WHERE project_path = ? AND type = 'dev' ORDER BY created_at ASC LIMIT 1")
      .get(plan.project_path) as { id: string } | undefined
    if (!devGraph) {
      logger.warn('auto-bug skipped: no dev graph for project')
      return []
    }
    const anchor = plan.work_item_id
      ? (this.db.prepare('SELECT anchor_entity_key FROM work_items WHERE id = ?').get(plan.work_item_id) as { anchor_entity_key: string | null } | undefined)
      : undefined

    const created: Array<{ bugNodeId: string; workItemId: string | null; title: string }> = []
    const now = new Date().toISOString()
    for (const item of failedItems) {
      const title = `测试失败:${item.command.slice(0, 60)}`
      // 派生稳定身份：同一失败（项目+测试项+失败签名）反复出现时复用，不重复建节点。
      const entityKey = deriveBugEntityKey(plan.project_path, item)
      const existing = this.db
        .prepare("SELECT id FROM nodes WHERE graph_id = ? AND entity_key = ? AND type = 'bug'")
        .get(devGraph.id, entityKey) as { id: string } | undefined
      if (existing) continue
      const bugNodeId = `n-bug-${randomUUID().slice(0, 8)}`
      try {
        // P0-2：bug 节点与 bug_nodes 必须同事务——任一步失败整体回滚,
        // 否则会留下没有 bug 记录的孤儿节点。bug 节点带 entity_key,
        // 与图内其它节点同一身份体系(evidence/links/UNIQUE(graph_id, entity_key))。
        const insertBug = this.db.transaction(() => {
          this.db
            .prepare(
              `INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key, position_x, position_y, metadata, created_at, updated_at)
               VALUES (?, 'bug', 'draft', ?, ?, 'dev', ?, 0, 0, ?, ?, ?)`,
            )
            .run(
              bugNodeId, title, devGraph.id, entityKey,
              JSON.stringify({
                test_run_id: testRunId,
                plan_id: plan.id,
                plan_item_id: item.id,
                failure_class: item.status === 'timed_out' ? 'timeout' : 'assertion',
                verifies_entity_key: anchor?.anchor_entity_key ?? null,
              }),
              now, now,
            )
          this.db
            .prepare(
              `INSERT INTO bug_nodes (id, title, description, severity, status, node_id, graph_id, created_at, updated_at)
               VALUES (?, ?, ?, 'high', 'open', ?, ?, ?, ?)`,
            )
            .run(
              `bug_${randomUUID().slice(0, 8)}`, title,
              `测试计划 ${plan.id} 用例失败(${item.status})。证据链:test_run=${testRunId} plan_item=${item.id}`,
              bugNodeId, devGraph.id, now, now,
            )
        })
        insertBug()
        // 修复 work_item:锚=被验证的 dev 实体,draft(仍需 C2 确认,§6.6-3)
        let workItemId: string | null = null
        if (anchor?.anchor_entity_key && this.deps.workItems) {
          try {
            const wi = this.deps.workItems.createDraft({
              graphId: devGraph.id,
              anchorEntityKey: anchor.anchor_entity_key,
              title: `修复:${title}`,
              goal: `定向重测来源:test_run=${testRunId}`,
              origin: 'derived_plan',
            })
            workItemId = wi.id
          } catch (err) {
            logger.warn(`fix work_item creation failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        created.push({ bugNodeId, workItemId, title })
        scheduleExecutionRecompute(this.db, devGraph.id, bugNodeId)
      } catch (err) {
        logger.warn(`auto-bug creation failed for item ${item.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return created
  }

  private seedEnvFailedRun(plan: TestPlanRow, reason: string): string {
    const runId = `tr_${Date.now()}_${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO test_runs (id, plan_id, project_path, graph_id, work_item_id, work_run_id, base_commit, status, report_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?, ?)`,
      )
      .run(runId, plan.id, plan.project_path, plan.graph_id ?? null, plan.work_item_id ?? null, plan.work_run_id ?? null, plan.base_commit ?? null, `env_fail:${reason}`, Date.now())
    return runId
  }

  private latestTestRunId(planId: string): string {
    const row = this.db
      .prepare('SELECT id FROM test_runs WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(planId) as { id: string } | undefined
    return row?.id ?? ''
  }
}

/** dirty_tree_hash(§4.7.7):dirty 文件按路径排序,拼 path+NUL+sha256(content) 取哈希。 */
function dirtyFilesHash(dirtyFiles: string[] | undefined, projectRoot: string): string | null {
  if (!dirtyFiles || dirtyFiles.length === 0) return null
  try {
    const hash = createHash('sha256')
    for (const rel of [...dirtyFiles].sort()) {
      let contentHash = 'unreadable'
      try {
        contentHash = createHash('sha256').update(fs.readFileSync(path.join(projectRoot, rel))).digest('hex')
      } catch { /* 不可读文件按占位参与 */ }
      hash.update(`${rel}\0${contentHash}`)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
