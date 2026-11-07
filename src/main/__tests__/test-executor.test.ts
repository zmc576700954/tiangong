/**
 * TestExecutor 编排真库回归(§6.2/§6.4/§6.5/§6.6/§6.8):
 * 全过+干净 → E3 落 verifies 目标+worktree 清理;dirty → E2 content_hash;
 * 失败 → 自动建 bug+修复 work_item(draft);WORKTREE_FAILED → env_fail 不建 bug;
 * 策略门 deny → skipped+后续停止。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapS7Schema, applyMapS8Schema, applyMapS6aSchema } from '../map/schema'
import { applyAgentSchema } from '../agent/runtime/db/schema'
import { TestPlanService } from '../map/test-plan-service'
import { TestExecutor, GitWorktreeManager, WorktreeFailedError } from '../map/test-executor'
import type { WorktreeManagerLike } from '../map/test-executor'
import { EvidenceService } from '../map/evidence-service'
import { WorkItemService } from '../map/work-item-service'

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
      severity TEXT NOT NULL, status TEXT NOT NULL, node_id TEXT NOT NULL,
      graph_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
    ...overrides,
  } as never
}

function fakeRunner(exitCodes: number[]): import('../map/test-plan-service').TestCommandRunner {
  let i = 0
  return {
    async runCommand() {
      const code = exitCodes[Math.min(i, exitCodes.length - 1)]
      i += 1
      return { exitCode: code, durationMs: 5 }
    },
  }
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
    plans = new TestPlanService(db, fakeRunner([]))
    worktrees = fakeWorktrees()
  })

  it('全过+干净:E3 落 verifies 目标(dev 节点)+worktree 清理', async () => {
    // 修复任务锚=ek-dev;创建 plan(经 work_item)
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0])), worktrees, {
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
    plans.approve(plan.id, 'u1')
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

  it('dirty → 只写 E2(content_hash 绑定),不写 E3(§6.2.1 fail-closed)', async () => {
    worktrees = fakeWorktrees({
      status: vi.fn(() => ({ head: 'headabc123', dirty: true, dirtyFiles: ['src/auth/login.ts'] })),
    })
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0])), worktrees, { evidence, workItems })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }], baseCommit: 'headabc123' })
    plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)

    expect(result.status).toBe('passed')
    expect(result.e3.eligible).toBe(false)
    expect(result.evidenceWritten).toEqual([{ nodeEntityKey: 'ek-dev', level: 'E2' }])
    const ev = db.prepare('SELECT version_binding, current_hash, code_dirty FROM node_evidence').get() as Record<string, unknown>
    expect(ev.version_binding).toBe('content_hash')
    expect(ev.current_hash).toBeTruthy() // dirty_tree_hash
    expect(ev.code_dirty).toBeNull() // E2 不绑 code hash
  })

  it('失败 → 自动建 bug 节点+bug_nodes+修复 work_item(draft,§6.6)', async () => {
    const wi = workItems.createDraft({ graphId: 'g-dev', anchorEntityKey: 'ek-dev', title: '实现登录', origin: 'derived_plan' })
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([2])), worktrees, { evidence, workItems, autoBug: true })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }], baseCommit: 'headabc123' })
    plans.approve(plan.id, 'u1')
    const result = await executor.executeTestPlan(plan.id)
    process.stdout.write(`DBG2: ${JSON.stringify({ status: result.status, bugs: result.bugsCreated, items: db.prepare('SELECT command, status FROM test_plan_items').all() })}\n`)

    expect(result.status).toBe('failed')
    expect(result.bugsCreated).toHaveLength(1)
    const bugNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(result.bugsCreated[0].bugNodeId) as Record<string, unknown>
    expect(bugNode.type).toBe('bug')
    expect(bugNode.status).toBe('draft') // 节点值域内;bug_nodes.status 才是 open
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
    const executor = new TestExecutor(db, new TestPlanService(db, fakeRunner([0])), worktrees, { evidence, workItems, autoBug: true })
    const plan = plans.createPlan({ projectPath: '/p', workItemId: wi.id, items: [{ command: 'npm t' }] })
    plans.approve(plan.id, 'u1')
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
      new TestPlanService(db, fakeRunner([0, 0, 0])),
      worktrees,
      { evidence, workItems, autoBug: false },
    )
    const plan = plans.createPlan({
      projectPath: '/p',
      workItemId: wi.id,
      items: [{ command: 'rm -rf .git' }, { command: 'npm t 1' }, { command: 'npm t 2' }],
    })
    plans.approve(plan.id, 'u1')
    // gitdir guard 对 .git 写类命令 block → deny(rm -rf .git 为 critical 零审批写)
    await executor.executeTestPlan(plan.id)

    const items = db.prepare('SELECT seq, status, policy_decision FROM test_plan_items WHERE plan_id = ? ORDER BY seq').all(plan.id) as Array<{ seq: number; status: string; policy_decision: string | null }>
    expect(items[0]).toMatchObject({ status: 'skipped', policy_decision: 'deny' })
    expect(items[1]).toMatchObject({ status: 'skipped' }) // 后续默认停止
    expect(items[2]).toMatchObject({ status: 'skipped' })
    // 全被 deny → 无执行无失败,聚合为 passed(零失败口径);skip 链是本测重点
  })
})

describe('GitWorktreeManager(受控 git,§6.4)', () => {
  it('非 git 目录 status 返回 null(不抛)', () => {
    const mgr = new GitWorktreeManager()
    expect(mgr.status('/tmp')).toBeNull()
  })
})
