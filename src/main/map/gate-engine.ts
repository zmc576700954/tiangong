/**
 * G1–G6 准入 gate 评估引擎（session-map 蓝图 §5.4 / §5.4.1 / §14 规格草案）。
 *
 * 职责边界：
 * - 只读：不写 work_items / work_steps / work_runs / node_evidence 任何一行；
 *   结果落库与状态迁移由调用方（work-execution-service 的 tick / WorkItemService）完成。
 * - 实现 §14 草案发布的 GateRecheck 端口（gate-recheck.ts）；**不读取也不信任**
 *   `work_items.gate_status`（§5.9「重跑不信任旧结果」）。唯一例外是人工豁免
 *   三字段（gate_waived_by/at/reason）：那是人工事实输入而非被重跑的缓存结论
 *   （§14.2 waiver 输入位），仅用于 G2 manual 条目的豁免判定（见下）。
 * - fail-closed（§14.5）：输入解析失败 / 数据缺失 / 查询异常 / 配置缺失一律
 *   判不通过并给出具体缺失码；不允许"跳过坏项继续判 pass"。
 *
 * 豁免规则（§14.4 G2 / §14.6；粒度与范围已裁决，2026-11-07，见 §M5.9）：
 * - 仅当**全部**缺失码都来自 G2、且每个失败的验收条目 type 都是 'manual' 时，
 *   有效的三字段豁免才把结论改判为 waived（视同通过）。
 * - 混入任何非 G2 缺失码（G1/G3/G4 明确不可豁免；G5/G6 经 D9 裁决**永久
 *   不可豁免**——G5 放行即乱序执行，G6 放行即准入时放过已知写冲突，重叠
 *   执行的正确路径是先 cancel running 任务）、或失败条目是 command/file_check/
 *   非结构化，豁免一律不生效（D3 已裁决：任务级粒度，不引入逐条目豁免；
 *   混合场景的正确路径是 revise 补全/改标失败条目）。
 * - 三字段缺任一（by/at/reason 为空或类型不符）→ 豁免不成立，维持 incomplete。
 *
 * 已裁决并实施的默认（行为不变，状态词更新）：
 * - D1（2026-11-07）：acceptance 须含 {type ∈ command|manual|file_check, expected}
 *   结构化条目（createDraft/revise 边界强制）；存量 [{id,text}] 仍会被判
 *   acceptance_item_not_structured（不自动迁移）。
 * - D3/D9（2026-11-07，见 §M5.9）：豁免为任务级粒度；G5/G6 永久不可豁免。
 *
 * 仍待决的 fail-closed 默认（§14.8，未替产品拍板，只落默认值）：
 * - D4：project_path 为空 → project_path_missing，不从图/项目兜底。
 * - D5/D6：「跨图写」在现有 schema 上无输入可表达（写入面只有 scope_files，
 *   已被 G1 限定在单一项目根内），故本引擎只强制 §5.4 原文可判定的部分：
 *   锚点存在 + graph_type='dev' + graph_id 一致；链接矩阵待 D5 裁决后扩展。
 * - D7（已裁决，2026-11-07）：预估行数来源 = Σ scope 文件行数的确定性代理——
 *   已存在文件按实际行数计，不存在的文件（将新建）计 0（新建规模由 G4 文件数
 *   上限约束）。生产来源由 runtime 装配注入（work-execution-runtime）；引擎
 *   默认仍无来源 → line_estimate_unavailable。真实改动行数属执行后 evidence
 *   对比（超限是执行后审计），不归准入判定。
 * - D10：G6 默认只比较同 project_path 的 running 任务；lineage 亲属不排除。
 *
 * 快照一致性：recheck 全程同步（better-sqlite3 同步 API + 单线程），一次调用
 * 内的多次读库之间不可能交错写入，等价于同一时点快照。
 */

import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { comparablePath, resolveRealPath } from '../agent/runtime/approval/write-paths'
import type { WorkItemRow } from './work-item-service'
import type { GateRecheck, GateRecheckResult, GateWaiverInfo } from './gate-recheck'

/** §5.4 G4 默认阈值；真实配置键待 D7 裁决，当前仅引擎参数。 */
const DEFAULT_G4_MAX_FILES = 20
const DEFAULT_G4_MAX_LINES = 800

/** §5.4 G2 结构化验收条目的合法 type。 */
const ACCEPTANCE_TYPES = ['command', 'manual', 'file_check'] as const

export interface GateEngineOptions {
  /** G4 文件数上限（§5.4：默认 20）。 */
  g4MaxFiles?: number
  /** G4 预估行数上限（§5.4：默认 800）。 */
  g4MaxLines?: number
  /**
   * G4 预估行数来源（D7 已裁决：Σ scope 文件行数代理，见文件头）。
   * 返回 null 表示无法预估（如文件不可读）→ fail-closed line_estimate_unavailable。
   * 未注入时同样 line_estimate_unavailable。
   */
  estimateLines?: (files: string[], projectPath: string | null) => number | null
}

/** 只读快照查询失败（§14.5-2）：表缺失/查询异常等，fail-closed。 */
const SNAPSHOT_FAILED = 'gate_snapshot_failed'

function parseStringArray(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return null
    return value.every((v) => typeof v === 'string') ? (value as string[]) : null
  } catch {
    return null
  }
}

/** 比较键：realpath 之后按平台折叠大小写，再 NFC 归一（§5.4.1 第 2/4 条）。 */
function compareKey(value: string): string {
  return comparablePath(value).normalize('NFC')
}

function isInsideRoot(rootReal: string, fileReal: string): boolean {
  const rel = path.relative(compareKey(rootReal), compareKey(fileReal))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 非 POSIX 根（Windows 盘符/反斜杠）按 §5.4.1 A9 fail-closed。 */
function isNonPosixRoot(root: string): boolean {
  return root.includes('\\') || /^[A-Za-z]:[\\/]/.test(root)
}

interface ScopeCheck {
  /** G1 缺失码。 */
  missing: string[]
  /** 规范化后的比较键（含未通过项的原始串兜底键），供 G4/G6 复用。 */
  keys: string[]
  /** 去重后的有效相对路径（通过根内校验的条目），供 G4 行数预估。 */
  validFiles: string[]
}

/**
 * G1：scope_files 非空，且全部位于项目根下（realpath + NFC + 大小写折叠，
 * 复用审批/write-paths 的统一管线，§5.4.1）。
 */
function checkScope(item: WorkItemRow): ScopeCheck {
  const missing: string[] = []
  const keys: string[] = []
  const validFiles: string[] = []

  const root = item.project_path
  if (!root || root.trim().length === 0) {
    return { missing: ['project_path_missing'], keys, validFiles }
  }
  if (isNonPosixRoot(root)) {
    return { missing: ['project_path_non_posix'], keys, validFiles }
  }

  const entries = parseStringArray(item.scope_files)
  if (entries === null) {
    return { missing: ['scope_files_invalid_json'], keys, validFiles }
  }

  let rootReal: string
  try {
    rootReal = resolveRealPath(path.resolve(root))
  } catch {
    return { missing: ['project_path_unresolvable'], keys, validFiles }
  }

  // G4 按「去重后的文件数」判定（§5.4）：同一规范化键只计一次。
  const seenValidKeys = new Set<string>()
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry.trim().length === 0) {
      missing.push(`scope_file_empty:${i}`)
      continue
    }
    if (path.isAbsolute(entry)) {
      // §5.4.1 第 5 条：外部绝对路径直接失败（scope 约定为项目根相对路径）。
      missing.push(`scope_file_escape:${i}`)
      keys.push(compareKey(entry))
      continue
    }
    const abs = path.resolve(rootReal, entry)
    try {
      const fileReal = resolveRealPath(abs)
      if (isInsideRoot(rootReal, fileReal)) {
        const key = compareKey(fileReal)
        keys.push(key)
        if (!seenValidKeys.has(key)) {
          seenValidKeys.add(key)
          validFiles.push(entry)
        }
      } else {
        missing.push(`scope_file_escape:${i}`)
        keys.push(compareKey(fileReal))
      }
    } catch {
      missing.push(`scope_file_unresolvable:${i}`)
    }
  }

  if (entries.length === 0) missing.push('scope_files_empty')
  return { missing, keys: [...new Set(keys)], validFiles }
}

/**
 * G2：acceptance_json 至少 1 条结构化可判定项
 * （type ∈ command/manual/file_check 且带非空 expected，§5.4 G2）。
 * 存量 [{id,text}] 条目 → acceptance_item_not_structured（D1 未裁决前即此判定）。
 *
 * manualWaivable：全部失败条目均为 type='manual'（缺 expected 的 manual 项）时
 * 才可能被三字段人工豁免（§14.4 G2、§14.9-3）；JSON 不可解析/空数组/混入
 * 任何非 manual 失败条目 → false（fail-closed）。
 */
interface AcceptanceCheck {
  missing: string[]
  manualWaivable: boolean
}

function checkAcceptance(item: WorkItemRow): AcceptanceCheck {
  const bad: string[] = []
  let manualOnly = true
  let parsed: unknown
  try {
    parsed = JSON.parse(item.acceptance_json)
  } catch {
    return { missing: ['acceptance_json_invalid'], manualWaivable: false }
  }
  if (!Array.isArray(parsed)) return { missing: ['acceptance_json_invalid'], manualWaivable: false }
  if (parsed.length === 0) return { missing: ['acceptance_json_empty'], manualWaivable: false }

  let hasStructured = false
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      bad.push(`acceptance_item_not_structured:${i}`)
      manualOnly = false
      continue
    }
    const record = entry as Record<string, unknown>
    const type = record['type']
    if (type === undefined || type === null) {
      bad.push(`acceptance_item_not_structured:${i}`)
      manualOnly = false
      continue
    }
    if (typeof type !== 'string' || !(ACCEPTANCE_TYPES as readonly string[]).includes(type)) {
      bad.push(`acceptance_type_unknown:${i}`)
      manualOnly = false
      continue
    }
    const expected = record['expected']
    if (expected === undefined || expected === null || (typeof expected === 'string' && expected.trim().length === 0)) {
      bad.push(`acceptance_expected_missing:${i}`)
      if (type !== 'manual') manualOnly = false
      continue
    }
    hasStructured = true
  }
  // §14.4 G2：pass 条件是「存在 ≥1 条结构化可判定项」；其余条目可以是非结构化
  // 补充，不得让坏条目的诊断码把整体判成 incomplete。
  if (hasStructured) return { missing: [], manualWaivable: false }
  if (bad.length === 0) bad.push('acceptance_json_empty')
  return { missing: bad, manualWaivable: manualOnly }
}

/** G4：规模上限（§5.4 G4）。预估行数来源由调用方注入（D7 已裁决的 Σ 行数代理）。 */
function checkScale(
  validFiles: string[],
  projectPath: string | null,
  options: Required<Pick<GateEngineOptions, 'g4MaxFiles' | 'g4MaxLines'>> & Pick<GateEngineOptions, 'estimateLines'>,
): string[] {
  const missing: string[] = []
  if (!Number.isFinite(options.g4MaxFiles) || options.g4MaxFiles <= 0 || !Number.isFinite(options.g4MaxLines) || options.g4MaxLines <= 0) {
    return ['gate_policy_missing']
  }
  if (validFiles.length > options.g4MaxFiles) {
    missing.push(`scope_file_count_exceeded:${validFiles.length}_${options.g4MaxFiles}`)
  }
  if (!options.estimateLines) {
    missing.push('line_estimate_unavailable')
  } else {
    const estimated = options.estimateLines(validFiles, projectPath)
    if (estimated === null) {
      missing.push('line_estimate_unavailable')
    } else if (estimated > options.g4MaxLines) {
      missing.push(`estimated_lines_exceeded:${estimated}_${options.g4MaxLines}`)
    }
  }
  return missing
}

interface AnchorCheck {
  missing: string[]
}

/**
 * G3：锚点存在、属于本图、graph_type='dev'（§5.4 G3 可判定子集；D5/D6 见文件头）。
 */
function checkAnchor(db: BetterSqlite3.Database, item: WorkItemRow): AnchorCheck {
  if (!item.anchor_node_id) return { missing: ['anchor_node_missing'] }
  let row: { graph_id: string; graph_type: string } | undefined
  try {
    row = db
      .prepare('SELECT graph_id, graph_type FROM nodes WHERE id = ?')
      .get(item.anchor_node_id) as { graph_id: string; graph_type: string } | undefined
  } catch {
    return { missing: [`${SNAPSHOT_FAILED}:anchor_node`] }
  }
  if (!row) return { missing: ['anchor_node_missing'] }
  if (row.graph_id !== item.graph_id) return { missing: ['anchor_node_graph_mismatch'] }
  if (row.graph_type !== 'dev') return { missing: [`anchor_node_not_dev:${row.graph_type}`] }
  return { missing: [] }
}

interface DepNode {
  id: string
  is_current: number
  status: string
  project_path: string | null
}

function loadDepsJson(db: BetterSqlite3.Database, itemId: string): string[] | null {
  try {
    const row = db.prepare('SELECT depends_on_json FROM work_items WHERE id = ?').get(itemId) as
      | { depends_on_json: string }
      | undefined
    if (!row) return null
    return parseStringArray(row.depends_on_json)
  } catch {
    return null
  }
}

/**
 * G5：depends_on_json 传递闭包内全部上游为当前 revision 且 status='done'，
 * 无环（§5.4 G5、§5.5.1）。隐式依赖不进闭包（D8 默认：显式声明为准）。
 */
function checkDependencies(db: BetterSqlite3.Database, item: WorkItemRow): string[] {
  const missing: string[] = []
  let stmt: BetterSqlite3.Statement
  try {
    stmt = db.prepare('SELECT id, is_current, status, project_path FROM work_items WHERE id = ?')
  } catch {
    return [`${SNAPSHOT_FAILED}:work_items`]
  }

  const visit = (id: string, visiting: Set<string>, visited: Set<string>): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      missing.push(`dep_cycle:${id}`)
      return
    }
    visiting.add(id)
    let row: DepNode | undefined
    try {
      row = stmt.get(id) as DepNode | undefined
    } catch {
      missing.push(`${SNAPSHOT_FAILED}:work_items`)
      return
    }
    if (!row) {
      missing.push(`dep_missing:${id}`)
    } else {
      if (!row.is_current) missing.push(`dep_revision_stale:${id}`)
      if (row.status !== 'done') missing.push(`dep_not_done:${id}:${row.status}`)
      if (item.project_path && row.project_path && row.project_path !== item.project_path) {
        missing.push(`dep_cross_project:${id}`)
      }
      const children = loadDepsJson(db, id)
      if (children === null) {
        missing.push(`depends_invalid_json:${id}`)
      } else {
        for (const child of children) visit(child, visiting, visited)
      }
    }
    visiting.delete(id)
    visited.add(id)
  }

  const roots = parseStringArray(item.depends_on_json)
  if (roots === null) return ['depends_invalid_json']
  for (const id of roots) visit(id, new Set(), new Set())
  return missing
}

/**
 * G6：与其它 running（is_current=1）任务的 scope_files 无交集（§5.4 G6）。
 * 准入快照，不是写锁——运行期互斥仍由 tick 写闸保证（§5.9 第 5 步）。
 */
function checkWriteConflicts(db: BetterSqlite3.Database, item: WorkItemRow, ownKeys: ReadonlySet<string>): string[] {
  const missing: string[] = []
  let rows: Array<{ id: string; project_path: string | null; scope_files: string }>
  try {
    rows = db
      .prepare(
        "SELECT id, project_path, scope_files FROM work_items WHERE status = 'running' AND is_current = 1 AND id <> ? ORDER BY id",
      )
      .all(item.id) as Array<{ id: string; project_path: string | null; scope_files: string }>
  } catch {
    return [`${SNAPSHOT_FAILED}:work_items`]
  }

  for (const row of rows) {
    // D10 默认：只比较同 project_path；己方无 project 时退化为全量比较（保守）。
    if (item.project_path && row.project_path && row.project_path !== item.project_path) continue
    const entries = parseStringArray(row.scope_files)
    if (entries === null) {
      missing.push(`scope_invalid:${row.id}`)
      continue
    }
    for (const entry of entries) {
      let key: string
      try {
        key = row.project_path
          ? compareKey(resolveRealPath(path.resolve(row.project_path, entry)))
          : compareKey(entry)
      } catch {
        missing.push(`scope_invalid:${row.id}`)
        continue
      }
      if (ownKeys.has(key)) {
        missing.push(`scope_conflict:${row.id}:${entry}`)
      }
    }
  }
  return missing
}

/** 人工豁免三字段校验（§14.3：缺任一 → 不成立；引擎独立复核，不沿用写入端守卫）。 */
function readValidWaiver(item: WorkItemRow): GateWaiverInfo | null {
  const { gate_waived_by: by, gate_waived_at: at, gate_waive_reason: reason } = item
  if (typeof by !== 'string' || by.trim().length === 0) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof reason !== 'string' || reason.trim().length === 0) return null
  return { by, at, reason }
}

/**
 * 构造 G1–G6 评估器（对齐 §14 规格草案与 gate-recheck.ts 的 GateRecheck 端口）。
 * 生产接线见 work-execution-runtime.ts（gateRecheck 选项）。
 */
export function createGateEngine(db: BetterSqlite3.Database, options: GateEngineOptions = {}): GateRecheck {
  const policy = {
    g4MaxFiles: options.g4MaxFiles ?? DEFAULT_G4_MAX_FILES,
    g4MaxLines: options.g4MaxLines ?? DEFAULT_G4_MAX_LINES,
    estimateLines: options.estimateLines,
  }

  return {
    recheck(item: WorkItemRow): GateRecheckResult {
      // G1..G6 顺序固定，缺失码按 gate 顺序聚合，保证同输入同输出（§14.9-10）。
      const scope = checkScope(item)
      const acceptance = checkAcceptance(item)
      const anchor = checkAnchor(db, item)
      const scale = checkScale(scope.validFiles, item.project_path, policy)
      const deps = checkDependencies(db, item)
      const conflicts = checkWriteConflicts(db, item, new Set(scope.keys))
      const missing: string[] = [
        ...scope.missing, // G1
        ...acceptance.missing, // G2
        ...anchor.missing, // G3
        ...scale, // G4
        ...deps, // G5
        ...conflicts, // G6
      ]
      if (missing.length === 0) return { ok: true, missing: [] }

      // 豁免（§14.6）：仅当全部缺失码都来自 G2 的 manual 失败条目，且三字段
      // 齐全时，人工豁免视同通过；任何其他 gate 的缺失码都使豁免不生效。
      const otherThanG2 =
        scope.missing.length +
        anchor.missing.length +
        scale.length +
        deps.length +
        conflicts.length
      if (otherThanG2 === 0 && acceptance.manualWaivable) {
        const waiver = readValidWaiver(item)
        if (waiver) return { ok: true, missing: [], waived: waiver }
      }
      return { ok: false, missing }
    },
  }
}
