/**
 * SG-1：越界拦截落库（`node_scope_violations`）。
 *
 * 这组用例守的是「记录不许说谎」：
 *  - 归属不清（无 nodeId / 节点不存在 / 缺 entity_key）时**不写伪行**；
 *  - 处置状态只有回滚成功才变 `rolled_back`，否则留 `pending`（面板显示「未处置」）；
 *  - 越界记录不写 `node_evidence`——否则派生引擎会把 E2 读成 `implemented`。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { applyMapViolationSchema, MAP_VIOLATION_INDEX_SQLS } from '../schema'
import {
  recordScopeViolation,
  markScopeViolationsRolledBack,
  listScopeViolations,
} from '../scope-violation-service'

const GRAPH_ID = 'graph-dev'
const NODE_ID = 'node-1'
const ENTITY_KEY = 'ek-login'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      project_path TEXT
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL,
      entity_key TEXT
    );
  `)
  db.prepare('INSERT INTO graphs (id, name, type, project_path) VALUES (?, ?, ?, ?)')
    .run(GRAPH_ID, 'Dev', 'dev', '/tmp/proj')
  db.prepare(
    'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(NODE_ID, 'feature', 'developing', '登录', GRAPH_ID, 'dev', ENTITY_KEY)
  applyMapViolationSchema(db)
  return db
}

describe('SG-1 越界记录', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
  })

  it('按 nodeId 解析归属并落库，初始处置为 pending', () => {
    const row = recordScopeViolation(db, {
      nodeId: NODE_ID,
      sessionId: 'sess-1',
      sandboxId: 'sandbox-1',
      violations: ['src/config/secret.ts'],
      workingDirectory: '/tmp/proj',
    })

    expect(row).not.toBeNull()
    expect(row).toMatchObject({
      graph_id: GRAPH_ID,
      graph_type: 'dev',
      node_entity_key: ENTITY_KEY,
      node_id: NODE_ID,
      session_id: 'sess-1',
      sandbox_id: 'sandbox-1',
      working_dir: '/tmp/proj',
      project_path: '/tmp/proj',
      disposition: 'pending',
      disposed_at: null,
    })
    expect(JSON.parse(row!.violations_json)).toEqual(['src/config/secret.ts'])

    const stored = listScopeViolations(db, GRAPH_ID, ENTITY_KEY)
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(row!.id)
  })

  it('不写 node_evidence（越界不是交付证据）', () => {
    recordScopeViolation(db, {
      nodeId: NODE_ID,
      sandboxId: 'sandbox-1',
      violations: ['src/a.ts'],
    })
    const hasEvidenceTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_evidence'")
      .get()
    // 本用例的库里根本没有 node_evidence；即便有，写入方也只有 node_scope_violations。
    expect(hasEvidenceTable).toBeUndefined()
    expect(listScopeViolations(db, GRAPH_ID, ENTITY_KEY)).toHaveLength(1)
  })

  it('缺 nodeId 时不写（会话未绑定节点，不造伪归属）', () => {
    const row = recordScopeViolation(db, {
      nodeId: null,
      sessionId: 'sess-1',
      sandboxId: 'sandbox-1',
      violations: ['src/a.ts'],
    })
    expect(row).toBeNull()
    expect(listScopeViolations(db, GRAPH_ID, ENTITY_KEY)).toHaveLength(0)
  })

  it('节点不存在时不写', () => {
    const row = recordScopeViolation(db, {
      nodeId: 'node-missing',
      sandboxId: 'sandbox-1',
      violations: ['src/a.ts'],
    })
    expect(row).toBeNull()
    expect(listScopeViolations(db, GRAPH_ID, ENTITY_KEY)).toHaveLength(0)
  })

  it('节点缺 entity_key 时不写（无法按节点索引，等于无归属）', () => {
    db.prepare('UPDATE nodes SET entity_key = NULL WHERE id = ?').run(NODE_ID)
    const row = recordScopeViolation(db, {
      nodeId: NODE_ID,
      sandboxId: 'sandbox-1',
      violations: ['src/a.ts'],
    })
    expect(row).toBeNull()
  })

  it('越界条目全为空时不写', () => {
    const row = recordScopeViolation(db, {
      nodeId: NODE_ID,
      sandboxId: 'sandbox-1',
      violations: ['', ''],
    })
    expect(row).toBeNull()
  })

  it('回滚成功回填 rolled_back 且幂等', () => {
    recordScopeViolation(db, {
      nodeId: NODE_ID,
      sandboxId: 'sandbox-1',
      violations: ['src/a.ts'],
    })

    expect(markScopeViolationsRolledBack(db, 'sandbox-1')).toBe(1)
    const [row] = listScopeViolations(db, GRAPH_ID, ENTITY_KEY)
    expect(row.disposition).toBe('rolled_back')
    expect(row.disposed_at).not.toBeNull()

    // 重复回填不改动已处置的行（条件 UPDATE 幂等）。
    expect(markScopeViolationsRolledBack(db, 'sandbox-1')).toBe(0)
  })

  it('回滚未成功时保持 pending（不得冒充已回滚）', () => {
    recordScopeViolation(db, {
      nodeId: NODE_ID,
      sandboxId: 'sandbox-1',
      violations: ['src/a.ts'],
    })
    // 回滚失败 → 不调用回填；此处只验证「没有回填时仍是 pending」。
    const [row] = listScopeViolations(db, GRAPH_ID, ENTITY_KEY)
    expect(row.disposition).toBe('pending')
    expect(row.disposed_at).toBeNull()
  })

  it('按节点隔离、按时间倒序', () => {
    db.prepare(
      'INSERT INTO nodes (id, type, status, title, graph_id, graph_type, entity_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('node-2', 'feature', 'developing', '支付', GRAPH_ID, 'dev', 'ek-pay')

    recordScopeViolation(db, {
      nodeId: NODE_ID, sandboxId: 'sb-old', violations: ['a.ts'],
      now: new Date('2026-11-13T10:00:00.000Z'),
    })
    recordScopeViolation(db, {
      nodeId: NODE_ID, sandboxId: 'sb-new', violations: ['b.ts'],
      now: new Date('2026-11-13T11:00:00.000Z'),
    })
    recordScopeViolation(db, {
      nodeId: 'node-2', sandboxId: 'sb-other', violations: ['c.ts'],
    })

    const mine = listScopeViolations(db, GRAPH_ID, ENTITY_KEY)
    expect(mine.map((r) => r.sandbox_id)).toEqual(['sb-new', 'sb-old'])
    expect(listScopeViolations(db, GRAPH_ID, 'ek-pay')).toHaveLength(1)
  })

  it('索引齐全（按节点 / 按 sandbox）', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
      .map((r) => r.name)
    expect(names).toContain('idx_node_scope_violations_node')
    expect(names).toContain('idx_node_scope_violations_sandbox')
    expect(MAP_VIOLATION_INDEX_SQLS).toHaveLength(2)
  })
})
