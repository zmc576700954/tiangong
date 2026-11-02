/**
 * Project Settings Repository
 *
 * 项目级默认（适配器 / 模型 / 可改文件范围）。
 *
 * 为什么按 `project_path` 存、而不是挂在 `graphs` 上：一个项目有 online + dev
 * **两张**图，挂 graphs 上会重复两份，而且改一份要同步另一份。
 *
 * 为什么进 DB 而不是 settings.json：settings.json 是单文件整体重写，多窗口并发写
 * 会互相覆盖；且项目级配置天然是「每项目一份」，DB 的行模型正合适。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { ProjectDefaults } from '@shared/types'
import { safeJsonParse } from '../shared/db-utils'

/**
 * 规范化项目路径 —— 作为主键。
 *
 * 同一个目录若因写法不同（尾斜杠、`.`/`..` 段、分隔符差异）落到两行，
 * 用户就会看到「这个项目的设置没生效」。所以存取两侧都要过这个函数。
 */
export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath) return ''
  // 统一分隔符为 '/'
  const p = projectPath.replace(/\\/g, '/')
  // UNC 路径以 '//' 开头 —— 保留这个根前缀（去掉重复斜杠会把 '//server' 压成 '/server'）
  const isUnc = p.startsWith('//')
  const withoutDup = isUnc ? p.slice(2) : p.replace(/\/{2,}/g, '/')
  // 去掉尾斜杠（根路径除外）
  const trimmed = withoutDup.length > 1 ? withoutDup.replace(/\/+$/, '') : withoutDup
  // POSIX 绝对路径的根前缀
  const isAbsolute = trimmed.startsWith('/')
  // 解析 '.' 与 '..' 段（词法解析，不碰文件系统 —— 目录可能还不存在）
  const segments = trimmed.split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }
  const resolved = out.join('/')
  if (isUnc) return `//${resolved}`
  if (isAbsolute) return `/${resolved}`
  return resolved || '/'
}

function isProjectDefaults(val: unknown): val is ProjectDefaults {
  if (typeof val !== 'object' || val === null) return false
  const v = val as Record<string, unknown>
  if (v.defaultAdapter !== undefined && typeof v.defaultAdapter !== 'string') return false
  if (v.defaultModel !== undefined && typeof v.defaultModel !== 'string') return false
  if (v.allowedFiles !== undefined) {
    if (!Array.isArray(v.allowedFiles)) return false
    if (!v.allowedFiles.every((f) => typeof f === 'string')) return false
  }
  return true
}

export class ProjectSettingsRepository {
  constructor(private db: BetterSqlite3.Database) {}

  get(projectPath: string): ProjectDefaults | undefined {
    const key = normalizeProjectPath(projectPath)
    if (!key) return undefined
    const row = this.db
      .prepare('SELECT defaults_json FROM project_settings WHERE project_path = ?')
      .get(key) as { defaults_json?: string } | undefined
    if (!row?.defaults_json) return undefined
    // 脏数据不该让整个应用起不来 —— 解析失败就当作「没有设置」
    return safeJsonParse<ProjectDefaults | undefined>(row.defaults_json, undefined, isProjectDefaults)
  }

  set(projectPath: string, defaults: ProjectDefaults): void {
    const key = normalizeProjectPath(projectPath)
    if (!key) return
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO project_settings (project_path, defaults_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_path) DO UPDATE SET
         defaults_json = excluded.defaults_json,
         updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(defaults), now)
  }

  clear(projectPath: string): void {
    const key = normalizeProjectPath(projectPath)
    if (!key) return
    this.db.prepare('DELETE FROM project_settings WHERE project_path = ?').run(key)
  }
}
