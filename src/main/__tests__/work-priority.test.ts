/**
 * v36 / W3 G3-4：work_items.priority 调度排序回归。
 *
 * 口径：`queued` 优先不变 → priority 大者先 → priority NULL 最后 →
 * created_at ASC。未设置 priority 的存量队列行为与旧序一致。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import { WorkItemService } from '../map/work-item-service'
import { WorkStepService } from '../map/work-step-service'
import { WorkScheduler } from '../map/work-scheduler'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  return db
}

describe('work_items.priority（v36 / G3-4）', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let steps: WorkStepService
  let scheduler: WorkScheduler

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    steps = new WorkStepService(db)
    scheduler = new WorkScheduler(db)
  })

  function confirmedItem(title: string): string {
    const id = items.createDraft({ graphId: 'g1', projectPath: '/p/a', title }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    return id
  }

  it('priority 大者先；NULL 排最后；未设置时与旧序一致', () => {
    const first = confirmedItem('旧任务 A')
    db.prepare("UPDATE work_items SET priority = 3 WHERE id = ?").run(first)
    const second = confirmedItem('旧任务 B')
    db.prepare("UPDATE work_items SET priority = 9 WHERE id = ?").run(second)
    const third = confirmedItem('无优先级 C')

    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(second)
    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(first)
    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(third)
  })

  it('priority 全为 NULL 时按 created_at ASC（升级后存量行为不变）', () => {
    const a = confirmedItem('A')
    const b = confirmedItem('B')
    const c = confirmedItem('C')
    db.prepare("UPDATE work_items SET created_at = '2026-01-01T00:00:03.000Z' WHERE id = ?").run(a)
    db.prepare("UPDATE work_items SET created_at = '2026-01-01T00:00:01.000Z' WHERE id = ?").run(b)
    db.prepare("UPDATE work_items SET created_at = '2026-01-01T00:00:02.000Z' WHERE id = ?").run(c)

    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(b)
    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(c)
    expect(scheduler.claimNext({ projectPath: '/p/a' })!.item.id).toBe(a)
  })

  it('priority 不影响同一任务内的步序（仍按 seq）', () => {
    const id = items.createDraft({
      graphId: 'g1',
      projectPath: '/p/a',
      title: '多步任务',
      steps: [{ title: '第一步' }, { title: '第二步' }],
    }).id
    items.submitForConfirm(id)
    items.setGateResult(id, 'pass')
    items.confirm(id)
    db.prepare('UPDATE work_items SET priority = 100 WHERE id = ?').run(id)

    const stepIds = steps.listByItem(id, 1).map((step) => step.id)
    const claimed = scheduler.claimNext({ projectPath: '/p/a' })!
    expect(claimed.step.id).toBe(stepIds[0])
  })
})
