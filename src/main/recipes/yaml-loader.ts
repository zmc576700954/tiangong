/**
 * Recipe YAML 解析器
 *
 * 输入：YAML 文件路径 + 原始字符串
 * 输出：RecipeDefinition（schema 校验后）
 * 失败：BizGraphError(RECIPE_PARSE_ERROR)，错误信息含 file + 字段路径
 *
 * 设计要点：
 * - 用 Zod 做 schema 校验（zod 已装在主仓库 node_modules）
 * - 失败信息包含文件名和字段路径，便于用户定位
 * - instructions 和 prompt 至少一个（与 Goose Recipe 兼容）
 */

import yaml from 'js-yaml'
import { z } from 'zod'
import { BizGraphError, ErrorCode } from '../errors'
import type { RecipeDefinition } from '@shared/types'

/**
 * Recipe parameter schema（参考 Goose `parameters[]` 字段）。
 */
const RecipeParameterSchema = z.object({
  key: z.string().min(1),
  inputType: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
})

/**
 * Recipe definition schema v1.0.0。
 *
 * 与 Goose Recipe 子集对齐：
 * - 必填：version / title / description
 * - 至少一个：instructions / prompt
 * - 可选：parameters / defaultAdapter / defaultModel / allowedTools / scopeStrategy
 */
const RecipeDefinitionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be in format X.Y.Z'),
  title: z.string().min(1, 'title is required and must be non-empty'),
  description: z.string().min(1, 'description is required and must be non-empty'),
  instructions: z.string().optional(),
  prompt: z.string().optional(),
  parameters: z.array(RecipeParameterSchema).optional(),
  defaultAdapter: z.string().optional(),
  defaultModel: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  scopeStrategy: z.enum(['subset', 'inherit', 'fresh']).optional(),
})

/**
 * 解析 Recipe YAML 文本。
 *
 * @param filePath 文件绝对路径（用于错误信息）
 * @param raw YAML 原始文本
 * @returns RecipeDefinition（schema 校验通过）
 * @throws BizGraphError(RECIPE_PARSE_ERROR) 当解析失败时
 */
export function parseRecipeYaml(filePath: string, raw: string): RecipeDefinition {
  let doc: unknown
  try {
    doc = yaml.load(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new BizGraphError(
      `Recipe parse error in ${filePath}: ${msg}`,
      ErrorCode.RECIPE_PARSE_ERROR,
    )
  }

  const result = RecipeDefinitionSchema.safeParse(doc)
  if (!result.success) {
    const first = result.error.issues[0]
    const pathHint = first.path.length > 0 ? ` at path ${first.path.join('.')}` : ''
    throw new BizGraphError(
      `Recipe schema error in ${filePath}${pathHint}: ${first.message}`,
      ErrorCode.RECIPE_PARSE_ERROR,
    )
  }

  const def = result.data as RecipeDefinition
  if (!def.instructions && !def.prompt) {
    throw new BizGraphError(
      `Recipe ${filePath} must have at least one of instructions or prompt`,
      ErrorCode.RECIPE_PARSE_ERROR,
    )
  }

  return def
}