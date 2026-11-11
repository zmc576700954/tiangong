/**
 * session-map 只读 IPC 回归。
 *
 * 覆盖：run / step / work_item / 证据 / 派生状态通道的读取结果、参数校验（图 id、
 * 分页上限、选择器必填），以及「只读」证明——所有只读通道调用前后五张表的行与
 * 内容逐字节相同（含 updated_at，不会被任何 handler 改写）。
 *
 * 只读白名单与 preload 暴露共用 `MAP_READ_ONLY_CHANNELS`：本测试同时断言白名单
 * 里没有写操作/执行触发通道。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapS5aSchema, applyMapS6aSchema } from '../map/schema'
import { registerMapHandlers } from '../ipc/map'
import type { TypedHandle } from '../ipc/utils'
import type { WorkExecutionService } from '../map/work-execution-service'
import { setWorkExecutionService } from '../map/work-execution-registry'
import { MAP_READ_ONLY_CHANNELS } from '@shared/types/ipc'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  applyMapS5aSchema(db)
  applyMapS6aSchema(db)
  return db
}

/** 六张被读表：只读断言逐表快照（行序固定，避免顺序抖动）。 */
const READ_TABLES = [
  ['work_items', 'id'],
  ['work_steps', 'id'],
  ['work_runs', 'id'],
  ['node_evidence', 'id'],
  ['node_execution_state', 'node_entity_key'],
  ['node_links', 'id'],
] as const

function snapshot(db: BetterSqlite3.Database): Record<string, string> {
  const snap: Record<string, string> = {}
  for (const [table, orderBy] of READ_TABLES) {
    snap[table] = JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy} ASC`).all())
  }
  return snap
}

/** work_steps 的 IPC 出参字段（显式列名；加列必须同步改这里与 listStepsForRead）。 */
const STEP_READ_COLUMNS = [
  'attempt', 'checker_work_item_id', 'consults_json', 'created_at', 'deadline_at',
  'depends_on_step_ids_json', 'ended_at', 'failure_class', 'id', 'input_request_json',
  'invocation_id', 'output_schema_json', 'scope_files_json', 'seq', 'skip_reason',
  'started_at', 'status', 'step_kind', 'title', 'updated_at', 'work_item_id',
  'work_item_revision',
]

describe('session-map 只读 IPC 通道', () => {
  let db: BetterSqlite3.Database
  let handlers: Map<string, Handler>

  beforeEach(() => {
    db = setupDb()
    handlers = new Map()
    registerMapHandlers(
      ((channel: string, handler: Handler) => handlers.set(channel, handler)) as unknown as TypedHandle,
      db,
    )
    seed(db)
  })

  function call(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler ${channel} 未注册`)
    return handler(null, ...args)
  }

  it('只读白名单：每个通道都有 handler，且不含写操作/执行触发', () => {
    for (const channel of MAP_READ_ONLY_CHANNELS) {
      expect(handlers.has(channel), channel).toBe(true)
    }
    const WRITE_CHANNELS = [
      'map:link:create',
      'map:link:delete',
      'map:evidence:suggestion:accept',
      'map:evidence:suggestion:dismiss',
      'map:evidence:e1:create',
      'workitem:create',
      'workitem:revise',
      'workitem:run:start',
      'workitem:cancel',
      'workitem:step:run',
      'workitem:run:cancel',
      'plan:draft:create',
      'plan:draft:revise',
      'plan:draft:confirm',
      'plan:draft:reject',
      'admin:map:integrity-check',
    ]
    // 写通道确实注册在 handler 面（不是漏注册），但一条都不在只读白名单里。
    for (const channel of WRITE_CHANNELS) {
      expect(handlers.has(channel), `${channel} 应已注册`).toBe(true)
      expect(MAP_READ_ONLY_CHANNELS as readonly string[], channel).not.toContain(channel)
    }
  })

  it('map:overlay:get 返回派生状态 + 当前 item 摘要（复用读侧刷新路径）', async () => {
    const result = (await call('map:overlay:get', 'g1')) as {
      executionStates: Array<Record<string, unknown>>
      workItems: Array<Record<string, unknown>>
    }
    expect(result.executionStates).toHaveLength(1)
    expect(result.executionStates[0].node_entity_key).toBe('k1')
    expect(result.executionStates[0].execution_state).toBe('verified')
    expect(result.workItems.map((w) => w.id)).toEqual(['wi1'])
  })

  it('workitem:get 是 item 下钻闭包：item + steps + runs', async () => {
    const result = (await call('workitem:get', 'wi1')) as {
      item: Record<string, unknown>
      steps: Array<Record<string, unknown>>
      runs: Array<Record<string, unknown>>
    }
    expect(result.item.id).toBe('wi1')
    expect(result.steps.map((s) => s.id)).toEqual(['ws1', 'ws2', 'ws3'])
    // 显式列名：出参字段集合锁定，避免将来加列无声漏进渲染进程。
    expect(Object.keys(result.steps[0]).sort()).toEqual(STEP_READ_COLUMNS)
    // v34 归因列在显式列清单内，UI 无需额外查询。
    expect(result.steps[1].failure_class).toBe('turn_fail')
    expect(result.steps[2].skip_reason).toBe('upstream_blocked')
    expect(result.runs.map((r) => r.id)).toEqual(['wr1', 'wr2'])
  })

  it('workitem:list / steps:list 参数校验与上限', async () => {
    await expect(call('workitem:list', {})).rejects.toThrow(/graphId/)
    const list = (await call('workitem:list', { graphId: 'g1', limit: 1 })) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('wi1')

    await expect(call('workitem:steps:list', {})).rejects.toThrow(/workItemId/)
    const steps = (await call('workitem:steps:list', { workItemId: 'wi1' })) as Array<Record<string, unknown>>
    expect(steps).toHaveLength(3)
    expect(Object.keys(steps[0]).sort()).toEqual(STEP_READ_COLUMNS)
    expect((await call('workitem:steps:list', { workItemId: 'missing' })) as unknown[]).toEqual([])
  })

  it('map:run:list / map:run:get 按 item / step / graph / status 查询', async () => {
    await expect(call('map:run:list', {})).rejects.toThrow(/workItemId, stepId or graphId/)
    await expect(call('map:run:list', { workItemId: 'wi1', status: 'bogus' })).rejects.toThrow(/status/)

    const byItem = (await call('map:run:list', { workItemId: 'wi1' })) as Array<Record<string, unknown>>
    expect(byItem.map((r) => r.id)).toEqual(['wr1', 'wr2'])

    const byStep = (await call('map:run:list', { stepId: 'ws2' })) as Array<Record<string, unknown>>
    expect(byStep.map((r) => r.id)).toEqual(['wr2'])

    // graph 维度经 work_items join，只返回该图的 run（不串到 g2）。
    const byGraph = (await call('map:run:list', { graphId: 'g1', status: 'failed' })) as Array<Record<string, unknown>>
    expect(byGraph.map((r) => r.id)).toEqual(['wr2'])

    expect(((await call('map:run:get', 'wr1')) as Record<string, unknown>).status).toBe('running')
    expect(await call('map:run:get', 'missing')).toBeNull()
    await expect(call('map:run:get', 123)).rejects.toThrow(/id/)
  })

  it('workitem:evidence:list 按 item 读证据', async () => {
    await expect(call('workitem:evidence:list', {})).rejects.toThrow(/workItemId/)
    const rows = (await call('workitem:evidence:list', { workItemId: 'wi1' })) as Array<Record<string, unknown>>
    expect(rows.map((r) => r.id)).toEqual(['ne1'])
    expect(rows[0].work_run_id).toBe('wr2')
  })

  it('G7-8：pinned adapter 非 Tier 1 时执行状态禁用并说明「只能裸 spawn」', async () => {
    const prevEnabled = process.env.BIZGRAPH_MAP_EXECUTION
    const prevAdapter = process.env.BIZGRAPH_MAP_EXECUTION_ADAPTER
    process.env.BIZGRAPH_MAP_EXECUTION = '1'
    process.env.BIZGRAPH_MAP_EXECUTION_ADAPTER = 'codex'
    setWorkExecutionService({
      inspectRouting: () => ({
        ok: false,
        code: 'TIER_UNSUPPORTED',
        reason: 'adapter codex 能力票 Tier 2，编排写路径仅接受 Tier 1（缺项：approval_callback）',
        tier: {
          adapter: 'codex',
          adapterVersion: null,
          tier: 2,
          resume: true,
          approval_callback: false,
          structured_output: true,
          cancel: true,
        },
      }),
    } as unknown as WorkExecutionService)
    try {
      const status = (await call('map:execution:status')) as {
        enabled: boolean
        adapterName: string | null
        disabledReason: string | null
        tier?: number | null
        tierMissing?: string[]
      }
      expect(status.enabled).toBe(false)
      expect(status.adapterName).toBe('codex')
      expect(status.tier).toBe(2)
      expect(status.tierMissing).toEqual(['approval_callback'])
      expect(status.disabledReason).toContain('裸 spawn')
      expect(status.disabledReason).toContain('Tier 2')
    } finally {
      setWorkExecutionService(null)
      if (prevEnabled === undefined) delete process.env.BIZGRAPH_MAP_EXECUTION
      else process.env.BIZGRAPH_MAP_EXECUTION = prevEnabled
      if (prevAdapter === undefined) delete process.env.BIZGRAPH_MAP_EXECUTION_ADAPTER
      else process.env.BIZGRAPH_MAP_EXECUTION_ADAPTER = prevAdapter
    }
  })

  it('map:node:timeline 出参只含 DTO 列（加列/改名时两端都能编译期发现）', async () => {
    db.prepare(
      `INSERT INTO node_session_links (
         id, project_path, graph_id, node_entity_key, thread_id, link_role, session_origin,
         started_at, ended_at, created_at
       ) VALUES ('l1', '/p/a', 'g1', 'k1', 'th1', 'primary', 'manual_panel', 1, 2, 3)`,
    ).run()
    const rows = (await call('map:node:timeline', {
      graphId: 'g1',
      nodeEntityKey: 'k1',
    })) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual([
      'created_at', 'ended_at', 'id', 'link_role', 'session_origin',
      'started_at', 'thread_adapter', 'thread_id', 'thread_status', 'thread_title',
    ])
    // 左连接不到线程时字段仍是 null，而不是整个键消失。
    expect(rows[0].thread_title).toBeNull()
  })

  it('map:link:delete：只删 origin=human，派生链接拒绝且行保留', async () => {
    const insert = db.prepare(
      `INSERT INTO node_links (
         id, project_path, from_entity_key, from_graph_id, from_graph_type, from_node_id,
         to_entity_key, to_graph_id, to_graph_type, to_node_id,
         link_type, direction, confidence, origin, status, reason, metadata, created_at, updated_at
       ) VALUES (?, '/p/a', 'k1', 'g1', 'dev', NULL, 'k2', 'g1', 'dev', NULL,
                 'relates_to', 'symmetric', 1.0, ?, 'active', NULL, NULL, ?, ?)`,
    )
    insert.run('nl-human', 'human', 't', 't')
    insert.run('nl-derived', 'derived', 't', 't')

    const deleted = (await call('map:link:delete', {
      id: 'nl-human',
      projectPath: '/p/a',
    })) as { deleted: boolean; row: Record<string, unknown> }
    expect(deleted.deleted).toBe(true)
    expect(deleted.row.id).toBe('nl-human')
    expect(db.prepare('SELECT COUNT(*) AS c FROM node_links WHERE id = ?').get('nl-human')).toEqual({ c: 0 })

    await expect(call('map:link:delete', { id: 'nl-derived', projectPath: '/p/a' })).rejects.toMatchObject({
      code: 'not_human_origin',
    })
    expect(db.prepare('SELECT COUNT(*) AS c FROM node_links WHERE id = ?').get('nl-derived')).toEqual({ c: 1 })

    await expect(call('map:link:delete', { id: 'nl-missing', projectPath: '/p/a' })).rejects.toMatchObject({
      code: 'link_not_found',
    })
  })

  it('只读证明：调用全部只读通道后五张表逐行不变', async () => {
    const before = snapshot(db)
    await call('map:overlay:get', 'g1')
    await call('map:link:list', { projectPath: '/p/a' })
    await call('map:node:timeline', { graphId: 'g1', nodeEntityKey: 'k1' })
    await call('map:node:evidence:list', { graphId: 'g1', nodeEntityKey: 'k1' })
    await call('workitem:get', 'wi1')
    await call('workitem:list', { graphId: 'g1' })
    await call('workitem:steps:list', { workItemId: 'wi1' })
    await call('workitem:evidence:list', { workItemId: 'wi1' })
    await call('map:run:list', { graphId: 'g1' })
    await call('map:run:get', 'wr1')
    await call('map:execution:status')
    expect(snapshot(db)).toEqual(before)
  })
})

function seed(db: BetterSqlite3.Database): void {
  const ts = '2026-11-07T00:00:00.000Z'
  // node_links 由主库 schema 建表（不在 map/schema.ts），这里按 LinkService 读取列建最小表。
  db.exec(
    `CREATE TABLE node_links (
       id TEXT PRIMARY KEY, project_path TEXT NOT NULL,
       from_entity_key TEXT NOT NULL, from_graph_id TEXT NOT NULL, from_graph_type TEXT NOT NULL,
       from_node_id TEXT,
       to_entity_key TEXT NOT NULL, to_graph_id TEXT NOT NULL, to_graph_type TEXT NOT NULL,
       to_node_id TEXT,
       link_type TEXT NOT NULL, direction TEXT NOT NULL, confidence REAL,
       origin TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, metadata TEXT,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`,
  )
  // map:node:timeline 会 LEFT JOIN chat_threads（主库表，不在 map/schema.ts）。
  db.exec(
    `CREATE TABLE chat_threads (
       id TEXT PRIMARY KEY, title TEXT, status TEXT, adapter_name TEXT
     )`,
  )
  db.prepare(
    `INSERT INTO work_items (id, lineage_id, revision, is_current, graph_id, anchor_entity_key,
       title, status, gate_status, origin, created_at, updated_at)
     VALUES ('wi1', 'wl1', 1, 1, 'g1', 'k1', '任务一', 'running', 'pass', 'human', ?, ?)`,
  ).run(ts, ts)
  db.prepare(
    `INSERT INTO work_items (id, lineage_id, revision, is_current, graph_id,
       title, status, gate_status, origin, created_at, updated_at)
     VALUES ('wi2', 'wl2', 1, 1, 'g2', '任务二', 'queued', 'pass', 'human', ?, ?)`,
  ).run(ts, ts)

  const insertStep = db.prepare(
    `INSERT INTO work_steps (id, work_item_id, work_item_revision, seq, title, step_kind, status,
       skip_reason, failure_class, created_at, updated_at)
     VALUES (?, 'wi1', 1, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
  )
  insertStep.run('ws1', 1, '步骤一', 'running', null, null, 1, 1)
  insertStep.run('ws2', 2, '步骤二', 'failed', null, 'turn_fail', 2, 2)
  insertStep.run('ws3', 3, '步骤三', 'skipped', 'upstream_blocked', null, 3, 3)

  const insertRun = db.prepare(
    `INSERT INTO work_runs (id, work_item_id, work_item_lineage_id, work_item_revision, step_id,
       run_seq, attempt, idempotency_key, executor_kind, status, failure_class, created_at)
     VALUES (?, ?, ?, 1, ?, ?, 1, ?, 'agent', ?, ?, ?)`,
  )
  insertRun.run('wr1', 'wi1', 'wl1', 'ws1', 1, 'wl1:1:1:1', 'running', null, 1)
  insertRun.run('wr2', 'wi1', 'wl1', 'ws2', 2, 'wl1:1:2:1', 'failed', 'turn_fail', 2)
  insertRun.run('wr3', 'wi2', 'wl2', null, 1, 'wl2:1:0:1', 'queued', null, 3)

  db.prepare(
    `INSERT INTO node_evidence (id, graph_id, graph_type, node_entity_key, evidence_level,
       evidence_type, ref_json, summary, produced_by, work_item_id, work_run_id, created_at)
     VALUES ('ne1', 'g1', 'dev', 'k1', 'E2', 'changed_files', '{"files":[]}', '变更', 'system', 'wi1', 'wr2', ?)`,
  ).run(ts)

  // derivation_version 取当前版本（2）：overlay 的惰性刷新不会重算它，快照稳定。
  db.prepare(
    `INSERT INTO node_execution_state (graph_id, node_entity_key, execution_state, evidence_level,
       is_reproducible, evidence_count, stale_count, derivation_version, inputs_hash, computed_at)
     VALUES ('g1', 'k1', 'verified', 'E2', NULL, 1, 0, 2, 'h1', 1)`,
  ).run()
}
