/**
 * G2-11 流程级测试最小版（§6.5.1 的 L2 口径 / II-13 验收）。
 *
 * 范围（已裁决 A）：**集成测试**，用现有 TestPlanService + TestExecutor +
 * EvidenceService 跑通「计划 → worktree 执行 → test_results/test_runs →
 * E3 证据 → 失败建 bug + 链接」。不扩 `selected_by` CHECK、不实现
 * §6.5.1.1 的 flow 计划生成（子图框选 → 拓扑排序 → verify+shell → test_report），
 * `steps_json` → 有序 plan items 的展开在本测试内完成（生产无此入口）。
 *
 * 覆盖：
 *  1. flow spec（kind='flow'，steps_json 有序两步）全过 → 每条 result 留痕 +
 *     run 聚合 passed + E3（绑定 worktree tree / work_run_id）+ worktree 清理；
 *  2. flow 中一步失败 → run 聚合 failed + 失败项 result 可定位 + 只落 E2 +
 *     自动建 bug 节点/bug_nodes/修复 work_item，且 bug 元数据链接回 test_run 与 plan_item。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapS7Schema, applyMapS8Schema, applyMapS6aSchema } from '../map/schema'
import { applyAgentSchema } from '../agent/runtime/db/schema'
import { TestPlanService } from '../map/test-plan-service'
import type { TestCommandRunner } from '../map/test-plan-service'
import { TestExecutor } from '../map/test-executor'
import type { WorktreeManagerLike } from '../map/test-executor'
import { EvidenceService } from '../map/evidence-service'
import { WorkItemService } from '../map/work-item-service'
import { ApprovalGateway } from '../agent/runtime/approval/gateway'

const FLOW_SPEC_ID = 'spec-flow-login'
const PROJECT_PATH = '/p'
const BASE_COMMIT = 'headabc123'
const WORK_RUN_ID = 'wr-flow-1'

/** 与 test-executor.test.ts 同源的只读最小表（生产 DDL 见 database.ts）。 */
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
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('g-dev', '开发', 'dev', PROJECT_PATH, now, now)
  db.prepare(
    `INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key, position_x, position_y, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('n-dev', 'feature', 'draft', '登录功能', 'g-dev', 'dev', 'ek-dev', 0, 0, now, now)
  return db
}

function fakeWorktrees(): WorktreeManagerLike & { removed: string[] } {
  const removed: string[] = []
  return {
    removed,
    create: vi.fn(() => ({ path: '/wt-flow-0' })),
    remove: vi.fn((p: string) => { removed.push(p) }),
    status: vi.fn(() => ({ head: BASE_COMMIT, dirty: false, dirtyFiles: [] })),
    executedContent: vi.fn(() => ({ treeHash: 'treeabc123', dirtyFiles: [], contentHash: 'treeabc123' })),
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

/** 真 ApprovalGateway + 自动 allow：审批事实真的落 agent_approvals。 */
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

const FLOW_STEPS = [
  { id: 'verify', command: 'npm run verify:login' },
  { id: 'shell', command: 'npm test -- login' },
]

describe('G2-11 流程级测试最小版（flow → 执行 → 证据）', () => {
  let db: BetterSqlite3.Database
  let evidence: EvidenceService
  let workItems: WorkItemService
  let plans: TestPlanService

  beforeEach(() => {
    db = setupDb()
    evidence = new EvidenceService(db)
    workItems = new WorkItemService(db)
    plans = new TestPlanService(db, fakeRunner([]), autoGateway(db))
    // flow spec：kind='flow' + steps_json 固化有序步骤（§6.5.1）
    db.prepare(
      `INSERT INTO test_specs
         (id, project_path, graph_id, test_node_entity_key, test_node_id, name, kind,
          command, cwd, env_json, timeout_ms, runner, file_globs_json, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'flow', ?, NULL, NULL, 300000, NULL, NULL, ?, ?, ?)`,
    ).run(
      FLOW_SPEC_ID, PROJECT_PATH, 'g-dev', 'ek-test-login', 'n-test', '登录流程',
      FLOW_STEPS.map((s) => s.command).join(' && '),
      JSON.stringify(FLOW_STEPS), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
    )
  })

  /** 把 flow spec 的有序步骤展开成 plan items（生产暂无此入口，见 I.9.3）。 */
  function createFlowPlan(items: Array<{ command: string }> = FLOW_STEPS): ReturnType<TestPlanService['createPlan']> {
    const wi = workItems.createDraft({
      graphId: 'g-dev',
      anchorEntityKey: 'ek-dev',
      title: '实现登录',
      origin: 'derived_plan',
    })
    return plans.createPlan({
      projectPath: PROJECT_PATH,
      graphId: 'g-dev',
      workItemId: wi.id,
      workRunId: WORK_RUN_ID,
      baseCommit: BASE_COMMIT,
      items: items.map((s) => ({ specId: FLOW_SPEC_ID, command: s.command })),
    })
  }

  function executorWith(exitCodes: number[], worktrees = fakeWorktrees()) {
    return {
      worktrees,
      executor: new TestExecutor(db, new TestPlanService(db, fakeRunner(exitCodes), autoGateway(db)), worktrees, {
        evidence,
        workItems,
        autoBug: true,
        cleanupOnPass: true,
      }),
    }
  }

  it('flow 全部步骤通过：逐条留痕 + run 聚合 passed + E3 + worktree 清理', async () => {
    const plan = createFlowPlan()
    await plans.approve(plan.id, 'u1')
    const { executor, worktrees } = executorWith([0, 0])

    const result = await executor.executeTestPlan(plan.id)

    // 1) 计划：两条按 steps_json 顺序，spec 关联保留；A 范围下 selected_by 仍是 'plan'
    const items = plans.listItems(plan.id)
    expect(items.map((i) => i.command)).toEqual(FLOW_STEPS.map((s) => s.command))
    expect(items.map((i) => i.seq)).toEqual([1, 2])
    expect(items.every((i) => i.spec_id === FLOW_SPEC_ID)).toBe(true)
    expect(items.every((i) => i.selected_by === 'plan')).toBe(true)
    expect(items.every((i) => i.status === 'passed')).toBe(true)

    // 2) 逐条 test_results：每条都能回到 plan_item 与 spec
    expect(result.status).toBe('passed')
    const results = db
      .prepare('SELECT plan_item_id, spec_id, status, exit_code FROM test_results WHERE test_run_id = ? ORDER BY rowid')
      .all(result.testRunId) as Array<{ plan_item_id: string; spec_id: string; status: string; exit_code: number }>
    expect(results).toHaveLength(2)
    expect(results.map((r) => [r.plan_item_id, r.spec_id, r.status, r.exit_code])).toEqual([
      [items[0].id, FLOW_SPEC_ID, 'passed', 0],
      [items[1].id, FLOW_SPEC_ID, 'passed', 0],
    ])

    // 3) run 聚合：flow 全过才算 passed
    expect(plans.getRun(result.testRunId)).toMatchObject({ status: 'passed', total: 2, passed: 2, failed: 0, skipped: 0 })
    expect(plans.getPlan(plan.id)!.status).toBe('completed')

    // 4) E3：绑定 worktree tree + work_run_id，且落到 work_item 锚
    expect(result.e3.eligible).toBe(true)
    expect(result.evidenceWritten).toEqual([{ nodeEntityKey: 'ek-dev', level: 'E3' }])
    const ev = db
      .prepare('SELECT evidence_level, evidence_type, ref_json, work_run_id, work_item_id, code_version, code_dirty, tree_hash FROM node_evidence')
      .get() as Record<string, unknown>
    expect(ev).toMatchObject({
      evidence_level: 'E3',
      evidence_type: 'test_run',
      work_run_id: WORK_RUN_ID,
      code_version: BASE_COMMIT,
      code_dirty: 0,
      tree_hash: 'treeabc123',
    })
    expect(JSON.parse(ev.ref_json as string)).toMatchObject({
      testRunId: result.testRunId,
      planId: plan.id,
      worktreeCommit: BASE_COMMIT,
      worktreeTree: 'treeabc123',
    })

    // 5) 全过：清理 worktree，且不建 bug
    expect(worktrees.removed).toEqual(['/wt-flow-0'])
    expect(result.bugsCreated).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM bug_nodes').get() as { c: number }).c).toBe(0)
  })

  it('flow 中一步失败：run 聚合 failed + 失败可定位 + E2 + 建 bug 并链接回 test_run/plan_item', async () => {
    const plan = createFlowPlan()
    await plans.approve(plan.id, 'u1')
    const { executor, worktrees } = executorWith([0, 2])

    const result = await executor.executeTestPlan(plan.id)

    // 1) run 聚合：任一步失败即 failed（当前执行器不短路后续步骤，见 I.9.3）
    expect(result.status).toBe('failed')
    expect(plans.getRun(result.testRunId)).toMatchObject({ status: 'failed', total: 2, passed: 1, failed: 1, skipped: 0 })
    expect(plans.getPlan(plan.id)!.status).toBe('failed')

    // 2) 失败可定位到 test_result → plan_item
    const items = plans.listItems(plan.id)
    const failedItem = items[1]
    const failedResult = db
      .prepare('SELECT status, exit_code, failure_class FROM test_results WHERE test_run_id = ? AND plan_item_id = ?')
      .get(result.testRunId, failedItem.id) as Record<string, unknown>
    expect(failedResult).toMatchObject({ status: 'failed', exit_code: 2, failure_class: 'assertion' })

    // 3) 未全过 → 只写 E2（不写 E3），仍绑定本次 test_run
    expect(result.e3.eligible).toBe(false)
    expect(result.evidenceWritten).toEqual([{ nodeEntityKey: 'ek-dev', level: 'E2' }])
    const ev = db
      .prepare('SELECT evidence_level, ref_json, work_run_id FROM node_evidence')
      .get() as Record<string, unknown>
    expect(ev.evidence_level).toBe('E2')
    expect(ev.work_run_id).toBe(WORK_RUN_ID)
    expect(JSON.parse(ev.ref_json as string)).toMatchObject({ testRunId: result.testRunId, planId: plan.id })

    // 4) 失败 → 建 bug 节点 + bug_nodes + 修复 work_item，并可链接回失败现场
    expect(result.bugsCreated).toHaveLength(1)
    const bug = result.bugsCreated[0]
    const bugNode = db.prepare('SELECT type, status, entity_key, metadata FROM nodes WHERE id = ?').get(bug.bugNodeId) as Record<string, unknown>
    expect(bugNode).toMatchObject({ type: 'bug', status: 'draft' })
    expect(bugNode.entity_key).toBeTruthy()
    expect(JSON.parse(bugNode.metadata as string)).toMatchObject({
      test_run_id: result.testRunId,
      plan_id: plan.id,
      plan_item_id: failedItem.id,
      failure_class: 'assertion',
      verifies_entity_key: 'ek-dev',
    })
    expect(
      db.prepare('SELECT status, node_id FROM bug_nodes WHERE node_id = ?').get(bug.bugNodeId),
    ).toMatchObject({ status: 'open', node_id: bug.bugNodeId })
    expect(bug.workItemId).toBeTruthy()
    expect(workItems.get(bug.workItemId!)!).toMatchObject({ status: 'draft', anchor_entity_key: 'ek-dev' })

    // 5) 失败现场保留（不清理 worktree）
    expect(worktrees.removed).toEqual([])
  })
})
