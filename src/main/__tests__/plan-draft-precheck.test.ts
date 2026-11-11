/**
 * I.8.F P1：C1 草稿级预检投影。
 *
 * 口径：草稿 item 投影成合成 `WorkItemRow`，交给生产同一个 `createGateEngine`；
 * G5 显式跳过（草稿依赖是 plan key），缺失码不改写、不补充。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMapS5aSchema, applyMapS6aSchema, applyMapS7Schema } from '../map/schema'
import { PlanDraftService, itemKeys, type PlanDraftRow, type PlanItem } from '../map/plan-derivation'
import { WorkItemService } from '../map/work-item-service'
import { createGateEngine } from '../map/gate-engine'
import { buildC1Display, precheckDraftItems } from '../map/plan-draft-precheck'
import { assertConfirmationDisplay } from '../map/confirmation-points'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS6aSchema(db)
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
  `)
  const now = '2026-01-01T00:00:00Z'
  db.prepare(
    'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('g1', 'dev 图', 'dev', '/p', now, now)
  db.prepare(
    `INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key,
       position_x, position_y, created_at, updated_at)
     VALUES ('n1', 'dev', 'todo', '节点', 'g1', 'dev', 'node-1', 0, 0, ?, ?)`,
  ).run(now, now)
  return db
}

function acceptance(): Array<Record<string, unknown>> {
  return [{ type: 'manual', expected: '人工确认行为符合预期' }]
}

const tempDirs: string[] = []

describe('plan-draft-precheck（C1 预检投影）', () => {
  let db: BetterSqlite3.Database
  let drafts: PlanDraftService
  let projectPath: string
  let gate: ReturnType<typeof createGateEngine>

  beforeEach(() => {
    db = setupDb()
    drafts = new PlanDraftService(db, new WorkItemService(db))
    projectPath = mkdtempSync(join(tmpdir(), 'plan-precheck-'))
    tempDirs.push(projectPath)
    writeFileSync(join(projectPath, 'a.ts'), 'export const a = 1\n')
    gate = createGateEngine(db, { estimateLines: () => 100 })
  })

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })

  function create(items: PlanItem[]): PlanDraftRow {
    return drafts.createDraft({
      projectPath,
      graphId: 'g1',
      anchorEntityKey: 'node-1',
      anchorNodeId: 'n1',
      items,
    })
  }

  function precheck(row: PlanDraftRow, items: PlanItem[]) {
    return precheckDraftItems(row, items, itemKeys(items), gate)
  }

  it('复用生产 gate 引擎：缺写域给 scope_files_empty，合规条目 ok，G5 声明跳过', () => {
    const items: PlanItem[] = [
      { title: '空写域', goal: 'g', scopeFiles: [], acceptance: acceptance() },
      { title: '合规', goal: 'g', scopeFiles: ['a.ts'], acceptance: acceptance() },
    ]
    const result = precheck(create(items), items)

    expect(result.items).toEqual([
      { key: 'item-1', ok: false, missing: ['scope_files_empty'] },
      { key: 'item-2', ok: true, missing: [] },
    ])
    expect(result.missing).toEqual(['item-1: scope_files_empty'])
    // G5 不伪造通过：显式登记「未判定」及原因。
    expect(result.skipped).toEqual([
      {
        gate: 'G5',
        reason: '草稿依赖是 plan item key，不是 work_items.id；G5 与环检测在 confirm 后由执行侧 gate 判定',
      },
    ])
  })

  it('锚点缺失由同一引擎判出（G3 未复制判据）', () => {
    const items: PlanItem[] = [{ title: '无锚点', scopeFiles: ['a.ts'], acceptance: acceptance() }]
    const row = drafts.createDraft({ projectPath, graphId: 'g1', items })
    expect(precheck(row, items).items[0]).toEqual({
      key: 'item-1',
      ok: false,
      missing: ['anchor_node_missing'],
    })
  })

  it('C1 八项展示：全部为对象信封，能通过 assertConfirmationDisplay 且内容来自真实数据', () => {
    const items: PlanItem[] = [
      { title: '第一步', goal: '先做 A', scopeFiles: ['a.ts'], acceptance: acceptance(), dependsOn: ['item-2'] },
      // 第二步故意留空写域：预检应给出带条目定位的 G1 缺失码。
      { title: '第二步', scopeFiles: [], acceptance: acceptance() },
    ]
    const created = create(items)
    db.prepare(
      `UPDATE plan_drafts SET derivation_run_id = 'run-1', rejected_boundaries_json = ? WHERE id = ?`,
    ).run(JSON.stringify([{ entityKey: 'node-9', reason: '范围外' }, 'bad-entry']), created.id)
    const insertCandidate = db.prepare(
      `INSERT INTO boundary_candidates (id, derivation_run_id, derivation_version, graph_id,
         node_keys_json, files_json, score, confidence, status, created_at)
       VALUES (?, 'run-1', 'v1', 'g1', ?, '["a.ts"]', ?, ?, ?, 't')`,
    )
    insertCandidate.run('bc1', '["node-1","node-2"]', 0.91, 0.8, 'chosen')
    insertCandidate.run('bc2', '["node-3"]', 0.42, 0.3, 'proposed')
    db.prepare(
      `INSERT INTO node_execution_state (graph_id, node_entity_key, execution_state,
         evidence_level, evidence_count, stale_count, computed_at)
       VALUES ('g1', 'node-1', 'verified', 'E3', 4, 1, 1)`,
    ).run()

    const row = drafts.get(created.id)!
    const display = buildC1Display(db, row, items, itemKeys(items), precheck(row, items))

    expect(() => assertConfirmationDisplay('C1', display)).not.toThrow()
    expect(Object.keys(display).sort()).toEqual(
      ['acceptance', 'anchorStates', 'candidateScore', 'dependencies', 'excludedItems', 'gateMissing', 'scopeFiles', 'subtasks'].sort(),
    )

    expect(display.subtasks).toMatchObject({ count: 2 })
    expect(display.scopeFiles).toEqual({ count: 1, items: ['a.ts'] })
    expect(display.dependencies).toEqual({ count: 1, items: [{ from: 'item-1', to: 'item-2' }] })
    // 缺失项带条目定位；无缺失时仍是合法对象（不会被判成展示缺失）。
    expect(display.gateMissing).toMatchObject({
      count: 1,
      items: ['item-2: scope_files_empty'],
    })
    expect((display.gateMissing as { skippedGates: unknown }).skippedGates).toHaveLength(1)

    // 候选得分按 derivation_run_id 取整批，按分数降序。
    expect(display.candidateScore).toMatchObject({
      count: 2,
      derivationRunId: 'run-1',
      items: [
        { id: 'bc1', score: 0.91, confidence: 0.8, status: 'chosen' },
        { id: 'bc2', score: 0.42, confidence: 0.3, status: 'proposed' },
      ],
    })

    // 剔除项：可解析的 1 条 + 不可解析计数，不猜语义。
    expect(display.excludedItems).toEqual({
      count: 1,
      items: [{ entityKey: 'node-9', reason: '范围外' }],
      source: 'rejected_boundaries_json',
      unparsed: 1,
    })

    // 锚点状态：node-1 有派生行；候选里的 node-2 / node-3 没有 → 进 missing。
    expect(display.anchorStates).toMatchObject({
      count: 1,
      items: [
        {
          entityKey: 'node-1',
          executionState: 'verified',
          evidenceLevel: 'E3',
          evidenceCount: 4,
          staleCount: 1,
          computedAt: 1,
        },
      ],
      missing: ['node-2', 'node-3'],
    })
  })

  it('无推导批次/无锚点：仍产出合法对象，并如实注明来源为空', () => {
    const items: PlanItem[] = [{ title: '一步', scopeFiles: ['a.ts'], acceptance: acceptance() }]
    const created = create(items)
    const row = drafts.get(created.id)!
    const display = buildC1Display(db, row, items, itemKeys(items), precheck(row, items))

    expect(() => assertConfirmationDisplay('C1', display)).not.toThrow()
    expect(display.candidateScore).toEqual({
      count: 0,
      items: [],
      derivationRunId: null,
      note: '该草稿未关联推导批次（无 derivation_run_id）',
    })
    expect(display.excludedItems).toMatchObject({ count: 0, items: [], unparsed: 0 })
  })
})
