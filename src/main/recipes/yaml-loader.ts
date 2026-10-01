/**
 * Recipe YAML Loader
 *
 * 极简的手工校验（避免引入 zod 依赖）。
 * - 解析失败的 YAML → 抛 BizGraphError(RECIPE_PARSE_ERROR)
 * - 校验失败的 shape → 抛 BizGraphError(RECIPE_INVALID_STEP)
 * - 校验失败的 shell 步骤（command 为空、含危险操作等）→ 抛 BizGraphError(RECIPE_INVALID_STEP)
 *
 * 安全边界（与 CLAUDE.md "Boundaries with Agent CLI" 一致）：
 *   - shell 步骤的 command 是 YAML 中声明的静态字符串数组，仍须 ScopeGuard 在执行时再次校验。
 *   - 我们只校验"白名单层"的形状/类型/危险信号，更深的 OS 级拦截由 ScopeGuard 兜底。
 */

import yaml from 'js-yaml'
import { BizGraphError, ErrorCode } from '../errors'
import type {
  RecipeDefinition,
  RecipeStep,
  RecipeAgentStep,
  RecipeShellStep,
  RecipeInputSpec,
  SubRecipe,
} from '@shared/types/recipe'

// ============================================
// 顶层工具：non-empty string + 数字 + 布尔
// ============================================

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// kebab-case 校验：仅允许小写字母、数字、横线
const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/

function isKebabCase(s: string): boolean {
  return KEBAB_CASE_RE.test(s)
}

// scalar 类型 union，用于 SubRecipe.inputs 的运行时校验
function isScalarValue(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

// ============================================
// inputs 校验
// ============================================

function validateInputSpec(raw: unknown, path: string): RecipeInputSpec {
  if (!isPlainObject(raw)) {
    throw new BizGraphError(
      `Recipe input must be an object at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isNonEmptyString(raw.name)) {
    throw new BizGraphError(
      `Recipe input must have a non-empty 'name' at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isKebabCase(raw.name)) {
    throw new BizGraphError(
      `Recipe input name must be kebab-case at ${path}: got "${raw.name}"`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  const t = raw.type
  if (t !== 'string' && t !== 'number' && t !== 'boolean' && t !== 'enum') {
    throw new BizGraphError(
      `Recipe input type must be one of string|number|boolean|enum at ${path}: got ${JSON.stringify(t)}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (t === 'enum') {
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      throw new BizGraphError(
        `Recipe enum input requires 'options' at ${path}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    if (!raw.options.every((o) => isString(o) || typeof o === 'number')) {
      throw new BizGraphError(
        `Recipe enum options must be string|number at ${path}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
  }
  return {
    name: raw.name,
    label: isString(raw.label) ? raw.label : undefined,
    type: t,
    description: isString(raw.description) ? raw.description : undefined,
    default: raw.default as string | number | boolean | undefined,
    required: typeof raw.required === 'boolean' ? raw.required : true,
    options: t === 'enum' ? (raw.options as Array<string | number>) : undefined,
  }
}

// ============================================
// 步骤校验
// ============================================

/**
 * 危险 shell 命令启发式（仅作第一道防线，不是绝对安全）。
 * 例如 rm -rf /、dd、mkfs、shutdown 等等。
 * - ScopeGuard 在执行时仍需做最终校验。
 * - 这里我们只拒绝"明显意图删除/格式化系统"的命令，避免错把无害命令误判。
 */
const FORBIDDEN_SHELL_BINARIES = new Set([
  'rm',          // 命令带特定参数会破坏系统（但 rm 在白名单项目里常见，故保守处理）
  'mkfs',        // 格式化磁盘
  'dd',          // 块设备操作
  'shutdown',    // 系统关机
  'reboot',      // 系统重启
  'halt',        // 系统停机
  'poweroff',
  'init',
  'fdisk',       // 分区表编辑
  'parted',
  'mkfs.ext4',
  'mkfs.ext3',
  'mkfs.xfs',
  'mkfs.btrfs',
  'mkswap',
  'chmod',       // 权限修改（白名单项目内审慎）
  'chown',       // 文件所有者修改
])

function validateAgentStep(raw: Record<string, unknown>, path: string): RecipeAgentStep {
  if (!isNonEmptyString(raw.agent_type)) {
    throw new BizGraphError(
      `agent step must have non-empty 'agent_type' at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isNonEmptyString(raw.description)) {
    throw new BizGraphError(
      `agent step must have non-empty 'description' at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isString(raw.prompt)) {
    throw new BizGraphError(
      `agent step must have string 'prompt' at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  return {
    kind: 'agent',
    id: isString(raw.id) ? raw.id : undefined,
    name: isString(raw.name) ? raw.name : undefined,
    description: isString(raw.description) ? raw.description : undefined,
    depends_on: isStringArray(raw.depends_on) ? (raw.depends_on as string[]) : undefined,
    agent_type: raw.agent_type,
    prompt: raw.prompt,
    adapter_name: isString(raw.adapter_name) ? raw.adapter_name : undefined,
    node_id: isString(raw.node_id) ? raw.node_id : undefined,
    allowed_files: isStringArray(raw.allowed_files) ? (raw.allowed_files as string[]) : undefined,
    parallel: typeof raw.parallel === 'boolean' ? raw.parallel : undefined,
  } as RecipeAgentStep
}

function validateShellStep(raw: Record<string, unknown>, path: string): RecipeShellStep {
  if (!isStringArray(raw.command) || (raw.command as unknown[]).length === 0) {
    throw new BizGraphError(
      `shell step must have non-empty 'command' array at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  const argv = raw.command as string[]
  const head = argv[0]!.toLowerCase()
  // 简单路径：basename 匹配（防止 /usr/bin/rm 等）
  const basename = head.split(/[\\/]/).pop() ?? head
  if (FORBIDDEN_SHELL_BINARIES.has(basename)) {
    throw new BizGraphError(
      `shell step uses forbidden binary "${basename}" at ${path}; ScopeGuard will refuse at runtime too. Allowed: project-scoped read commands and a curated write list (npm/pnpm/yarn/git/etc.).`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  return {
    kind: 'shell',
    id: isString(raw.id) ? raw.id : undefined,
    name: isString(raw.name) ? raw.name : undefined,
    description: isString(raw.description) ? raw.description : undefined,
    depends_on: isStringArray(raw.depends_on) ? (raw.depends_on as string[]) : undefined,
    command: argv,
    cwd: isString(raw.cwd) ? raw.cwd : undefined,
    timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : undefined,
    writable: typeof raw.writable === 'boolean' ? raw.writable : undefined,
  }
}

function validateStep(raw: unknown, index: number): RecipeStep {
  const path = `steps[${index}]`
  if (!isPlainObject(raw)) {
    throw new BizGraphError(`Recipe step must be an object at ${path}`, ErrorCode.RECIPE_INVALID_STEP)
  }
  const kind = raw.kind
  if (kind === 'agent') {
    return validateAgentStep(raw, path)
  } else if (kind === 'shell') {
    return validateShellStep(raw, path)
  }
  throw new BizGraphError(
    `Recipe step kind must be 'agent' or 'shell' at ${path}: got ${JSON.stringify(kind)}`,
    ErrorCode.RECIPE_INVALID_STEP,
  )
}

// ============================================
// Sub Recipe 校验（D5a）
// ============================================

/**
 * 校验单个 sub_recipe 节点。
 * - name：kebab-case、非空
 * - recipe：非空字符串（被引用的 Recipe id；存在性由 RecipeManager 在加载时校验）
 * - inputs：可选，纯对象，值只能是 string|number|boolean
 */
function validateSubRecipe(raw: unknown, path: string, seenNames: Set<string>): SubRecipe {
  if (!isPlainObject(raw)) {
    throw new BizGraphError(
      `Recipe sub_recipe must be an object at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isNonEmptyString(raw.name)) {
    throw new BizGraphError(
      `Recipe sub_recipe must have non-empty 'name' at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isKebabCase(raw.name)) {
    throw new BizGraphError(
      `Recipe sub_recipe name must be kebab-case at ${path}: got "${raw.name}"`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (seenNames.has(raw.name)) {
    throw new BizGraphError(
      `Duplicate sub_recipe name "${raw.name}" at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  seenNames.add(raw.name)
  if (!isNonEmptyString(raw.recipe)) {
    throw new BizGraphError(
      `Recipe sub_recipe must have non-empty 'recipe' (referenced recipe id) at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  let inputs: Record<string, string | number | boolean> | undefined
  if (raw.inputs !== undefined && raw.inputs !== null) {
    if (!isPlainObject(raw.inputs)) {
      throw new BizGraphError(
        `Recipe sub_recipe 'inputs' must be an object at ${path}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    inputs = {}
    for (const [k, v] of Object.entries(raw.inputs as Record<string, unknown>)) {
      if (!isScalarValue(v)) {
        throw new BizGraphError(
          `Recipe sub_recipe input "${k}" must be string|number|boolean at ${path}`,
          ErrorCode.RECIPE_INVALID_STEP,
        )
      }
      inputs[k] = v
    }
  }
  return {
    name: raw.name,
    recipe: raw.recipe,
    inputs,
  }
}

/**
 * 校验 sub_recipes 数组。
 * - 顺序即 DAG 执行顺序（D5a 不解析 depends_on；D5b 再加 parallel / on_failure）
 * - name 在 Recipe 内必须唯一
 */
function validateSubRecipes(raw: unknown, path: string): SubRecipe[] {
  if (!Array.isArray(raw)) {
    throw new BizGraphError(
      `Recipe sub_recipes must be an array at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  const seenNames = new Set<string>()
  return raw.map((sr, i) => validateSubRecipe(sr, `${path}[${i}]`, seenNames))
}

/**
 * 校验 response 对象（D5a 仅结构校验，不执行 LLM 判断）。
 */
function validateResponse(raw: unknown, path: string): { success_condition?: string; failure_condition?: string } {
  if (!isPlainObject(raw)) {
    throw new BizGraphError(
      `Recipe response must be an object at ${path}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  const out: { success_condition?: string; failure_condition?: string } = {}
  if (raw.success_condition !== undefined) {
    if (!isString(raw.success_condition)) {
      throw new BizGraphError(
        `Recipe response.success_condition must be a string at ${path}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    out.success_condition = raw.success_condition
  }
  if (raw.failure_condition !== undefined) {
    if (!isString(raw.failure_condition)) {
      throw new BizGraphError(
        `Recipe response.failure_condition must be a string at ${path}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    out.failure_condition = raw.failure_condition
  }
  return out
}

// ============================================
// 顶层解析
// ============================================

/**
 * 解析 Recipe YAML 文本为 RecipeDefinition。
 * 抛 BizGraphError（RECIPE_PARSE_ERROR / RECIPE_INVALID_STEP）。
 */
export function parseRecipe(yamlText: string): RecipeDefinition {
  let raw: unknown
  try {
    raw = yaml.load(yamlText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new BizGraphError(`Failed to parse recipe YAML: ${msg}`, ErrorCode.RECIPE_PARSE_ERROR)
  }

  if (!isPlainObject(raw)) {
    throw new BizGraphError(
      'Recipe YAML root must be an object',
      ErrorCode.RECIPE_PARSE_ERROR,
    )
  }

  if (!isNonEmptyString(raw.id)) {
    throw new BizGraphError(
      "Recipe must have non-empty 'id' field",
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isKebabCase(raw.id)) {
    throw new BizGraphError(
      `Recipe id must be kebab-case: got "${raw.id}"`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (!isNonEmptyString(raw.name)) {
    throw new BizGraphError(
      "Recipe must have non-empty 'name' field",
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }
  if (raw.version !== '1') {
    throw new BizGraphError(
      `Recipe version must be "1", got ${JSON.stringify(raw.version)}`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }

  const inputsArr: RecipeInputSpec[] = []
  if (Array.isArray(raw.inputs)) {
    raw.inputs.forEach((input, i) => {
      inputsArr.push(validateInputSpec(input, `inputs[${i}]`))
    })
  }

  const steps: RecipeStep[] = []
  if (Array.isArray(raw.steps)) {
    raw.steps.forEach((s, i) => steps.push(validateStep(s, i)))
  }

  const subRecipes: SubRecipe[] | undefined = Array.isArray(raw.sub_recipes)
    ? validateSubRecipes(raw.sub_recipes, 'sub_recipes')
    : undefined

  const response:
    | { success_condition?: string; failure_condition?: string }
    | undefined = isPlainObject(raw.response) ? validateResponse(raw.response, 'response') : undefined

  // steps 与 sub_recipes 至少有一个非空（D5a：sub_recipes-only 也合法）
  const hasSteps = steps.length > 0
  const hasSubRecipes = (subRecipes?.length ?? 0) > 0
  if (!hasSteps && !hasSubRecipes) {
    throw new BizGraphError(
      'Recipe must have at least 1 step or 1 sub_recipe',
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }

  // id 唯一性 + depends_on 引用校验
  const seenIds = new Set<string>()
  for (const s of steps) {
    if (s.id) {
      if (seenIds.has(s.id)) {
        throw new BizGraphError(
          `Duplicate step id "${s.id}"`,
          ErrorCode.RECIPE_INVALID_STEP,
        )
      }
      seenIds.add(s.id)
    }
  }
  for (const s of steps) {
    if (s.depends_on) {
      for (const dep of s.depends_on) {
        if (seenIds.has(dep) || steps.some((other) => other.name === dep)) {
          continue
        }
        throw new BizGraphError(
          `Step "${s.id ?? s.name ?? '?'}" depends on unknown step "${dep}"`,
          ErrorCode.RECIPE_INVALID_STEP,
        )
      }
    }
  }

  return {
    id: raw.id,
    name: raw.name,
    version: '1',
    description: isString(raw.description) ? raw.description : undefined,
    tags: isStringArray(raw.tags) ? (raw.tags as string[]) : undefined,
    inputs: inputsArr.length > 0 ? inputsArr : undefined,
    steps: steps.length > 0 ? steps : undefined,
    default_adapter: isString(raw.default_adapter) ? raw.default_adapter : undefined,
    sub_recipes: subRecipes && subRecipes.length > 0 ? subRecipes : undefined,
    response,
  }
}

/**
 * 把 RecipeDefinition 序列化为 YAML 文本（用于 UI 编辑后写回）。
 * 与 parseRecipe 互逆。
 */
export function stringifyRecipe(def: RecipeDefinition): string {
  const raw: Record<string, unknown> = {
    id: def.id,
    name: def.name,
    version: def.version,
    description: def.description,
    tags: def.tags,
    inputs: def.inputs,
    steps: def.steps,
    default_adapter: def.default_adapter,
    sub_recipes: def.sub_recipes,
    response: def.response,
  }
  return yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }).trimEnd()
}

// ============================================
// 模板替换（运行时）：${input.x} / ${outputs.x.y}
// ============================================

const TEMPLATE_INPUT_RE = /\$\{input\.([a-z][a-z0-9_]*)\}/g
const TEMPLATE_OUTPUT_RE = /\$\{outputs\.([a-z][a-z0-9-]*)(?:\.([a-zA-Z0-9_.-]+))?\}/g

/**
 * 在对象上按 dotted path 取值。仅支持 own-property 标量 / 子对象；非标量返回值走 JSON.stringify。
 * 空字段段被跳过；路径非法 → undefined。
 */
function readPath(root: unknown, path: string): unknown {
  if (root === undefined || root === null) return undefined
  if (path === '') return root
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 把 ${input.x} + ${outputs.x.y} 模板字符串中的占位替换为实际值。
 *
 * - inputs：来自 RecipeRunRequest.inputs（schema.default / required 行为见下）。
 * - outputs：来自 DAG runner 的 dagOutputs[name]（结构化对象；缺字段抛错）。
 *
 * 缺 inputs 值时：
 *   - 字段 required=true（默认）→ 抛 BizGraphError
 *   - 字段 required=false + 有 default → 用 default
 *   - 都没有 → 替换为空字符串
 */
export function applyTemplate(
  template: string,
  inputs: Record<string, string | number | boolean>,
  outputs: Record<string, unknown>,
  schema?: RecipeInputSpec[],
): string {
  // 先 outputs（避免被 input 规则捕获）
  const result = template.replace(TEMPLATE_OUTPUT_RE, (_, name: string, path?: string) => {
    const bucket = outputs[name]
    if (bucket === undefined || bucket === null) {
      throw new BizGraphError(
        `Recipe output "${name}" is not available in this scope`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    const value = path ? readPath(bucket, path) : bucket
    if (value === undefined || value === null) {
      throw new BizGraphError(
        `Recipe output "${name}${path ? '.' + path : ''}" resolved to undefined`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    if (typeof value === 'object') {
      // 复杂结构 → JSON 序列化（避免 String() 退化为 [object Object]）
      return JSON.stringify(value)
    }
    return String(value)
  })
  // 再 inputs（保持基座语义）
  return result.replace(TEMPLATE_INPUT_RE, (_, key: string) => {
    const value = inputs[key]
    if (value !== undefined && value !== null) {
      return String(value)
    }
    const spec = schema?.find((s) => s.name === key)
    if (spec?.default !== undefined) {
      return String(spec.default)
    }
    if (spec?.required === false) {
      return ''
    }
    throw new BizGraphError(
      `Recipe input "${key}" is required but not provided`,
      ErrorCode.RECIPE_INVALID_STEP,
    )
  })
}

/**
 * 把 ${input.name} 模板字符串中的占位替换为实际输入值。
 * 仅处理 ${input.x}（不引用 outputs）。保留以兼容基座版调用点；新代码请用 applyTemplate。
 *
 * 缺输入值时：
 *   - 字段 required=true（默认）→ 抛 BizGraphError
 *   - 字段 required=false + 有 default → 用 default
 *   - 都没有 → 替换为空字符串
 */
export function applyInputTemplate(
  template: string,
  inputs: Record<string, string | number | boolean>,
  schema?: RecipeInputSpec[],
): string {
  return applyTemplate(template, inputs, {}, schema)
}

// ============================================
// DAG 校验（D5a）
// ============================================

/**
 * 校验 Recipe 的 sub_recipes 引用完整性 + 检测循环。
 * 由 RecipeManager 在加载完所有 Recipe 后调用，确保 referenced recipe 都存在。
 *
 * 参数：
 *   - def：被校验的 RecipeDefinition（顶层）
 *   - allDefs：当前已加载的所有 Recipe 快照（id → def）
 *
 * 抛 BizGraphError(RECIPE_INVALID_STEP) 当：
 *   - sub_recipes[*].recipe 引用了不存在的 id
 *   - 图中存在循环（A → B → A）
 *
 * 注：DAG 拓扑排序在 RecipeRunner.runDAG() 中执行（仅对子图，跨 Recipe 引用视为节点）。
 *
 * 实现：标准 3 色 DFS（WHITE/GRAY/BLACK）。遇到 GRAY 邻居即回边 → 环。
 */
export function validateRecipeGraph(
  def: RecipeDefinition,
  allDefs: Map<string, RecipeDefinition>,
): void {
  if (!def.sub_recipes || def.sub_recipes.length === 0) return

  // 1. 检查每个被引用的 recipe 是否存在
  for (const sr of def.sub_recipes) {
    if (!allDefs.has(sr.recipe)) {
      throw new BizGraphError(
        `Recipe "${def.id}" sub_recipe "${sr.name}" references unknown recipe "${sr.recipe}"`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
  }

  // 2. 三色 DFS：跨 Recipe 循环检测（递归版；DAG 一般较浅，栈深度可控）
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of allDefs.keys()) color.set(id, WHITE)

  const visit = (id: string, path: string[]): void => {
    const c = color.get(id) ?? WHITE
    if (c === GRAY) {
      // 回边 = 环
      const cycle = [...path, id].join(' -> ')
      throw new BizGraphError(
        `Recipe graph contains a cycle: ${cycle}`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    if (c === BLACK) return
    color.set(id, GRAY)
    const cur = allDefs.get(id)
    if (cur?.sub_recipes) {
      for (const sr of cur.sub_recipes) {
        visit(sr.recipe, [...path, id])
      }
    }
    color.set(id, BLACK)
  }

  visit(def.id, [def.id])
}

/**
 * 对单个 Recipe 的 sub_recipes 数组执行拓扑排序。
 * 当前实现：每个 sub_recipe 视为节点，依赖顺序即数组顺序（D5a 不解析 depends_on）；
 * 检测 self-loop（同一 name 出现两次已经在 parseRecipe 阶段拒绝）。
 *
 * 返回值：排序后的 sub_recipes 数组（基座版 = 输入顺序拷贝）。
 * 抛 BizGraphError 当输入包含重复 recipe 引用且 ordering 形成冲突。
 *
 * 注：跨 Recipe 循环由 validateRecipeGraph() 检测；本函数仅处理单 Recipe 内。
 */
export function topoSortSubRecipes(subs: SubRecipe[]): SubRecipe[] {
  // 基座版：拓扑顺序 = 数组顺序；引用合法性由 validateRecipeGraph 兜底。
  // 这里做一个简单去重 + 自检（同名重复已在 parseRecipe 拒绝）。
  const seen = new Set<string>()
  const ordered: SubRecipe[] = []
  for (const sr of subs) {
    if (seen.has(sr.name)) {
      throw new BizGraphError(
        `Duplicate sub_recipe name "${sr.name}" in topological order`,
        ErrorCode.RECIPE_INVALID_STEP,
      )
    }
    seen.add(sr.name)
    ordered.push(sr)
  }
  return ordered
}