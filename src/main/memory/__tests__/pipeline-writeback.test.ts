/**
 * 管线 writeback 阶段测试
 *
 * 测试策略：用 createDefault({ skip: [...] }) 只保留 writeback 阶段，
 * mock 掉全局单例 getClient（指向真实内存库）与 readSettings（可编程设置），
 * 直接以 initial context 喂入 sessionId/nodeId/memories，验证开关与写库行为。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { MemoryItem } from '@shared/types'
import { readSettings } from '../../settings'
import { getClient } from '../../database'
import { PipelineRunner } from '../pipeline'

// writeback 阶段动态 import 的是 '../../settings' 与 '../../database'（相对 pipeline.ts），
// vitest 按解析后的绝对路径匹配模块 id，此处 mock 对本测试文件同样生效。
vi.mock('../../settings', () => ({
  readSettings: vi.fn(),
}))
vi.mock('../../database', () => ({
  getClient: vi.fn(),
}))

const mockReadSettings = vi.mocked(readSettings)
const mockGetClient = vi.mocked(getClient)

/** 除 writeback 外的全部默认阶段名 */
const OTHER_STAGES = ['normalize', 'compress', 'extract', 'verify', 'compile', 'waterline', 'node-bind', 'persist']

/** 最小真实内存库：只建 writeback 阶段依赖的 graphs/nodes/writeback_items */
function makeDb() {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('online', 'dev')),
      project_path TEXT,
      writeback_disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('project', 'module', 'process', 'feature', 'bug', 'wiki-page')),
      status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder')),
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL CHECK(graph_type IN ('online', 'dev')),
      parent_id TEXT,
      rules TEXT,
      metadata TEXT,
      owner_role TEXT CHECK(owner_role IN ('product', 'developer', 'tester')),
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      content TEXT,
      community_summary TEXT,
      community_level INTEGER,
      community_id TEXT,
      context_refs TEXT,
      wiki_content TEXT,
      wiki_meta TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE writeback_items (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('append-log','new-page')),
      target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `)
  db.prepare(
    `INSERT INTO graphs (id, name, type, created_at, updated_at) VALUES ('g1', 'G1', 'online', '2026-01-01', '2026-01-01')`,
  ).run()
  db.prepare(
    `INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, created_at, updated_at)
     VALUES ('n1', 'feature', 'confirmed', 'Node A', 'g1', 'online', 0, 0, '2026-01-01', '2026-01-01')`,
  ).run()
  return db
}

function makeMemory(overrides?: Partial<Omit<MemoryItem, 'id'>>): Omit<MemoryItem, 'id'> {
  return {
    session_id: 'sess_1',
    kind: 'discovery',
    project_id: 'g1',
    node_id: 'n1',
    title: '发现 X',
    narrative: 'narrative',
    facts: [],
    concepts: [],
    files_read: [],
    files_modified: [],
    adapter_name: 'claude-code',
    token_cost: 100,
    confidence: 0.8,
    created_at: '2026-07-30T00:00:00Z',
    ...overrides,
  } as Omit<MemoryItem, 'id'>
}

async function runWritebackOnly(initial: Parameters<PipelineRunner['run']>[0]) {
  const runner = await PipelineRunner.createDefault({ skip: OTHER_STAGES })
  return runner.run(initial)
}

function countWritebackRows(db: BetterSqlite3.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM writeback_items').get() as { c: number }).c
}

describe('pipeline writeback stage', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb()
    mockGetClient.mockReturnValue(db)
    // 默认：settings 无 writeback 字段 → 视为开启
    mockReadSettings.mockResolvedValue({ version: 1, cliTools: [], apiKeys: [], mcpServers: [] })
  })

  afterEach(() => {
    db.close()
  })

  it('writes pending items on happy path (settings field absent → default enabled)', async () => {
    const result = await runWritebackOnly({
      sessionId: 'sess_1',
      nodeId: 'n1',
      memories: [makeMemory()],
    })

    expect(result.errors).toHaveLength(0)
    const rows = db
      .prepare(`SELECT * FROM writeback_items WHERE graph_id = 'g1' AND status = 'pending'`)
      .all() as Array<{ kind: string; target_node_id: string; source_session_id: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].kind).toBe('append-log')
    expect(rows[0].target_node_id).toBe('n1')
    expect(rows[0].source_session_id).toBe('sess_1')
  })

  it('writes pending items when writeback.enabled is explicitly true', async () => {
    mockReadSettings.mockResolvedValue({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [],
      writeback: { enabled: true },
    })

    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })

    expect(countWritebackRows(db)).toBeGreaterThanOrEqual(1)
  })

  it('skips when globally disabled (writeback.enabled === false)', async () => {
    mockReadSettings.mockResolvedValue({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [],
      writeback: { enabled: false },
    })

    const result = await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })

    expect(result.errors).toHaveLength(0)
    expect(countWritebackRows(db)).toBe(0)
  })

  it('skips when project writeback_disabled = 1 (global enabled)', async () => {
    db.prepare(`UPDATE graphs SET writeback_disabled = 1 WHERE id = 'g1'`).run()

    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })

    expect(countWritebackRows(db)).toBe(0)
  })

  it('project cannot re-enable when globally disabled (单向覆盖)', async () => {
    mockReadSettings.mockResolvedValue({
      version: 1, cliTools: [], apiKeys: [], mcpServers: [],
      writeback: { enabled: false },
    })
    // writeback_disabled = 0（项目侧未关闭），但全局关 → 仍跳过
    const result = await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })

    expect(result.errors).toHaveLength(0)
    expect(countWritebackRows(db)).toBe(0)
  })

  it('skips when nodeId missing', async () => {
    await runWritebackOnly({ sessionId: 'sess_1', memories: [makeMemory()] })
    expect(countWritebackRows(db)).toBe(0)
  })

  it('skips when memories empty or absent', async () => {
    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [] })
    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1' })
    expect(countWritebackRows(db)).toBe(0)
  })

  it('skips when node not found', async () => {
    const result = await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'node_ghost', memories: [makeMemory()] })
    expect(result.errors).toHaveLength(0)
    expect(countWritebackRows(db)).toBe(0)
  })

  it('skips special pages (index/log/community)', async () => {
    db.prepare(
      `INSERT INTO nodes (id, type, status, title, graph_id, graph_type, position_x, position_y, wiki_meta, created_at, updated_at)
       VALUES ('n_index', 'wiki-page', 'confirmed', 'Graph Index', 'g1', 'online', 0, 0, '{"specialPage":"index"}', '2026-01-01', '2026-01-01')`,
    ).run()

    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n_index', memories: [makeMemory()] })

    expect(countWritebackRows(db)).toBe(0)
  })

  it('dedups by session: second run for same session creates nothing', async () => {
    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })
    const afterFirst = countWritebackRows(db)
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })
    expect(countWritebackRows(db)).toBe(afterFirst)
  })

  it('stage failure does not break run() — error stays contained', async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error('db boom')
    })

    const result = await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })

    // 阶段内部已 try/catch，异常不外逃、不进入 result.errors
    expect(result.errors).toHaveLength(0)
    expect(result.context.sessionId).toBe('sess_1')
  })

  it('settings read failure defaults to enabled', async () => {
    mockReadSettings.mockRejectedValue(new Error('settings boom'))

    const result = await runWritebackOnly({ sessionId: 'sess_1', nodeId: 'n1', memories: [makeMemory()] })

    expect(result.errors).toHaveLength(0)
    expect(countWritebackRows(db)).toBeGreaterThanOrEqual(1)
  })
})
