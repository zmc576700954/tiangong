/**
 * manual 验收人工确认（§M5.11 / v35）：确认事实落 acceptance_confirmations
 * + 重算验收 + 状态收口；agent_approvals 不再出现非工具审批行。
 *
 * 覆盖：manual-only 确认通过；部分确认继续等待；确认后硬失败落 verify_fail；
 * 只给 itemId 定位等待步；未知条目拒绝；重复确认拒绝。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapAcceptanceSchema, LEGACY_ACCEPTANCE_APPROVAL_TOOL } from '../map/schema'
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
    applyAgentSchema(db)
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

  function createItem(projectPath: string, acceptance: Array<Record<string, unknown>>): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath,
      anchorNodeId: 'node-1',
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
})
