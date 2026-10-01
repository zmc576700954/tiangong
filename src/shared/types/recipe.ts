/**
 * Recipes — YAML 可分享工作流
 *
 * 设计哲学（借鉴 Goose Recipes）：
 *   - Recipe 是一个声明式的多步骤工作流，可以跨项目、跨用户分享。
 *   - 步骤类型白名单：仅支持 agent / shell 两类，避免引入不可控的执行面。
 *   - agent 步骤复用 SubagentManager 路由，shell 步骤强制走 ScopeGuard。
 *   - Recipe 通过 dispatch_subagent 的 `recipe:<id>` 前缀被调用（参见 src/main/agent/subagent-manager.ts）。
 *   - 用户级（userData/recipes/）+ 项目级（<workingDir>/.bizgraph/recipes/）双层加载，项目级覆盖用户级。
 *
 * 风险边界：
 *   - shell 步骤的 command 是用户/项目作者在 YAML 中声明的字符串，必须经 ScopeGuard 黑名单校验。
 *   - YAML 解析失败 → 抛 BizGraphError（RECIPE_PARSE_ERROR），绝不让单个坏 recipe 把整个加载流程拖崩。
 *   - recipe_runs 的 outputs / error 字段保留调试能力，不参与 KV-cache 复用。
 */

// ============================================
// Recipe Definition
// ============================================

/** Recipe 步骤类型白名单。仅两类，避免任意执行入口。 */
export type RecipeStepKind = 'agent' | 'shell'

// ============================================
// Sub Recipe (D5a)
// ============================================

/**
 * SubRecipe —— Recipe 内嵌的子流程引用（受 Goose `sub_recipes` 启发）。
 *
 * 设计哲学（基座 v1 不变）：
 *   - 串行执行（D5b 再加 parallel / on_failure）。
 *   - 局部 `name` 作为 outputs 命名空间前缀：`sub_recipes[*].name` 必须 kebab-case 且唯一。
 *   - `recipe` 引用另一个 Recipe 的 id（解析期校验存在性）。
 *   - `inputs` 字典会经 `${inputs.x}` / `${outputs.<name>.field}` 模板渲染后传入被引用 Recipe。
 */
export interface SubRecipe {
  /** 局部名（kebab-case 且在本 Recipe 内唯一）。同时作为 outputs 命名空间前缀。 */
  name: string
  /** 引用的 Recipe id（必须存在于 RecipeManager 缓存）。 */
  recipe: string
  /** 传给被引用 Recipe 的 inputs。值允许 string|number|boolean。 */
  inputs?: Record<string, string | number | boolean>
}

/**
 * Recipe 完成条件（基座版预留，runner 当前只校验结构，不执行 LLM 判断）。
 * 阶段 2 接入 LLM-evaluator：把 recipe 最终输出喂给模型，让模型按条件字符串判断成功/失败。
 */
export interface RecipeResponse {
  /** 成功条件表达式（自然语言，LLM 解释）。 */
  success_condition?: string
  /** 失败条件表达式（自然语言，LLM 解释）。 */
  failure_condition?: string
}

/**
 * Recipe 步骤基类。kind 决定其余字段。
 *
 * 共享字段：
 *   - id：用于日志/diff/UI 锚定；缺省时由运行器按索引生成。
 *   - name：可选的人类可读标签。
 *   - description：步骤语义说明（写回 README / 调试输出）。
 *   - depends_on：步骤依赖（字符串列表，依赖项的 id 或 name）。用于串行执行前的拓扑校验。
 *
 * 不共享字段：见 RecipeAgentStep / RecipeShellStep。
 */
export interface RecipeStepBase {
  id?: string
  name?: string
  description?: string
  depends_on?: string[]
}

/** agent 步骤 —— 复用 SubagentManager.invoke() 的参数结构，但 prompt 支持 ${input.x} 模板。 */
export interface RecipeAgentStep extends RecipeStepBase {
  kind: 'agent'
  /**
   * Subagent 类型名。允许：
   *   - 内置类型（explore / implement / review / fix / general）
   *   - 用户自定义类型（settings.customAgentTypes 注册的）
   *   - 嵌套 recipe: `<recipe-id>`（运行器展开为多步骤）
   * 注意：本文件中"agent 步骤不直接接受 recipe: 前缀"——嵌套在运行器层做。
   */
  agent_type: string
  description: string
  /** 模板字符串，可用 ${input.<name>} 引用 recipe inputs。 */
  prompt: string
  /** 可选 adapter 覆盖。 */
  adapter_name?: string
  /** 可选节点绑定（画布上对应节点 id）。 */
  node_id?: string
  /** 允许的文件列表；缺省 = 仅读（scopeStrategy=inherit 时的行为）。 */
  allowed_files?: string[]
  /** 串行/并行控制：默认 false。true 时该步骤与同级并行启动。 */
  parallel?: boolean
}

/** shell 步骤 —— 仅允许静态命令白名单（rm / mv / curl 等）；强制走 ScopeGuard。 */
export interface RecipeShellStep extends RecipeStepBase {
  kind: 'shell'
  /** 静态命令字符串数组（argv 形式，避免 shell 解释器层注入）。 */
  command: string[]
  /** 命令运行的工作目录；${workdir} 模板会被替换为当前项目工作目录。 */
  cwd?: string
  /** 超时（毫秒）。默认 30_000。 */
  timeout_ms?: number
  /** 是否允许写入。false 时命令仅做读操作校验。 */
  writable?: boolean
}

export type RecipeStep = RecipeAgentStep | RecipeShellStep

/** YAML inputs schema 的简化版 —— 用于画布表单生成 + 运行期校验。 */
export interface RecipeInputSpec {
  /** 输入参数名（模板里的 ${input.<name>}）。 */
  name: string
  /** 人类可读标签。 */
  label?: string
  /** 类型：string | number | boolean | enum。 */
  type: 'string' | 'number' | 'boolean' | 'enum'
  /** 描述（鼠标 hover 提示）。 */
  description?: string
  /** 默认值。 */
  default?: string | number | boolean
  /** 必填。默认 true。 */
  required?: boolean
  /** enum 选项。仅 type=enum  时必填。 */
  options?: Array<string | number>
}

/** 完整的 Recipe 定义 —— 从 YAML 解析得到 + 入库。 */
export interface RecipeDefinition {
  /** 稳定 id（kebab-case）。YAML 中通过 `id:` 指定；缺省时从文件名推导。 */
  id: string
  /** 人类可读名称。 */
  name: string
  /** Recipe schema 版本。当前固定 "1"。 */
  version: '1'
  /** 描述。 */
  description?: string
  /** 标签，用于 UI 过滤。 */
  tags?: string[]
  /** 来源标识：'user'（userData） / 'project'（项目 .bizgraph/recipes/）。运行时派生，不存库。 */
  source?: 'user' | 'project'
  /** 来源文件绝对路径。运行时派生，不存库。 */
  sourcePath?: string
  /** 入参 schema。 */
  inputs?: RecipeInputSpec[]
  /** 步骤列表。至少 1 个（D5a 起：含 sub_recipes 的 Recipe 允许空 steps）。 */
  steps?: RecipeStep[]
  /** 默认使用哪个 adapter。未指定时由 SubagentManager 决定。 */
  default_adapter?: string
  /** SubRecipe 序列（D5a）：按数组顺序串行执行，outputs 累积到 `dagOutputs[name]`。 */
  sub_recipes?: SubRecipe[]
  /** 完成条件（基座版仅结构校验，runner 不执行 LLM 判断）。 */
  response?: RecipeResponse
}

// ============================================
// Recipe Run
// ============================================

/** Recipe 运行状态机。 */
export type RecipeRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 单步执行记录。 */
export interface RecipeRunStepRecord {
  /** 步骤 id（来自 RecipeStep.id 或派生）。 */
  step_id: string
  /** 步骤名称（人类可读）。 */
  step_name: string
  /** 步骤类型。 */
  kind: RecipeStepKind
  /** 步骤状态。 */
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  /** 开始时间（ms）。 */
  started_at: number
  /** 完成时间（ms，可选）。 */
  finished_at?: number
  /** 步骤输出（agent 步骤：resultText；shell 步骤：stdout/stderr 合并文本）。 */
  output?: string
  /** 错误信息（status=failed 时填充）。 */
  error?: string
}

/** 单次 Recipe 运行结果（持久化到 recipe_runs 表）。 */
export interface RecipeRun {
  id: string
  recipe_id: string
  /** 加载时的 Recipe 版本（向后兼容：未来 recipe 升级时旧 run 仍可读）。 */
  recipe_version: string
  /** 关联的 parent session（被 dispatch_subagent 调起时填写）。 */
  session_id: string | null
  /** 关联的画布节点。 */
  graph_id: string | null
  node_id: string | null
  /** 状态。 */
  status: RecipeRunStatus
  /** 入参 JSON。 */
  inputs: Record<string, string | number | boolean>
  /** 每步执行记录 JSON。 */
  steps: RecipeRunStepRecord[]
  /** 最终汇总输出（最后一个 agent 步骤的 resultText）。 */
  outputs: Record<string, string>
  /** 错误信息（status=failed 时）。 */
  error: string | null
  started_at: number
  finished_at: number | null
  /** 子流程记录（D5a）：当顶层 Recipe 含 sub_recipes 并由 runDAG 触发时填充。 */
  subRuns?: RecipeRun[]
}

/** RecipeRunner.run() 的入参 —— 类似 SubagentInvokeArgs 但不限于单步。 */
export interface RecipeRunRequest {
  recipeId: string
  inputs?: Record<string, string | number | boolean>
  /** 关联的 parent session（被 dispatch_subagent 调起时填写；UI 直接 Run 时为空）。 */
  parentSessionId?: string
  /** 关联的画布节点。 */
  nodeId?: string
  /** 允许的文件列表；缺省时步骤内部按需自行收敛。 */
  allowedFiles?: string[]
  /** 可选 adapter 覆盖；缺省时使用 recipe.default_adapter。 */
  adapterName?: string
  /** 可选 description（用于子代理日志）。 */
  description?: string
}