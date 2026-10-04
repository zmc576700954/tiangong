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
  /** 步骤列表。至少 1 个。 */
  steps: RecipeStep[]
  /** 默认使用哪个 adapter。未指定时由 SubagentManager 决定。 */
  default_adapter?: string
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

// ============================================
// Recipe DAG —— 静态视图（D5c-1）
// ============================================

/** DAG 中每个节点的状态（独立于运行期，UI 渲染用）。 */
export type RecipeDagNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/**
 * DAG 节点 = Recipe 的一个 step。
 *
 * 渲染层只关心「拓扑排序 + 节点状态着色」，所以把 step 元数据 flatten 成简单结构。
 * 步骤 kind 通过 nodeType 字段保留，避免渲染层再回去查 RecipeDefinition。
 */
export interface RecipeDagNode {
  /** 节点唯一 id（在 DAG 内稳定）。派生规则：step.id → step.name → 索引。 */
  id: string
  /** 步骤在 Recipe.steps 数组中的索引（用于排序兜底）。 */
  index: number
  /** 显示名。 */
  label: string
  /** 步骤类型：agent / shell。 */
  nodeType: 'agent' | 'shell'
  /** agent 步骤的 agent_type；shell 步骤为空。 */
  agentType?: string
  /** shell 步骤的 command[0]；agent 步骤为空。 */
  shellCommand?: string
  /** 静态运行时状态；UI 用它着色。 */
  status: RecipeDagNodeStatus
  /** 拓扑层级（0 = 入度为 0 的起点）。并行步骤会共享同一层级。 */
  level: number
  /** 运行期信息：开始时间（ms）。 */
  startedAt?: number
  /** 运行期信息：完成时间（ms）。 */
  finishedAt?: number
  /** 运行期信息：错误信息。 */
  error?: string
}

/** DAG 边：from → to 的依赖关系。 */
export interface RecipeDagEdge {
  id: string
  source: string
  target: string
  /**
   * 边的来源：
   *   - 'depends_on'：来自 RecipeStep.depends_on 显式声明
   *   - 'output-ref'：来自 prompt 模板里的 ${outputs.x.y} 引用（隐式推断）
   *   - 'index'：来自 YAML 数组顺序（兜底：相邻步骤的前向边）
   */
  kind: 'depends_on' | 'output-ref' | 'index'
}

/** Recipe 的 DAG 视图（运行前 + 运行中通用）。 */
export interface RecipeDag {
  /** 关联的 recipe id。 */
  recipeId: string
  /** 节点列表。 */
  nodes: RecipeDagNode[]
  /** 边列表。 */
  edges: RecipeDagEdge[]
  /**
   * 拓扑层级（每层一组可并行执行的节点）。
   * 渲染层用此决定列布局。
   */
  levels: RecipeDagNode[][]
  /** 检测到的循环依赖（节点 id 列表）。空数组 = 无环。 */
  cycles: string[][]
  /**
   * 推断失败/缺失依赖（引用的上游 id 在 steps 里不存在）。
   * 仅用于 UI 提示；不阻断运行（RecipeRunner 当前按数组顺序跑）。
   */
  missingDeps: Array<{ from: string; to: string; reason: 'depends_on' | 'output-ref'; missing: string }>
}

// ============================================
// Recipe Run Progress Event（D5c-3）
// ============================================

/**
 * RecipeRunner 推送给渲染进程的实时进度事件。
 *
 * 与 SubagentProgressEvent 不同：这里关心的是「整条 Recipe 的步骤级进度」，
 * 包括 shell 步骤（无 subagent 包装）。Renderer 通过 runId 过滤 + stepId 着色。
 */
export interface RecipeRunProgressEvent {
  /** Recipe run id（与 RecipeRun.id 一致）。 */
  runId: string
  /** 关联的 recipe id。 */
  recipeId: string
  /** 当前步骤 id。 */
  stepId: string
  /** 当前步骤状态。 */
  status: RecipeRunNodeStatus
  /** 步骤序号（0-based）。便于 UI 排序。 */
  stepIndex: number
  /** 总步骤数（便于顶部进度 X/Y）。 */
  totalSteps: number
  /** 已完成步骤数（含当前若是 completed）。 */
  completedSteps: number
  /** 失败步骤数（> 0 时 UI 标红）。 */
  failedSteps: number
  /** 错误信息（status=failed 时填充）。 */
  error?: string
  /** 步骤开始时间（ms）。 */
  startedAt?: number
  /** 步骤完成时间（ms）。 */
  finishedAt?: number
}

/** RecipeRunProgressEvent 中 step status 的取值。 */
export type RecipeRunNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'