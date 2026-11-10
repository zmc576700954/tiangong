/**
 * TestExecutor（S8 完成,session-map 蓝图 §6.2/§6.4/§6.5/§6.6/§6.8）
 *
 * 编排 TestPlanService 的完整执行流程:
 *  1. 状态采集:只取项目 HEAD 作 base_commit（§6.2 Step 1）;主工作区 dirty
 *     与本次执行无关,不参与任何判定
 *  2. worktree:主进程受控 git 能力创建（不经 Bash 工具,§6.4）,固定 detach 在
 *     base_commit;主工作区未提交改动不进入执行集（「base+应用 diff」增强留 L3）
 *  3. 策略门（§6.8,逐条不可跳过,§6.4）:evaluateBashPolicy（allow/ask 经计划审批
 *     提升,空命令拒）+ evaluateGitDirWriteGuard（block=硬 deny,§6.3 不豁免）;
 *     deny → 该条 skipped+denied 结果,后续默认停止（continue_on_failure=false）
 *  4. 结果回写（§6.5):证据只描述**实际被执行**的那份代码——worktree 的
 *     `HEAD^{tree}` + 执行后 worktree 内未提交改动的逐文件 sha256 一起做内容绑定。
 *     E3 需 worktree 执行后仍干净 + 全过 + work_run_id;否则只写 E2；零执行
 *     （全 deny/全 skip/infra error）或取不到执行内容 → 不写任何证据（宁缺勿假）。
 *     失败（非 env_fail）→ 自动建 bug 节点 + bug_nodes + 修复 work_item
 *     （draft 走 C2,§6.6-3）;bug 行可反查 test_run→plan_item（§6.6-6）
 *  5. 清理:全过删 worktree;失败现场保留在项目外(tmps)最多 7 天,由「创建时惰性回收 +
 *     启动后/每 6h 定时清理」两条路径共同回收（G9-10）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
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

/**
 * worktree 根目录：放在系统临时目录而不是项目内。原因见 §6.4：建在
 * `<project>/.bizgraph-worktrees` 时,失败现场会成为项目里永久未跟踪目录,
 * 而下一次执行的 dirty 判定先于 worktree 清理 → 该项目 E3 永久不可用。
 * 按项目路径哈希分目录,避免多项目互相清理;失败现场保留 7 天后惰性回收。
 */
const WORKTREE_ROOT_DIR = 'bizgraph-worktrees'
const LEGACY_WORKTREE_DIR = '.bizgraph-worktrees'
export const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** 定时清理周期（G9-10 口径：启动后一次 + 每 6 小时一次）。 */
export const WORKTREE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 单轮回收上限（II-33 边界）。 */
export const WORKTREE_SWEEP_MAX_PER_ROUND = 50
/** 标记文件后缀：与 worktree 目录同级，不写进工作树（否则会把 E3 判脏）。 */
const WORKTREE_MARKER_SUFFIX = '.marker'
/** 严格命名：wt-<13 位毫秒时间戳>-<6 位小写十六进制>。 */
const WORKTREE_NAME_RE = /^wt-\d{13}-[0-9a-f]{6}$/

export function resolveWorktreeRoot(projectPath: string): string {
  const key = createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), WORKTREE_ROOT_DIR, key)
}

function worktreeRootDir(projectPath: string): string {
  return resolveWorktreeRoot(projectPath)
}

/** 旧版本落在项目内的 worktree 目录;只用于 status 过滤,不参与 dirty 判定。 */
function isLegacyWorktreePath(file: string): boolean {
  return file === LEGACY_WORKTREE_DIR || file.startsWith(`${LEGACY_WORKTREE_DIR}/`)
}

/** 本次执行实际内容的绑定指纹（执行结束后采集）。 */
export interface ExecutedContent {
  /** worktree HEAD 的 tree 对象哈希（提交树）。 */
  treeHash: string
  /** 执行结束后 worktree 内仍未提交的文件（命令自己改出来的产物/改动）。 */
  dirtyFiles: string[]
  /** 内容绑定：干净时 = treeHash;有未提交改动时 = treeHash + 逐文件 sha256 的聚合。 */
  contentHash: string
}

/** worktree 管理器（主进程受控 git 能力;测试可注入 fake）。 */
export interface WorktreeManagerLike {
  /** 从 base_commit 创建 detach worktree,返回路径;失败抛 WorktreeFailedError。 */
  create(projectPath: string, baseCommit: string): { path: string }
  remove(worktreePath: string): void
  /** HEAD + porcelain 状态采集;非 git 返回 null。 */
  status(projectPath: string): { head: string; dirty: boolean; dirtyFiles: string[] } | null
  /** 执行结束后 worktree 的真实内容指纹;取不到返回 null（调用方不得凭猜测写内容绑定）。 */
  executedContent(worktreePath: string): ExecutedContent | null
}

export class GitWorktreeManager implements WorktreeManagerLike {
  create(projectPath: string, baseCommit: string): { path: string } {
    const root = worktreeRootDir(projectPath)
    try {
      // base_commit 先解析成真实 commit sha：既保证 worktree 锚点确定,也避免
      // 调用方传入以 `-` 开头的字符串被 git 当成选项（本路径没有 Bash 审批兜底）。
      const commit = execFileSync(
        'git',
        ['-C', projectPath, 'rev-parse', '--verify', '--end-of-options', `${baseCommit}^{commit}`],
        { encoding: 'utf-8' },
      ).trim()
      fs.mkdirSync(root, { recursive: true })
      this.reclaimExpired(projectPath, root)
      const wtPath = path.join(root, `wt-${Date.now()}-${randomUUID().slice(0, 6)}`)
      execFileSync('git', ['-C', projectPath, 'worktree', 'add', '--detach', wtPath, commit], { stdio: 'pipe' })
      this.writeMarker(wtPath, projectPath, commit)
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
      this.removeMarker(worktreePath)
      return
    } catch (err) {
      logger.warn(`worktree remove failed (${worktreePath}): ${err instanceof Error ? err.message : String(err)}`)
    }
    // git 元数据损坏/目录已不在：直接删目录兜底,残留的 admin 元数据由下次
    // worktree prune 清掉。失败现场不能再永久占住路径。
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true })
    } catch (err) {
      logger.warn(`worktree force remove failed (${worktreePath}): ${err instanceof Error ? err.message : String(err)}`)
    }
    this.removeMarker(worktreePath)
  }

  /**
   * 归属标记写在 worktree 目录**同级**，不写进工作树：写进目录会让
   * `status --porcelain` 判脏，从而把 E3 永久挡掉（§6.5 内容绑定）。
   */
  private writeMarker(worktreePath: string, projectPath: string, baseCommit: string): void {
    try {
      fs.writeFileSync(
        `${worktreePath}${WORKTREE_MARKER_SUFFIX}`,
        JSON.stringify({ v: 1, projectPath: path.resolve(projectPath), baseCommit, createdAt: Date.now() }),
      )
    } catch (err) {
      logger.warn(`worktree marker write failed (${worktreePath}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private removeMarker(worktreePath: string): void {
    try {
      fs.rmSync(`${worktreePath}${WORKTREE_MARKER_SUFFIX}`, { force: true })
    } catch (err) {
      logger.warn(`worktree marker remove failed (${worktreePath}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  status(projectPath: string): { head: string; dirty: boolean; dirtyFiles: string[] } | null {
    try {
      const head = execFileSync('git', ['-C', projectPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      const porcelain = execFileSync('git', ['-C', projectPath, 'status', '--porcelain'], { encoding: 'utf-8' })
      const dirtyFiles = porcelain
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean)
        // 旧版本遗留在项目内的 worktree 不计入 dirty：否则首次失败后该项目
        // 永远无法再判干净,且用户没有清理入口。
        .filter((f) => !isLegacyWorktreePath(f))
      return { head, dirty: dirtyFiles.length > 0, dirtyFiles }
    } catch {
      return null // 非 git 项目（§3.5:到不了 E3,只能 E4 人工签收）
    }
  }

  executedContent(worktreePath: string): ExecutedContent | null {
    try {
      const treeHash = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf-8' }).trim()
      // -uall：未跟踪目录展开到文件级,否则目录名读不到内容,绑定会漏掉改动。
      const porcelain = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain', '-uall'], { encoding: 'utf-8' })
      const dirtyFiles = porcelain
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean)
      if (dirtyFiles.length === 0) return { treeHash, dirtyFiles, contentHash: treeHash }
      // 执行过程中命令自己改动了 worktree 的文件：这些改动实际参与了本次执行,
      // 必须一起纳入内容绑定。读不到内容（已删除/重命名旧路径）按 absent 计入。
      const parts = dirtyFiles
        .map((f) => {
          try {
            const content = fs.readFileSync(path.join(worktreePath, f))
            return `${f}:${createHash('sha256').update(content).digest('hex')}`
          } catch {
            return `${f}:absent`
          }
        })
        .sort()
      const contentHash = createHash('sha256').update(`${treeHash}\n${parts.join('\n')}`).digest('hex')
      return { treeHash, dirtyFiles, contentHash }
    } catch {
      return null // worktree 已删/非 git：调用方不得凭猜测写内容绑定
    }
  }

  /** 惰性回收超过保留期的失败现场（尽力而为,不影响本次 create）。 */
  private reclaimExpired(projectPath: string, root: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    let removed = false
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('wt-')) continue
      const createdMs = Number(entry.name.split('-')[1])
      if (!Number.isFinite(createdMs) || Date.now() - createdMs < WORKTREE_RETENTION_MS) continue
      this.remove(path.join(root, entry.name))
      removed = true
    }
    if (removed) {
      try {
        execFileSync('git', ['-C', projectPath, 'worktree', 'prune'], { stdio: 'pipe' })
      } catch (err) {
        logger.warn(`worktree prune failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

export interface WorktreeSweepOptions {
  now?: number
  maxPerRound?: number
  retentionMs?: number
  /** 测试注入：替换真实 git 删除（默认走 GitWorktreeManager.remove）。 */
  remove?: (worktreePath: string) => void
}

export interface WorktreeSweepReport {
  projects: number
  removed: number
  skippedActive: number
  skippedYoung: number
  skippedUnowned: number
  clearedPaths: number
  capped: boolean
}

/**
 * 定时清理（G9-10）：按 `test_plans.worktree_path` 反查项目根，逐目录判定。
 *
 * 选择条件：
 *  - 严格命名 `wt-<13 位 ms>-<6 位 hex>`，且位于本应用根目录/<已知 project-hash> 下；
 *  - 超过 7 天保留期；
 *  - 不被 `test_plans.status IN ('running','approved')` 引用（活跃 worktree 绝不删）。
 * 归属：新建 worktree 带同级 `.marker`；无标记的历史目录按严格命名放行一次并记日志。
 * 幂等：目录删除后自然不再命中；`worktree_path` 指向已不存在目录的行顺手清空。
 * 上限：单轮最多回收 50 个，超出留到下一轮。
 */
export function sweepStaleWorktrees(
  db: BetterSqlite3.Database,
  opts: WorktreeSweepOptions = {},
): WorktreeSweepReport {
  const now = opts.now ?? Date.now()
  const maxPerRound = opts.maxPerRound ?? WORKTREE_SWEEP_MAX_PER_ROUND
  const retentionMs = opts.retentionMs ?? WORKTREE_RETENTION_MS
  const manager = opts.remove ? null : new GitWorktreeManager()
  const remove = opts.remove ?? ((p: string) => manager!.remove(p))

  const rows = db
    .prepare('SELECT id, project_path, status, worktree_path FROM test_plans WHERE worktree_path IS NOT NULL')
    .all() as Array<{ id: string; project_path: string; status: string; worktree_path: string }>

  const active = new Set<string>()
  const projects = new Set<string>()
  for (const row of rows) {
    projects.add(row.project_path)
    if (row.status === 'running' || row.status === 'approved') {
      active.add(path.resolve(row.worktree_path))
    }
  }

  const report: WorktreeSweepReport = {
    projects: projects.size,
    removed: 0,
    skippedActive: 0,
    skippedYoung: 0,
    skippedUnowned: 0,
    clearedPaths: 0,
    capped: false,
  }

  scan: for (const projectPath of projects) {
    const root = resolveWorktreeRoot(projectPath)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    let projectRemoved = false
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!WORKTREE_NAME_RE.test(entry.name)) {
        report.skippedUnowned++
        continue
      }
      const full = path.join(root, entry.name)
      if (active.has(path.resolve(full))) {
        report.skippedActive++
        continue
      }
      const createdMs = Number(entry.name.split('-')[1])
      if (!Number.isFinite(createdMs) || now - createdMs < retentionMs) {
        report.skippedYoung++
        continue
      }
      if (report.removed >= maxPerRound) {
        report.capped = true
        break scan
      }
      if (!fs.existsSync(`${full}${WORKTREE_MARKER_SUFFIX}`)) {
        logger.info(`worktree sweep: 无标记历史目录按严格命名放行回收 ${full}`)
      }
      remove(full)
      try {
        fs.rmSync(`${full}${WORKTREE_MARKER_SUFFIX}`, { force: true })
      } catch (err) {
        logger.warn(`worktree marker sweep remove failed (${full}): ${err instanceof Error ? err.message : String(err)}`)
      }
      if (fs.existsSync(full)) {
        logger.warn(`worktree sweep: 回收失败，留待下一轮 ${full}`)
      } else {
        report.removed++
        projectRemoved = true
      }
    }
    if (projectRemoved && fs.existsSync(path.join(projectPath, '.git'))) {
      try {
        execFileSync('git', ['-C', projectPath, 'worktree', 'prune'], { stdio: 'pipe' })
      } catch (err) {
        logger.warn(`worktree sweep prune failed (${projectPath}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // 已删除/被外部删除的现场不再保留陈旧路径；幂等：下一轮不会重复计数。
  const remaining = db
    .prepare('SELECT id, worktree_path FROM test_plans WHERE worktree_path IS NOT NULL')
    .all() as Array<{ id: string; worktree_path: string }>
  const clearPath = db.prepare('UPDATE test_plans SET worktree_path = NULL WHERE id = ? AND worktree_path = ?')
  for (const row of remaining) {
    if (fs.existsSync(row.worktree_path)) continue
    clearPath.run(row.id, row.worktree_path)
    report.clearedPaths++
  }

  return report
}

/**
 * 启动后一次 + 每 6 小时一次。返回停止函数（测试/退出时清理计时器）。
 * 失败只告警，不阻断主进程。
 */
export function startWorktreeRetentionSweep(
  db: BetterSqlite3.Database,
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): () => void {
  const run = (phase: string): void => {
    try {
      const report = sweepStaleWorktrees(db)
      if (report.removed > 0 || report.clearedPaths > 0) {
        logger.info(
          `worktree ${phase} sweep: removed=${report.removed} clearedPaths=${report.clearedPaths}` +
            ` skippedActive=${report.skippedActive} skippedYoung=${report.skippedYoung}` +
            ` skippedUnowned=${report.skippedUnowned} capped=${report.capped}`,
        )
      }
    } catch (err) {
      logger.warn(`worktree ${phase} sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const initial = setTimeout(() => run('startup'), opts.initialDelayMs ?? 5000)
  initial.unref()
  const timer = setInterval(() => run('scheduled'), opts.intervalMs ?? WORKTREE_SWEEP_INTERVAL_MS)
  timer.unref()
  return () => {
    clearTimeout(initial)
    clearInterval(timer)
  }
}

export interface TestExecutorDeps {
  evidence?: EvidenceService
  workItems?: WorkItemService
  /** §6.6:失败自动建 bug+修复 work_item（draft 走 C2）;默认开;env_fail 不建。 */
  autoBug?: boolean
  /** 全过后删 worktree（默认 true）;失败现场保留在 tmps 最多 7 天,由惰性回收 + 定时清理共同回收。 */
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

    // ---- Step 1:状态采集（只取 base_commit;主工作区脏不参与执行判定）----
    const statusInfo = this.worktrees.status(plan.project_path)
    const baseCommit = opts?.headCommit ?? statusInfo?.head ?? null

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

    // E3 的 code_dirty 只认**被执行 worktree**的干净状态。新建 worktree 固定在
    // base_commit，主工作区是否脏与本次执行无关——不能再拿它当代理指标。
    const worktreeStatus = this.worktrees.status(worktreePath)
    const worktreeDirty = worktreeStatus?.dirty ?? true // 无法确认 → fail-closed（E3 禁）

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
        codeDirty: worktreeDirty,
        cwdOverride: worktreePath,
        policyGate,
      })
    } catch (err) {
      this.worktrees.remove(worktreePath)
      throw err
    }

    // ---- Step 5:结果回写 + bug 闭环 ----
    // 证据只描述真正执行的那份代码：worktree 固定在 baseCommit，执行结束后再采集
    // 其 tree 与残留未提交改动；主工作区脏文件不参与（它们从未被这次执行读到）。
    const executed = this.worktrees.executedContent(worktreePath)
    const executedCount = this.countExecutedTestItems(result.run.id)
    const evidenceWritten = this.deps.evidence
      ? this.writeEvidence(plan, result.e3, baseCommit, executed, executedCount)
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

  /** 真实执行过的命令数（passed/failed/timed_out；skip/deny 与 infra error 不算）。 */
  private countExecutedTestItems(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM test_results WHERE test_run_id = ? AND status IN ('passed','failed','timed_out')",
      )
      .get(runId) as { c: number }
    return row.c
  }

  /** §6.5:verifies 目标节点(dev 侧)写 E3/E2;无 verifies 链 → 退化为 work_item 锚。 */
  private writeEvidence(
    plan: TestPlanRow,
    e3: { eligible: boolean; reason: string; codeVersion: string | null },
    baseCommit: string | null,
    executed: ExecutedContent | null,
    executedCount: number,
  ): Array<{ nodeEntityKey: string; level: 'E3' | 'E2' }> {
    const evidence = this.deps.evidence
    if (!evidence || !plan.work_item_id) return []
    // 零执行（全 deny / 全 skip / 仅有 infra error）→ 不写任何证据（宁缺勿假）。
    if (executedCount === 0) {
      logger.info(`test plan ${plan.id}: 零执行，不写 E2/E3 证据`)
      return []
    }
    // 取不到执行内容的指纹（worktree 已被删/git 异常）→ 同样不写：宁可没有证据,
    // 也不能拿主工作区或猜测值冒充"被执行的那份代码"。
    if (!executed) {
      logger.warn(`test plan ${plan.id}: 无法解析 worktree 执行内容，不写证据`)
      return []
    }
    const executedDirty = executed.dirtyFiles.length > 0
    const item = this.db
      .prepare('SELECT anchor_entity_key, graph_id FROM work_items WHERE id = ?')
      .get(plan.work_item_id) as { anchor_entity_key: string | null; graph_id: string } | undefined
    if (!item) return []

    const targets = this.resolveVerifyTargets(item.anchor_entity_key)
    const allPassed = this.plans.getPlan(plan.id)?.status === 'completed'
    const testRunId = this.latestTestRunId(plan.id)
    const written: Array<{ nodeEntityKey: string; level: 'E3' | 'E2' }> = []

    // §3.7.1:E3 必带 work_run_id——计划未关联 work_run(独立手工计划)时从严落 E2
    // (§6.2.1 五条之外的执行链要求;关联 run 由编排层创建,L2 流水线自然满足)。
    // 执行后 worktree 若被命令改脏，本次验证已不再对应提交树 → 同样降级 E2。
    const e3Allowed = e3.eligible && allPassed && Boolean(plan.work_run_id) && !executedDirty

    for (const target of targets) {
      try {
        if (e3Allowed) {
          evidence.create({
            level: 'E3',
            graphId: item.graph_id,
            nodeEntityKey: target,
            evidenceType: 'test_run',
            ref: { testRunId, planId: plan.id, worktreeCommit: baseCommit, worktreeTree: executed.treeHash },
            actor: 'test_executor',
            producedBy: 'test_executor',
            codeVersion: e3.codeVersion ?? baseCommit ?? undefined,
            codeDirty: 0,
            currentHash: undefined,
            // G11-10：记录这次 E3 对应的执行树（worktree 干净时即 HEAD tree）。
            treeHash: executed.treeHash,
            workRunId: plan.work_run_id ?? undefined,
            workItemId: plan.work_item_id ?? undefined,
            summary: `测试通过(worktree@${(e3.codeVersion ?? '').slice(0, 8)} 干净提交树)`,
          })
          written.push({ nodeEntityKey: target, level: 'E3' })
        } else {
          evidence.create({
            level: 'E2',
            graphId: item.graph_id,
            nodeEntityKey: target,
            evidenceType: 'test_run',
            ref: {
              testRunId,
              planId: plan.id,
              worktreeCommit: baseCommit,
              worktreeTree: executed.treeHash,
              executedContentHash: executed.contentHash,
              worktreeDirtyFiles: executed.dirtyFiles,
              // 主工作区未提交改动从未进入 worktree,与本次执行无关。
              workspaceChangesIncluded: false,
            },
            actor: 'test_executor',
            producedBy: 'test_executor',
            currentHash: executed.contentHash,
            workRunId: plan.work_run_id ?? undefined,
            workItemId: plan.work_item_id ?? undefined,
            summary:
              `测试事实(worktree@${(baseCommit ?? '').slice(0, 8)} 提交树,${allPassed ? '通过' : '未通过'}` +
              `${executedDirty ? `;执行后 worktree 内 ${executed.dirtyFiles.length} 个未提交文件已计入内容绑定` : ''}` +
              `;不含主工作区未提交改动)${e3.reason ? ':' + e3.reason : ''}`,
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
