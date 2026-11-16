/**
 * manual 验收人工确认（§M5.11 / v35）：确认事实落 acceptance_confirmations
 * + 重算验收 + 状态收口；agent_approvals 不再出现非工具审批行。
 *
 * 覆盖：manual-only 确认通过；部分确认继续等待；确认后硬失败落 verify_fail；
 * 只给 itemId 定位等待步；未知条目拒绝；重复确认拒绝。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapAcceptanceSchema, applyMapS6aSchema, LEGACY_ACCEPTANCE_APPROVAL_TOOL } from '../map/schema'
import { applyAgentSchema } from '../agent/runtime/db/schema'
import { WorkItemService } from '../map/work-item-service'
import { WorkStepService } from '../map/work-step-service'
import { WorkRunService } from '../map/work-run-service'
import { WorkScheduler } from '../map/work-scheduler'
import { AgentStepRunner, type AgentTurnRunner, type AgentTurnSignal } from '../map/agent-step-runner'
import { evaluateAcceptance } from '../map/acceptance-executor'
import {
  type AcceptanceConfirmationError,
  AcceptanceConfirmationService,
} from '../map/acceptance-confirmation'

class FakeTurns implements AgentTurnRunner {
  async startSession() {
    return { sessionId: 'sess-confirm', adapterUsed: 'claude-code' }
  }
  async runTurn(): Promise<AgentTurnSignal> {
    return { status: 'completed' }
  }
  async terminateSession(): Promise<void> {}
}

describe('AcceptanceConfirmationService', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let scheduler: WorkScheduler
  let runner: AgentStepRunner
  let confirmService: AcceptanceConfirmationService
  let roots: string[]

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    applyMapS5aSchema(db)
    applyMapAcceptanceSchema(db)
    applyMapS6aSchema(db)
    applyAgentSchema(db)
    // 证据端点解析依赖 nodes；建最小表并插入锚点节点。
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        graph_id TEXT NOT NULL, graph_type TEXT NOT NULL, entity_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    db.prepare(
      "INSERT INTO nodes (id, type, title, graph_id, graph_type, entity_key, created_at, updated_at) VALUES ('node-1', 'feature', '节点', 'g1', 'dev', 'key-1', 'x', 'x')",
    ).run()
    // 验收诊断复用该报告表；建表以便断言落库行为（缺表时模块应静默跳过）。
    db.exec(`
      CREATE TABLE map_migration_reports (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
        started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
        status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
      );
    `)
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    scheduler = new WorkScheduler(db)
    runner = new AgentStepRunner(db, new FakeTurns())
    confirmService = new AcceptanceConfirmationService(db)
    roots = []
  })

  afterEach(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  })

  function makeRoot(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'accept-confirm-'))
    roots.push(dir)
    return dir
  }

  function createItem(
    projectPath: string,
    acceptance: Array<Record<string, unknown>>,
    anchorEntityKey?: string,
  ): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath,
      anchorNodeId: 'node-1',
      anchorEntityKey,
      title: '验收任务',
      goal: '目标',
      scopeFiles: ['src/a.ts'],
      acceptance,
      steps: [{ title: '第一步', stepKind: 'agent', scopeFiles: ['src/a.ts'] }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  async function runToWaiting(projectPath: string) {
    const claimed = scheduler.claimNext({ projectPath, adapterName: 'claude-code' })
    expect(claimed).not.toBeNull()
    const result = await runner.run(claimed!, {
      adapterName: 'claude-code',
      verifyAcceptance: ({ acceptanceJson, projectPath: root }) =>
        evaluateAcceptance({ acceptanceJson, projectPath: root }),
    })
    expect(result.status).toBe('needs_input')
    return claimed!
  }

  function confirmationsFor(stepId: string) {
    return db
      .prepare('SELECT * FROM acceptance_confirmations WHERE step_id = ? ORDER BY created_at ASC, entry_id ASC')
      .all(stepId) as Array<{
      id: string
      batch_id: string
      work_item_id: string
      step_id: string
      entry_id: string
      decided_by: string
      decided_at: number
      decision_note: string | null
      source: string
      legacy_approval_id: string | null
    }>
  }

  function legacyApprovalRows() {
    return db
      .prepare('SELECT id FROM agent_approvals WHERE tool_name = ?')
      .all(LEGACY_ACCEPTANCE_APPROVAL_TOOL) as Array<{ id: string }>
  }

  it('manual-only：确认后步 succeeded、item done，并记录确认事实', async () => {
    const root = makeRoot()
    const itemId = createItem(root, [{ id: 'm1', type: 'manual', expected: '人工确认样式', text: '看截图' }])
    const claimed = await runToWaiting(root)
    expect(steps.get(claimed.step.id)?.status).toBe('needs_input')
    expect(items.get(itemId)?.status).toBe('needs_input')

    const result = await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m1'], note: '看过截图' })

    expect(result.stepStatus).toBe('succeeded')
    expect(result.itemStatus).toBe('done')
    expect(result.remainingEntryIds).toEqual([])
    expect(steps.get(claimed.step.id)?.status).toBe('succeeded')
    expect(items.get(itemId)?.status).toBe('done')
    expect(runs.get(claimed.run.id)?.status).toBe('completed')

    const rows = confirmationsFor(claimed.step.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].batch_id).toBe(result.confirmationBatchId)
    expect(rows[0].work_item_id).toBe(itemId)
    expect(rows[0].entry_id).toBe('m1')
    expect(rows[0].decided_by).toBe('user')
    expect(rows[0].decided_at).toBeTypeOf('number')
    expect(rows[0].source).toBe('user')
    expect(rows[0].legacy_approval_id).toBeNull()
    expect(rows[0].decision_note).toContain('看过截图')
    expect(result.confirmationIds).toEqual([rows[0].id])
    // agent_approvals 只承载工具审批：人工验收不得再写入非工具审批行。
    expect(legacyApprovalRows()).toHaveLength(0)

    // 验收诊断：turn 完成时一条 + 人工确认重算一条，逐条结果与来源可查。
    const evals = db
      .prepare('SELECT stats_json, details_json FROM map_migration_reports WHERE stage = ? ORDER BY id ASC')
      .all(`acceptance_eval:${claimed.step.id}`) as Array<{ stats_json: string; details_json: string }>
    expect(evals).toHaveLength(2)
    const sources = evals.map((row) => (JSON.parse(row.stats_json) as { source: string }).source)
    expect(sources).toEqual(['turn_completed', 'manual_confirmation'])
    const manualDetails = JSON.parse(evals[1].details_json) as { items: Array<{ id?: string; outcome: string }> }
    expect(manualDetails.items).toEqual([{ index: 0, id: 'm1', type: 'manual', required: true, outcome: 'pass', codes: [] }])
  })

  it('两个 manual：部分确认继续等待，剩余条目写回 input_request_json', async () => {
    const root = makeRoot()
    const itemId = createItem(root, [
      { id: 'm1', type: 'manual', expected: '确认 A' },
      { id: 'm2', type: 'manual', expected: '确认 B' },
    ])
    const claimed = await runToWaiting(root)

    const partial = await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m1'] })
    expect(partial.stepStatus).toBe('needs_input')
    expect(partial.itemStatus).toBe('needs_input')
    expect(partial.remainingEntryIds).toEqual(['m2'])
    expect(items.get(itemId)?.status).toBe('needs_input')
    const stepAfterPartial = steps.get(claimed.step.id)
    expect(stepAfterPartial?.status).toBe('needs_input')
    expect(stepAfterPartial?.input_request_json).toContain('"id":"m2"')
    expect(stepAfterPartial?.input_request_json).not.toContain('"id":"m1"')

    const done = await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m2'] })
    expect(done.stepStatus).toBe('succeeded')
    expect(done.itemStatus).toBe('done')
    expect(confirmationsFor(claimed.step.id)).toHaveLength(2)
    expect(legacyApprovalRows()).toHaveLength(0)
  })

  it('确认后重算仍有非 manual 硬失败 → verify_fail', async () => {
    const root = makeRoot()
    const flag = path.join(root, 'done.txt')
    writeFileSync(flag, 'ok')
    const itemId = createItem(root, [
      { id: 'c1', type: 'command', expected: 'test -f done.txt' },
      { id: 'm1', type: 'manual', expected: '人工确认' },
    ])
    const claimed = await runToWaiting(root)

    // 确认时命令已不再通过：重算必须落失败，而不是因人工确认就放行。
    rmSync(flag)
    const result = await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m1'] })

    expect(result.stepStatus).toBe('failed')
    expect(result.itemStatus).toBe('failed')
    expect(steps.get(claimed.step.id)?.status).toBe('failed')
    expect(steps.get(claimed.step.id)?.failure_class).toBe('verify_fail')
    expect(items.get(itemId)?.status).toBe('failed')
  })

  it('只给 workItemId：按条目匹配唯一等待步', async () => {
    const root = makeRoot()
    const itemId = createItem(root, [{ id: 'm1', type: 'manual', expected: '人工确认' }])
    const claimed = await runToWaiting(root)

    const result = await confirmService.confirm({ workItemId: itemId, entryIds: ['m1'] })

    expect(result.stepId).toBe(claimed.step.id)
    expect(result.stepStatus).toBe('succeeded')
    expect(items.get(itemId)?.status).toBe('done')
  })

  it('未知条目 → ENTRY_NOT_PENDING；已收口后重复确认 → STEP_NOT_WAITING', async () => {
    const root = makeRoot()
    createItem(root, [{ id: 'm1', type: 'manual', expected: '人工确认' }])
    const claimed = await runToWaiting(root)

    await expect(
      confirmService.confirm({ stepId: claimed.step.id, entryIds: ['nope'] }),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_PENDING' } satisfies Partial<AcceptanceConfirmationError>)

    await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m1'] })
    await expect(
      confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m1'] }),
    ).rejects.toMatchObject({ code: 'STEP_NOT_WAITING' } satisfies Partial<AcceptanceConfirmationError>)
    // 重复确认不得多写事实。
    expect(confirmationsFor(claimed.step.id)).toHaveLength(1)
    expect(legacyApprovalRows()).toHaveLength(0)
  })

  it('收口 → E4 human_confirm，current_hash 与产物文件实际 sha256 一致', async () => {
    const root = makeRoot()
    mkdirSync(path.join(root, 'out'))
    const artifact = 'artifact-v1'
    writeFileSync(path.join(root, 'out', 'result.txt'), artifact)
    createItem(
      root,
      [
        { id: 'm1', type: 'manual', expected: '人工确认样式' },
        { type: 'file_check', expected: 'out/result.txt' },
      ],
      'key-1',
    )
    const claimed = await runToWaiting(root)

    const result = await confirmService.confirm({
      stepId: claimed.step.id,
      entryIds: ['m1'],
      confirmedBy: 'alice',
    })
    expect(result.stepStatus).toBe('succeeded')

    const rows = db.prepare('SELECT * FROM node_evidence').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    const ev = rows[0]
    expect(ev['evidence_level']).toBe('E4')
    expect(ev['evidence_type']).toBe('human_confirm')
    expect(ev['version_binding']).toBe('none')
    expect(ev['code_version']).toBeNull()
    expect(ev['reproducible']).toBe(0)
    expect(ev['signed_by']).toBe('alice')
    expect(ev['signed_at']).toBeTypeOf('string')
    expect(ev['graph_id']).toBe('g1')
    expect(ev['node_entity_key']).toBe('key-1')
    expect(ev['work_run_id']).toBe(claimed.run.id)
    // 产物单文件：current_hash 必须直接等于该文件内容 sha256。
    const expectedHash = createHash('sha256').update(artifact).digest('hex')
    expect(ev['current_hash']).toBe(expectedHash)
    const coverage = JSON.parse(ev['coverage_json'] as string) as Array<{ acceptance_ids: string[]; files: string[] }>
    expect(coverage[0].acceptance_ids).toEqual(['m1'])
    expect(coverage[0].files).toEqual(['out/result.txt'])
    const basis = JSON.parse(ev['basis_ref_json'] as string) as Array<{ kind: string; ref: string; hash?: string }>
    expect(basis.find((r) => r.kind === 'file')).toEqual({
      kind: 'file',
      ref: 'out/result.txt',
      hash: expectedHash,
    })
  })

  it('部分确认不写 E4；最后一条收口才写一条覆盖全部条目的 E4', async () => {
    const root = makeRoot()
    createItem(
      root,
      [
        { id: 'm1', type: 'manual', expected: '确认 A' },
        { id: 'm2', type: 'manual', expected: '确认 B' },
      ],
      'key-1',
    )
    const claimed = await runToWaiting(root)

    const partial = await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m1'] })
    expect(partial.stepStatus).toBe('needs_input')
    expect(db.prepare('SELECT COUNT(*) AS n FROM node_evidence').get()).toEqual({ n: 0 })

    await confirmService.confirm({ stepId: claimed.step.id, entryIds: ['m2'], confirmedBy: 'bob' })
    const rows = db.prepare('SELECT * FROM node_evidence').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    const coverage = JSON.parse(rows[0]['coverage_json'] as string) as Array<{ acceptance_ids: string[] }>
    expect(coverage[0].acceptance_ids).toEqual(['m1', 'm2'])
    expect(rows[0]['signed_by']).toBe('bob')
  })
})
