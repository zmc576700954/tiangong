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
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new BizGraphError(
      'Recipe must have at least 1 step',
      ErrorCode.RECIPE_INVALID_STEP,
    )
  }

  const inputsArr: RecipeInputSpec[] = []
  if (Array.isArray(raw.inputs)) {
    raw.inputs.forEach((input, i) => {
      inputsArr.push(validateInputSpec(input, `inputs[${i}]`))
    })
  }

  const steps: RecipeStep[] = raw.steps.map((s, i) => validateStep(s, i))

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
    steps,
    default_adapter: isString(raw.default_adapter) ? raw.default_adapter : undefined,
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
  }
  return yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }).trimEnd()
}

// ============================================
// 模板替换（运行时）：${input.<name>}
// ============================================

const TEMPLATE_INPUT_RE = /\$\{input\.([a-z][a-z0-9_]*)\}/g

/**
 * 把 ${input.name} 模板字符串中的占位替换为实际输入值。
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
  return template.replace(TEMPLATE_INPUT_RE, (_, key: string) => {
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