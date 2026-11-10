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
  WORK_STEP_STATUSES,
  WORK_STEP_TERMINAL,
  WORK_STEP_TRANSITIONS,
  canTransitionStepStatus,
  type WorkStepChangeEvent,
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
      const failureClass = target === 'timed_out' ? 'timeout' : 'turn_fail'
      expect(steps.fail(sid, { status: target, failureClass }).status).toBe(target)
      expect(steps.get(sid)!.failure_class).toBe(failureClass)
    }
  })

  it('pending → skipped；任一非终态 → cancelled；终态取消返回 CONFLICT', () => {
    confirmItem()
    expect(steps.skip(stepId, 'human').status).toBe('skipped')
    expect(steps.get(stepId)!.skip_reason).toBe('human')
    expect(() => steps.cancel(stepId)).toThrow(WorkStepConflictError)

    const other = items.createDraft({ graphId: 'g1', title: '可取消任务' }).id
    const otherStep = steps.listByItem(other, 1)[0].id
    items.submitForConfirm(other)
    items.setGateResult(other, 'pass')
    items.confirm(other)
    steps.start(otherStep)
    expect(steps.cancel(otherStep).status).toBe('cancelled')
  })

  describe('G2-18 声明式迁移表（12 值）', () => {
    it('状态集合与迁移表键精确一致；终态零出边', () => {
      expect(WORK_STEP_STATUSES).toHaveLength(12)
      expect(Object.keys(WORK_STEP_TRANSITIONS).sort()).toEqual([...WORK_STEP_STATUSES].sort())
      for (const status of WORK_STEP_STATUSES) {
        const declared = WORK_STEP_TRANSITIONS[status]
        if (WORK_STEP_TERMINAL.includes(status)) {
          expect(declared, `${status} 是终态`).toEqual([])
        } else {
          expect(declared.length, `${status} 必须有出边`).toBeGreaterThan(0)
        }
        // 出边只能指向声明过的状态，禁止拼写/幽灵状态。
        for (const to of declared) expect(WORK_STEP_STATUSES).toContain(to)
      }
    })

    it('迁移表快照：改表必须撞测试', () => {
      expect(WORK_STEP_TRANSITIONS).toEqual({
        planning: ['pending', 'failed', 'cancelled'],
        pending: ['waiting_approval', 'running', 'skipped', 'failed', 'cancelled', 'paused'],
        waiting_approval: ['running', 'timed_out', 'cancelled', 'pending'],
        running: ['review', 'succeeded', 'failed', 'timed_out', 'needs_input', 'paused', 'cancelled'],
        review: ['succeeded', 'needs_input', 'paused', 'cancelled'],
        needs_input: ['pending', 'succeeded', 'failed', 'cancelled'],
        paused: ['pending', 'cancelled'],
        succeeded: [],
        failed: [],
        timed_out: [],
        cancelled: [],
        skipped: [],
      })
    })

    it('canTransitionStepStatus 与表一致（非法迁移一律 false）', () => {
      expect(canTransitionStepStatus('pending', 'running')).toBe(true)
      expect(canTransitionStepStatus('waiting_approval', 'timed_out')).toBe(true)
      expect(canTransitionStepStatus('review', 'failed')).toBe(false)
      expect(canTransitionStepStatus('succeeded', 'pending')).toBe(false)
    })

    it('waiting_approval → timed_out 已补齐；waiting_approval 不接 failed', () => {
      confirmItem()
      steps.awaitApproval(stepId)
      expect(steps.fail(stepId, { status: 'timed_out', failureClass: 'timeout' }).status).toBe(
        'timed_out',
      )

      const other = items.createDraft({ graphId: 'g1', title: '审批等待任务' }).id
      const otherStep = steps.listByItem(other, 1)[0].id
      items.submitForConfirm(other)
      items.setGateResult(other, 'pass')
      items.confirm(other)
      steps.awaitApproval(otherStep)
      expect(() => steps.fail(otherStep, { status: 'failed', failureClass: 'infra' })).toThrow(
        WorkStepConflictError,
      )
      expect(steps.get(otherStep)!.status).toBe('waiting_approval')
    })

    it('G2-10：确认通过/驳回返工走 waiting_approval → pending，确认契约写入 input_request_json', () => {
      confirmItem()
      const request = JSON.stringify({ kind: 'step_confirmation', point: 'C4' })
      expect(steps.awaitApproval(stepId, request).input_request_json).toBe(request)

      // 通过：清空确认契约
      expect(steps.returnToPending(stepId, null).status).toBe('pending')
      expect(steps.get(stepId)!.input_request_json).toBeNull()

      // 驳回返工：保留返工标记
      steps.awaitApproval(stepId, request)
      const rejection = JSON.stringify({ kind: 'step_confirmation', decision: 'reject' })
      const pending = steps.returnToPending(stepId, rejection)
      expect(pending.status).toBe('pending')
      expect(pending.input_request_json).toBe(rejection)
    })

    it('review → failed 未声明（当前无生产写入方，不为死状态加迁移）', () => {
      confirmItem()
      steps.start(stepId)
      steps.complete(stepId, { status: 'review' })
      expect(() => steps.fail(stepId, { status: 'failed', failureClass: 'turn_fail' })).toThrow(
        WorkStepConflictError,
      )
      expect(steps.get(stepId)!.status).toBe('review')
    })
  })

  describe('G2-18 步级迁移事件', () => {
    it('每次成功迁移回调一次，status 与库内一致；失败迁移不回调', () => {
      confirmItem()
      const events: Array<WorkStepChangeEvent & { rowStatus: string }> = []
      const svc = new WorkStepService(db, {
        onChanged: (event) => {
          events.push({ ...event, rowStatus: svc.get(event.stepId)!.status })
        },
      })

      svc.start(stepId)
      svc.complete(stepId, { status: 'succeeded' })
      expect(() => svc.start(stepId)).toThrow(WorkStepConflictError)

      expect(events.map((e) => e.status)).toEqual(['running', 'succeeded'])
      expect(events.every((e) => e.stepId === stepId && e.workItemId === itemId && e.revision === 1)).toBe(
        true,
      )
      expect(events.every((e) => e.status === e.rowStatus)).toBe(true)
      // 失败迁移（终态回退）不得产生事件。
      expect(events).toHaveLength(2)
    })

    it('blocked_by_dependency 与 settleNeedsInput 也走同一事件出口', () => {
      confirmItem()
      const events: WorkStepChangeEvent[] = []
      const svc = new WorkStepService(db, { onChanged: (event) => events.push(event) })

      const blocked = svc.failUnstarted(stepId)
      expect(blocked?.failure_class).toBe('blocked_by_dependency')
      expect(events.at(-1)).toMatchObject({ status: 'failed', stepId })

      const other = items.createDraft({ graphId: 'g1', title: '验收收口任务' }).id
      const otherStep = svc.listByItem(other, 1)[0].id
      items.submitForConfirm(other)
      items.setGateResult(other, 'pass')
      items.confirm(other)
      svc.start(otherStep)
      svc.complete(otherStep, {
        status: 'needs_input',
        inputRequestJson: JSON.stringify({ kind: 'acceptance_manual_confirm', entries: [] }),
      })
      svc.settleNeedsInput(otherStep, { status: 'succeeded' })
      expect(events.at(-1)).toMatchObject({ status: 'succeeded', stepId: otherStep })
    })

    it('回调抛错不影响已落库的迁移', () => {
      confirmItem()
      const svc = new WorkStepService(db, {
        onChanged: () => {
          throw new Error('listener boom')
        },
      })
      expect(svc.start(stepId).status).toBe('running')
      expect(svc.get(stepId)!.status).toBe('running')
    })
  })
})
