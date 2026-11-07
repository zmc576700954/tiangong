/**
 * S1 迁移状态机（§8.14.1）真库回归。
 *
 * 覆盖：阶段记录语义（running/ok/partial/failed）、心跳、latest 查询、
 * 孤儿 _backup/_new 五场景判定、启动预检 fail-closed（integrity/FK/
 * failed 阻断/并发互斥/半迁移/partial 续跑白名单）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  MapMigrationStore,
  MapMigrationBlockedError,
  runMigrationStage,
  preflightStartup,
  isResumeMigrationRequested,
  HEARTBEAT_STALE_MS,
} from '../map-migration/migration-state'

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE map_migration_reports (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK(kind IN (
        'entity_key_backfill','link_backfill','integrity_check','import_dedup',
        'derivation','cleanup')),
      stage         TEXT,
      schema_version INTEGER,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      heartbeat_at  TEXT,
      owner_pid     INTEGER,
      status        TEXT NOT NULL CHECK(status IN ('running','ok','partial','failed')),
      stats_json    TEXT,
      details_json  TEXT,
      error_json    TEXT
    )
  `)
  return db
}

const SCHEMA_VERSION = 26

describe('MapMigrationStore 阶段记录', () => {
  let db: BetterSqlite3.Database
  let store: MapMigrationStore

  beforeEach(() => {
    db = setupDb()
    store = new MapMigrationStore(db)
  })

  it('startStage 写 running 行（owner_pid/started_at/heartbeat_at），completeStage(ok) 补 finished_at+stats', () => {
    const id = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    const running = db.prepare('SELECT * FROM map_migration_reports WHERE id=?').get(id) as Record<string, unknown>
    expect(running.status).toBe('running')
    expect(running.owner_pid).toBe(process.pid)
    expect(running.started_at).toBeTruthy()
    expect(running.heartbeat_at).toBeTruthy()

    store.completeStage(id, 'ok', { stats: { matched: 3, null_after: 0 } })
    const done = db.prepare('SELECT * FROM map_migration_reports WHERE id=?').get(id) as Record<string, unknown>
    expect(done.status).toBe('ok')
    expect(done.finished_at).toBeTruthy()
    expect(JSON.parse(done.stats_json as string)).toEqual({ matched: 3, null_after: 0 })
  })

  it('completeStage(failed) 记 error_json；重跑同一阶段新建行不覆盖历史', () => {
    const first = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    store.completeStage(first, 'failed', { error: new Error('boom') })
    const second = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    store.completeStage(second, 'ok', { stats: {} })

    const rowById = (id: string) => db.prepare('SELECT * FROM map_migration_reports WHERE id=?').get(id) as Record<string, unknown>
    expect(rowById(first).status).toBe('failed')
    expect(JSON.parse(rowById(first).error_json as string)).toEqual({ message: 'boom' })
    expect(rowById(second).status).toBe('ok')
    // 两次运行 = 两行历史,互不覆盖
    const count = db.prepare("SELECT COUNT(*) AS c FROM map_migration_reports WHERE stage='S1.backfill'").get() as { c: number }
    expect(count.c).toBe(2)

    const latest = store.latestStage('entity_key_backfill', 'S1.backfill')
    expect(latest?.status).toBe('ok')
  })

  it('runMigrationStage：工作成功→ok，抛错→failed 且异常向上传播', () => {
    runMigrationStage(db, {
      kind: 'integrity_check',
      stage: 'S1.verify',
      schemaVersion: SCHEMA_VERSION,
      work: () => ({ stats: { checked: 1 } }),
    })
    expect(store.latestStage('integrity_check', 'S1.verify')?.status).toBe('ok')

    expect(() =>
      runMigrationStage(db, {
        kind: 'integrity_check',
        stage: 'S1.verify',
        schemaVersion: SCHEMA_VERSION,
        work: () => {
          throw new Error('verify blew up')
        },
      }),
    ).toThrow('verify blew up')
    expect(store.latestStage('integrity_check', 'S1.verify')?.status).toBe('failed')
  })
})

describe('孤儿 _backup/_new 五场景判定', () => {
  let db: BetterSqlite3.Database
  let store: MapMigrationStore

  beforeEach(() => {
    db = setupDb()
    store = new MapMigrationStore(db)
  })

  function createTables(...names: string[]): void {
    for (const name of names) {
      db.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`)
    }
  }

  it('无备份现场 → 空数组', () => {
    expect(store.scanOrphanBackupTables()).toEqual([])
  })

  it('original+backup+new → blocking（重建中断歧义）', () => {
    createTables('nodes', 'nodes_backup', 'nodes_new')
    const findings = store.scanOrphanBackupTables()
    expect(findings).toHaveLength(1)
    expect(findings[0].blocking).toBe(true)
    expect(findings[0].scenario).toContain('original+backup+new')
  })

  it('original+backup 无 new → 不阻断（上次重建完成未清理）', () => {
    createTables('edges', 'edges_backup')
    const findings = store.scanOrphanBackupTables()
    expect(findings).toHaveLength(1)
    expect(findings[0].blocking).toBe(false)
  })

  it('仅 backup / 仅 new → blocking', () => {
    createTables('graphs_backup', 'bugs_new')
    const findings = store.scanOrphanBackupTables()
    expect(findings).toHaveLength(2)
    expect(findings.every((f) => f.blocking)).toBe(true)
  })

  it('backup+new 无原表 → blocking', () => {
    createTables('wiki_pages_backup', 'wiki_pages_new')
    const findings = store.scanOrphanBackupTables()
    expect(findings).toHaveLength(1)
    expect(findings[0].blocking).toBe(true)
  })
})

describe('preflightStartup fail-closed', () => {
  let db: BetterSqlite3.Database
  let store: MapMigrationStore

  beforeEach(() => {
    db = setupDb()
    store = new MapMigrationStore(db)
  })

  it('干净库 → 通过', () => {
    expect(() => preflightStartup(db, store, { resumeRequested: false })).not.toThrow()
  })

  it('failed 阶段 → 拒绝启动（恢复备份或人工修复）', () => {
    const id = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    store.completeStage(id, 'failed', { error: 'x' })
    expect(() => preflightStartup(db, store, { resumeRequested: true })).toThrowError(MapMigrationBlockedError)
    try {
      preflightStartup(db, store, { resumeRequested: true })
    } catch (err) {
      expect((err as MapMigrationBlockedError).reason).toBe('stage_failed')
    }
  })

  it('另一存活实例持有 running 阶段 → 拒绝启动（并发互斥）', () => {
    const id = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    // 模拟另一实例：改写 owner_pid 为一个存活进程（当前进程以外的——用 1，init 进程恒存在）
    db.prepare('UPDATE map_migration_reports SET owner_pid = 1 WHERE id = ?').run(id)
    expect(() => preflightStartup(db, store, { resumeRequested: true })).toThrowError(MapMigrationBlockedError)
    try {
      preflightStartup(db, store, { resumeRequested: true })
    } catch (err) {
      expect((err as MapMigrationBlockedError).reason).toBe('another_instance_migrating')
    }
  })

  it('半迁移（本进程 pid 但心跳过期）→ 未显式续跑时拒绝；--resume-migration 放行', () => {
    const id = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    // 心跳拨老：超过 10 分钟
    const stale = new Date(Date.now() - HEARTBEAT_STALE_MS - 1000).toISOString()
    db.prepare('UPDATE map_migration_reports SET heartbeat_at = ? WHERE id = ?').run(stale, id)

    expect(() => preflightStartup(db, store, { resumeRequested: false })).toThrowError(MapMigrationBlockedError)
    try {
      preflightStartup(db, store, { resumeRequested: false })
    } catch (err) {
      expect((err as MapMigrationBlockedError).reason).toBe('half_migration')
    }
    expect(() => preflightStartup(db, store, { resumeRequested: true })).not.toThrow()
  })

  it('partial 且不可续跑阶段 → 拒绝；可续跑白名单内放行', () => {
    const id = store.startStage({ kind: 'integrity_check', stage: 'S4.rebuild', schemaVersion: SCHEMA_VERSION })
    store.completeStage(id, 'partial', { details: {} })
    expect(() => preflightStartup(db, store, { resumeRequested: true })).toThrowError(MapMigrationBlockedError)

    // 移除不可续跑现场后,白名单内的 partial 允许续跑
    db.prepare('DELETE FROM map_migration_reports WHERE id = ?').run(id)
    const id2 = store.startStage({ kind: 'entity_key_backfill', stage: 'S1.backfill', schemaVersion: SCHEMA_VERSION })
    store.completeStage(id2, 'partial', { details: { resume_from: 'project-b' } })
    expect(() => preflightStartup(db, store, { resumeRequested: true })).not.toThrow()
  })

  it('孤儿 backup 歧义现场 → 拒绝启动', () => {
    db.exec('CREATE TABLE nodes_backup (id TEXT PRIMARY KEY)')
    db.exec('CREATE TABLE nodes_new (id TEXT PRIMARY KEY)')
    expect(() => preflightStartup(db, store, { resumeRequested: false })).toThrowError(MapMigrationBlockedError)
    try {
      preflightStartup(db, store, { resumeRequested: false })
    } catch (err) {
      expect((err as MapMigrationBlockedError).reason).toBe('orphan_backup_ambiguous')
    }
  })

  it('表不存在的极老库 → 阶段类检查跳过，不误伤', () => {
    db.exec('DROP TABLE map_migration_reports')
    expect(() => preflightStartup(db, store, { resumeRequested: false })).not.toThrow()
  })
})

describe('isResumeMigrationRequested', () => {
  it('识别 --resume-migration', () => {
    expect(isResumeMigrationRequested(['electron', '.', '--resume-migration'])).toBe(true)
    expect(isResumeMigrationRequested(['electron', '.'])).toBe(false)
  })
})
