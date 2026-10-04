/**
 * Recipe IPC Handlers
 *
 * 提供 5 个通道：
 * - `recipes:list` — 列出所有 Recipe（user + project + builtin）
 * - `recipes:run` — 执行 Recipe（需要 parentSessionId + inputs）
 * - `recipes:listRuns` — 查询历史 RecipeRun
 * - `recipes:getBuiltIn` — 只列出 builtin
 *
 * 基座版：RecipeRun 持久化用内存 Map（key=runId）。后续 Phase D 可改 DB 表。
 */

import type { TypedHandle } from './utils'
import { ensureString, ensureOptionalString } from './utils'
import type { SubagentManager } from '../agent/subagent-manager'
import type { RecipeRunner } from '../recipes/runner'
import { loadAllRecipes, getUserRecipeDir, getProjectRecipeDir } from '../recipes/loader'
import { loadBuiltInRecipes } from '../recipes/builtin'
import { slugifyRecipeId } from '../recipes/template'
import type {
  RecipeDefinition,
  RecipeRun,
  RecipeWithSource,
} from '@shared/types'
import { IpcError, ErrorCode } from '../errors'

/** 内存持久化的 RecipeRun 仓库（key=runId） */
const recipeRuns = new Map<string, RecipeRun>()

export interface RegisterRecipeHandlersDeps {
  subagentManager: SubagentManager
  runner: RecipeRunner
  /** 返回当前项目的 workingDirectory（用于加载 project 级 Recipe） */
  getWorkingDirectory: () => string | null
}

/**
 * 将 Recipe 注册为 SubagentManager 的自定义类型 `recipe:<slug>`。
 *
 * 该函数应在 IPC handlers 初始化之前调用（详见 ipc-handlers.ts）。
 * 内置 + 用户级 + 项目级都注册。
 */
export async function registerRecipesAsSubagentTypes(
  subagentManager: SubagentManager,
  getWorkingDirectory: () => string | null,
): Promise<RecipeDefinition[]> {
  const wd = getWorkingDirectory()
  const recipes = await loadAllRecipes(wd ?? undefined)
  for (const r of recipes) {
    registerOne(subagentManager, r)
  }
  // 内置 Recipe 也注册（id 前缀 builtin: 不冲突）
  try {
    const builtins = await loadBuiltInRecipes()
    for (const r of builtins) {
      registerOne(subagentManager, r)
    }
    return [...recipes, ...builtins]
  } catch {
    return recipes
  }
}

function registerOne(
  subagentManager: SubagentManager,
  r: RecipeDefinition | RecipeWithSource,
): void {
  const id = slugifyRecipeId(r.title)
  const agentType = `recipe:${id}`
  subagentManager.registerType({
    name: agentType,
    displayName: r.title,
    description: r.description,
    allowedTools: (r.allowedTools as unknown as import('@shared/types').SubagentToolName[] | '*') ?? ['Read', 'Edit', 'Write', 'Bash'],
    defaultAdapter: r.defaultAdapter,
    defaultModel: r.defaultModel,
    systemPromptAddon: r.instructions,
    scopeStrategy: r.scopeStrategy ?? 'subset',
  })
}

export function registerRecipeHandlers(
  deps: RegisterRecipeHandlersDeps,
  typedHandle: TypedHandle,
): void {
  const { runner, getWorkingDirectory } = deps

  /** 列出所有 Recipe（user + project + builtin） */
  typedHandle('recipes:list', async (): Promise<RecipeWithSource[]> => {
    const wd = getWorkingDirectory()
    const recipes = await loadAllRecipes(wd ?? undefined)
    // 标记 builtin 来源
    try {
      const builtins = await loadBuiltInRecipes()
      for (const b of builtins) {
        recipes.push({
          ...b,
          source: 'project', // builtin 在 UI 上以「内置」徽章呈现
          filePath: '<builtin>',
        })
      }
    } catch { /* builtin dir missing — skip */ }
    return recipes
  })

  /** 仅内置 Recipe */
  typedHandle('recipes:getBuiltIn', async (): Promise<RecipeWithSource[]> => {
    const builtins = await loadBuiltInRecipes()
    return builtins.map((b) => ({
      ...b,
      source: 'project',
      filePath: '<builtin>',
    }))
  })

  /** 执行 Recipe */
  typedHandle('recipes:run', async (
    _,
    recipe: unknown,
    inputs: unknown,
    parentSessionId: unknown,
  ): Promise<RecipeRun> => {
    if (!recipe || typeof recipe !== 'object') {
      throw new IpcError('recipe must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const r = recipe as RecipeWithSource
    const pid = ensureString('parentSessionId', parentSessionId)
    const ins = (inputs && typeof inputs === 'object' ? inputs : {}) as Record<string, unknown>
    const run = await runner.run({
      recipe: r,
      inputs: ins,
      parentSessionId: pid,
    })
    recipeRuns.set(run.id, run)
    return run
  })

  /** 列出历史 RecipeRun */
  typedHandle('recipes:listRuns', async (
    _,
    recipeId: unknown,
  ): Promise<RecipeRun[]> => {
    const id = ensureOptionalString('recipeId', recipeId)
    const all = [...recipeRuns.values()]
    if (id) return all.filter((r) => r.recipeId === id)
    return all.sort((a, b) => b.startedAt - a.startedAt)
  })

  /** 用户级 / 项目级目录（调试用） */
  typedHandle('recipes:getDirs', async () => ({
    user: getUserRecipeDir(),
    project: getProjectRecipeDir(getWorkingDirectory() ?? undefined),
  }))
}