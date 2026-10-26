/**
 * Recipe Manager
 *
 * 职责：
 *   1. 从两个来源加载 Recipe：
 *      - userData/recipes/*.yaml（用户级）
 *      - <workingDirectory>/.bizgraph/recipes/*.yaml（项目级；同 id 覆盖用户级）
 *   2. 持久化到 recipes 表（source_path + yaml_text + 解析后字段）。
 *   3. 提供 list / get / registerRecipe 供 IPC handler 调用。
 *   4. 提供 runRecipe 入口（实际上委托给 RecipeRunner）。
 *
 * 边界：
 *   - 单个坏 YAML 不会让整个加载流程崩溃（try/catch 每个文件）。
 *   - 工作目录改变时（项目切换）重新扫描项目级目录。
 *   - 不主动监听文件系统变化（编辑器直接改 .yaml 后用户点 Refresh 即可）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { createLogger } from '../shared/logger'
import { BizGraphError, ErrorCode } from '../errors'
import { parseRecipe, validateRecipeGraph } from './yaml-loader'
import type { RecipeDefinition } from '@shared/types/recipe'
import type Database from 'better-sqlite3'

const logger = createLogger('RecipeManager')

/** Recipe 加载来源（决定覆盖优先级：project > user）。 */
export type RecipeSource = 'user' | 'project'

/** RecipeManager 的最小依赖接口。便于测试时注入 mock database。 */
export interface RecipeManagerDeps {
  db: Database.Database
}

export class RecipeManager {
  private cache = new Map<string, RecipeDefinition>()
  /** 工作目录（项目级 Recipe 的扫描根）；null 时跳过项目级加载。 */
  private workingDirectory: string | null = null

  constructor(private deps: RecipeManagerDeps) {}

  /** 切换工作目录后调用：清缓存 → 重扫项目级。 */
  async setWorkingDirectory(workingDirectory: string | null): Promise<void> {
    this.workingDirectory = workingDirectory
    // 清掉所有项目级缓存（user 级保留）
    for (const [id, def] of this.cache.entries()) {
      if (def.source === 'project') this.cache.delete(id)
    }
    await this.scanProjectRecipes()
    this.validateGraphs()
  }

  /** 从两个目录加载所有 Recipe。失败的文件被记录到 logger，但不会抛错。 */
  async loadAll(): Promise<void> {
    this.cache.clear()
    await this.scanUserRecipes()
    await this.scanProjectRecipes()
    this.validateGraphs()
  }

  /** 项目级重扫后做一次图校验（user 级在 loadAll 时已并入）。 */
  private validateGraphs(): void {
    const all = new Map<string, RecipeDefinition>()
    for (const [id, def] of this.cache.entries()) all.set(id, def)
    for (const def of this.cache.values()) {
      if (def.sub_recipes && def.sub_recipes.length > 0) {
        try {
          validateRecipeGraph(def, all)
        } catch (err) {
          // 单个坏 recipe 不影响其它加载；从缓存中丢弃并日志记录。
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(`Recipe "${def.id}" failed graph validation: ${msg}`)
          this.cache.delete(def.id)
        }
      }
    }
  }

  private async scanUserRecipes(): Promise<void> {
    const userDir = path.join(app.getPath('userData'), 'recipes')
    await this.scanDirectory(userDir, 'user')
  }

  private async scanProjectRecipes(): Promise<void> {
    if (!this.workingDirectory) return
    const projectDir = path.join(this.workingDirectory, '.bizgraph', 'recipes')
    await this.scanDirectory(projectDir, 'project')
  }

  private async scanDirectory(dir: string, source: RecipeSource): Promise<void> {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      // 目录不存在是常态（首次启动 / 项目级未配置）。
      // 仅在目录确实存在但权限错误时记录。
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        logger.warn(`Failed to read recipes dir ${dir}:`, err)
      }
      return
    }
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
      const fullPath = path.join(dir, file)
      try {
        await this.loadOneFile(fullPath, source)
      } catch (err) {
        // 单个坏文件不影响其它加载。
        logger.warn(`Failed to load recipe ${fullPath}:`, err)
      }
    }
  }

  /** 解析单个 YAML 文件 → 校验 → 缓存 → 入库。 */
  private async loadOneFile(filePath: string, source: RecipeSource): Promise<RecipeDefinition> {
    const yamlText = await fs.readFile(filePath, 'utf8')
    const def = parseRecipe(yamlText)
    // 运行时派生字段
    const enriched: RecipeDefinition = { ...def, source, sourcePath: filePath }

    // 持久化（不影响缓存：缓存由当前扫描结果决定）
    this.upsertRecipeRow(enriched, yamlText)
    // 项目级覆盖用户级：缓存里同 id 的 user 级被替换
    this.cache.set(enriched.id, enriched)
    logger.info(`Loaded recipe "${enriched.id}" from ${filePath} (${source})`)
    return enriched
  }

  /** 写入/更新 recipes 表。 */
  private upsertRecipeRow(def: RecipeDefinition, yamlText: string): void {
    const now = new Date().toISOString()
    const inputsSchemaJson = def.inputs ? JSON.stringify(def.inputs) : null
    const stepsJson = JSON.stringify(def.steps ?? [])
    const tagsJson = def.tags ? JSON.stringify(def.tags) : null
    const source = def.source ?? 'user'

    const existing = this.deps.db
      .prepare('SELECT created_at FROM recipes WHERE id = ?')
      .get(def.id) as { created_at: string } | undefined

    if (existing) {
      this.deps.db.prepare(`
        UPDATE recipes
        SET name = ?, version = ?, description = ?, tags = ?, source = ?, source_path = ?,
            yaml_text = ?, inputs_schema = ?, steps_json = ?, default_adapter = ?, updated_at = ?
        WHERE id = ?
      `).run(
        def.name,
        def.version,
        def.description ?? null,
        tagsJson,
        source,
        def.sourcePath ?? '',
        yamlText,
        inputsSchemaJson,
        stepsJson,
        def.default_adapter ?? null,
        now,
        def.id,
      )
    } else {
      this.deps.db.prepare(`
        INSERT INTO recipes (id, name, version, description, tags, source, source_path, yaml_text, inputs_schema, steps_json, default_adapter, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        def.id,
        def.name,
        def.version,
        def.description ?? null,
        tagsJson,
        source,
        def.sourcePath ?? '',
        yamlText,
        inputsSchemaJson,
        stepsJson,
        def.default_adapter ?? null,
        now,
        now,
      )
    }
  }

  /** 列出所有已加载的 Recipe。 */
  list(): RecipeDefinition[] {
    return Array.from(this.cache.values())
  }

  /** 通过 id 获取 Recipe。未找到时返回 undefined。 */
  get(id: string): RecipeDefinition | undefined {
    return this.cache.get(id)
  }

  /** 通过 id 获取；未找到时抛 BizGraphError(RECIPE_NOT_FOUND)。 */
  getOrThrow(id: string): RecipeDefinition {
    const def = this.cache.get(id)
    if (!def) {
      throw new BizGraphError(`Recipe "${id}" not found`, ErrorCode.RECIPE_NOT_FOUND)
    }
    return def
  }

  /** 强制从指定目录重扫（用于 UI Refresh 按钮）。 */
  async refresh(): Promise<void> {
    await this.loadAll()
  }
}