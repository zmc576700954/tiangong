/**
 * 内置 Recipe 加载器（从打包资源中读取）。
 *
 * 路径解析：
 * - dev 模式：`<__dirname>/../../main/resources/recipes/*.yaml`
 *   （__dirname 是 src/main/recipes/，向上两级到 src/main/，再到 resources/recipes/）
 * - packaged：`<process.resourcesPath>/resources/recipes/*.yaml`
 *   （electron-builder 的 extraResources 把 src/main/resources 拷到 resources/）
 *
 * 内置 Recipe 的 id 统一带 `builtin-` 前缀，与用户/项目级 Recipe 区分。
 * 加载优先级：项目级 > 用户级 > 内置（用户同名 id 可覆盖内置）。
 *
 * 错误策略：单个坏文件跳过并记日志，不让内置资源问题拖垮整个加载流程。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import { createLogger } from '../shared/logger'
import { parseRecipe } from './yaml-loader'
import type { RecipeDefinition } from '@shared/types/recipe'

const logger = createLogger('RecipeBuiltin')

/**
 * 返回内置 Recipe 目录的绝对路径。
 *
 * dev：`__dirname/../../main/resources/recipes`
 * packaged：`process.resourcesPath/resources/recipes`
 */
export function getBuiltinRecipeDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'recipes')
  }
  // __dirname = src/main/recipes/ → 上两级到 src/，再 main/resources/recipes/
  return path.join(__dirname, '..', '..', 'main', 'resources', 'recipes')
}

/** 一个内置 Recipe 及其原始 YAML 文本（DB 的 yaml_text 列存原文）。 */
export interface BuiltinRecipe {
  def: RecipeDefinition
  yamlText: string
}

/**
 * 加载所有内置 Recipe YAML。
 *
 * 目录不存在时返回空数组（packaged 资源缺失的容错）。
 * 单个文件解析失败只跳过该文件。
 */
export async function loadBuiltInRecipes(): Promise<BuiltinRecipe[]> {
  const dir = getBuiltinRecipeDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const recipes: BuiltinRecipe[] = []
  for (const name of entries) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    const filePath = path.join(dir, name)
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const def = parseRecipe(raw)
      recipes.push({
        def: { ...def, source: 'builtin', sourcePath: filePath },
        yamlText: raw,
      })
    } catch (err) {
      logger.warn(`Failed to load builtin recipe ${filePath}:`, err)
    }
  }
  return recipes
}
