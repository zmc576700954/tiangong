import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mutation } from '../mutation'

export type Db = Database.Database

const SCHEMA = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8')

function configure(db: Db, filePath: string): void {
  if (filePath !== ':memory:') {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
  }
}

export function openDb(filePath = ':memory:'): Db {
  const db = new Database(filePath)
  configure(db, filePath)
  db.exec(SCHEMA)
  // 同一节点最多一个非终态 run（部分唯一索引）
  if (mutation() !== 'no-unique-index') {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_runs_active_node
      ON agent_runs(node_id)
      WHERE status IN ('created','running','awaiting_approval','cancelling','interrupted')
    `)
  }
  return db
}

/** 打开已被子进程建过表的库（崩溃恢复路径），不重复执行 DDL */
export function openExistingDb(filePath: string): Db {
  const db = new Database(filePath)
  configure(db, filePath)
  return db
}
