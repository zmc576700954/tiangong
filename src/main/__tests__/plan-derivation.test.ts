/**
 * S7 真库回归(§5.2/§5.5/§5.7):候选推导(退化/聚类/打分带/约束)/计划草稿
 * 生命周期(C1 环检测硬性/确认生成 work_items/修订)/偏差记录(NULL 口径)。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapS7Schema } from '../map/schema'
import {
  BoundaryDerivationService,
  PlanDraftService,
  PlanDeviationRepository,
  PlanDraftCycleError,
  detectCycle,
  kahnLayers,
} from '../map/plan-derivation'
import { WorkItemService } from '../map/work-item-service'
import { WorkRunService } from '../map/work-run-service'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS7Schema(db)
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, project_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, parent_id TEXT, entity_key TEXT,
      metadata TEXT, content TEXT, context_refs TEXT,
      position_x REAL NOT NULL, position_y REAL NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
      edge_type TEXT, graph_id TEXT NOT NULL
    );
  `)
  const now = '2026-01-01T00:00:00Z'
  db.prepare('INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('g1', 'dev 图', 'dev', '/p', now, now)
  return db
}

function insertNode(db: BetterSqlite3.Database, opts: { id: string; parent?: string; type?: string; files?: string[] }): void {
  const now = '2026-01-01T00:00:00Z'
  const metadata = opts.files && opts.files.length > 0 ? JSON.stringify({ fileAssociations: opts.files.map((f) => ({ type: 'file', path: f })) }) : null
  db.prepare(
    'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, parent_id, metadata, position_x, position_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(opts.id, opts.type ?? 'feature', 'draft', `节点${opts.id}`, 'g1', 'dev', opts.parent ?? null, metadata, 0, 0, now, now)
}

describe('BoundaryDerivationService(§5.2)', () => {
  let db: BetterSqlite3.Database
  let svc: BoundaryDerivationService

  beforeEach(() => {
    db = setupDb()
    svc = new BoundaryDerivationService(db)
  })

  it('聚类与打分:文件重叠+同父 → 同候选;run 批次落库 proposed', () => {
    insertNode(db, { id: 'root', type: 'module' })
    insertNode(db, { id: 'a', parent: 'root', files: ['src/auth/login.ts', 'src/auth/session.ts'] })
    insertNode(db, { id: 'b', parent: 'root', files: ['src/auth/token.ts'] }) // 与 a 重叠 auth/ 前缀语义→Jaccard 0
    // 让 a/b 文件真正重叠:共享一个文件
    insertNode(db, { id: 'c', parent: 'root', files: ['src/auth/login.ts', 'src/billing/invoice.ts'] })

    const result = svc.derive('g1')
    expect(result.degraded).toBe(false)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const c of result.candidates) {
      expect(c.status).toBe('proposed')
      expect(c.derivation_run_id).toBe(result.runId)
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(1)
    }
    // 同 run 的候选 node_keys 不重叠(聚类互斥)
    const keySets = result.candidates.map((c) => new Set(JSON.parse(c.node_keys_json) as string[]))
    for (let i = 0; i < keySets.length; i++) {
      for (let j = i + 1; j < keySets.length; j++) {
        for (const k of keySets[i]) expect(keySets[j].has(k)).toBe(false)
      }
    }
  })

  it('退化路径:全部节点无文件 → D1;锚点为 wiki-page → D5', () => {
    insertNode(db, { id: 'bare' })
    expect(svc.derive('g1').degraded).toBe('D1-empty-files')

    insertNode(db, { id: 'wiki', type: 'wiki-page', files: ['x.md'] })
    expect(svc.derive('g1', { anchorNodeId: 'wiki' }).degraded).toBe('D5-anchor-degenerate')
  })

  it('确定性:同输入两次推导候选集合一致(键集合+分数)', () => {
    insertNode(db, { id: 'r', type: 'module' })
    insertNode(db, { id: 'x', parent: 'r', files: ['src/a.ts', 'src/b.ts'] })
    insertNode(db, { id: 'y', parent: 'r', files: ['src/a.ts', 'src/c.ts'] })

    const r1 = svc.derive('g1')
    const r2 = svc.derive('g1')
    const norm = (r: ReturnType<typeof svc.derive>) =>
      r.candidates.map((c) => ({ keys: (JSON.parse(c.node_keys_json) as string[]).sort(), score: c.score }))
    expect(norm(r2)).toEqual(norm(r1))
  })
})

describe('detectCycle / kahnLayers(§5.5.1)', () => {
  it('环检测:直接环/自环/无环', () => {
    expect(detectCycle(['a', 'b'], new Map([['a', ['b']], ['b', ['a']]]))).not.toBeNull()
    expect(detectCycle(['a'], new Map([['a', ['a']]]))).not.toBeNull()
    expect(detectCycle(['a', 'b', 'c'], new Map([['a', ['b']], ['b', ['c']]]))).toBeNull()
  })

  it('Kahn 分层:入度分层;残环抛错', () => {
    const layers = kahnLayers(['a', 'b', 'c'], new Map([['b', ['a']], ['c', ['b']]]))
    expect(layers[0]).toEqual(['a'])
    expect(layers.flat()).toEqual(expect.arrayContaining(['a', 'b', 'c']))
    expect(() => kahnLayers(['a', 'b'], new Map([['a', ['b']], ['b', ['a']]]))).toThrow(PlanDraftCycleError)
  })
})

describe('PlanDraftService(§5.5/§5.6)', () => {
  let db: BetterSqlite3.Database
  let svc: PlanDraftService
  let workItems: WorkItemService

  beforeEach(() => {
    db = setupDb()
    workItems = new WorkItemService(db)
    svc = new PlanDraftService(db, workItems)
  })

  const items = [
    { key: 't1', title: '实现登录', scopeFiles: ['src/auth/**'], dependsOn: [] },
    { key: 't2', title: '实现账单', scopeFiles: ['src/billing/**'], dependsOn: ['t1'] },
  ]

  it('生命周期:draft→awaiting_confirm→confirmed 生成 1 父+N 子(依赖映射为 id,层序创建)', () => {
    const draft = svc.createDraft({ graphId: 'g1', items })
    expect(draft.status).toBe('draft')
    svc.submit(draft.id)
    const { draft: confirmed, workItemIds, parentId } = svc.confirm(draft.id, { confirmedBy: 'u1' })
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.confirmed_by).toBe('u1')
    expect(workItemIds).toHaveLength(2)

    const parent = workItems.get(parentId)!
    expect(parent.origin).toBe('derived_plan')
    const steps = workItems.listSteps(parentId, 1)
    expect(steps.map((s) => s.title)).toEqual(['实现登录', '实现账单'])

    const child1 = workItems.get(workItemIds[0])!
    expect(child1.parent_work_item_id).toBe(parentId)
    expect(JSON.parse(child1.depends_on_json)).toEqual([])
    const child2 = workItems.get(workItemIds[1])!
    expect(child2.parent_work_item_id).toBe(parentId)
    expect(JSON.parse(child2.depends_on_json)).toEqual([child1.id]) // 依赖映射到真实 id

    // 生成的任务按护栏落 draft,走人工 gate(§8.1.1)
    expect(child1.status).toBe('draft')
    // 同 lineage 只有一行 is_current
    expect((db.prepare('SELECT COUNT(*) AS c FROM plan_drafts WHERE lineage_id = ? AND is_current = 1').get(confirmed.lineage_id) as { c: number }).c).toBe(1)
  })

  it('C1 环检测硬性:有环拒绝确认,不得生成 work_items', () => {
    const cyclic = [
      { key: 'a', title: 'A', dependsOn: ['b'] },
      { key: 'b', title: 'B', dependsOn: ['a'] },
    ]
    const draft = svc.createDraft({ graphId: 'g1', items: cyclic })
    svc.submit(draft.id)
    expect(() => svc.confirm(draft.id)).toThrow(PlanDraftCycleError)
    // 未生成任何任务
    expect((db.prepare('SELECT COUNT(*) AS c FROM work_items').get() as { c: number }).c).toBe(0)
  })

  it('修订:draft 修订保持 draft;confirmed 后拒绝 revise 与重复 confirm(§5.5)', () => {
    // draft 上修订:状态保持 draft(§5.5 状态机 revise 箭头回落 draft)
    const draft = svc.createDraft({ graphId: 'g1', items })
    const revised = svc.revise(draft.id, [...items, { key: 't3', title: '新增子任务' }])
    expect(revised.revision).toBe(2)
    expect(revised.status).toBe('draft')
    expect(JSON.parse(revised.items_json)).toHaveLength(3)
    expect((db.prepare('SELECT status FROM plan_drafts WHERE id = ?').get(draft.id) as { status: string }).status).toBe('superseded')
    expect(() => svc.revise(draft.id, items)).toThrow(/CONFLICT|修订/)

    // 确认后计划行作为确认事实只读：不得 revise 回 awaiting_confirm 再造一套 work_items
    svc.submit(revised.id)
    const confirmed = svc.confirm(revised.id, { confirmedBy: 'u1' })
    expect(confirmed.draft.status).toBe('confirmed')
    expect(() => svc.revise(revised.id, items)).toThrow(/已确认/)
    expect((db.prepare('SELECT COUNT(*) AS c FROM work_items').get() as { c: number }).c).toBe(4)

    // 旧版本可能留下 confirmed + awaiting_confirm 共存的 lineage：confirm 须兜底拒绝
    const legacyId = 'pd_legacy'
    db.prepare('UPDATE plan_drafts SET is_current = 0 WHERE id = ?').run(revised.id)
    db.prepare(
      `INSERT INTO plan_drafts (
         id, lineage_id, revision, supersedes_id, is_current, project_path, graph_id,
         anchor_entity_key, anchor_node_id, derivation_run_id, items_json, status, created_at, updated_at
       ) SELECT ?, lineage_id, revision + 1, id, 1, project_path, graph_id,
         anchor_entity_key, anchor_node_id, derivation_run_id, items_json, 'awaiting_confirm', ?, ?
       FROM plan_drafts WHERE id = ?`,
    ).run(legacyId, 'now', 'now', revised.id)
    expect(() => svc.confirm(legacyId)).toThrow(/已有已确认 revision/)
    expect((db.prepare('SELECT COUNT(*) AS c FROM work_items').get() as { c: number }).c).toBe(4)
  })
})

describe('PlanDeviationRepository(§5.7)', () => {
  let db: BetterSqlite3.Database
  let repo: PlanDeviationRepository
  let workItems: WorkItemService
  let runSvc: WorkRunService

  beforeEach(() => {
    db = setupDb()
    workItems = new WorkItemService(db)
    runSvc = new WorkRunService(db)
    repo = new PlanDeviationRepository(db)
  })

  it('run 终态记录:planned/actual/change_set 未采集时 actual=NULL 不写 0;replan=lineage revision-1', () => {
    const item = workItems.createDraft({ graphId: 'g1', title: '任务', scopeFiles: ['src/a.ts', 'src/b.ts'] })
    const { run } = runSvc.enqueue({ workItemId: item.id, executorKind: 'agent' })
    runSvc.claim(run.id)
    runSvc.complete(run.id, { resultSummary: 'ok' })

    const row = repo.recordForRun({
      workRunId: run.id,
      derivationVersion: '1',
      observedRuleVersion: 'cfg-hash-1',
      taskType: 'feature.dev',
      agentType: 'claude-code',
    })
    expect(row.planned_file_count).toBe(2)
    expect(row.actual_file_count).toBeNull() // change_sets 未采集 → NULL 不写 0
    expect(row.replan_count).toBe(0)
    expect(row.derivation_version).toBe('1')

    // 修订一次 → replan_count=1
    const revised = workItems.revise(item.id, { title: '任务 v2' })
    expect(revised.revision).toBe(2)
    const row2 = repo.recordForRun({
      workRunId: run.id,
      derivationVersion: '1',
      observedRuleVersion: 'cfg-hash-1',
      taskType: 'feature.dev',
    })
    expect(row2.replan_count).toBe(1)
  })

  it('change_set 已采集 → actual 取文件数;boundary_changed 自动判定', () => {
    const item = workItems.createDraft({ graphId: 'g1', title: '任务', scopeFiles: ['src/a.ts'] })
    const { run } = runSvc.enqueue({ workItemId: item.id, executorKind: 'agent' })
    runSvc.claim(run.id)
    db.prepare(
      `INSERT INTO change_sets (id, project_path, work_run_id, base_commit, files_json, file_count, captured_at)
       VALUES ('cs1', '/p', ?, 'base', ?, 1, 0)`,
    ).run(run.id, JSON.stringify([{ path: 'src/other.ts', change: 'modified', additions: 1, deletions: 0 }]))
    runSvc.complete(run.id)

    const row = repo.recordForRun({
      workRunId: run.id,
      derivationVersion: '1',
      observedRuleVersion: 'cfg',
      taskType: 'feature.dev',
    })
    expect(row.actual_file_count).toBe(1)
    expect(row.boundary_changed).toBe(1) // 实际变更不在计划范围内
  })
})
