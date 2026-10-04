/**
 * RecipeRunner — 派发 Recipe 到 SubagentManager。
 *
 * 流程：
 * 1. 校验必填参数（findMissingRequired）
 * 2. 渲染 instructions + prompt（{{ key }} 替换）
 * 3. SubagentManager.invoke({ agentType: 'recipe:<id>', prompt, parentSessionId })
 * 4. 把 SubagentResult 包成 RecipeRun 返回
 *
 * 设计要点：
 * - Recipe 不直接驱动 AgentManager.startSession，而是走 SubagentManager，
 *   与父代理的 dispatch_subagent 共享同一条派发通道（基座版统一派发入口）
 * - 失败时回填 status='failed' + error 字段；不抛给上层（IPC 层包装为 toast）
 */

import type { SubagentManager } from '../agent/subagent-manager'
import type { RecipeRun, RecipeWithSource } from '@shared/types'
import { BizGraphError, ErrorCode } from '../errors'
import { generateId } from '../shared/env'
import { findMissingRequired, renderTemplate, slugifyRecipeId } from './template'

export interface RecipeRunArgs {
  /** Recipe 来源（用户级或项目级） */
  recipe: RecipeWithSource
  /** 用户填入的参数 */
  inputs: Record<string, unknown>
  /** 父会话 ID（用于 SubagentManager 派发） */
  parentSessionId: string
  /** 父消息 ID（可选） */
  parentMessageId?: string
  /** 关联节点 ID（可选） */
  nodeId?: string
  /** 显式允许的文件列表（覆盖 Recipe 默认 allowedFiles） */
  allowedFiles?: string[]
}

/**
 * 执行一次 Recipe，返回 RecipeRun 记录。
 *
 * 异常会被捕获并包装到 RecipeRun.error 字段（status='failed'）。
 */
export class RecipeRunner {
  constructor(private subagentManager: SubagentManager) {}

  async run(args: RecipeRunArgs): Promise<RecipeRun> {
    const { recipe, inputs, parentSessionId } = args
    const id = generateId('reciperun')
    const startedAt = Date.now()

    // 1. 必填参数校验
    const missing = findMissingRequired(recipe.parameters, inputs)
    if (missing.length > 0) {
      return {
        id,
        recipeId: slugifyRecipeId(recipe.title),
        recipeVersion: recipe.version,
        inputs,
        resultText: '',
        status: 'failed',
        startedAt,
        finishedAt: Date.now(),
        error: `Missing required parameters: ${missing.join(', ')}`,
        tokensUsed: 0,
      }
    }

    // 2. 渲染 prompt + instructions
    const renderedPrompt = renderTemplate(recipe.prompt, inputs)
    const renderedInstructions = renderTemplate(recipe.instructions, inputs)

    // 3. 派生 agent type 名（与 builtin/loader 注册保持一致）
    const recipeId = slugifyRecipeId(recipe.title)
    const agentType = `recipe:${recipeId}`

    // 4. 派发到 SubagentManager
    try {
      const result = await this.subagentManager.invoke({
        parentSessionId,
        parentMessageId: args.parentMessageId,
        nodeId: args.nodeId,
        agentType,
        description: recipe.title,
        // prompt 注入：prompt 优先，缺则取 instructions 当 prompt
        prompt: renderedPrompt || renderedInstructions,
        adapterName: recipe.defaultAdapter,
        allowedFiles: args.allowedFiles,
      })

      return {
        id,
        recipeId,
        recipeVersion: recipe.version,
        inputs,
        resultText: result.resultText,
        status: 'completed',
        startedAt,
        finishedAt: Date.now(),
        tokensUsed: result.tokensUsed,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      // BizGraphError 直接透传 code，其他包装为通用 UNKNOWN
      const code = err instanceof BizGraphError ? err.code : ErrorCode.UNKNOWN
      return {
        id,
        recipeId,
        recipeVersion: recipe.version,
        inputs,
        resultText: '',
        status: 'failed',
        startedAt,
        finishedAt: Date.now(),
        error: `${code}: ${errorMsg}`,
        tokensUsed: 0,
      }
    }
  }
}