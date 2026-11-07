/**
 * S5a 编排步状态机回归（session-map 蓝图 §4.7.4）。
 *
 * 覆盖：planning→pending 随任务确认激活、pending/waiting_approval→running、
 * running→succeeded/review/needs_input、review→succeeded、running→failed/timed_out、
 * pending→skipped、任一非终态→cancelled、needs_input 同事务写 input_request_json、
 * 恢复 attempt+1 且旧 run 未终态时拒绝、终态不可回退（条件更新 CONFLICT）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import { WorkItemService } from '../map/work-item-service'
import { WorkRunService } from '../map/work-run-service'
import {
  WorkStepService,
  WorkStepConflictError,
  WorkStepGuardError,
} from '../map/work-step-service'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  return db
}

describe('WorkStepService（§4.7.4 状态迁移）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let itemId: string
  let stepId: string

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    itemId = items.createDraft({ graphId: 'g1', title: '修复登录超时' }).id
    stepId = steps.listByItem(itemId, 1)[0].id
  })

  function confirmItem(): void {
    items.submitForConfirm(itemId)
    items.setGateResult(itemId, 'pass')
    items.confirm(itemId)
  }

  it('confirm 同事务把 planning 激活为 pending；gate 未过时不激活', () => {
    expect(steps.get(stepId)!.status).toBe('planning')
    items.submitForConfirm(itemId)
    expect(() => items.confirm(itemId)).toThrow()
    expect(steps.get(stepId)!.status).toBe('planning')

    items.setGateResult(itemId, 'pass')
    items.confirm(itemId)
    expect(steps.get(stepId)!.status).toBe('pending')
    // 幂等：再次激活只命中 planning，不改变已 pending 的步
    expect(steps.activatePlanningSteps(itemId, 1)).toBe(0)
  })

  it('pending → running → succeeded；终态不可回退', () => {
    confirmItem()
    const started = steps.start(stepId, { invocationId: 'inv-1', deadlineAt: 123 })
    expect(started).toMatchObject({ status: 'running', invocation_id: 'inv-1', deadline_at: 123 })
    expect(started.started_at).not.toBeNull()

    const done = steps.complete(stepId, { status: 'succeeded' })
    expect(done.status).toBe('succeeded')
    expect(done.ended_at).not.toBeNull()

    expect(() => steps.start(stepId)).toThrow(WorkStepConflictError)
    expect(() => steps.cancel(stepId)).toThrow(WorkStepConflictError)
  })

  it('需审批：pending → waiting_approval → running；批准回调幂等失败返回 CONFLICT', () => {
    confirmItem()
    const waiting = steps.awaitApproval(stepId)
    expect(waiting.status).toBe('waiting_approval')
    expect(() => steps.awaitApproval(stepId)).toThrow(WorkStepConflictError)

    expect(steps.start(stepId).status).toBe('running')
  })

  it('running → needs_input 同事务写 input_request_json；回复后 pending 且 attempt+1', () => {
    confirmItem()
    steps.start(stepId)
    const req = JSON.stringify({ type: 'choice', question: '用哪个方案?' })
    const row = steps.complete(stepId, { status: 'needs_input', inputRequestJson: req })
    expect(row.status).toBe('needs_input')
    expect(row.input_request_json).toBe(req)
    expect(row.attempt).toBe(1)

    expect(() => steps.complete(stepId, { status: 'needs_input', inputRequestJson: '  ' })).toThrow(
      WorkStepGuardError,
    )

    const resumed = steps.resume(stepId)
    expect(resumed.status).toBe('pending')
    expect(resumed.attempt).toBe(2)
    expect(resumed.invocation_id).toBeNull()
    expect(resumed.deadline_at).toBeNull()
  })

  it('恢复守卫：最新 run 未终态时拒绝（RUN_NOT_TERMINAL）', () => {
    confirmItem()
    steps.start(stepId)
    const { run } = runs.enqueue({ workItemId: itemId, stepId, executorKind: 'agent' })
    runs.claim(run.id)

    expect(() => steps.resume(stepId)).toThrow(WorkStepGuardError)

    runs.fail(run.id, { failureClass: 'infra' })
    steps.pause(stepId)
    expect(steps.resume(stepId).status).toBe('pending')
  })

  it('running → review → succeeded；running → failed / timed_out', () => {
    confirmItem()
    steps.start(stepId)
    expect(steps.complete(stepId, { status: 'review' }).status).toBe('review')
    expect(steps.complete(stepId, { status: 'succeeded' }).status).toBe('succeeded')

    for (const target of ['failed', 'timed_out'] as const) {
      const id = items.createDraft({ graphId: 'g1', title: `任务-${target}` }).id
      const sid = steps.listByItem(id, 1)[0].id
      items.submitForConfirm(id)
      items.setGateResult(id, 'pass')
      items.confirm(id)
      steps.start(sid)
      expect(steps.fail(sid, { status: target }).status).toBe(target)
    }
  })

  it('pending → skipped；任一非终态 → cancelled；终态取消返回 CONFLICT', () => {
    confirmItem()
    expect(steps.skip(stepId).status).toBe('skipped')
    expect(() => steps.cancel(stepId)).toThrow(WorkStepConflictError)

    const other = items.createDraft({ graphId: 'g1', title: '可取消任务' }).id
    const otherStep = steps.listByItem(other, 1)[0].id
    items.submitForConfirm(other)
    items.setGateResult(other, 'pass')
    items.confirm(other)
    steps.start(otherStep)
    expect(steps.cancel(otherStep).status).toBe('cancelled')
  })
})
