/**
 * Recipe IPC Handlers
 *
 * 暴露给渲染进程的 Recipe 操作：
 *   - recipes:list          → RecipeDefinition[]
 *   - recipes:get           → RecipeDefinition
 *   - recipes:dag           → RecipeDag（静态 DAG 视图，D5c-1）
 *   - recipes:run           → RecipeRun（异步返回最终结果）
 *   - recipes:cancel        → boolean
 *   - recipes:refresh       → 强制重扫 userData + 项目级目录
 *   - recipes:listRuns      → RecipeRun[]（某 recipe 的历史 runs）
 *   - recipes:getRun        → RecipeRun | null
 *
 * 推送事件：
 *   - recipe:run:progress   → RecipeRunProgressEvent（D5c-3，RecipeRunner → renderer）
 */

import type { TypedHandle } from './utils'
import { ensureString } from './utils'
import type { RecipeManager } from '../recipes/recipe-manager'
import type { RecipeRunner } from '../recipes/recipe-runner'
import { ErrorCode, IpcError } from '../errors'
import type { RecipeRunRequest } from '@shared/types/recipe'
import { buildRecipeDag } from '@shared/recipe-dag'
import type { BrowserWindow } from 'electron'

export interface RecipeHandlerDeps {
  manager: RecipeManager
  runner: RecipeRunner
}

export function registerRecipeHandlers(
  deps: RecipeHandlerDeps,
  typedHandle: TypedHandle,
  getMainWindow?: () => BrowserWindow | null,
): void {
  const { manager, runner } = deps

  typedHandle('recipes:list', async () => {
    return manager.list()
  })

  typedHandle('recipes:get', async (_, id: unknown) => {
    const recipeId = ensureString('id', id)
    return manager.get(recipeId) ?? null
  })

  typedHandle('recipes:dag', async (_, id: unknown) => {
    const recipeId = ensureString('id', id)
    const def = manager.get(recipeId)
    if (!def) {
      throw new IpcError(`Recipe not found: ${recipeId}`, ErrorCode.RECIPE_NOT_FOUND)
    }
    return buildRecipeDag(def)
  })

  typedHandle('recipes:run', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new IpcError('recipes:run requires a request object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const r = request as Record<string, unknown>
    const recipeId = ensureString('recipeId', r.recipeId)
    const parentSessionId = typeof r.parentSessionId === 'string' ? r.parentSessionId : undefined
    const nodeId = typeof r.nodeId === 'string' ? r.nodeId : undefined
    const inputs: Record<string, string | number | boolean> = {}
    if (r.inputs !== undefined && r.inputs !== null) {
      if (typeof r.inputs !== 'object') {
        throw new IpcError('inputs must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      for (const [k, v] of Object.entries(r.inputs as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          inputs[k] = v
        } else {
          throw new IpcError(
            `inputs.${k} must be string|number|boolean`,
            ErrorCode.IPC_INVALID_ARGUMENT,
          )
        }
      }
    }
    const req: RecipeRunRequest = {
      recipeId,
      inputs,
      parentSessionId,
      nodeId,
    }
    return runner.run(req)
  })

  typedHandle('recipes:cancel', async (_, runId: unknown) => {
    const id = ensureString('runId', runId)
    return runner.cancel(id)
  })

  typedHandle('recipes:refresh', async () => {
    await manager.refresh()
    return manager.list().length
  })

  typedHandle('recipes:listRuns', async (_, recipeId: unknown, limit: unknown) => {
    const id = ensureString('recipeId', recipeId)
    const lim = typeof limit === 'number' ? limit : 50
    return runner.listRuns(id, lim)
  })

  typedHandle('recipes:getRun', async (_, runId: unknown) => {
    const id = ensureString('runId', runId)
    return runner.getRun(id) ?? null
  })

  // Push step-level progress events to the renderer (D5c-3).
  // RecipeRunner 不直接持有 BrowserWindow 引用 —— 它通过 onProgress 回调把事件
  // 传出来，IPC 层负责转发到当前主窗口。这避免 RecipeRunner 与 Electron UI 耦合。
  if (getMainWindow) {
    runner.setProgressListener((event) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('recipe:run:progress', event)
      }
    })
  }
}