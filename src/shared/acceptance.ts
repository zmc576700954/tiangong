/**
 * 节点验收项的共享类型与纯函数（Stage 1 · FR-S1-02）。
 *
 * 形状事实（勿凭想象改键名，均有代码依据）：
 * - 权威形状来自 `src/main/map/acceptance-executor.ts` 的逐条解析：`type` 必填、
 *   **`expected` 对所有类型都必填非空**，`manual` 另需 `id`，`command` 另需
 *   `stdout_contains` / `timeout_ms`，`file_check` 另需 `content_contains`。
 * - `expected` 是**语义复用的**：`command` 时它就是命令本身，`file_check` 时它就是
 *   项目根内相对路径，`manual` 时它是人读的期望结果。不要为「命令」另造 `command`
 *   字段——那会在节点侧与 work_item 侧引入第二套翻译层。
 * - 存量迁移 `src/main/map-migration/legacy-acceptance.ts` 产出的正是
 *   `{id, type:'manual', expected:text, text, provenance:'legacy_free_text'}`，
 *   本模块归一化结果与该形状逐字对齐，保证两侧同构。
 *
 * 与 `acceptanceCriteria: string[]` 的关系：
 * - `nodes.acceptance_criteria` 的读取受 `isStringArray` 守卫（`src/shared/type-guards.ts:72`，
 *   要求**每个元素都是字符串**）。写入结构化对象会让 `safeJsonParse` 整体退回 `[]`，
 *   等于静默清空验收项。因此结构化数据**不得**写进该列；该列继续存人读摘要，
 *   由 `deriveAcceptanceTexts` 从结构化条目反向派生，既有消费方（提示词拼装、画布、
 *   导出）无需改动。
 *
 * 校验一律 fail-closed：任一条非法则整批拒绝，错误定位到「第 N 条 + 字段」，
 * 不允许「跳过坏项当通过」——与执行器同一纪律。
 */

/** 验收条目结构版本；写入侧据此判断是否需要迁移。 */
export const ACCEPTANCE_SCHEMA_VERSION = 1

export const ACCEPTANCE_LIMITS = {
  /** 单节点最多条目数 */
  maxItems: 20,
  /** 人读描述（text）最大长度 */
  maxText: 500,
  /** expected 最大长度（command 类型下即命令长度上限） */
  maxExpected: 500,
  /** 单条超时上限，与执行器 MAX_TIMEOUT_MS 对齐 */
  maxTimeoutMs: 600_000,
  /** 单条超时缺省值，与执行器 DEFAULT_TIMEOUT_MS 对齐 */
  defaultTimeoutMs: 120_000,
} as const

export type AcceptanceItemType = 'command' | 'file_check' | 'manual'

/** legacy 自由文本归一化后的来源标记，与 map-migration 保持一致。 */
export const LEGACY_FREE_TEXT_PROVENANCE = 'legacy_free_text'

/**
 * 一条验收项。字段可缺省性刻意保守：`required` 缺省视为必过（fail-closed），
 * `provenance` 只透传不解释（迁移来源必须可判别）。
 */
export interface AcceptanceItem {
  /** `manual` 必填（人工确认锚点）；命令/文件类可省略。 */
  id?: string
  type: AcceptanceItemType
  /**
   * 必填。语义随 type 变化：
   * - `command`：要执行的命令
   * - `file_check`：项目根内相对路径
   * - `manual`：期望结果描述
   */
  expected: string
  /** 人读描述；`manual` 建议填写，缺省时回退 `expected` 展示。 */
  text?: string
  /** 是否必过；缺省 true。 */
  required?: boolean
  /** `command`：期望 stdout 包含的片段 */
  stdout_contains?: string
  /** `command`：超时毫秒 */
  timeout_ms?: number
  /** `file_check`：文件内容需包含的片段 */
  content_contains?: string
  /** 来源标记（如 legacy_free_text）；透传，不参与判定。 */
  provenance?: string
}

/** 节点侧历史上存字符串数组；输入允许两者混排，便于渐进迁移。 */
export type AcceptanceInput = ReadonlyArray<string | AcceptanceItem> | null | undefined

const TYPES: readonly AcceptanceItemType[] = ['command', 'file_check', 'manual']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAcceptanceItemType(value: unknown): value is AcceptanceItemType {
  return typeof value === 'string' && (TYPES as readonly string[]).includes(value)
}

/** 形状守卫：只判「能否当条目用」，字段完备性交 `validateAcceptanceItems`。 */
export function isAcceptanceItem(value: unknown): value is AcceptanceItem {
  return (
    isRecord(value) &&
    isAcceptanceItemType(value['type']) &&
    typeof value['expected'] === 'string' &&
    value['expected'].trim() !== ''
  )
}

/**
 * 归一化为结构化条目（R1 读取兼容）。
 * - 字符串 → `{type:'manual', expected:原文, text:原文, id:'acc_<i>', provenance:'legacy_free_text'}`
 *   **原文同时进 expected 与 text，逐字不改写**；`id` 按位置确定性生成，重载后稳定。
 * - 结构化条目 → 原样返回（不补默认值，保留「未声明 required」语义）。
 * - 非法项 → 丢弃（不伪造通过）；调用方可用返回的长度差决定是否告警。
 */
export function normalizeAcceptanceItems(input: AcceptanceInput): AcceptanceItem[] {
  if (!Array.isArray(input)) return []
  const items: AcceptanceItem[] = []
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i]
    if (typeof raw === 'string') {
      if (raw.trim() === '') continue
      items.push({
        id: `acc_${i}`,
        type: 'manual',
        expected: raw,
        text: raw,
        required: true,
        provenance: LEGACY_FREE_TEXT_PROVENANCE,
      })
      continue
    }
    if (isAcceptanceItem(raw)) items.push(raw)
  }
  return items
}

/**
 * 反向派生人读摘要，写回 `acceptanceCriteria: string[]`。
 * 优先 `text`，缺省回退 `expected`——保证既有消费方拿到的仍是可读文本。
 */
export function deriveAcceptanceTexts(items: ReadonlyArray<AcceptanceItem>): string[] {
  return items.map((item) => {
    const text = typeof item.text === 'string' ? item.text : ''
    return text.trim() !== '' ? text : item.expected
  })
}

/** 是否必过：缺省 true（与执行器 fail-closed 一致）。 */
export function isRequired(item: AcceptanceItem): boolean {
  return item.required !== false
}

/** 稳定 id 生成：用于新增条目，避免同一节点内撞车。 */
export function makeAcceptanceItemId(seed: number, existing: ReadonlyArray<string> = []): string {
  const used = new Set(existing)
  let n = seed
  let candidate = `acc_${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `acc_${n}`
  }
  return candidate
}

/** `file_check` 的 expected 必须是项目根内相对路径（与执行器同源判定前先自检）。 */
export function validateRelativePath(raw: string): string | null {
  if (raw.trim() === '') return '路径不能为空'
  if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) return '必须使用项目根内的相对路径'
  const segments = raw.split(/[\\/]+/)
  if (segments.includes('..')) return '不得包含 .. 路径段'
  return null
}

/**
 * 校验单条；返回错误描述数组（空数组 = 合法）。
 * `index` 从 0 开始，错误信息里显示为「第 N 条」。
 */
export function validateAcceptanceItem(item: unknown, index: number): string[] {
  const where = `第 ${index + 1} 条`
  if (!isRecord(item)) return [`${where}：条目形状非法`]

  const type = item['type']
  if (!isAcceptanceItemType(type)) {
    return [`${where}：type 必须是 command / file_check / manual`]
  }

  const expected = item['expected']
  if (typeof expected !== 'string' || expected.trim() === '') {
    return [`${where}：${type === 'command' ? '命令' : type === 'file_check' ? '路径' : '期望结果'}不能为空`]
  }
  if (expected.length > ACCEPTANCE_LIMITS.maxExpected) {
    return [`${where}：expected 不能超过 ${ACCEPTANCE_LIMITS.maxExpected} 字`]
  }

  const errors: string[] = []

  const text = item['text']
  if (text !== undefined) {
    if (typeof text !== 'string') {
      errors.push(`${where}：描述必须是文本`)
    } else if (text.length > ACCEPTANCE_LIMITS.maxText) {
      errors.push(`${where}：描述不能超过 ${ACCEPTANCE_LIMITS.maxText} 字`)
    }
  }

  if (item['required'] !== undefined && typeof item['required'] !== 'boolean') {
    errors.push(`${where}：required 必须是布尔值`)
  }

  if (type === 'manual') {
    const id = item['id']
    if (typeof id !== 'string' || id.trim() === '') {
      errors.push(`${where}：人工确认项必须有 id`)
    }
  }

  if (type === 'command') {
    if (item['timeout_ms'] !== undefined) {
      const timeout = item['timeout_ms']
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        errors.push(`${where}：timeout_ms 必须是正数`)
      } else if (timeout > ACCEPTANCE_LIMITS.maxTimeoutMs) {
        errors.push(`${where}：timeout_ms 不能超过 ${ACCEPTANCE_LIMITS.maxTimeoutMs}`)
      }
    }
    if (item['stdout_contains'] !== undefined && typeof item['stdout_contains'] !== 'string') {
      errors.push(`${where}：stdout_contains 必须是文本`)
    }
  }

  if (type === 'file_check') {
    const pathError = validateRelativePath(expected)
    if (pathError) errors.push(`${where}：${pathError}`)
    if (item['content_contains'] !== undefined && typeof item['content_contains'] !== 'string') {
      errors.push(`${where}：content_contains 必须是文本`)
    }
  }

  return errors
}

export interface AcceptanceValidation {
  ok: boolean
  errors: string[]
}

/** 整批校验（R3/R4）：数量上限 + 逐条校验，任一非法则整批拒绝。 */
export function validateAcceptanceItems(items: unknown): AcceptanceValidation {
  if (!Array.isArray(items)) return { ok: false, errors: ['验收项必须是数组'] }
  if (items.length > ACCEPTANCE_LIMITS.maxItems) {
    return { ok: false, errors: [`验收项最多 ${ACCEPTANCE_LIMITS.maxItems} 条`] }
  }
  const errors = items.flatMap((item, index) => validateAcceptanceItem(item, index))
  return { ok: errors.length === 0, errors }
}

/**
 * 序列化为执行器消费的 JSON（R5）。
 * 只保留执行器认识的键，且 `required === false` 的条目不在此处消失——
 * 执行器（acceptance-executor）认得该字段：可选条目的运行失败/待确认只进
 * `optionalFailures`，不阻塞 `ok`、不触发 needs_input；形状非法不受豁免。
 */
export function serializeAcceptanceItems(items: ReadonlyArray<AcceptanceItem>): string {
  return JSON.stringify(items.map(toExecutorEntry))
}

function toExecutorEntry(item: AcceptanceItem): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: item.type, expected: item.expected }
  if (item.id !== undefined && item.id.trim() !== '') entry['id'] = item.id
  if (item.text !== undefined) entry['text'] = item.text
  if (item.required === false) entry['required'] = false
  if (item.type === 'command') {
    if (item.stdout_contains !== undefined) entry['stdout_contains'] = item.stdout_contains
    if (item.timeout_ms !== undefined) entry['timeout_ms'] = item.timeout_ms
  }
  if (item.type === 'file_check' && item.content_contains !== undefined) {
    entry['content_contains'] = item.content_contains
  }
  if (item.provenance !== undefined) entry['provenance'] = item.provenance
  return entry
}
