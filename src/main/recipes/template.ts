/**
 * Recipe 模板渲染（参考 Goose Recipe `{{ key }}` 参数替换）。
 *
 * 规则：
 * - 匹配 `{{ key }}`，key 由字母/数字/下划线组成
 * - inputs 中存在的值（包括 undefined/null）→ 字符串化（null/undefined → 空串）
 * - 未在 inputs 中出现的 key → 保留原始 `{{ key }}` 不替换（便于调用方校验）
 *
 * 注意：基座版不做严格 required 校验，由 IPC 调用方在收到 inputs 时检查缺失必填。
 */

const PARAM_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/**
 * 把 `{{ key }}` 占位符替换为 inputs 中的对应值。
 *
 * @param tpl 模板文本
 * @param inputs 参数表（key → 值）
 * @returns 替换后的文本
 */
export function renderTemplate(tpl: string | undefined, inputs: Record<string, unknown>): string {
  if (!tpl) return ''
  return tpl.replace(PARAM_REGEX, (_match, key: string) => {
    const v = inputs[key]
    if (v === undefined || v === null) return ''
    return String(v)
  })
}

/**
 * 检查 inputs 中是否缺失 Recipe 声明的必填参数。
 *
 * @returns 缺失的参数 key 列表（空数组 = 完整）
 */
export function findMissingRequired(
  parameters: Array<{ key: string; required: boolean }> | undefined,
  inputs: Record<string, unknown>,
): string[] {
  if (!parameters) return []
  return parameters.filter((p) => p.required && inputs[p.key] === undefined).map((p) => p.key)
}

/**
 * 生成 Recipe id slug（kebab-case）。
 *
 * 取 RecipeDefinition.title 作为基础，去除非 ASCII / 空格 → `-`。
 *
 * 例：`"Refactor React Component"` → `"refactor-react-component"`
 */
export function slugifyRecipeId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'recipe'
}