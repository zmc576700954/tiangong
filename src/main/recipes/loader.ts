/**
 * Recipe 加载器（双层加载 + 项目级覆盖用户级）
 *
 * 加载路径：
 * - 用户级：`<userData>/recipes/*.yaml`（跨项目共享）
 * - 项目级：`<workingDirectory>/.bizgraph/recipes/*.yaml`（项目专属，覆盖用户级）
 *
 * 设计要点：
 * - 文件名（不含扩展名）作为 Recipe id
 * - 同 id 时 project 覆盖 user
 * - 非法 YAML 不污染成功列表（错误抛到调用方）
 * - 不存在的目录返回空数组（不抛错）
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import { parseRecipeYaml } from './yaml-loader'
import type { RecipeWithSource } from '@shared/types'

/**
 * 用户级 Recipe 目录：`<userData>/recipes/`。
 *
 * `app.getPath('userData')` 返回路径已在 main 进程合法目录内（renderer 写入受 IPC 限制）。
 */
export function getUserRecipeDir(): string {
  return path.join(app.getPath('userData'), 'recipes')
}

/**
 * 项目级 Recipe 目录：`<workingDirectory>/.bizgraph/recipes/`。
 *
 * 未传 workingDirectory 时返回 null（跳过项目级加载）。
 */
export function getProjectRecipeDir(workingDirectory?: string): string | null {
  if (!workingDirectory) return null
  return path.join(workingDirectory, '.bizgraph', 'recipes')
}

/**
 * 扫描目录中的所有 Recipe YAML。
 *
 * @param dir 目录绝对路径
 * @param source 来源标签（'user' 或 'project'）
 * @returns RecipeWithSource[]（含 filePath；非法 yaml 抛出 RECIPE_PARSE_ERROR）
 */
async function scanDir(dir: string, source: 'user' | 'project'): Promise<RecipeWithSource[]> {
  const out: RecipeWithSource[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    // 目录不存在或无权限 — 返回空数组（不抛错）
    return out
  }

  for (const name of entries) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    const filePath = path.join(dir, name)
    const raw = await fs.readFile(filePath, 'utf-8')
    const def = parseRecipeYaml(filePath, raw) // 失败抛 RECIPE_PARSE_ERROR
    out.push({
      ...def,
      source,
      filePath,
    })
  }
  return out
}

/**
 * 加载所有 Recipe（用户级 + 项目级，项目级覆盖用户级）。
 *
 * 同 id（文件名 basename）冲突时，project 覆盖 user。
 *
 * @param workingDirectory 项目根目录（可选，传则加载项目级；不传则仅用户级）
 * @returns RecipeWithSource[]（去重后）
 */
export async function loadAllRecipes(workingDirectory?: string): Promise<RecipeWithSource[]> {
  const userDir = getUserRecipeDir()
  const projectDir = getProjectRecipeDir(workingDirectory)

  const userRecipes = await scanDir(userDir, 'user')
  const projectRecipes = projectDir ? await scanDir(projectDir, 'project') : []

  // 项目级覆盖用户级（按文件名 basename 作为 id）
  const merged = new Map<string, RecipeWithSource>()
  for (const r of userRecipes) {
    const id = path.basename(r.filePath, path.extname(r.filePath))
    merged.set(id, r)
  }
  for (const r of projectRecipes) {
    const id = path.basename(r.filePath, path.extname(r.filePath))
    merged.set(id, r)
  }
  return [...merged.values()]
}