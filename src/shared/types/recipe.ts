/**
 * Recipe YAML 工作流类型定义
 *
 * 基座版简化设计：每个 Recipe 是一个可复用的 Agent 任务模板，通过 SubagentManager
 * 派发为 `recipe:<id>` 自定义 subagent type。
 *
 * Schema 参考 Block Goose Recipes v1.0.0（https://block.github.io/goose/docs/getting-started/recipes）
 * - 借鉴：version/title/description/instructions/prompt/parameters
 * - 简化：不做 sub_recipes / response / extensions（DAG 编排留待 Phase D）
 */

export type RecipeParameterInputType = 'string' | 'number' | 'boolean'

/**
 * Recipe 参数定义（参考 Goose parameters schema）。
 *
 * 模板渲染时使用 `{{ key }}` 占位符（见 src/main/recipes/runner.ts）。
 * 必填但未提供时，替换结果为空字符串（不抛错，由调用方校验）。
 */
export interface RecipeParameter {
  /** 参数名（lower-kebab-case，用于 `{{ key }}` 替换） */
  key: string
  /** 参数类型，决定 UI 表单元素类型（input/checkbox/number） */
  inputType: RecipeParameterInputType
  /** 是否必填（基座版：仅 UI 提示，不强制校验） */
  required: boolean
  /** 默认值（缺省时使用） */
  default?: unknown
  /** 人类可读说明 */
  description?: string
}

/**
 * Recipe YAML 文件结构（基座版 v1.0.0）。
 *
 * instructions 和 prompt 至少一个（与 Goose 一致）。
 */
export interface RecipeDefinition {
  /** Schema 版本，格式 `"X.Y.Z"`，基座版固定 `"1.0.0"` */
  version: string
  /** 简短标题 */
  title: string
  /** 详细说明 */
  description: string
  /** 系统提示（注入到子代理 systemPromptAddon） */
  instructions?: string
  /** 用户提示（派发给子代理的主 prompt） */
  prompt?: string
  /** 参数定义 */
  parameters?: RecipeParameter[]
  /** 默认适配器（claude-code/codex/opencode/mcp/...） */
  defaultAdapter?: string
  /** 默认模型 */
  defaultModel?: string
  /** 子代理允许工具列表（默认 ['Read','Edit','Write','Bash']） */
  allowedTools?: string[]
  /** 子代理 scope 策略（默认 'subset'） */
  scopeStrategy?: 'subset' | 'inherit' | 'fresh'
}

/**
 * Recipe 运行记录（基座版：内存 Map 持久化；后续可改 DB 表）。
 */
export interface RecipeRun {
  /** Recipe run ID（generateId('reciperun')） */
  id: string
  /** Recipe 文件名（不含扩展名） */
  recipeId: string
  /** Recipe 版本号（与 RecipeDefinition.version 对应） */
  recipeVersion: string
  /** 用户填入的参数 */
  inputs: Record<string, unknown>
  /** 执行结果文本 */
  resultText: string
  /** 运行状态 */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  /** 开始时间戳（ms） */
  startedAt: number
  /** 结束时间戳（ms），未完成时为 undefined */
  finishedAt?: number
  /** 错误信息（status='failed' 时填入） */
  error?: string
  /** Token 消耗 */
  tokensUsed: number
}

/**
 * 加载后的 Recipe（带来源标签 + 文件路径）。
 *
 * 由 `src/main/recipes/loader.ts` 的 `loadAllRecipes` 返回。
 */
export interface RecipeWithSource extends RecipeDefinition {
  /** 来源：user = 用户全局目录；project = 项目级目录（优先级更高） */
  source: 'user' | 'project'
  /** YAML 文件绝对路径 */
  filePath: string
}