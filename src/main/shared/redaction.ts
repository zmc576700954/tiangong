/**
 * 事件落库脱敏（P1 隐私）。
 *
 * 目标：事件保留 90 天，payload 里的工具入参/命令原文不能带走 token、密码、连接串。
 * 边界：
 * - 只覆盖**可识别模式**（下表 8 条规则）；自定义格式的密钥（例如裸 40 位 base64、
 *   私有编码、图片里的密钥）无法识别，会原样落库；
 * - 只改**落库副本**：`appendEvents` 复制 payload 后再脱敏，内存事件对象不动，
 *   因此审批卡片/实时旁路（`onEvent`）仍拿到原文，用户看得到自己要批准的命令；
 * - 脱敏保留「哪个参数、多长」：值替换为 `***REDACTED(N chars)`，规则名与字段路径
 *   写入 payload 的 `_redaction.fields`，便于事后审计解释。
 */

export const REDACTION_META_KEY = '_redaction'

export interface RedactionField {
  /** 字段路径，如 `$.command`、`$.input.args[1]` */
  path: string
  /** 命中的规则名（去重，按首次命中顺序） */
  rules: string[]
  /** 该字段被替换的次数 */
  occurrences: number
}

export interface RedactionMeta {
  fields: RedactionField[]
  /** 全部替换次数 */
  total: number
}

export interface RedactPayloadResult {
  payload: Record<string, unknown>
  meta: RedactionMeta | null
}

const REDACTED_TEXT = /\*\*\*REDACTED\(\d+ chars\)/

function marker(value: string): string {
  return `***REDACTED(${value.length} chars)`
}

/** 键名归一化：去掉 `_`/`-`/`.` 并小写，用于「键名本身即敏感」的判断。 */
function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[._-]/g, '')
}

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'token', 'accesstoken', 'refreshtoken', 'authtoken',
  'idtoken', 'apikey', 'secret', 'secrets', 'clientsecret', 'authorization', 'auth',
  'credentials', 'credential', 'privatekey', 'accesskey', 'secretkey', 'bearer',
  'cookie', 'sessioncookie',
])

/** 环境变量名/参数名里的敏感词：`AWS_SECRET_ACCESS_KEY`、`OPENAI_API_KEY`、`--db-password`。 */
const SECRET_NAME_PATTERN = /(?:^|[._-])(API[_-]?KEY|APIKEY|SECRET|SECRET[_-]?KEY|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)(?:$|[._-])/i

function isSensitiveKeyName(name: string): boolean {
  if (SENSITIVE_KEYS.has(normalizeKey(name))) return true
  return SECRET_NAME_PATTERN.test(name)
}

/** 收集命中：每个字段记录规则名与次数，供 `_redaction` 元数据使用。 */
class HitSink {
  private readonly fields = new Map<string, { rules: string[]; occurrences: number }>()

  add(path: string, rule: string): void {
    const hit = this.fields.get(path) ?? { rules: [], occurrences: 0 }
    if (!hit.rules.includes(rule)) hit.rules.push(rule)
    hit.occurrences += 1
    this.fields.set(path, hit)
  }

  meta(): RedactionMeta | null {
    if (this.fields.size === 0) return null
    let total = 0
    const fields: RedactionField[] = []
    for (const [path, hit] of this.fields) {
      total += hit.occurrences
      fields.push({ path, rules: [...hit.rules], occurrences: hit.occurrences })
    }
    return { fields, total }
  }
}

/** 1) `Authorization: Bearer xxx` / `authorization: token xxx`（保留认证方案，只换凭证）。 */
const AUTHORIZATION_RE = /(authorization\s*:\s*)(?:([A-Za-z]+)\s+)?([^\s"'`,;}\\]+)/gi

/** 2) 独立的 `Bearer xxx`。 */
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g

/** 3) URL 里的 `user:pass@`（只脱密码，保留用户名便于定位是哪个连接串）。 */
const URL_CREDENTIAL_RE = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s:@]*):([^/\s@]+)@/g

/** 4) `--token=xxx` / `--password xxx` 一类命令行参数（保留参数名）。 */
const SECRET_FLAG_RE =
  /(^|[\s(])(--?(?:token|password|passwd|api[_-]key|apikey|access[_-]token|auth[_-]token|refresh[_-]token|client[_-]secret|secret|private[_-]key|authorization))(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s'"]+)/gi

/** 5) `password=...` / `"api_key": "..."` / `AWS_SECRET_ACCESS_KEY=...`（键名按敏感词判断）。 */
const ASSIGNMENT_RE =
  /(^|[\s,{;"'(?&])(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_.-]*))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/g

/** 认证方案词：`Authorization: Bearer <token>` 的方案不当作秘密。 */
const AUTH_SCHEMES = new Set(['bearer', 'basic', 'token', 'digest', 'negotiate'])

/** 6) 常见供应商 token 前缀（`sk-` / `ghp_` / `AKIA...` 等）。 */
const PROVIDER_TOKEN_RE =
  /(\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{12,})/g

function stripQuotes(value: string): { quote: '"' | "'" | ''; inner: string } {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return { quote: value[0], inner: value.slice(1, -1) }
  }
  return { quote: '', inner: value }
}

/** 对一段文本按 6 条文本规则顺序脱敏；已脱敏的占位符不会被后续规则二次处理。 */
function redactTextWithHits(text: string, path: string, sink: HitSink): string {
  let out = text

  out = out.replace(AUTHORIZATION_RE, (match, lead: string, scheme: string | undefined, secret: string) => {
    if (REDACTED_TEXT.test(secret)) return match
    sink.add(path, 'authorization-header')
    return `${lead}${scheme ? `${scheme} ` : ''}${marker(secret)}`
  })

  out = out.replace(BEARER_RE, (match, secret: string) => {
    if (REDACTED_TEXT.test(secret)) return match
    sink.add(path, 'bearer-token')
    return `Bearer ${marker(secret)}`
  })

  out = out.replace(URL_CREDENTIAL_RE, (match, scheme: string, user: string, secret: string) => {
    if (REDACTED_TEXT.test(secret)) return match
    sink.add(path, 'url-credentials')
    return `${scheme}${user}:${marker(secret)}@`
  })

  out = out.replace(SECRET_FLAG_RE, (match, lead: string, flag: string, sep: string, rawValue: string) => {
    const { quote, inner } = stripQuotes(rawValue)
    if (!inner || REDACTED_TEXT.test(inner)) return match
    sink.add(path, 'flag-secret')
    return `${lead}${flag}${sep}${quote}${marker(inner)}${quote}`
  })

  out = out.replace(
    ASSIGNMENT_RE,
    (match, lead: string, dq: string | undefined, sq: string | undefined, bare: string | undefined, sep: string, rawValue: string) => {
      const key = dq ?? sq ?? bare ?? ''
      if (!isSensitiveKeyName(key)) return match
      const { quote, inner } = stripQuotes(rawValue)
      if (!inner || REDACTED_TEXT.test(inner)) return match
      // `Authorization: Bearer <已经脱敏的凭证>` 已由 authorization-header 规则处理，
      // 这里只看到方案词 Bearer 时不能再把方案词当秘密替换掉。
      if (normalizeKey(key) === 'authorization' && AUTH_SCHEMES.has(inner.toLowerCase())) return match
      sink.add(path, 'secret-assignment')
      const renderedKey = dq !== undefined ? `"${dq}"` : sq !== undefined ? `'${sq}'` : bare
      return `${lead}${renderedKey}${sep}${quote}${marker(inner)}${quote}`
    },
  )

  out = out.replace(PROVIDER_TOKEN_RE, (match) => {
    sink.add(path, 'provider-token')
    return marker(match)
  })

  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function childPath(parent: string, key: string): string {
  return parent === '$' ? `$.${key}` : `${parent}.${key}`
}

/** 递归遍历 payload：字符串走文本规则；敏感键整体脱敏（对象/数组则强制全脱敏）。 */
function walk(value: unknown, path: string, sink: HitSink, forceRedact = false): unknown {
  if (typeof value === 'string') {
    if (forceRedact) {
      if (!value) return value
      sink.add(path, 'sensitive-key')
      return marker(value)
    }
    return redactTextWithHits(value, path, sink)
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactTextWithHits(value.message, path, sink) }
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, `${path}[${index}]`, sink, forceRedact))
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const nextPath = childPath(path, key)
      const sensitive = forceRedact || isSensitiveKeyName(key)
      if (sensitive && typeof item === 'string') {
        if (item) {
          sink.add(nextPath, 'sensitive-key')
          out[key] = marker(item)
        } else {
          out[key] = item
        }
        continue
      }
      out[key] = walk(item, nextPath, sink, sensitive)
    }
    return out
  }
  return value
}

/**
 * 返回**脱敏后的副本**（不修改入参），`meta` 为 null 表示没有识别到敏感内容。
 * 调用方负责把 meta 以 `_redaction` 写入落库 payload。
 */
export function redactPayload(payload: Record<string, unknown>): RedactPayloadResult {
  const sink = new HitSink()
  const next = walk(payload, '$', sink)
  const meta = sink.meta()
  if (!meta) return { payload, meta: null }
  return { payload: next as Record<string, unknown>, meta }
}

/** 单段文本脱敏（日志用）：不产生元数据，只替换可识别秘密。 */
export function redactTextForLog(text: string): string {
  return redactTextWithHits(text, '$', new HitSink())
}

/** 任意值脱敏（日志用）：字符串走文本规则，对象/数组递归，其他原样返回。 */
export function redactUnknown(value: unknown): unknown {
  return walk(value, '$', new HitSink())
}

/**
 * 审批参数落库脱敏：入参是 `JSON.stringify(args)`，脱敏后仍保留 `_redaction` 元数据。
 * **argsHash 必须在调用前基于原文计算**（网关先 hash 再 insert），哈希不随之改变。
 */
export function redactArgsJson(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    if (!isPlainObject(parsed)) return argsJson
    const { payload, meta } = redactPayload(parsed)
    if (!meta) return argsJson
    return JSON.stringify({ ...payload, [REDACTION_META_KEY]: meta })
  } catch {
    return argsJson
  }
}

/** 判断落库的 args_json 是否带脱敏元数据（重启重放时用于 UI 提示）。 */
export function hasRedactionMeta(argsJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    return isPlainObject(parsed) && REDACTION_META_KEY in parsed
  } catch {
    return false
  }
}
