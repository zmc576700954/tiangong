/**
 * D2 确定性验收执行器（session-map 蓝图 §14.8 D2）。
 *
 * 边界（最小闭环）：
 * - 只处理机器可判条目：`command` 判退出码（可选 `stdout_contains`、`timeout_ms`），
 *   `file_check` 判项目根内路径存在（可选 `content_contains`）。
 * - `manual` 条目**不自动通过**：只记 `acceptance_manual_pending:<i>`，等待人工确认；
 *   本执行器不把人工描述转成 pass。
 * - fail-closed：JSON 非法/空、条目非结构化、type 未知、expected 缺失、命令超时或
 *   启动失败、路径逃逸根目录、文件不可读、内容不匹配 → 一律 `ok=false` 并给出
 *   具体缺失码；不得"跳过坏项当作通过"。
 * - 路径判定复用审批/write-paths 的 realpath + NFC + 平台折叠管线（与 G1 同源）。
 * - 缺失码一旦发布只追加不改名（与 D11 同纪律）。
 *
 * 本执行器不做重试、不写库；调用方（agent-step-runner / tick）据 `ok` 决定终态。
 */

import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import type { ExecException } from 'node:child_process'
import { isPathInside } from '../agent/runtime/approval/write-paths'

/** command 条目默认超时；单条可经 `timeout_ms` 覆盖，上限 10 分钟。 */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export interface AcceptanceCommandOutcome {
  exitCode: number
  stdout: string
  timedOut: boolean
}

export type AcceptanceCommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<AcceptanceCommandOutcome>

/** manual 待确认条目：id 用于确认事实关联，expected/text 用于人工阅读。 */
export interface AcceptancePendingItem {
  id: string
  expected: string
  text?: string
}

/**
 * 单条验收结果（逐条诊断用）。
 * - `type` 非法形状时为 null；`id` 仅 manual 条目且声明了 id 时才存在。
 * - `codes` 是本条产生的缺失码/待确认码，未产生任何码即视为通过。
 */
export interface AcceptanceItemResult {
  index: number
  id?: string
  type: string | null
  outcome: 'pass' | 'fail' | 'pending'
  codes: string[]
}

export interface AcceptanceVerdict {
  /**
   * 全部条目均已判定且通过。manual 待确认也属于「判定不出来」：
   * `pending` 非空时 ok 必为 false，绝不把人工条目当自动通过。
   */
  ok: boolean
  /** 失败/判定不出的具体缺失码（写入终态摘要 / 事件，供人排查）。 */
  missing: string[]
  /** manual 条目：不自动通过，等待人工确认。 */
  pending: string[]
  /** 逐条结果（供调用处写可查诊断；本执行器自身不落库）。 */
  items: AcceptanceItemResult[]
  /** manual 条目的结构化明细（写入 work_steps.input_request_json）。 */
  pendingItems: AcceptancePendingItem[]
  /** 已判定条目数（command/file_check 实际执行 + 已人工确认的 manual）。 */
  checked: number
}

export interface EvaluateAcceptanceInput {
  acceptanceJson: string | null | undefined
  projectPath: string | null | undefined
  defaultTimeoutMs?: number
  /**
   * 已人工确认的 manual 条目 id：重算时视为通过。
   * 只由人工确认入口传入，执行器自身绝不自动确认任何 manual。
   */
  confirmedManualEntryIds?: string[]
  /** 测试注入；生产缺省用 shell 执行。 */
  runCommand?: AcceptanceCommandRunner
  /** 测试注入；生产缺省用 fs 读 UTF-8。 */
  readFile?: (absPath: string) => string
}

/** 生产默认命令执行：shell 语义（与 acceptance 里人写的命令一致），带超时。 */
export const defaultAcceptanceCommandRunner: AcceptanceCommandRunner = (command, options) =>
  new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error: ExecException | null, stdout: string) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: stdout ?? '', timedOut: false })
          return
        }
        if (error.killed) {
          resolve({ exitCode: -1, stdout: stdout ?? '', timedOut: true })
          return
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout: stdout ?? '', timedOut: false })
          return
        }
        // 非数字 code（如 spawn ENOENT）说明命令根本没跑起来：必须失败。
        reject(error)
      }
    )
  })

function parseEntries(raw: string | null | undefined): unknown[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | null | 'invalid' {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0) return 'invalid'
  return value
}

function optionalTimeout(record: Record<string, unknown>, fallback: number): number | null {
  const value = record['timeout_ms']
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS)
}

/**
 * 评估结构化 acceptance。无任何条目 / 非法形状属于「判定不出」→ ok=false（fail-closed）；
 * 仅 manual 条目 → ok=false + pending（不自动通过，交人工，但本执行器不判 pass）。
 */
export async function evaluateAcceptance(input: EvaluateAcceptanceInput): Promise<AcceptanceVerdict> {
  const missing: string[] = []
  const pending: string[] = []
  const pendingItems: AcceptancePendingItem[] = []
  const items: AcceptanceItemResult[] = []
  const confirmedManualIds = new Set(input.confirmedManualEntryIds ?? [])
  let checked = 0

  const projectPath = input.projectPath?.trim()
  if (!projectPath) {
    return { ok: false, missing: ['project_path_missing'], pending, items, pendingItems, checked }
  }

  const entries = parseEntries(input.acceptanceJson)
  if (entries === null) {
    return { ok: false, missing: ['acceptance_json_invalid'], pending, items, pendingItems, checked }
  }
  if (entries.length === 0) {
    return { ok: false, missing: ['acceptance_json_empty'], pending, items, pendingItems, checked }
  }

  let projectStat: fs.Stats
  try {
    projectStat = fs.statSync(projectPath)
  } catch {
    return { ok: false, missing: ['project_path_unresolvable'], pending, items, pendingItems, checked }
  }
  if (!projectStat.isDirectory()) {
    return { ok: false, missing: ['project_path_not_directory'], pending, items, pendingItems, checked }
  }

  const runCommand = input.runCommand ?? defaultAcceptanceCommandRunner
  const readFile = input.readFile ?? ((abs: string) => fs.readFileSync(abs, 'utf8'))
  const fallbackTimeout = input.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  for (let i = 0; i < entries.length; i += 1) {
    const entryCodes: string[] = []
    let entryType: string | null = null
    let entryId: string | undefined
    let isPending = false
    const fail = (code: string): void => {
      entryCodes.push(code)
      missing.push(code)
    }
    const wait = (code: string): void => {
      entryCodes.push(code)
      pending.push(code)
      isPending = true
    }
    // finally 保证每条（含所有 continue 分支）都留下逐条结果，供调用处落诊断。
    try {
      const entry = entries[i]
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        fail(`acceptance_item_not_structured:${i}`)
        continue
      }
      const record = entry as Record<string, unknown>
      const type = record['type']
      if (typeof type !== 'string' || type.trim().length === 0) {
        fail(`acceptance_item_not_structured:${i}`)
        continue
      }
      entryType = type
      const expected = record['expected']
      if (typeof expected !== 'string' || expected.trim().length === 0) {
        fail(`acceptance_expected_missing:${i}`)
        continue
      }

      if (type === 'manual') {
        // 人工判定：不自动通过，也不阻塞；由人工确认路径处理。
        // 确认入口需要稳定 id 关联事实：缺 id 时无法记录「确认了哪一条」，按缺失收口。
        const id = record['id']
        if (typeof id !== 'string' || id.trim().length === 0) {
          fail(`acceptance_manual_id_missing:${i}`)
          continue
        }
        entryId = id
        const text = typeof record['text'] === 'string' ? record['text'] : undefined
        if (confirmedManualIds.has(id)) {
          // 人工已确认：本次重算视为通过；不再进入 pending。
          checked += 1
          continue
        }
        wait(`acceptance_manual_pending:${i}`)
        pendingItems.push({ id, expected, ...(text !== undefined ? { text } : {}) })
        continue
      }

      if (type === 'command') {
        const timeoutMs = optionalTimeout(record, fallbackTimeout)
        if (timeoutMs === null) {
          fail(`acceptance_command_timeout_invalid:${i}`)
          continue
        }
        const stdoutContains = optionalString(record, 'stdout_contains')
        if (stdoutContains === 'invalid') {
          fail(`acceptance_command_option_invalid:${i}`)
          continue
        }
        checked += 1
        let outcome: AcceptanceCommandOutcome
        try {
          outcome = await runCommand(expected, { cwd: projectPath, timeoutMs })
        } catch {
          fail(`acceptance_command_spawn_failed:${i}`)
          continue
        }
        if (outcome.timedOut) {
          fail(`acceptance_command_timeout:${i}`)
          continue
        }
        if (outcome.exitCode !== 0) {
          fail(`acceptance_command_exit:${i}:${outcome.exitCode}`)
          continue
        }
        if (stdoutContains !== null && !outcome.stdout.includes(stdoutContains)) {
          fail(`acceptance_command_stdout_mismatch:${i}`)
        }
        continue
      }

      if (type === 'file_check') {
        const contentContains = optionalString(record, 'content_contains')
        if (contentContains === 'invalid') {
          fail(`acceptance_file_option_invalid:${i}`)
          continue
        }
        if (path.isAbsolute(expected)) {
          fail(`acceptance_file_not_relative:${i}`)
          continue
        }
        let inside = false
        try {
          inside = isPathInside(projectPath, expected)
        } catch {
          inside = false
        }
        if (!inside) {
          fail(`acceptance_file_outside_root:${i}`)
          continue
        }
        const abs = path.resolve(projectPath, expected)
        checked += 1
        let stat: fs.Stats
        try {
          stat = fs.statSync(abs)
        } catch {
          fail(`acceptance_file_missing:${i}`)
          continue
        }
        if (!stat.isFile()) {
          fail(`acceptance_file_not_file:${i}`)
          continue
        }
        if (contentContains !== null) {
          let content: string
          try {
            content = readFile(abs)
          } catch {
            fail(`acceptance_file_unreadable:${i}`)
            continue
          }
          if (!content.includes(contentContains)) {
            fail(`acceptance_file_content_mismatch:${i}`)
          }
        }
        continue
      }

      fail(`acceptance_type_unknown:${i}`)
    } finally {
      items.push({
        index: i,
        ...(entryId !== undefined ? { id: entryId } : {}),
        type: entryType,
        outcome: isPending ? 'pending' : entryCodes.length > 0 ? 'fail' : 'pass',
        codes: entryCodes,
      })
    }
  }

  return { ok: missing.length === 0 && pending.length === 0, missing, pending, items, pendingItems, checked }
}
