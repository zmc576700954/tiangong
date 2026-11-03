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
import { normalizeProjectPath } from '@shared/project-path'

// 规范化实现在 @shared/project-path —— **主进程与渲染层必须用同一份**。
// 曾经两边各有一份而语义不同（渲染层把 `\` 换成 `/`、主进程不换），
// 于是 POSIX 上 `/work/my\dir` 与 `/work/my/dir` 落到同一行 → A 项目的范围
// 默认值出现在 B 项目上。
export { normalizeProjectPath }

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
