/**
 * M2 调度入口回归（§5.9 tick 第 1–6 步）。
 *
 * 覆盖：claimNext 领取首个就绪步、item queued→running、run 幂等绑定；
 * 依赖（succeeded/skipped 放行，failed/未终态阻断）；gate 只读复核；
 * 崩溃残留 run 复用；既有终态 run 拒绝；projectPath 过滤；重复领取返回 null。
 * 不驱动 Agent、不接 IPC。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import { WorkItemService } from '../map/work-item-service'
import { WorkStepService } from '../map/work-step-service'
import { WorkRunService } from '../map/work-run-service'
import { WorkScheduler, WorkSchedulerGuardError } from '../map/work-scheduler'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  return db
}

describe('WorkScheduler（claimNext + startStep）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let scheduler: WorkScheduler

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    scheduler = new WorkScheduler(db)
  })

  function confirmedItem(opts: { projectPath?: string; steps?: Array<{ title: string }> } = {}): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: opts.projectPath ?? '/p/a',
      title: '任务',
      steps: opts.steps,
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  it('claimNext 领取首个就绪步：item queued→running，run 与 step 同时 running；重复领取返回 null', () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id

    const claimed = scheduler.claimNext({ projectPath: '/p/a' })
    expect(claimed).not.toBeNull()
    expect(claimed!.item.id).toBe(itemId)
    expect(claimed!.item.status).toBe('running')
    expect(claimed!.step.status).toBe('running')
    expect(claimed!.run.status).toBe('running')
    expect(claimed!.run.step_id).toBe(stepId)
    expect(claimed!.run.attempt).toBe(1)
    expect(claimed!.reused).toBe(false)

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
  })

  it('依赖未满足时阻断；前一步 succeeded 后放行', () => {
    const itemId = confirmedItem({ steps: [{ title: 'a' }, { title: 'b' }] })
    const [a, b] = steps.listByItem(itemId, 1)
    db.prepare('UPDATE work_steps SET depends_on_step_ids_json = ? WHERE id = ?').run(
      JSON.stringify([a.id]),
      b.id,
    )

    const first = scheduler.claimNext({ projectPath: '/p/a' })!
    expect(first.step.id).toBe(a.id)
    steps.complete(a.id, { status: 'succeeded' })
    runs.complete(first.run.id)

    const second = scheduler.claimNext({ projectPath: '/p/a' })!
    expect(second.step.id).toBe(b.id)
    expect(second.run.attempt).toBe(1)
  })

  it('依赖为 skipped 也放行；依赖 failed 则整条不可领取', () => {
    const itemId = confirmedItem({ steps: [{ title: 'a' }, { title: 'b' }] })
    const [a, b] = steps.listByItem(itemId, 1)
    db.prepare('UPDATE work_steps SET depends_on_step_ids_json = ? WHERE id = ?').run(
      JSON.stringify([a.id]),
      b.id,
    )
    steps.skip(a.id, 'optional_not_required')
    expect(scheduler.claimNext({ projectPath: '/p/a' })!.step.id).toBe(b.id)

    const other = confirmedItem({ steps: [{ title: 'c' }, { title: 'd' }] })
    const [c, d] = steps.listByItem(other, 1)
    db.prepare('UPDATE work_steps SET depends_on_step_ids_json = ? WHERE id = ?').run(
      JSON.stringify([c.id]),
      d.id,
    )
    steps.start(c.id)
    steps.fail(c.id, { status: 'failed', failureClass: 'turn_fail' })
    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
  })

  it('gate 只复核已落库值：非 pass/waived 不领取，startStep 抛 GATE_NOT_PASSED', () => {
    const itemId = confirmedItem()
    db.prepare("UPDATE work_items SET gate_status = 'incomplete' WHERE id = ?").run(itemId)
    const stepId = steps.listByItem(itemId, 1)[0].id

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(() => scheduler.startStep(stepId)).toThrow(WorkSchedulerGuardError)
    try {
      scheduler.startStep(stepId)
    } catch (error) {
      expect((error as WorkSchedulerGuardError).code).toBe('GATE_NOT_PASSED')
    }
  })

  it('崩溃恢复：既有 running run + 步仍 pending → 复用原 run，不新建', () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const { run } = runs.enqueue({ workItemId: itemId, stepId, executorKind: 'agent' })
    runs.claim(run.id)

    const claimed = scheduler.startStep(stepId)
    expect(claimed.reused).toBe(true)
    expect(claimed.run.id).toBe(run.id)
    expect(claimed.step.status).toBe('running')
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_runs WHERE step_id = ?').get(stepId)).toEqual({ n: 1 })
  })

  it('既有 run 已终态而步仍 pending → RUN_TERMINAL（不得静默新建）', () => {
    const itemId = confirmedItem()
    const stepId = steps.listByItem(itemId, 1)[0].id
    const { run } = runs.enqueue({ workItemId: itemId, stepId, executorKind: 'agent' })
    runs.claim(run.id)
    runs.fail(run.id, { failureClass: 'infra' })

    try {
      scheduler.startStep(stepId)
      throw new Error('应当抛 RUN_TERMINAL')
    } catch (error) {
      expect((error as WorkSchedulerGuardError).code).toBe('RUN_TERMINAL')
    }
  })

  it('projectPath 过滤：只领取指定项目', () => {
    const a = confirmedItem({ projectPath: '/p/a' })
    const b = confirmedItem({ projectPath: '/p/b' })

    expect(scheduler.claimNext({ projectPath: '/p/b' })!.item.id).toBe(b)
    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(a)
  })
})
