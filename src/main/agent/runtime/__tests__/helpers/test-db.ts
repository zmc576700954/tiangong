/**
 * 测试用 SQLite 句柄。
 *
 * 仓库根目录的 better-sqlite3 原生模块是为 Electron ABI 编译的，
 * 直接在 Node/vitest 下 new Database 会抛 NODE_MODULE_VERSION 不匹配。
 * 这里优先用根依赖；失败时回退到 spikes/agent-core 中同版本、Node ABI 的副本
 * （spike 基线环境）。两条路径都不可用时给出可读报错，而不是静默 mock。
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { applyAgentSchema } from '../../db/schema'

const requireFromHere = createRequire(import.meta.url)

interface DatabaseConstructor {
  new (filename: string): BetterSqlite3.Database
}

function tryConstructor(modulePath: string): DatabaseConstructor | null {
  try {
    const mod = requireFromHere(modulePath) as DatabaseConstructor | { default: DatabaseConstructor }
    return typeof mod === 'function' ? (mod as DatabaseConstructor) : mod.default
  } catch {
    return null
  }
}

export function openTestDb(applySchema = true): BetterSqlite3.Database {
  const direct = tryConstructor('better-sqlite3')
  const fallback = path.resolve(process.cwd(), 'spikes/agent-core/node_modules/better-sqlite3')
  const candidates = [direct, tryConstructor(fallback)].filter((item): item is DatabaseConstructor => item !== null)

  for (const Ctor of candidates) {
    try {
      const db = new Ctor(':memory:')
      db.pragma('foreign_keys = ON')
      if (applySchema) applyAgentSchema(db)
      return db
    } catch {
      // 继续尝试下一个 ABI 副本
    }
  }

  throw new Error(
    'No Node-ABI better-sqlite3 available. Root module targets Electron ABI; ' +
      'spikes/agent-core/node_modules/better-sqlite3 is the expected local fallback.',
  )
}
