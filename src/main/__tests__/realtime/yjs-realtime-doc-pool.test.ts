/**
 * G1-13（W1）：Yjs doc 池按需装载。
 *
 * 新建图只写 graphs 行，不在启动时批量加载的 docs 里；WS 连接必须能按需装载，
 * 同时对不存在的 graphId 返回 undefined（不造孤儿 doc，避免绕过 1008 拒绝）。
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { YjsRealtime } from '../../realtime/snapshot/yjs-realtime'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY);
    CREATE TABLE yjs_snapshots (
      graph_id TEXT PRIMARY KEY,
      doc_state BLOB,
      schema_version INTEGER,
      updated_at TEXT
    );
    CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT);
    CREATE TABLE edges (id TEXT PRIMARY KEY, graph_id TEXT);
  `)
  return db
}

describe('YjsRealtime doc 池（G1-13）', () => {
  it('已建但启动后新增的图：getOrLoadDoc 按需装载并进入池', async () => {
    const db = setupDb()
    db.prepare("INSERT INTO graphs (id) VALUES ('g-new')").run()
    const realtime = new YjsRealtime(db, { disableWebSocket: true })

    expect(realtime.size()).toBe(0)
    const doc = realtime.getOrLoadDoc('g-new')
    expect(doc).toBeDefined()
    expect(realtime.size()).toBe(1)
    await realtime.shutdown()
  })

  it('不存在的图：返回 undefined，不写空 doc 进池', async () => {
    const db = setupDb()
    const realtime = new YjsRealtime(db, { disableWebSocket: true })

    expect(realtime.getOrLoadDoc('ghost')).toBeUndefined()
    expect(realtime.size()).toBe(0)
    await realtime.shutdown()
  })
})
