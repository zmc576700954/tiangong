/**
 * 通用 schema 检测回归：UNIQUE 约束必须参与重建判定，且重建前对重复键 fail-closed。
 * 覆盖内联 `UNIQUE(...)` 与独立 `CREATE UNIQUE INDEX` 两种形态。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}))

import BetterSqlite3 from 'better-sqlite3'
import type BetterSqlite3DB from 'better-sqlite3'
import { rebuildTableIfNeeded, reconcileSchemaIndexes } from '../database'

describe('UNIQUE 约束参与重建判定', () => {
  let db: BetterSqlite3DB.Database

  beforeEach(() => {
    db = new BetterSqlite3(':memory:') as unknown as BetterSqlite3DB.Database
  })

  afterEach(() => db.close())

  function tableSql(name: string): string {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string }).sql
  }

  it('仅内联 UNIQUE 变化也会重建（不再静默保留旧约束）', () => {
    db.exec(`CREATE TABLE demo (
      id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL,
      UNIQUE(a, b, c)
    )`)
    db.exec(`INSERT INTO demo VALUES ('1', 'x', 'y', 'p'), ('2', 'x', 'z', 'q')`)

    rebuildTableIfNeeded(
      db,
      'demo',
      `CREATE TABLE demo (
        id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL,
        UNIQUE(a, b)
      )`,
      ['id', 'a', 'b', 'c'],
    )

    expect(tableSql('demo')).toMatch(/UNIQUE\(a, b\)/i)
    // 新约束确实生效：再插 (a,b) 重复应被拒绝
    expect(() => db.exec(`INSERT INTO demo VALUES ('3', 'x', 'y', 'r')`)).toThrow(/UNIQUE/)
  })

  it('新 UNIQUE 键在旧数据上重复 → fail-closed，报出表/键/组数且不丢行', () => {
    db.exec(`CREATE TABLE demo (
      id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL,
      UNIQUE(a, b, c)
    )`)
    db.exec(`INSERT INTO demo VALUES ('1', 'x', 'y', 'p'), ('2', 'x', 'y', 'q')`)

    expect(() =>
      rebuildTableIfNeeded(
        db,
        'demo',
        `CREATE TABLE demo (
          id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL,
          UNIQUE(a, b)
        )`,
        ['id', 'a', 'b', 'c'],
      ),
    ).toThrow(/demo.*UNIQUE\(a, b\) 存在 1 组重复键/s)

    // 拒绝后原表原样保留
    expect(tableSql('demo')).toMatch(/UNIQUE\(a, b, c\)/i)
    expect((db.prepare('SELECT COUNT(*) AS n FROM demo').get() as { n: number }).n).toBe(2)
  })

  it('独立唯一索引定义变化被对账替换，并对重复键 fail-closed', () => {
    db.exec('CREATE TABLE demo_idx (id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL)')
    db.exec('CREATE UNIQUE INDEX ux_demo_idx ON demo_idx(a)')
    db.exec(`INSERT INTO demo_idx VALUES ('1', 'x', 'm'), ('2', 'y', 'n')`)

    const expected = 'CREATE UNIQUE INDEX IF NOT EXISTS ux_demo_idx ON demo_idx(b)'
    reconcileSchemaIndexes(db, [expected])

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_demo_idx'").get() as { sql: string }).sql
    expect(sql.toLowerCase()).toContain('on demo_idx(b)')
    expect(() => db.exec(`INSERT INTO demo_idx VALUES ('3', 'z', 'm')`)).toThrow(/UNIQUE/)

    // 重复键场景：重建前必须拒绝
    db.exec('DROP INDEX ux_demo_idx')
    db.exec('CREATE UNIQUE INDEX ux_demo_idx ON demo_idx(a)')
    db.exec(`UPDATE demo_idx SET b = 'm' WHERE id = '2'`)
    expect(() => reconcileSchemaIndexes(db, [expected])).toThrow(/ux_demo_idx.*UNIQUE\(b\) 存在 1 组重复键/s)
  })
})
