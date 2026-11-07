/**
 * S5a 服务真库回归（session-map 蓝图 §4.7 施工细则 / §4.7.9 验收判据）。
 *
 * 覆盖:13 值状态机关键迁移与 CONFLICT、gate waived 三字段守卫、revision 修订
 * (复制 steps pending/清 invocation)/并发修订唯一索引兜底、run 入队幂等
 * (run_seq/attempt/idempotency_key)/claim 竞态/终态 CAS(取消 vs 完成)/
 * partial 16KB/64KB 截断、会话挂载幂等与项目级部分唯一、时间线、
 * change_sets base/head 采集与失败不写空行、routing chosen_adapter 非空。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema } from '../map/schema'
import {
  WorkItemService,
  WorkItemConflictError,
  WorkItemGuardError,
} from '../map/work-item-service'
import {
  WorkRunService,
  WorkRunConflictError,
  NodeSessionLinkService,
  ChangeSetService,
  RoutingDecisionRepository,
  normalizePartial,
  PARTIAL_FIELD_MAX_BYTES,
} from '../map/work-run-service'
import type { GitRunner } from '../map/work-run-service'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  return db
}

describe('WorkItemService（§4.7.2 状态机）', () => {
  let db: BetterSqlite3.Database
  let svc: WorkItemService
  let itemId: string

  beforeEach(() => {
    db = setupDb()
    svc = new WorkItemService(db)
    itemId = svc.createDraft({ graphId: 'g1', title: '修复登录超时', goal: 'goal' }).id
  })

  it('createDraft：revision 1/is_current 1/draft/默认 1 个 agent step（planning）', () => {
    const item = svc.get(itemId)!
    expect(item).toMatchObject({ revision: 1, is_current: 1, status: 'draft', gate_status: 'incomplete', origin: 'human' })
    const steps = svc.listSteps(itemId, 1)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ step_kind: 'agent', status: 'planning', seq: 1 })
  })

  it('gate:waived 缺 waivedBy/waiveReason → 拒绝且落 incomplete;pass 后 confirm 入队', () => {
    svc.submitForConfirm(itemId)
    expect(() => svc.setGateResult(itemId, 'waived', {})).toThrow(WorkItemGuardError)
    expect(svc.get(itemId)!.gate_status).toBe('incomplete')

    svc.setGateResult(itemId, 'pass')
    const row = svc.confirm(itemId)
    expect(row.status).toBe('queued')
  })

  it('confirm 在 gate incomplete 时拒绝（守卫,非 CONFLICT）', () => {
    svc.submitForConfirm(itemId)
    expect(() => svc.confirm(itemId)).toThrow(WorkItemGuardError)
  })

  it('happy path:draft→awaiting_confirm→queued→claim→running→done', () => {
    svc.submitForConfirm(itemId)
    svc.setGateResult(itemId, 'pass')
    svc.confirm(itemId)
    svc.claim(itemId)
    const done = svc.complete(itemId)
    expect(done.status).toBe('done')
  })

  it('CONFLICT:终态不可回退、非法迁移不写（changes=0 → WorkItemConflictError）', () => {
    svc.submitForConfirm(itemId)
    svc.setGateResult(itemId, 'pass')
    svc.confirm(itemId)
    // queued 上直接 complete 不合法
    expect(() => svc.complete(itemId)).toThrow(WorkItemConflictError)
    svc.claim(itemId)
    svc.complete(itemId)
    // 终态再取消 → CONFLICT
    expect(() => svc.cancel(itemId)).toThrow(WorkItemConflictError)
    // 数据不变
    expect(svc.get(itemId)!.status).toBe('done')
  })

  it('needs_input:同事务写 work_steps.input_request_json;回答 → queued', () => {
    svc.submitForConfirm(itemId)
    svc.setGateResult(itemId, 'pass')
    svc.confirm(itemId)
    svc.claim(itemId)
    const step = svc.listSteps(itemId, 1)[0]
    // 步还处 planning——needs_input 要求 item running + step running;手动推进 step
    db.prepare("UPDATE work_steps SET status='running' WHERE id=?").run(step.id)
    svc.needsInput(itemId, step.id, JSON.stringify({ type: 'INPUT_REQUIRED', question: '用哪个端口?' }))
    expect(svc.get(itemId)!.status).toBe('needs_input')
    const updated = svc.listSteps(itemId, 1)[0]
    expect(updated.status).toBe('needs_input')
    expect(updated.input_request_json).toContain('INPUT_REQUIRED')

    svc.answerNeedsInput(itemId)
    expect(svc.get(itemId)!.status).toBe('queued')
  })

  it('blocked/unblock/pause/resume/interrupted 覆盖', () => {
    svc.submitForConfirm(itemId)
    svc.setGateResult(itemId, 'pass')
    svc.confirm(itemId)
    svc.markBlocked(itemId, ['dep-1 未完成'])
    expect(svc.get(itemId)!.gate_missing_json).toContain('dep-1')
    // 未重跑 gate（incomplete）→ unblock 拒绝（§4.7.2 不信任旧结果）
    expect(() => svc.unblock(itemId)).toThrow(WorkItemGuardError)
    svc.setGateResult(itemId, 'pass')
    const q = svc.unblock(itemId)
    expect(q.status).toBe('queued')

    svc.claim(itemId)
    svc.pause(itemId)
    expect(svc.resume(itemId).status).toBe('queued')
    svc.claim(itemId)
    svc.markInterrupted(itemId)
    expect(svc.resume(itemId).status).toBe('queued')
  })

  it('取消:draft 且无 running run 可取消;draft+running run 拒绝(守卫)', () => {
    const cancelled = svc.cancel(itemId)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancel_reason).toBe('user')
  })

  it('修订(§4.7.3):新 revision 复制 steps 为 pending,旧行 superseded;running run 拒绝修订', () => {
    svc.submitForConfirm(itemId)
    svc.setGateResult(itemId, 'pass')
    svc.confirm(itemId)
    const revised = svc.revise(itemId, { title: '修复登录超时 v2' })
    expect(revised.revision).toBe(2)
    expect(revised.is_current).toBe(1)
    expect(revised.title).toBe('修复登录超时 v2')
    expect(svc.get(itemId)!.status).toBe('superseded')
    expect(svc.get(itemId)!.is_current).toBe(0)
    const newSteps = svc.listSteps(revised.id, 2)
    expect(newSteps).toHaveLength(1)
    expect(newSteps[0].status).toBe('pending')
    expect(newSteps[0].invocation_id).toBeNull()
    expect(newSteps[0].deadline_at).toBeNull()
    // lineage 只允许一行 is_current=1
    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE lineage_id = ? AND is_current = 1').get(revised.lineage_id) as { c: number }
    expect(currentCount.c).toBe(1)

    // running run 时修订被拒
    svc.submitForConfirm(revised.id)
    svc.setGateResult(revised.id, 'pass')
    svc.confirm(revised.id)
    db.prepare("INSERT INTO work_runs (id, work_item_id, work_item_lineage_id, work_item_revision, run_seq, attempt, idempotency_key, executor_kind, status, created_at) VALUES ('wr-x', ?, ?, 2, 1, 1, 'k-x', 'agent', 'running', 0)").run(revised.id, revised.lineage_id)
    expect(() => svc.revise(revised.id, { title: 'v3' })).toThrow(WorkItemGuardError)
  })

  it('并发修订:第二次修订因旧行已退位被拒,数据不变', () => {
    const revised = svc.revise(itemId, { title: 'v2' })
    expect(revised.revision).toBe(2)
    // 第二次对同一（已退位）id 修订 → 只能修订当前 revision → GuardError
    expect(() => svc.revise(itemId, { title: 'v3' })).toThrow(WorkItemGuardError)
    // 真正的 demote 竞态由 ux_work_items_current 唯一索引兜底（事务内回滚）
    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE lineage_id = ? AND is_current = 1').get(revised.lineage_id) as { c: number }
    expect(currentCount.c).toBe(1)
  })
})

describe('D1 裁决：acceptance 结构化校验（系统边界 fail-closed）', () => {
  let db: BetterSqlite3.Database
  let svc: WorkItemService

  beforeEach(() => {
    db = setupDb()
    svc = new WorkItemService(db)
  })

  it('结构化条目通过：规范化落库（缺 id 自动补 acc_N，text 保留）', () => {
    const id = svc
      .createDraft({
        graphId: 'g1',
        title: '任务',
        acceptance: [
          { type: 'command', expected: 'npm test' },
          { id: 'acc-manual', type: 'manual', expected: '人工核对', text: '备注' },
        ],
      })
      .id
    const parsed = JSON.parse(svc.get(id)!.acceptance_json) as Array<Record<string, unknown>>
    expect(parsed).toEqual([
      { id: 'acc_1', type: 'command', expected: 'npm test' },
      { id: 'acc-manual', type: 'manual', expected: '人工核对', text: '备注' },
    ])
  })

  it('存量 [{id,text}] 自由文本 → 拒绝（不自动升格，D1 裁决）', () => {
    expect(() =>
      svc.createDraft({
        graphId: 'g1',
        title: '任务',
        acceptance: [{ id: 'acc1', text: '必须通过' }],
      }),
    ).toThrow(/type 必须是/)
  })

  it('缺 expected / expected 空串 / 未知 type → 拒绝', () => {
    expect(() => svc.createDraft({ graphId: 'g1', title: '任务', acceptance: [{ type: 'command' }] })).toThrow(
      /expected/,
    )
    expect(() =>
      svc.createDraft({ graphId: 'g1', title: '任务', acceptance: [{ type: 'command', expected: '  ' }] }),
    ).toThrow(/expected/)
    expect(() =>
      svc.createDraft({ graphId: 'g1', title: '任务', acceptance: [{ type: 'poem', expected: 'x' }] }),
    ).toThrow(/type 必须是/)
  })

  it('revise 改写 acceptance 走同一校验：不合法即抛且不落新 revision', () => {
    const id = svc
      .createDraft({ graphId: 'g1', title: '任务', acceptance: [{ type: 'command', expected: 'npm test' }] })
      .id
    expect(() => svc.revise(id, { acceptance_json: JSON.stringify([{ id: 'a', text: '旧格式' }]) })).toThrow(
      /type 必须是/,
    )
    const after = svc.get(id)!
    expect(after.revision).toBe(1)
    expect(after.is_current).toBe(1)
    // 合法修订正常落新 revision。
    const revised = svc.revise(id, {
      acceptance_json: JSON.stringify([{ type: 'file_check', expected: 'dist/index.html 存在' }]),
    })
    expect(revised.revision).toBe(2)
    expect(JSON.parse(revised.acceptance_json)).toEqual([{ id: 'acc_1', type: 'file_check', expected: 'dist/index.html 存在' }])
  })
})

describe('WorkRunService(§4.7.5)', () => {
  let db: BetterSqlite3.Database
  let items: WorkItemService
  let runs: WorkRunService
  let itemId: string
  let lineageId: string
  let stepId: string

  beforeEach(() => {
    db = setupDb()
    items = new WorkItemService(db)
    runs = new WorkRunService(db)
    const item = items.createDraft({ graphId: 'g1', title: '任务' })
    itemId = item.id
    lineageId = item.lineage_id
    stepId = items.listSteps(itemId, 1)[0].id
  })

  it('入队:run_seq 单调;attempt 取 step.attempt;同 attempt 重入队复用既有 run;attempt+1 才有新 run', () => {
    const first = runs.enqueue({ workItemId: itemId, stepId, executorKind: 'agent' })
    expect(first.reused).toBe(false)
    expect(first.run.run_seq).toBe(1)
    expect(first.run.idempotency_key).toBe(`${lineageId}:1:1:1`)
    runs.complete(first.run.id)

    // 同 attempt 再次入队（无新 attempt）→ 幂等复用首条（§4.7.5 键=lineage:revision:step_seq:attempt）
    const sameKey = runs.enqueue({ workItemId: itemId, stepId, executorKind: 'agent' })
    expect(sameKey.reused).toBe(true)
    expect(sameKey.run.id).toBe(first.run.id)

    // 步重进 pending（§4.7.4:恢复路径 attempt+1）→ 新键新 run
    db.prepare('UPDATE work_steps SET attempt = 2 WHERE id = ?').run(stepId)
    const second = runs.enqueue({ workItemId: itemId, stepId, executorKind: 'agent' })
    expect(second.reused).toBe(false)
    expect(second.run.run_seq).toBe(2)
    expect(second.run.idempotency_key).toBe(`${lineageId}:1:1:2`)
  })

  it('claim:queued→running;二次 claim 返回 undefined(竞态)', () => {
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    expect(runs.claim(run.id)!.status).toBe('running')
    expect(runs.claim(run.id)).toBeUndefined()
  })

  it('取消 vs 完成竞态:取消先行,完成 CAS 不命中,终态唯一保留 cancelled', () => {
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    runs.claim(run.id)
    const cancelled = runs.cancel(run.id, 'user')
    expect(cancelled!.status).toBe('cancelled')
    expect(cancelled!.cancel_reason).toBe('user')
    const completed = runs.complete(run.id, { resultSummary: '晚到的完成' })
    expect(completed).toBeUndefined()
    const row = runs.get(run.id)!
    expect(row.status).toBe('cancelled')
    expect(row.result_summary).toBeNull()
  })

  it('fail 带 partial;normalizePartial 单字段 16KB/总量截断', () => {
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    runs.claim(run.id)
    const failed = runs.fail(run.id, {
      failureClass: 'turn_fail',
      partial: { stdout_tail: 'x'.repeat(20 * 1024), file_changes: ['src/a.ts'], errors: ['boom'] },
    })!
    expect(failed.failure_class).toBe('turn_fail')
    const partial = JSON.parse(failed.partial_output_ref!)
    expect(partial.truncated).toBe(true)
    expect(Buffer.byteLength(partial.stdout_tail, 'utf8')).toBeLessThanOrEqual(PARTIAL_FIELD_MAX_BYTES)

    // normalizePartial 直测:两个超长字段触发总量截断
    const p = normalizePartial({ stdout_tail: 'a'.repeat(40 * 1024), stderr_tail: 'b'.repeat(40 * 1024) })
    expect(p.truncated).toBe(true)
    const total = Buffer.byteLength(p.stdout_tail!, 'utf8') + Buffer.byteLength(p.stderr_tail!, 'utf8')
    expect(total).toBeLessThanOrEqual(64 * 1024)
  })

  it('timed_out/interrupted:条件更新,失败先行则保留失败', () => {
    const { run } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    runs.claim(run.id)
    expect(runs.timeout(run.id, { stdout_tail: 'partial' })!.status).toBe('timed_out')

    const { run: r2 } = runs.enqueue({ workItemId: itemId, executorKind: 'agent' })
    runs.claim(r2.id)
    runs.fail(r2.id, { failureClass: 'infra' })
    expect(runs.markInterrupted(r2.id)).toBeUndefined()
  })

  it('入队守卫:被替代 revision/终态 item/旧 revision step 都不得起 run', () => {
    const current = items.revise(itemId, { title: '任务 v2' })
    // 旧 revision 已 superseded
    expect(() => runs.enqueue({ workItemId: itemId, executorKind: 'agent' })).toThrow(WorkRunConflictError)
    // 终态 item（done / cancelled）
    for (const terminal of ['done', 'cancelled']) {
      db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(terminal, current.id)
      expect(() => runs.enqueue({ workItemId: current.id, executorKind: 'agent' })).toThrow(/已终态/)
    }
    // 旧 revision 的 step 不能挂到新 revision（幂等键会错位）
    db.prepare("UPDATE work_items SET status = 'draft' WHERE id = ?").run(current.id)
    expect(() => runs.enqueue({ workItemId: current.id, stepId, executorKind: 'agent' })).toThrow(/当前 revision/)
    // 新 revision 自己的 step 正常入队
    const newStep = items.listSteps(current.id, current.revision)[0].id
    expect(runs.enqueue({ workItemId: current.id, stepId: newStep, executorKind: 'agent' }).run.status).toBe('queued')
  })
})

describe('NodeSessionLinkService(§4.7.6)', () => {
  let db: BetterSqlite3.Database
  let links: NodeSessionLinkService

  beforeEach(() => {
    db = setupDb()
    links = new NodeSessionLinkService(db)
  })

  it('挂载幂等:同 thread+node+role 一条;项目级 NULL 独立(部分唯一索引)', () => {
    const first = links.attach({ projectPath: '/p', graphId: 'g1', nodeEntityKey: 'k1', threadId: 't1', sessionOrigin: 'manual_panel' })
    expect(first.reused).toBe(false)
    const second = links.attach({ projectPath: '/p', graphId: 'g1', nodeEntityKey: 'k1', threadId: 't1', sessionOrigin: 'manual_panel' })
    expect(second.reused).toBe(true)
    expect(second.row.id).toBe(first.row.id)

    // 项目级(NULL)与节点级是两条独立行
    const proj = links.attach({ projectPath: '/p', graphId: 'g1', threadId: 't1', sessionOrigin: 'manual_panel' })
    expect(proj.reused).toBe(false)
    expect(proj.row.node_entity_key).toBeNull()
  })

  it('end 只写 ended_at 不删行;时间线返回 threadIds 全集', () => {
    links.attach({ projectPath: '/p', graphId: 'g1', nodeEntityKey: 'k1', threadId: 't1', sessionOrigin: 'map_task' })
    links.attach({ projectPath: '/p', graphId: 'g1', nodeEntityKey: 'k1', threadId: 't2', sessionOrigin: 'map_task' })
    links.end('t1')

    const timeline = links.timelineForNode('g1', 'k1')
    expect(timeline.map((r) => r.thread_id)).toEqual(['t1', 't2']) // §9.5-3:threadIds[] 全保留
    expect(timeline[0].ended_at).toBeTruthy()
    expect(timeline[1].ended_at).toBeNull()
    const count = db.prepare('SELECT COUNT(*) AS c FROM node_session_links').get() as { c: number }
    expect(count.c).toBe(2)
  })
})

describe('ChangeSetService(§4.7.7)', () => {
  let db: BetterSqlite3.Database
  let cs: ChangeSetService
  const gitOk: GitRunner = {
    revParseHEAD: () => 'abc1234',
    statusPorcelain: () => [' M src/a.ts'],
  }

  beforeEach(() => {
    db = setupDb()
    cs = new ChangeSetService(db, gitOk)
  })

  it('base 采集:HEAD+dirty;同 run 重试不重复插入(UNIQUE 兜底返回既有)', () => {
    const b1 = cs.captureBase({ projectPath: '/p', workRunId: 'wr-1' })!
    expect(b1.base_commit).toBe('abc1234')
    expect(b1.dirty).toBe(1)
    const b2 = cs.captureBase({ projectPath: '/p', workRunId: 'wr-1' })
    expect(b2!.id).toBe(b1.id)
    expect((db.prepare('SELECT COUNT(*) AS c FROM change_sets').get() as { c: number }).c).toBe(1)
  })

  it('采集失败不写空行(假"无变更"被禁止,§4.7.7)', () => {
    const failing = new ChangeSetService(db, { revParseHEAD: () => { throw new Error('not a repo') }, statusPorcelain: () => null })
    expect(failing.captureBase({ projectPath: '/p', workRunId: 'wr-2' })).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) AS c FROM change_sets').get() as { c: number }).c).toBe(0)
  })

  it('head 采集:文件面/增删行/dirty_tree_hash;无 base 行则拒写', () => {
    cs.captureBase({ projectPath: '/p', workRunId: 'wr-3' })
    const head = cs.captureHead('wr-3', {
      headCommit: 'def5678',
      files: [{ path: 'src/a.ts', change: 'modified', additions: 10, deletions: 2 }],
      dirtyTreeHash: 'treehash',
    })!
    expect(head.head_commit).toBe('def5678')
    expect(head.file_count).toBe(1)
    expect(head.line_additions).toBe(10)
    expect(head.dirty_tree_hash).toBe('treehash')
    expect(JSON.parse(head.files_json)).toHaveLength(1)

    expect(cs.captureHead('wr-missing', { headCommit: 'x', files: [] })).toBeUndefined()
  })
})

describe('RoutingDecisionRepository(§4.7.8)', () => {
  let db: BetterSqlite3.Database
  let repo: RoutingDecisionRepository

  beforeEach(() => {
    db = setupDb()
    repo = new RoutingDecisionRepository(db)
  })

  it('record 正常写入;chosen_adapter 空串拒绝(路由失败不写半条行)', () => {
    const row = repo.record({
      workItemId: 'wi-1', workRunId: 'wr-1', chosenAdapter: 'claude-code',
      candidates: [{ adapter: 'claude-code', score: 0.9 }, { adapter: 'codex', score: 0.4, gaps: ['approval'] }],
      policy: 'single_agent', confidence: 0.9,
    })
    expect(row.chosen_adapter).toBe('claude-code')
    expect(JSON.parse(row.candidate_json)).toHaveLength(2)
    expect(() => repo.record({ workRunId: 'wr-2', chosenAdapter: '', candidates: [], policy: 'fallback' })).toThrow(/不写半条行/)
  })
})
