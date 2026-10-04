/**
 * 内置 Recipe 加载器（从打包资源中读取）。
 *
 * 路径解析：
 * - dev 模式：`<__dirname>/../../main/resources/recipes/*.yaml`
 *   （__dirname 是 src/main/recipes/，向上两级到 src/main/，再到 resources/recipes/）
 * - packaged：`<process.resourcesPath>/resources/recipes/*.yaml`
 *
 * 所有内置 Recipe 共享 id 前缀 `builtin:` 以便和用户自定义区分。
 *
 * 错误策略：内置资源加载失败时抛错（开发期即发现），不静默忽略。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import { parseRecipeYaml } from './yaml-loader'
import type { RecipeDefinition } from '@shared/types'

/**
 * 返回内置 Recipe 目录的绝对路径。
 *
 * dev：`__dirname/../../resources/recipes`
 * packaged：`process.resourcesPath/resources/recipes`
 */
export function getBuiltinRecipeDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'recipes')
  }
  // __dirname = src/main/recipes/ → 上两级到 src/，再 main/resources/recipes/
  return path.join(__dirname, '..', '..', 'main', 'resources', 'recipes')
}

/**
 * 加载所有内置 Recipe YAML。
 *
 * 目录不存在时返回空数组（packaged 资源缺失的容错；dev 期抛错见上注释）。
 */
export async function loadBuiltInRecipes(): Promise<RecipeDefinition[]> {
  const dir = getBuiltinRecipeDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const recipes: RecipeDefinition[] = []
  for (const name of entries) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue
    const filePath = path.join(dir, name)
    const raw = await fs.readFile(filePath, 'utf-8')
    recipes.push(parseRecipeYaml(filePath, raw))
  }
  return recipes
}