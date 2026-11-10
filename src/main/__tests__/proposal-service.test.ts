/**
 * G1-14 提案机制（含 G2-6 冲突/权重细节）单测。
 *
 * 覆盖：创建即待确认、同实体唯一 open、并发上限 3、conflict_group 串行与提升、
 * 驳回必带理由、采纳幂等且**不改 online 节点**、stale 判定、200KB 截断、
 * 24h 阻塞超时取消、weight 仅影响展示排序。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapViews } from '../map/schema'
import {
  ProposalService,
  ProposalError,
  PROPOSAL_FIELD_MAX_BYTES,
} from '../map/proposal-service'

const NODES_DDL = `
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    content TEXT,
    metadata TEXT,
    updated_at TEXT NOT NULL
  )
`

describe('ProposalService', () => {
  let db: BetterSqlite3.Database
  let service: ProposalService

  const seedNode = (entityKey: string, graphId = 'g_online', updatedAt = '2026-01-01T00:00:00.000Z') => {
    db.prepare(
      'INSERT INTO nodes (id, graph_id, entity_key, title, description, status, content, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `n_${entityKey}`, graphId, entityKey, `节点 ${entityKey}`, '原描述', 'active',
      JSON.stringify({ summary: 'old' }), '{}', updatedAt,
    )
  }

  beforeEach(() => {
    db = new BetterSqlite3(':memory:')
    db.pragma('foreign_keys = ON')
    applyMapS5aSchema(db)
    db.exec(NODES_DDL)
    applyMapViews(db)
    service = new ProposalService(db)
    seedNode('user.order')
    seedNode('user.pay')
  })

  afterEach(() => {
    db.close()
  })

  const baseInput = (over: Partial<Parameters<ProposalService['create']>[0]> = {}) => ({
    graphId: 'g_online',
    anchorEntityKey: 'user.order',
    title: '订单实体补状态字段',
    reason: '线上订单缺状态，导致对账口径不一致',
    after: { title: '订单', status: 'new' },
    ...over,
  })

  it('创建即进入 awaiting_confirm，载荷落 metadata，online 节点不被改动', () => {
    const before = db.prepare('SELECT title, description, status, content, metadata FROM nodes WHERE id = ?').get('n_user.order')
    const { row, proposal } = service.create(baseInput({ createdBy: 'alice' }))

    expect(row.status).toBe('awaiting_confirm')
    expect(proposal.reason).toContain('对账')
    expect(proposal.created_via).toBe('proposal')
    // 服务端自动快照 before（调用方未提供）。
    expect(JSON.parse(proposal.before)).toMatchObject({ title: '节点 user.order', status: 'active' })

    // 提案写入不触碰 online 图。
    expect(db.prepare('SELECT title, description, status, content, metadata FROM nodes WHERE id = ?').get('n_user.order'))
      .toEqual(before)

    const list = service.list({ graphId: 'g_online' })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: row.id, status: 'awaiting_confirm', stale: 0 })
  })

  it('同一实体只允许一个 open 提案', () => {
    service.create(baseInput())
    expect(() => service.create(baseInput({ title: '第二个提案' })))
      .toThrowError(/同一实体只允许一个 open 提案/)
    try {
      service.create(baseInput({ title: '第二个提案' }))
    } catch (err) {
      expect((err as ProposalError).code).toBe('CONFLICT')
    }
  })

  it('同实体并发提案上限 3（1 open 在别的实体 + 2 blocked）', () => {
    // open 提案挂在 user.pay，同 conflict_group 的 blocked 提案挂在 user.order，
    // 才能在 user.order 上堆到 3 条非终态。
    service.create(baseInput({ anchorEntityKey: 'user.pay', title: 'P0', conflictGroup: 'grp' }))
    service.create(baseInput({ title: 'P1', conflictGroup: 'grp' }))
    service.create(baseInput({ title: 'P2', conflictGroup: 'grp' }))
    service.create(baseInput({ title: 'P3', conflictGroup: 'grp' }))
    expect(() => service.create(baseInput({ title: 'P4', conflictGroup: 'grp' })))
      .toThrowError(/并发提案上限 3/)
  })

  it('conflict_group 串行：后者 blocked，前序驳回后提升为 open', () => {
    const p1 = service.create(baseInput({ conflictGroup: 'grp' }))
    const p2 = service.create(baseInput({ anchorEntityKey: 'user.pay', title: 'P2', conflictGroup: 'grp' }))

    expect(p2.row.status).toBe('blocked')
    const diffP2 = service.diff(String(p2.row.id))!
    expect(diffP2.status).toBe('blocked')

    service.reject(String(p1.row.id), { reason: '口径不对' })
    const promoted = service.diff(String(p2.row.id))!
    expect(promoted.status).toBe('awaiting_confirm')
  })

  it('驳回必须填写理由', () => {
    const { row } = service.create(baseInput())
    expect(() => service.reject(String(row.id), { reason: '   ' }))
      .toThrowError(/必须填写理由/)
  })

  it('驳回写理由并取消，重复驳回幂等', () => {
    const { row } = service.create(baseInput())
    const first = service.reject(String(row.id), { reason: '不是线上问题', rejectedBy: 'bob' })
    expect(first.reused).toBe(false)
    expect(first.row.status).toBe('cancelled')
    expect(first.row.cancel_reason).toBe('user')
    expect(service.diff(String(row.id))!.rejectReason).toBe('不是线上问题')

    const second = service.reject(String(row.id), { reason: '再说一次' })
    expect(second.reused).toBe(true)
  })

  it('采纳幂等，且不写 online 节点', () => {
    const { row } = service.create(baseInput())
    const nodeBefore = db.prepare('SELECT * FROM nodes WHERE id = ?').get('n_user.order')

    const first = service.accept(String(row.id), { acceptedBy: 'alice' })
    expect(first.reused).toBe(false)
    expect(first.row.status).toBe('done')
    expect(db.prepare('SELECT * FROM nodes WHERE id = ?').get('n_user.order')).toEqual(nodeBefore)

    const second = service.accept(String(row.id), { acceptedBy: 'alice' })
    expect(second.reused).toBe(true)
    // 已 done 的提案默认不出现在列表，但 includeResolved 可查。
    expect(service.list({ graphId: 'g_online' })).toHaveLength(0)
    expect(service.list({ graphId: 'g_online', includeResolved: true })).toHaveLength(1)
  })

  it('采纳必须带审计主体', () => {
    const { row } = service.create(baseInput())
    expect(() => service.accept(String(row.id), { acceptedBy: ' ' }))
      .toThrowError(/acceptedBy 必填/)
  })

  it('online 节点 updated_at 变化后标 stale', () => {
    const { row } = service.create(baseInput())
    expect(service.list({ graphId: 'g_online' })[0].stale).toBe(0)

    db.prepare('UPDATE nodes SET updated_at = ? WHERE id = ?').run('2026-02-02T00:00:00.000Z', 'n_user.order')
    expect(service.list({ graphId: 'g_online' })[0].stale).toBe(1)
    expect(service.diff(String(row.id))!.stale).toBe(true)
  })

  it('before/after 超过 200KB 截断并标 truncated', () => {
    const huge = 'x'.repeat(PROPOSAL_FIELD_MAX_BYTES + 1024)
    const { proposal } = service.create(baseInput({ after: { content: huge } }))
    expect(proposal.truncated).toBe(true)
    expect(proposal.after).toContain('[truncated]')
    expect(Buffer.byteLength(proposal.after, 'utf8')).toBeLessThanOrEqual(PROPOSAL_FIELD_MAX_BYTES + 32)
    expect(service.diff(
      String((db.prepare("SELECT id FROM work_items WHERE json_extract(metadata,'$.proposal') IS NOT NULL").get() as { id: string }).id),
    )!.truncated).toBe(true)
  })

  it('weight 越界拒绝；排序按 weight 降序（仅展示）', () => {
    expect(() => service.create(baseInput({ weight: 1.5 }))).toThrowError(/weight/)
    service.create(baseInput({ title: '高权重', weight: 0.9 }))
    // 同实体只能一个 open，换实体验证排序。
    service.create(baseInput({ anchorEntityKey: 'user.pay', title: '低权重', weight: 0.1 }))
    const titles = service.list({ graphId: 'g_online' }).map((r) => r.title)
    expect(titles).toEqual(['高权重', '低权重'])
  })

  it('阻塞超 24h 自动取消', () => {
    const p1 = service.create(baseInput({ conflictGroup: 'grp' }))
    const p2 = service.create(baseInput({ anchorEntityKey: 'user.pay', title: 'P2', conflictGroup: 'grp' }))
    expect(p2.row.status).toBe('blocked')

    // 模拟 25h 前进入 blocked。
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(old, String(p2.row.id))

    expect(service.expireStale()).toBe(1)
    const expired = service.diff(String(p2.row.id))!
    expect(expired.status).toBe('cancelled')
    // p1 不受影响。
    expect(service.diff(String(p1.row.id))!.status).toBe('awaiting_confirm')
  })

  it('非空 before 被原样采用（不再自动快照）', () => {
    const { proposal } = service.create(baseInput({ before: { title: '调用方声明旧值' } }))
    expect(JSON.parse(proposal.before)).toEqual({ title: '调用方声明旧值' })
  })
})
