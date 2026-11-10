/**
 * G2-10 步级确认闸（C3/C4）。
 *
 * 口径：只在 test/human 步上建闸；高风险线复用 G4（20 文件 / 800 行）；
 * approve 落 `acceptance_confirmations`（entry_id = 确认点），reject 因唯一索引
 * 不占位，改写 `input_request_json`；不新建表、不做 v50。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  applyMapAcceptanceSchema,
  applyMapS5aSchema,
  applyMapS6aSchema,
  applyMapS8Schema,
} from '../map/schema'
import { WorkItemService } from '../map/work-item-service'
import { StepConfirmationError, StepConfirmationService } from '../map/step-confirmation-service'
import { CONFIRMATION_POINTS } from '../map/confirmation-points'

function files(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/f${i}.ts`)
}

function displayFor(point: 'C3' | 'C4', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...Object.fromEntries(CONFIRMATION_POINTS[point].requiredDisplay.map((key) => [key, 'shown'])),
    ...overrides,
  }
}

describe('StepConfirmationService（G2-10 C3/C4）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let service: StepConfirmationService

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    applyMapS5aSchema(db)
    applyMapAcceptanceSchema(db)
    applyMapS6aSchema(db)
    applyMapS8Schema(db)
    items = new WorkItemService(db)
    service = new StepConfirmationService(db)
  })

  /** 建一个已确认（步已 pending）的任务，返回任务与按 seq 排列的步。 */
  function confirmedItem(
    steps: Array<{ title: string; stepKind: 'agent' | 'test' | 'human'; scopeFiles?: string[] }>,
    projectPath?: string,
  ): { itemId: string; stepIds: string[] } {
    const itemId = items.createDraft({ graphId: 'g1', title: '确认闸任务', projectPath, steps }).id
    items.submitForConfirm(itemId)
    items.setGateResult(itemId, 'pass')
    items.confirm(itemId)
    const stepIds = db
      .prepare('SELECT id FROM work_steps WHERE work_item_id = ? ORDER BY seq ASC')
      .all(itemId)
      .map((row) => (row as { id: string }).id)
    return { itemId, stepIds }
  }

  function statusOf(stepId: string): string {
    return (db.prepare('SELECT status FROM work_steps WHERE id = ?').get(stepId) as { status: string }).status
  }

  it('高风险 test 步：pending 时挂到 waiting_approval 并写 C3 契约', () => {
    const { stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
    ])
    expect(service.maybeGate(stepIds[0])).toBe(true)
    expect(statusOf(stepIds[0])).toBe('waiting_approval')

    const view = service.inspect(stepIds[0])!
    expect(view.point).toBe('C3')
    expect(view.risk?.level).toBe('high')
    expect(view.required).toBe(true)
    expect(view.waiting).toBe(true)
    expect(view.request?.kind).toBe('step_confirmation')
    expect(view.request?.point).toBe('C3')
    expect(view.request?.required_display).toEqual(CONFIRMATION_POINTS.C3.requiredDisplay)
  })

  it('低风险 test 步：不建闸（不把确认信号稀释成噪声）', () => {
    const { stepIds } = confirmedItem([
      { title: '跑小测试', stepKind: 'test', scopeFiles: files(2) },
    ])
    expect(service.maybeGate(stepIds[0])).toBe(false)
    expect(statusOf(stepIds[0])).toBe('pending')
    expect(service.inspect(stepIds[0])!.required).toBe(false)
  })

  it('human 步走 C4；agent 步没有计划期确认点', () => {
    const { stepIds } = confirmedItem([
      { title: '人工认定', stepKind: 'human', scopeFiles: files(20) },
      { title: '写代码', stepKind: 'agent', scopeFiles: files(20) },
    ])
    expect(service.maybeGate(stepIds[0])).toBe(true)
    expect(service.inspect(stepIds[0])!.point).toBe('C4')

    expect(service.maybeGate(stepIds[1])).toBe(false)
    const agentView = service.inspect(stepIds[1])!
    expect(agentView.point).toBeNull()
    expect(agentView.risk).toBeNull()
    expect(agentView.required).toBe(false)
  })

  it('行数代理达到 G4 线时同样判 high（与 gate 引擎同一个 estimator）', () => {
    const svc = new StepConfirmationService(db, { estimateLines: () => 800 })
    const { stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(1) },
    ])
    expect(svc.inspect(stepIds[0])!.risk?.level).toBe('high')
    expect(svc.maybeGate(stepIds[0])).toBe(true)
  })

  it('approve：落 acceptance_confirmations（entry_id=C3）并回 pending', () => {
    const { itemId, stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
    ])
    service.maybeGate(stepIds[0])
    const view = service.decide({
      stepId: stepIds[0],
      decision: 'approve',
      display: displayFor('C3'),
      note: '命令已核对',
      decidedBy: 'alice',
    })
    expect(view.status).toBe('pending')
    expect(view.decision).toMatchObject({ decision: 'approve', decidedBy: 'alice', risk: 'high' })
    expect(view.required).toBe(false)
    expect(view.request).toBeNull()

    const rows = db
      .prepare('SELECT * FROM acceptance_confirmations WHERE work_item_id = ? AND step_id = ?')
      .all(itemId, stepIds[0]) as Array<{ entry_id: string; source: string; decision_note: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].entry_id).toBe('C3')
    expect(rows[0].source).toBe('user')
    expect(JSON.parse(rows[0].decision_note)).toMatchObject({ decision: 'approve', point: 'C3' })
  })

  it('reject + C3：步落 cancelled，驳回事实写回 input_request_json（不占用唯一索引）', () => {
    const { itemId, stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
    ])
    service.maybeGate(stepIds[0])
    const view = service.decide({
      stepId: stepIds[0],
      decision: 'reject',
      display: displayFor('C3'),
      note: '测试范围不对',
      decidedBy: 'bob',
    })
    expect(view.status).toBe('cancelled')
    expect(view.decision).toMatchObject({ decision: 'reject', decidedBy: 'bob' })

    const confirmed = db
      .prepare('SELECT COUNT(*) AS n FROM acceptance_confirmations WHERE step_id = ?')
      .get(stepIds[0]) as { n: number }
    expect(confirmed.n).toBe(0)

    const row = db.prepare('SELECT input_request_json FROM work_steps WHERE id = ?').get(stepIds[0]) as {
      input_request_json: string
    }
    expect(JSON.parse(row.input_request_json)).toMatchObject({
      kind: 'step_confirmation',
      point: 'C3',
      decision: 'reject',
      decided_by: 'bob',
      note: '测试范围不对',
    })
    expect(itemId).toBeTruthy()
  })

  it('reject + C4：返工回 pending，驳回标记保留', () => {
    const { stepIds } = confirmedItem([
      { title: '人工认定', stepKind: 'human', scopeFiles: files(20) },
    ])
    service.maybeGate(stepIds[0])
    const view = service.decide({
      stepId: stepIds[0],
      decision: 'reject',
      display: displayFor('C4'),
    })
    expect(view.status).toBe('pending')
    expect(view.decision?.decision).toBe('reject')
    const row = db.prepare('SELECT input_request_json FROM work_steps WHERE id = ?').get(stepIds[0]) as {
      input_request_json: string
    }
    expect(JSON.parse(row.input_request_json)).toMatchObject({ decision: 'reject', point: 'C4' })
  })

  it('必填展示项缺失：拒绝确认，步停在闸上', () => {
    const { stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
    ])
    service.maybeGate(stepIds[0])
    expect(() =>
      service.decide({
        stepId: stepIds[0],
        decision: 'approve',
        display: displayFor('C3', { planHash: undefined }),
      }),
    ).toThrow(StepConfirmationError)
    expect(statusOf(stepIds[0])).toBe('waiting_approval')
  })

  function expectCode(fn: () => unknown, code: string): void {
    try {
      fn()
    } catch (err) {
      expect((err as { code?: string }).code).toBe(code)
      return
    }
    throw new Error(`应当抛出 ${code}`)
  }

  it('非法决策：不在闸上 / agent 步 / 重复决策都被显式拒绝', () => {
    const { stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
      { title: '写代码', stepKind: 'agent', scopeFiles: files(20) },
    ])

    expectCode(
      () => service.decide({ stepId: stepIds[0], decision: 'approve', display: displayFor('C3') }),
      'STEP_NOT_WAITING',
    )
    expectCode(
      () => service.decide({ stepId: stepIds[1], decision: 'approve', display: displayFor('C3') }),
      'NOT_STEP_CONFIRMATION',
    )

    service.maybeGate(stepIds[0])
    service.decide({ stepId: stepIds[0], decision: 'approve', display: displayFor('C3') })
    expectCode(
      () => service.decide({ stepId: stepIds[0], decision: 'approve', display: displayFor('C3') }),
      'STEP_NOT_WAITING',
    )

    expect(service.inspect('missing')).toBeNull()
    expect(service.listForItem('missing', 1)).toEqual([])
  })

  it('C3 展示投影：命令/cwd、worktree、策略、计划哈希与时长上限都来自真实计划', () => {
    const { itemId, stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
    ])
    db.prepare(
      `INSERT INTO test_plans (id, project_path, graph_id, work_item_id, node_keys_json,
         base_commit, worktree_path, plan_hash, status, created_at)
       VALUES ('tp1', '/p', 'g1', ?, '[]', 'base-1', '/p/.wt/1', 'hash-1', 'approved', 1)`,
    ).run(itemId)
    db.prepare(
      `INSERT INTO test_specs (id, project_path, test_node_entity_key, name, kind, command,
         timeout_ms, created_at, updated_at)
       VALUES ('ts1', '/p', 'node-1', '单测', 'unit', 'npx vitest run', 120000, 't', 't')`,
    ).run()
    db.prepare(
      `INSERT INTO test_plan_items (id, plan_id, spec_id, seq, command, cwd,
         policy_decision, status)
       VALUES ('i1', 'tp1', 'ts1', 1, 'npx vitest run', '.', 'allow', 'pending')`,
    ).run()

    service.maybeGate(stepIds[0])
    const display = service.inspect(stepIds[0])!.display

    expect(display.commands).toEqual([{ seq: 1, command: 'npx vitest run', cwd: '.' }])
    expect(display.worktree).toEqual({ path: '/p/.wt/1', baseCommit: 'base-1' })
    expect(display.policies).toEqual([{ seq: 1, decision: 'allow' }])
    expect(display.planHash).toBe('hash-1')
    expect(display.durationLimit).toEqual({ totalMs: 120000 })
    expect(display.affectedFiles).toEqual(files(20))
  })

  it('C3 没有测试计划时只投影影响文件，其余键缺失（渲染层据此禁用确认）', () => {
    const { stepIds } = confirmedItem([
      { title: '跑测试', stepKind: 'test', scopeFiles: files(20) },
    ])
    service.maybeGate(stepIds[0])
    const display = service.inspect(stepIds[0])!.display

    expect(display.affectedFiles).toEqual(files(20))
    expect(display.commands).toBeUndefined()
    expect(display.planHash).toBeUndefined()
  })

  it('C4 展示投影：执行状态、证据、stale、未满足验收、建议与人工状态差异', () => {
    const { itemId, stepIds } = confirmedItem([
      { title: '人工认定', stepKind: 'human', scopeFiles: files(20) },
    ])
    db.prepare(`UPDATE work_items SET anchor_entity_key = 'node-1' WHERE id = ?`).run(itemId)
    db.prepare(`UPDATE work_items SET acceptance_json = ? WHERE id = ?`).run(
      JSON.stringify([
        { id: 'a1', type: 'tests_pass', expected: '测试全绿' },
        { id: 'a2', type: 'manual', expected: '人工看过 diff' },
      ]),
      itemId,
    )
    db.prepare(
      `INSERT INTO node_execution_state (graph_id, node_entity_key, execution_state,
         evidence_level, evidence_count, stale_count, computed_at)
       VALUES ('g1', 'node-1', 'verified', 'E2', 2, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO node_evidence (id, graph_id, graph_type, node_entity_key, evidence_level,
         evidence_type, ref_json, summary, freshness, produced_by, work_item_id, created_at)
       VALUES ('ev1', 'g1', 'test', 'node-1', 'E2', 'test_run', '{}', '全绿', 'fresh', 'system', ?, 't')`,
    ).run(itemId)
    db.prepare(
      `INSERT INTO node_evidence (id, graph_id, graph_type, node_entity_key, evidence_level,
         evidence_type, ref_json, summary, freshness, produced_by, work_item_id, created_at)
       VALUES ('ev2', 'g1', 'test', 'node-1', 'E2', 'test_run', '{}', '旧结果', 'stale', 'system', ?, 't')`,
    ).run(itemId)
    db.prepare(
      `INSERT INTO acceptance_confirmations (id, work_item_id, step_id, entry_id, source,
         decision_note, decided_by, decided_at, batch_id, created_at)
       VALUES ('cf1', ?, ?, 'a1', 'user', null, 'alice', 1, 'b1', 't')`,
    ).run(itemId, stepIds[0])
    db.prepare(
      `INSERT INTO evidence_suggestions (id, graph_id, node_entity_key, suggested_level,
         evidence_type, ref_json, rationale, confidence, status, created_at)
       VALUES ('s1', 'g1', 'node-1', 'E3', 'commit', '{}', '建议补一次可复现运行', 0.8, 'pending', 't')`,
    ).run()

    service.maybeGate(stepIds[0])
    const display = service.inspect(stepIds[0])!.display

    expect(display.executionState).toEqual({
      state: 'verified',
      evidenceLevel: 'E2',
      evidenceCount: 2,
      staleCount: 1,
    })
    expect(display.evidence).toHaveLength(2)
    expect(display.staleEvidence).toEqual({ count: 1, items: [{ id: 'ev2', reason: '已过期' }] })
    expect(display.unmetAcceptance).toEqual({
      total: 2,
      items: [{ id: 'a2', type: 'manual', expected: '人工看过 diff' }],
    })
    expect(display.suggestions).toEqual({
      count: 1,
      items: [
        {
          id: 's1',
          level: 'E3',
          type: 'commit',
          rationale: '建议补一次可复现运行',
          confidence: 0.8,
        },
      ],
    })
    expect(display.statusDiff).toEqual({ humanStatus: null, derivedState: 'verified' })
  })
})
