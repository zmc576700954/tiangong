/**
 * D1 验收：9 张表 DDL、必需列、ux_turns_active 部分唯一索引，以及
 * 在「旧库」上追加 Agent 表时旧表行数不变（非破坏性迁移）。
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applyAgentSchema, AGENT_INDEX_SQLS, AGENT_TABLE_SCHEMAS } from '../db/schema'
import { openTestDb } from './helpers/test-db'

const EXPECTED_TABLES = [
  'agent_runs',
  'agent_sessions',
  'agent_turns',
  'agent_steps',
  'agent_events',
  'agent_approvals',
  'agent_artifacts',
  'agent_usage',
  'agent_snapshots',
]

function tableNames(db: ReturnType<typeof openTestDb>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
}

function columnsOf(db: ReturnType<typeof openTestDb>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
}

describe('Agent schema (D1)', () => {
  it('creates exactly the 9 M0 tables', () => {
    const db = openTestDb()
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES].sort())
    for (const schema of AGENT_TABLE_SCHEMAS) {
      expect(tableNames(db)).toContain(schema.name)
    }
  })

  it('exposes the M0 extensions required by the task', () => {
    const db = openTestDb()
    expect(columnsOf(db, 'agent_sessions')).toEqual(
      expect.arrayContaining([
        'executor_pid',
        'executor_pgid',
        'executor_started_at',
        'executor_cmd',
        'executor_env_marker',
        'residual_risk',
      ]),
    )
    expect(columnsOf(db, 'agent_usage')).toEqual(
      expect.arrayContaining(['graph_id', 'day_key', 'cost_micros']),
    )

    const stepSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_steps'").get() as { sql: string }
    ).sql
    expect(stepSql).toContain("'aborted'")

    const turnSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_turns'").get() as { sql: string }
    ).sql
    expect(turnSql).toContain("'queued'")
  })

  it('creates ux_turns_active as a partial unique index on active turns', () => {
    const db = openTestDb()
    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_turns_active'")
      .get() as { sql: string } | undefined
    expect(index).toBeDefined()
    expect(index!.sql.replace(/\s+/g, ' ')).toContain("WHERE status IN ('running','waiting_approval','cancelling')")

    const allIndexes = AGENT_INDEX_SQLS.join('\n')
    expect(allIndexes).toContain('ux_turns_active')
  })

  it('adds agent tables to a legacy database without touching existing rows', () => {
    const db = openTestDb(false)
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT, name TEXT);
      CREATE TABLE chat_threads (id TEXT PRIMARY KEY, node_id TEXT, title TEXT);
    `)
    db.prepare('INSERT INTO nodes (id, graph_id, name) VALUES (?, ?, ?)').run('n1', 'g1', 'Legacy node')
    db.prepare('INSERT INTO chat_threads (id, node_id, title) VALUES (?, ?, ?)').run('t1', 'n1', 'Legacy thread')

    const before = {
      nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
      threads: db.prepare('SELECT * FROM chat_threads ORDER BY id').all(),
    }
    const hashBefore = createHash('sha256').update(JSON.stringify(before)).digest('hex')

    applyAgentSchema(db)

    const after = {
      nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all(),
      threads: db.prepare('SELECT * FROM chat_threads ORDER BY id').all(),
    }
    const hashAfter = createHash('sha256').update(JSON.stringify(after)).digest('hex')

    expect(hashAfter).toBe(hashBefore)
    expect((before.nodes as unknown[]).length).toBe(1)
    expect((before.threads as unknown[]).length).toBe(1)
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES].sort())
  })
})
