/**
 * M4 item 级终态聚合（§5.5.1 / §4.7.2）。
 *
 * 关键区分：
 * - 没有就绪步 + 仍有非终态步 → **等**（item 保持 running/queued）；
 * - 没有就绪步 + 当前 revision 全部步终态 → **收敛**（done / failed / cancelled）。
 *
 * 规则优先级：≥1 failed/timed_out → failed；否则有 cancelled → cancelled；
 * 否则全 succeeded/skipped → done。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import { WorkItemService } from '../map/work-item-service'
import { WorkStepService } from '../map/work-step-service'
import { WorkRunService } from '../map/work-run-service'
import { WorkScheduler, type ClaimedStep } from '../map/work-scheduler'

describe('work_item 终态聚合（M4）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let runs: WorkRunService
  let scheduler: WorkScheduler

  beforeEach(() => {
    db = new Database(':memory:') as unknown as BetterSqlite3.Database
    applyMapS5aSchema(db)
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    runs = new WorkRunService(db)
    scheduler = new WorkScheduler(db)
  })

  function confirmedItem(opts: { title?: string; steps?: Array<{ title: string }> } = {}): string {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      title: opts.title ?? '任务',
      steps: opts.steps ?? [{ title: 'a' }, { title: 'b' }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  /** 让 b 依赖 a（claimNext 会先给 a、后给 b）。 */
  function dependOn(itemId: string, needed: number, dep: number): void {
    const list = steps.listByItem(itemId, 1)
    db.prepare('UPDATE work_steps SET depends_on_step_ids_json = ? WHERE id = ?').run(
      JSON.stringify([list[dep].id]),
      list[needed].id,
    )
  }

  function claim(): ClaimedStep {
    const c = scheduler.claimNext({ projectPath: '/p/a' })
    expect(c).not.toBeNull()
    return c!
  }

  function succeed(c: ClaimedStep): void {
    steps.complete(c.step.id, { status: 'succeeded' })
    runs.complete(c.run.id)
  }

  function fail(c: ClaimedStep, status: 'failed' | 'timed_out' = 'failed'): void {
    steps.fail(c.step.id, { status })
    if (status === 'timed_out') runs.timeout(c.run.id)
    else runs.fail(c.run.id, { failureClass: 'turn_fail' })
  }

  function cancel(c: ClaimedStep): void {
    steps.cancel(c.step.id)
    runs.cancel(c.run.id, 'user')
  }

  it('全部 succeeded → item done；收敛后重复调用保持终态', () => {
    const itemId = confirmedItem()
    dependOn(itemId, 1, 0)

    succeed(claim())
    const second = claim()
    expect(second.step.id).toBe(steps.listByItem(itemId, 1)[1].id)
    succeed(second)

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('done')
    // 幂等：再次调用不修改终态，也不抛错。
    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('done')
  })

  it('queued 且全部步 skipped → 仍收敛为 done', () => {
    const itemId = confirmedItem({ steps: [{ title: 'a' }] })
    const [a] = steps.listByItem(itemId, 1)
    expect(items.get(itemId)!.status).toBe('queued')
    steps.skip(a.id)

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('done')
  })

  it('≥1 failed（其余成功）→ item failed', () => {
    const itemId = confirmedItem()
    fail(claim())
    succeed(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('failed')
  })

  it('≥1 timed_out → item failed（timed_out 与 failed 同等优先）', () => {
    const itemId = confirmedItem()
    fail(claim(), 'timed_out')
    succeed(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('failed')
  })

  it('全部 cancelled → item cancelled', () => {
    const itemId = confirmedItem()
    cancel(claim())
    cancel(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('cancelled')
  })

  it('成功 + 取消混合（无失败）→ item cancelled（§5.5.1 partial_cancel 口径）', () => {
    const itemId = confirmedItem()
    succeed(claim())
    cancel(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('cancelled')
  })

  it('失败 + 取消混合 → item failed（失败优先于取消）', () => {
    const itemId = confirmedItem()
    fail(claim())
    cancel(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('failed')
  })

  it('单级阻断：a 失败 → b 级联 failed，item 正常收敛为 failed', () => {
    const itemId = confirmedItem()
    dependOn(itemId, 1, 0)

    fail(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    const list = steps.listByItem(itemId, 1)
    expect(list[1].status).toBe('failed')
    expect(items.get(itemId)!.status).toBe('failed')
  })

  it('多级传递：a 失败 → b、c 依次级联 failed，item 收敛', () => {
    const itemId = confirmedItem({ steps: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] })
    dependOn(itemId, 1, 0) // b 依赖 a
    dependOn(itemId, 2, 1) // c 依赖 b

    fail(claim())

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    const list = steps.listByItem(itemId, 1)
    expect(list[1].status).toBe('failed')
    expect(list[2].status).toBe('failed')
    expect(items.get(itemId)!.status).toBe('failed')
  })

  it('已 running 的下游不被级联改写；item 继续等该步', () => {
    // x 独立且先启动；r 独立失败；m 依赖 r。
    const itemId = confirmedItem({ steps: [{ title: 'x' }, { title: 'r' }, { title: 'm' }] })
    dependOn(itemId, 2, 1)

    const x = claim()
    expect(x.step.title).toBe('x')
    expect(x.step.status).toBe('running')

    const r = claim()
    expect(r.step.title).toBe('r')
    fail(r)

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    const list = steps.listByItem(itemId, 1)
    expect(list[0].status).toBe('running') // 已 started，保持不动
    expect(list[2].status).toBe('failed') // 未 started，被阻断
    expect(items.get(itemId)!.status).toBe('running') // 还有 running 步 → 等
  })

  it('一步 running（执行中）→ 等，不收敛', () => {
    const itemId = confirmedItem({ steps: [{ title: 'a' }] })
    expect(claim().step.status).toBe('running')

    expect(scheduler.claimNext({ projectPath: '/p/a' })).toBeNull()
    expect(items.get(itemId)!.status).toBe('running')
  })

  it('多 item：先收敛已全部终态的旧 item，仍返回另一 item 的就绪步', () => {
    const allTerminal = confirmedItem({ title: 'old', steps: [{ title: 'old-a' }] })
    db.prepare('UPDATE work_items SET created_at = ? WHERE id = ?').run(Date.now() - 10_000, allTerminal)
    const oldStep = steps.listByItem(allTerminal, 1)[0]
    steps.skip(oldStep.id)

    const runnable = confirmedItem({ title: 'new', steps: [{ title: 'new-a' }] })

    const claimed = claim()
    expect(claimed.item.id).toBe(runnable)
    expect(items.get(allTerminal)!.status).toBe('done')
  })
})
