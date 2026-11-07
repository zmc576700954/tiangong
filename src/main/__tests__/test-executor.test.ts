/**
 * TestExecutor 编排真库回归(§6.2/§6.4/§6.5/§6.6/§6.8):
 * 全过+干净 → E3 落 verifies 目标+worktree 清理;执行内容被改脏 → 只写 E2 content_hash;
 * 零执行 / 取不到执行内容 → 不写证据;失败 → 自动建 bug+修复 work_item(draft);
 * WORKTREE_FAILED → env_fail 不建 bug;策略门 deny → skipped+后续停止。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMapS5aSchema, applyMapS7Schema, applyMapS8Schema, applyMapS6aSchema } from '../map/schema'
import { applyAgentSchema } from '../agent/runtime/db/schema'
import { TestPlanService } from '../map/test-plan-service'
import type { TestCommandRunner } from '../map/test-plan-service'
import { TestExecutor, GitWorktreeManager, WorktreeFailedError, deriveBugEntityKey } from '../map/test-executor'
import type { WorktreeManagerLike } from '../map/test-executor'
import { EvidenceService } from '../map/evidence-service'
import { WorkItemService } from '../map/work-item-service'
import { ApprovalGateway } from '../agent/runtime/approval/gateway'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS7Schema(db)
  applyMapS6aSchema(db)
  applyMapS8Schema(db)
  applyAgentSchema(db)
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, entity_key TEXT, parent_id TEXT,
      metadata TEXT, position_x REAL NOT NULL, position_y REAL NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE edges (id TEXT PRIMARY KEY, source TEXT, target TEXT, graph_id TEXT);
    CREATE TABLE bug_nodes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT NOT NULL CHECK(status IN ('open', 'fixed', 'verified')),
      node_id TEXT NOT NULL, graph_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE node_links (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
      from_entity_key TEXT NOT NULL, from_graph_id TEXT NOT NULL, from_graph_type TEXT NOT NULL,
      from_node_id TEXT, to_entity_key TEXT NOT NULL, to_graph_id TEXT NOT NULL,
      to_graph_type TEXT NOT NULL, to_node_id TEXT,
      link_type TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'directed',
      origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  const now = '2026-01-01T00:00:00Z'
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('g-dev', '开发', 'dev', '/p', now, now)
  db.prepare('INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('n-dev', 'feature', 'draft', '登录功能', 'g-dev', 'dev', 'ek-dev', 0, 0, now, now)
  return db
}

function fakeWorktrees(overrides: Partial<WorktreeManagerLike> = {}): WorktreeManagerLike & { created: string[]; removed: string[] } {
  const created: string[] = []
  const removed: string[] = []
  return {
    created,
    removed,
    create: vi.fn((_projectPath: string, base: string) => {
      const p = `/wt-${base.slice(0, 6)}-${created.length}`
      created.push(p)
      return { path: p }
    }),
    remove: vi.fn((p: string) => { removed.push(p) }),
    status: vi.fn(() => ({ head: 'headabc123', dirty: false, dirtyFiles: [] })),
    executedContent: vi.fn(() => ({ treeHash: 'treeabc123', dirtyFiles: [], contentHash: 'treeabc123' })),
    ...overrides,
  } as never
}

function fakeRunner(exitCodes: number[]): TestCommandRunner {
  let i = 0
  return {
    async runCommand() {
      const code = exitCodes[Math.min(i, exitCodes.length - 1)]
      i += 1
      return { exitCode: code, durationMs: 5 }
    },
  }
}

/** 真 ApprovalGateway + 自动 allow：审批事实真的落 agent_approvals（P0-3）。 */
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

describe('TestExecutor 编排(§6.2/§6.5/§6.6/§6.8)', () => {
  let db: BetterSqlite3.Database
  let plans: TestPlanService
  let evidence: EvidenceService
  let workItems: WorkItemService
  let worktrees: ReturnType<typeof fakeWorktrees>

  beforeEach(() => {
    db = setupDb()
    evidence = new EvidenceService(db)
    workItems = new WorkItemService(db)
    plans = new TestPlanService(db, fakeRunner([]), autoGateway(db))
    worktrees = fakeWorktrees()
  })

  it('全过+干净:E3 落 verifies 目标(dev 节点)+worktree 清理', async () => {
    // 修复任务锚=ek-dev;创建 plan(经 work_item)
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0]), autoGateway(db)), worktrees, {
      evidence,
      workItems,
      autoBug: true,
      cleanupOnPass: true,
    })
    const plan = plans.createPlan({
      projectPath: '/p',
      graphId: 'g-dev',
      workItemId: wi.id,
      items: [{ command: 'npm t' }],
      baseCommit: 'headabc123',
      workRunId: 'wr-test',
    })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('passed')
    expect(result.e3.eligible).toBe(true)
    // E3 落在 verifies 目标(无 verifies 链 → 退化 work_item 锚 ek-dev)
    expect(result.evidenceWritten).toEqual([{ nodeEntityKey: 'ek-dev', level: 'E3' }])
    const ev = db.prepare("SELECT evidence_level, code_version, code_dirty, reproducible FROM node_evidence").get() as Record<string, unknown>
    expect(ev).toMatchObject({ evidence_level: 'E3', code_version: 'headabc123', code_dirty: 0, reproducible: 1 })
    // 全过 → worktree 清理
    expect(worktrees.removed).toHaveLength(1)
    // 全过无失败 → 无 bug
    expect(result.bugsCreated).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM bug_nodes').get() as { c: number }).c).toBe(0)
  })

  it('主工作区脏但 worktree 干净 → E3 绑定 baseCommit,不再用主区脏当代理', async () => {
    worktrees = fakeWorktrees({
      status: vi.fn((p: string) =>
        p.startsWith('/wt-')
          ? { head: 'headabc123', dirty: false, dirtyFiles: [] }
          : { head: 'headabc123', dirty: true, dirtyFiles: ['src/auth/login.ts'] },
      ),
    })
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0]), autoGateway(db)), worktrees, { evidence, workItems })
    const plan = plans.createPlan({
      projectPath: '/p',
      workItemId: wi.id,
      items: [{ command: 'npm t' }],
      baseCommit: 'headabc123',
      workRunId: 'wr-test',
    })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('passed')
    expect(result.e3.eligible).toBe(true)
    expect(result.evidenceWritten).toEqual([{ nodeEntityKey: 'ek-dev', level: 'E3' }])
    const ev = db.prepare('SELECT evidence_level, code_version, code_dirty, ref_json FROM node_evidence').get() as Record<string, unknown>
    expect(ev).toMatchObject({ evidence_level: 'E3', code_version: 'headabc123', code_dirty: 0 })
    expect(JSON.parse(ev.ref_json as string)).toMatchObject({ worktreeCommit: 'headabc123', worktreeTree: 'treeabc123' })
  })

  it('执行后 worktree 被命令改脏 → 只写 E2,内容绑定含实际改动', async () => {
    worktrees = fakeWorktrees({
      executedContent: vi.fn(() => ({
        treeHash: 'treeabc123',
        dirtyFiles: ['build/generated.ts'],
        contentHash: 'contentdef456',
      })),
    })
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0]), autoGateway(db)), worktrees, { evidence, workItems })
    const plan = plans.createPlan({
      projectPath: '/p',
      workItemId: wi.id,
      items: [{ command: 'npm t' }],
      baseCommit: 'headabc123',
      workRunId: 'wr-test', // 执行前 E3 判据成立;执行后改脏 → 必须降级
    })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('passed')
    expect(result.e3.eligible).toBe(true)
    expect(result.evidenceWritten).toEqual([{ nodeEntityKey: 'ek-dev', level: 'E2' }])
    const ev = db.prepare('SELECT version_binding, current_hash, code_dirty, summary, ref_json FROM node_evidence').get() as Record<string, unknown>
    expect(ev.version_binding).toBe('content_hash')
    // 内容绑定 = 提交树 + worktree 内实际改动;不是主工作区脏文件哈希
    expect(ev.current_hash).toBe('contentdef456')
    expect(ev.code_dirty).toBeNull()
    expect(ev.summary).not.toContain('dirty 工作区')
    expect(ev.summary).toContain('已计入内容绑定')
    expect(JSON.parse(ev.ref_json as string)).toMatchObject({
      worktreeCommit: 'headabc123',
      worktreeTree: 'treeabc123',
      executedContentHash: 'contentdef456',
      worktreeDirtyFiles: ['build/generated.ts'],
      workspaceChangesIncluded: false,
    })
  })

  it('无法解析执行内容 → 不写证据(宁缺勿假)', async () => {
    worktrees = fakeWorktrees({ executedContent: vi.fn(() => null) })
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0]), autoGateway(db)), worktrees, { evidence, workItems })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }], baseCommit: 'headabc123' })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('passed')
    expect(result.evidenceWritten).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM node_evidence').get() as { c: number }).c).toBe(0)
  })

  it('失败 → 自动建 bug 节点+bug_nodes+修复 work_item(draft,§6.6)', async () => {
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([2]), autoGateway(db)), worktrees, { evidence, workItems, autoBug: true })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }], baseCommit: 'headabc123' })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)
    process.stdout.write(`DBG2: ${JSON.stringify({ status: result.status, bugs: result.bugsCreated, items: db.prepare('SELECT command, status FROM test_plan_items').all() })}\n`)

    expect(result.status).toBe('failed')
    expect(result.bugsCreated).toHaveLength(1)
    const bugNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.bugsCreated[0].bugNodeId) as Record<string, unknown>
    expect(bugNode.type).toBe('bug')
    expect(bugNode.status).toBe('draft') // 节点值域内;bug_nodes.status 才是 open
    // P0-2：bug 节点需带 entity_key（与图内其它节点同一身份体系）
    expect(bugNode.entity_key).toBeTruthy()
    const meta = JSON.parse(bugNode.metadata as string)
    expect(meta).toMatchObject({ failure_class: 'assertion', test_run_id: result.testRunId })
    // bug_nodes 行 open
    expect((db.prepare('SELECT status FROM bug_nodes WHERE node_id = ?').get(result.bugsCreated[0].bugNodeId) as { status: string }).status).toBe('open')
    // 修复 work_item:锚=ek-dev,draft,derived_plan
    expect(result.bugsCreated[0].workItemId).toBeTruthy()
    const fix = workItems.get(result.bugsCreated[0].workItemId!)!
    expect(fix).toMatchObject({ status: 'draft', origin: 'derived_plan', anchor_entity_key: 'ek-dev' })
    // 失败现场保留
    expect(worktrees.removed).toHaveLength(0)
  })

  it('WORKTREE_FAILED → env_fail:run error 不建 bug(§6.8.2)', async () => {
    worktrees = fakeWorktrees({
      create: vi.fn(() => { throw new WorktreeFailedError('git worktree boom') }),
    })
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0]), autoGateway(db)), worktrees, { evidence, workItems, autoBug: true })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }] })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('failed')
    expect(result.e3.reason).toContain('WORKTREE_FAILED')
    expect(result.bugsCreated).toEqual([]) // env_fail 不建 bug
    const runRow = db.prepare('SELECT status, report_ref FROM test_runs WHERE plan_id = ?').get(plan.id) as Record<string, unknown>
    expect(runRow.status).toBe('error')
    expect(runRow.report_ref).toContain('env_fail')
  })

  it('策略门 deny → 该条 skipped+denied 记录,后续默认停止(§6.8.2)', async () => {
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(
      db,
      new TestPlanService(db, fakeRunner([0, 0, 0]), autoGateway(db)),
      worktrees,
      { evidence, workItems, autoBug: false },
    )
    const plan = plans.createPlan({
      projectPath: '/p',
      workItemId: wi.id,
      items: [{ command: 'rm -rf .git' }, { command: 'npm t 1' }, { command: 'npm t 2' }],
      workRunId: 'wr-denied',
    })
    await plans.approve(plan.id, 'u1')
    // gitdir guard 对 .git 写类命令 block → deny(rm -rf .git 为 critical 零审批写)
    const result = await executor.executeTestPlan(plan.id)

    const items = db.prepare('SELECT seq, status, policy_decision FROM test_plan_items WHERE plan_id = ? ORDER BY seq').all(plan.id) as Array<{ seq: number; status: string; policy_decision: string | null }>
    expect(items[0]).toMatchObject({ status: 'skipped', policy_decision: 'deny' })
    expect(items[1]).toMatchObject({ status: 'skipped' }) // 后续默认停止
    expect(items[2]).toMatchObject({ status: 'skipped' })

    // P0-1：全 deny = 零执行，即使带 work_run_id 也不得聚合为 passed、不得产出 E3
    expect(result.status).toBe('failed')
    expect(result.e3.eligible).toBe(false)
    const run = db.prepare('SELECT status, passed, failed, skipped FROM test_runs WHERE plan_id = ?').get(plan.id) as Record<string, unknown>
    expect(run).toMatchObject({ status: 'failed', passed: 0, failed: 0, skipped: 3 })
    expect(plans.getPlan(plan.id)!.status).toBe('failed')
    // 零执行（全 deny）→ 不写任何证据，连 E2 都不写（宁缺勿假）
    expect(result.evidenceWritten).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM node_evidence').get() as { c: number }).c).toBe(0)
  })

  it('同一失败跑两次 → 派生稳定 entity_key,只产生一个 bug 节点(P0-2)', async () => {
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([2]), autoGateway(db)), worktrees, {
      evidence,
      workItems,
      autoBug: true,
    })
    const makePlan = () =>
      plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }], baseCommit: 'headabc123' })

    const p1 = makePlan()
    await plans.approve(p1.id, 'u1')
    const r1 = await executor.executeTestPlan(p1.id)
    expect(r1.bugsCreated).toHaveLength(1)

    const p2 = makePlan()
    await plans.approve(p2.id, 'u1')
    const r2 = await executor.executeTestPlan(p2.id)

    expect(r2.bugsCreated).toEqual([]) // 同一失败复用,不新建
    const bugs = db.prepare("SELECT id, entity_key FROM nodes WHERE type = 'bug'").all() as Array<{ id: string; entity_key: string }>
    expect(bugs).toHaveLength(1)
    expect(bugs[0].id).toBe(r1.bugsCreated[0].bugNodeId)
    expect(bugs[0].entity_key).toBe(
      deriveBugEntityKey('/p', { spec_id: null, command: 'npm t', status: 'failed', exit_code: 2 }),
    )
    expect((db.prepare('SELECT COUNT(*) AS c FROM bug_nodes').get() as { c: number }).c).toBe(1)
  })

  it('P0-2:bug_nodes 插入失败 → 同事务整体回滚,不留孤儿节点(§6.6)', async () => {
    // 让 bug_nodes 写入必然失败（模拟 CHECK/约束错误），节点插入必须先回滚
    db.exec(`CREATE TRIGGER fail_bug_nodes BEFORE INSERT ON bug_nodes BEGIN SELECT RAISE(ABORT, 'boom'); END;`)
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([2]), autoGateway(db)), worktrees, {
      evidence,
      workItems,
      autoBug: true,
    })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }], baseCommit: 'headabc123' })
    await plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('failed')
    expect(result.bugsCreated).toEqual([])
    expect((db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE type = 'bug'").get() as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM bug_nodes').get() as { c: number }).c).toBe(0)
  })
})

describe('GitWorktreeManager(受控 git,§6.4)', () => {
  it('非 git 目录 status 返回 null(不抛)', () => {
    const mgr = new GitWorktreeManager()
    expect(mgr.status('/tmp')).toBeNull()
  })

  it('worktree 建在项目外;遗留 .bizgraph-worktrees 不判 dirty;真实改动仍判 dirty', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-wt-'))
    const mgr = new GitWorktreeManager()
    let worktreePath: string | undefined
    try {
      execFileSync('git', ['-C', project, 'init', '-q'])
      execFileSync('git', ['-C', project, 'config', 'user.email', 'test@local'])
      execFileSync('git', ['-C', project, 'config', 'user.name', 'test'])
      fs.writeFileSync(path.join(project, 'a.txt'), 'x')
      execFileSync('git', ['-C', project, 'add', '.'])
      execFileSync('git', ['-C', project, 'commit', '-qm', 'init'])
      const head = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
      expect(mgr.status(project)!.dirty).toBe(false)

      worktreePath = mgr.create(project, head).path
      // 失败现场不落在项目里：新建 worktree 不污染主仓 status
      expect(worktreePath.startsWith(`${project}${path.sep}`)).toBe(false)
      expect(fs.existsSync(worktreePath)).toBe(true)
      expect(mgr.status(project)!.dirty).toBe(false)

      // 旧版本遗留的 in-project worktree 目录：不再让项目永久 dirty（无需人工删目录）
      fs.mkdirSync(path.join(project, '.bizgraph-worktrees', 'wt-legacy'), { recursive: true })
      fs.writeFileSync(path.join(project, '.bizgraph-worktrees', 'wt-legacy', 'leftover.txt'), 'x')
      expect(mgr.status(project)!.dirty).toBe(false)

      // 用户真实改动仍然判 dirty（E3 依旧只认干净工作区）
      fs.writeFileSync(path.join(project, 'a.txt'), 'y')
      expect(mgr.status(project)!.dirty).toBe(true)
    } finally {
      if (worktreePath) mgr.remove(worktreePath)
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
