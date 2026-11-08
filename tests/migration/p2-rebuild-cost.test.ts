/**
 * P2 — 重建耗时与数据量（session-map 蓝图 §8.11）。
 *
 * 断言：
 *   - 1 万节点量级表重建 < 2s；
 *   - 重建前后行数一致、内容 hash 全等；
 *   - `PRAGMA foreign_key_check` 违规 0。
 *
 * 前提缺口：§8.11 要求“生产级副本计时”。CI 用合成 1 万行夹具，
 * 只能证明算法与阈值量级；真实生产副本的耗时仍需人工在生产副本上跑一次。
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { rebuildTableIfNeeded } from '../../src/main/database'

const ROWS = 10_000

function contentHash(db: BetterSqlite3.Database): string {
  const rows = db.prepare('SELECT * FROM p2_nodes ORDER BY id').all() as Array<Record<string, unknown>>
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

describe('P2 重建耗时与数据量', () => {
  it('1 万节点重建 < 2s、行数/hash 全等、FK 违规 0', () => {
    const db = new Database(':memory:') as unknown as BetterSqlite3.Database
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE p2_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('module','feature')),
        title TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        payload TEXT
      );
      CREATE TABLE p2_children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES p2_nodes(id) ON DELETE CASCADE
      );
    `)

    const insertNode = db.prepare('INSERT INTO p2_nodes (id, type, title, graph_id, payload) VALUES (?, ?, ?, ?, ?)')
    const insertChild = db.prepare('INSERT INTO p2_children (id, parent_id) VALUES (?, ?)')
    const seed = db.transaction(() => {
      for (let i = 0; i < ROWS; i++) {
        insertNode.run(`n-${i}`, i % 2 ? 'module' : 'feature', `node-${i}`, 'g-1', `payload-${i}`)
        if (i % 10 === 0) insertChild.run(`c-${i}`, `n-${i}`)
      }
    })
    seed()

    const beforeHash = contentHash(db)
    const beforeCount = (db.prepare('SELECT COUNT(*) AS c FROM p2_nodes').get() as { c: number }).c

    // 新 DDL 扩展 CHECK 值域：必然触发重建
    const createSql = `
      CREATE TABLE p2_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('module','feature','test-case')),
        title TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        payload TEXT
      )
    `
    db.pragma('foreign_keys = OFF')
    const started = performance.now()
    rebuildTableIfNeeded(db, 'p2_nodes', createSql, ['id', 'type', 'title', 'graph_id', 'payload'])
    const elapsed = performance.now() - started
    db.pragma('foreign_keys = ON')

    // 判据：单表 < 2s（1 万节点量级）
    expect(elapsed).toBeLessThan(2000)
    expect((db.prepare('SELECT COUNT(*) AS c FROM p2_nodes').get() as { c: number }).c).toBe(beforeCount)
    expect(contentHash(db)).toBe(beforeHash)

    const fkViolations = db.pragma('foreign_key_check') as unknown[]
    expect(fkViolations).toHaveLength(0)
  })
})
