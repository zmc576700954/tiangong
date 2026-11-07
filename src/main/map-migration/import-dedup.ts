/**
 * S1 导入查重（session-map 蓝图 §2.6 + §2.2.2 S1-d）
 *
 * 铁律：重复导入不允许生成第二套 lineage——查重在**任何 graph/node 写入之前**
 * （I5），命中即拒绝并写 import_rejections；允许时指纹行与图创建在同一事务提交
 * （I6，由 GraphService 在其图事务内调用 commitFingerprint 完成）。
 *
 * 指纹 4 信号：项目名 / 目录名（主判据）/ max(mtime)（仅证据，不参与拒绝）/
 * 内容抽样 N=12 等距（主判据）。已定参数：sampleSize=12、similarityReject=0.6、
 * similarityBranchVariant=0.8（先默认上线，按 import_rejections 真实分布调整）。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('ImportDedup')

/** 已定参数（§2.6）：写配置前的默认值。 */
export const IMPORT_DEDUP_DEFAULTS = {
  sampleSize: 12,
  similarityReject: 0.6,
  similarityBranchVariant: 0.8,
  /** 单样本文件大小上限；超大文件跳过且不降低分母。 */
  maxSampleFileBytes: 2 * 1024 * 1024,
  /** 明细留存天数（可配置）。 */
  rejectionRetentionDays: 90,
} as const

/** 受管文件枚举忽略目录（锁文件不忽略，作为依赖内容信号）。 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'coverage'])

const BINARY_EXTENSIONS = new Set([
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tif', '.tiff',
  // 压缩
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.7z', '.rar', '.jar',
  // 可执行/库
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
])

export interface FingerprintSample {
  /** 项目根相对 POSIX 路径。 */
  path: string
  size: number
  sha256: string
}

export interface ProjectFingerprint {
  projectName: string | null
  dirName: string
  rootPath: string
  lastModifiedAt: number | null
  samples: FingerprintSample[]
  sampleCount: number
  /** 采集失败明细（文件读失败等；§2.2.2 S1-d）。 */
  errors: string[]
}

/** 目录名规范化：去首尾空白、转小写；比较用规范化值，落库保留原值。 */
export function normalizeDirName(dirName: string): string {
  return dirName.trim().toLowerCase()
}

function isBinaryFile(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase())
}

async function walkManagedFiles(root: string, limit = 20_000): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= limit) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // 不可读目录跳过
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

/**
 * 指纹采集（事务外；S1-d 采集顺序）。抽样失败（无可采文件）返回 sampleCount=0，
 * 由判定层走 §2.6 Step 4 分支。
 */
export async function collectFingerprint(
  projectRoot: string,
  projectNameHint?: string,
  options?: { sampleSize?: number },
): Promise<ProjectFingerprint> {
  const sampleSize = options?.sampleSize ?? IMPORT_DEDUP_DEFAULTS.sampleSize
  const rootPath = await fs.realpath(projectRoot)
  const dirName = path.basename(rootPath)
  let projectName: string | null = projectNameHint ?? null
  if (!projectName) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(rootPath, 'package.json'), 'utf-8')) as { name?: string }
      if (typeof pkg.name === 'string' && pkg.name.trim() !== '') projectName = pkg.name
    } catch {
      /* 无 package.json 或不可读 → 用目录名 */
    }
    projectName = projectName ?? dirName
  }

  const allFiles = await walkManagedFiles(rootPath)
  let lastModifiedAt: number | null = null
  const errors: string[] = []
  const candidates: Array<{ abs: string; rel: string; size: number }> = []
  for (const abs of allFiles) {
    try {
      const st = await fs.stat(abs)
      if (lastModifiedAt == null || st.mtimeMs > lastModifiedAt) lastModifiedAt = st.mtimeMs
      const rel = path.relative(rootPath, abs).split(path.sep).join('/')
      const ext = path.extname(abs)
      if (isBinaryFile(ext)) continue
      if (st.size > IMPORT_DEDUP_DEFAULTS.maxSampleFileBytes) continue
      candidates.push({ abs, rel, size: st.size })
    } catch (err) {
      errors.push(`${abs}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  candidates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  // 等距抽样：M ≥ N 取 floor(i*(M-1)/(N-1)) 去重；M < N 全取（S1-d）
  const M = candidates.length
  const picked: Array<{ abs: string; rel: string; size: number }> = []
  if (M > sampleSize) {
    const seen = new Set<number>()
    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.floor((i * (M - 1)) / (sampleSize - 1))
      if (seen.has(idx)) continue
      seen.add(idx)
      picked.push(candidates[idx])
    }
  } else {
    picked.push(...candidates)
  }

  const samples: FingerprintSample[] = []
  for (const c of picked) {
    try {
      const buf = await fs.readFile(c.abs)
      // 二进制兜底判定：前 4KB 含 NUL → 跳过（§2.2.2 S1-d），不因跳过降低分母
      const head = buf.subarray(0, 4096)
      if (head.includes(0)) continue
      samples.push({ path: c.rel, size: c.size, sha256: createHash('sha256').update(buf).digest('hex') })
    } catch (err) {
      errors.push(`${c.abs}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    projectName,
    dirName,
    rootPath,
    lastModifiedAt,
    samples,
    sampleCount: samples.length,
    errors,
  }
}

/** 落库形态的既有指纹（ImportDedupService 读取）。 */
export interface StoredFingerprint {
  id: string
  root_path: string
  dir_name: string
  project_name: string | null
  sample_files_json: string
  sample_count: number
  graph_ids_json: string
}

export interface MatchedSignals {
  dir_name_same: boolean
  name_same: boolean | null
  similarity: number | null
  sample_count: number
  mtime_used: false
  decision_step: string
}

export type ImportDecision =
  | { action: 'reject'; step: '1' | '2a' | '3b' | '4a' | '3a-auto'; signals: MatchedSignals; matchedFingerprintId: string | null; reason: string }
  | { action: 'allow_with_warning'; step: '2b' | '4b'; signals: MatchedSignals; matchedFingerprintId: string | null; reason: string }
  | { action: 'allow_branch_variant'; step: '3a-remembered' | '3a-this_time'; signals: MatchedSignals; matchedFingerprintId: string; reason: string }
  | { action: 'allow'; step: '3c'; signals: MatchedSignals; matchedFingerprintId: string | null; reason: string }
  | { action: 'allow_rebuild'; step: 'rebuild'; signals: MatchedSignals; matchedFingerprintId: string; reason: string }

/** 与既有指纹的内容相似度：按相对路径交集比对 sha256；分母用本次采样数（S1-d）。 */
export function contentSimilarity(current: ProjectFingerprint, stored: StoredFingerprint): number | null {
  if (current.sampleCount === 0) return null
  let storedSamples: FingerprintSample[]
  try {
    storedSamples = JSON.parse(stored.sample_files_json) as FingerprintSample[]
  } catch {
    return null
  }
  if (!Array.isArray(storedSamples) || storedSamples.length === 0) return null
  const storedByPath = new Map(storedSamples.map((s) => [s.path, s.sha256]))
  let matched = 0
  for (const s of current.samples) {
    if (storedByPath.get(s.path) === s.sha256) matched += 1
  }
  return Number((matched / current.sampleCount).toFixed(4))
}

export interface DecideInput {
  fingerprint: ProjectFingerprint
  /** 全部既有指纹（事务内重读，防 TOCTOU）。 */
  stored: StoredFingerprint[]
  /** 命中分支变体放行时用户是否显式确认（interactive=false 时 3a 一律拒绝）。 */
  interactive: boolean
  /** 用户是否勾选"对同一指纹记住"（仅 interactive 下有效）。 */
  rememberAllowance?: boolean
  /** 已撤销未过期的放行规则 (fingerprint_id, dir_name)（事务内重读）。 */
  activeAllowanceDirs: Set<string>
  /** 项目删除时指纹一并删除（§2.6 规则 6）；graph 存在性由调用方传入。 */
  graphExists: (graphId: string) => boolean
}

/**
 * 可执行判定顺序（§2.6，命中即停）。纯函数——DB 读写由调用方承担，
 * 便于对 6 类样本做验收测试（S1-f 判据 2）。
 */
export function decideImport(input: DecideInput): ImportDecision {
  const { fingerprint: fp } = input
  const baseSignals = (step: string, extra?: Partial<MatchedSignals>): MatchedSignals => ({
    dir_name_same: false,
    name_same: null,
    similarity: null,
    sample_count: fp.sampleCount,
    mtime_used: false,
    decision_step: step,
    ...extra,
  })

  const sameRoot = input.stored.find((s) => s.root_path === fp.rootPath)
  if (sameRoot) {
    // §2.6 规则 6：指纹在且图在才拒绝；指向的图均已不存在 → 重建路径（复用指纹）
    const graphIds = safeParseStringArray(sameRoot.graph_ids_json)
    const anyGraphAlive = graphIds.some((g) => input.graphExists(g))
    if (anyGraphAlive) {
      return {
        action: 'reject',
        step: '1',
        signals: baseSignals('1', { dir_name_same: normalizeDirName(sameRoot.dir_name) === normalizeDirName(fp.dirName) }),
        matchedFingerprintId: sameRoot.id,
        reason: '同一工作区重复导入（root_path 相同且仍有现存图）',
      }
    }
    return {
      action: 'allow_rebuild',
      step: 'rebuild',
      signals: baseSignals('1-rebuild', { dir_name_same: true }),
      matchedFingerprintId: sameRoot.id,
      reason: '图已被删除,按"重建同一项目"处理(复用原指纹,不新建 lineage)',
    }
  }

  // 与全部既有指纹取最大相似度（同/异目录名两个通道分别取）
  let bestSameDir: { stored: StoredFingerprint; sim: number } | null = null
  let bestDiffDir: { stored: StoredFingerprint; sim: number } | null = null
  for (const s of input.stored) {
    const sim = contentSimilarity(fp, s)
    if (sim == null) continue
    const same = normalizeDirName(s.dir_name) === normalizeDirName(fp.dirName)
    if (same) {
      if (!bestSameDir || sim > bestSameDir.sim) bestSameDir = { stored: s, sim }
    } else {
      if (!bestDiffDir || sim > bestDiffDir.sim) bestDiffDir = { stored: s, sim }
    }
  }

  // Step 2：目录名相同
  if (bestSameDir) {
    const { stored, sim } = bestSameDir
    const signals = baseSignals('', {
      dir_name_same: true,
      name_same: fp.projectName != null && stored.project_name != null ? fp.projectName === stored.project_name : null,
      similarity: sim,
    })
    if (sim >= IMPORT_DEDUP_DEFAULTS.similarityReject) {
      return { action: 'reject', step: '2a', signals: { ...signals, decision_step: '2a' }, matchedFingerprintId: stored.id, reason: `同一项目重导（同名目录且内容相似度 ${sim} ≥ 0.6）` }
    }
    return { action: 'allow_with_warning', step: '2b', signals: { ...signals, decision_step: '2b' }, matchedFingerprintId: stored.id, reason: `同名目录但内容差异大（相似度 ${sim} < 0.6），可能是另一个项目` }
  }

  // Step 3：目录名不同
  if (bestDiffDir) {
    const { stored, sim } = bestDiffDir
    const signals = baseSignals('', { dir_name_same: false, similarity: sim })
    if (sim >= IMPORT_DEDUP_DEFAULTS.similarityBranchVariant) {
      // 3a：分支/副本。记住规则最小粒度 (fingerprint_id, dir_name)
      const allowanceKey = `${stored.id}::${normalizeDirName(fp.dirName)}`
      if (input.activeAllowanceDirs.has(allowanceKey)) {
        return { action: 'allow_branch_variant', step: '3a-remembered', signals: { ...signals, decision_step: '3a' }, matchedFingerprintId: stored.id, reason: '放行来自记住的规则（不允许静默豁免,证据面板须标明）' }
      }
      if (input.interactive) {
        return { action: 'allow_branch_variant', step: input.rememberAllowance ? '3a-this_time' : '3a-this_time', signals: { ...signals, decision_step: '3a' }, matchedFingerprintId: stored.id, reason: '同一仓库的不同分支/副本（用户显式确认放行）' }
      }
      return { action: 'reject', step: '3a-auto', signals: { ...signals, decision_step: '3a' }, matchedFingerprintId: stored.id, reason: `自动导入不允放行分支/副本（相似度 ${sim} ≥ 0.8，拿不准一律拒绝）` }
    }
    if (sim >= IMPORT_DEDUP_DEFAULTS.similarityReject) {
      return { action: 'reject', step: '3b', signals: { ...signals, decision_step: '3b' }, matchedFingerprintId: stored.id, reason: `按重复处理（相似度 0.6 ≤ ${sim} < 0.8）` }
    }
    return { action: 'allow', step: '3c', signals: { ...signals, decision_step: '3c' }, matchedFingerprintId: stored.id, reason: `不同项目（相似度 ${sim} < 0.6）` }
  }

  // Step 4：抽样失败（无可采文件）
  if (fp.sampleCount === 0) {
    const nameMatch = input.stored.find((s) => normalizeDirName(s.dir_name) === normalizeDirName(fp.dirName) && s.project_name != null && s.project_name === fp.projectName)
    if (nameMatch) {
      return { action: 'reject', step: '4a', signals: baseSignals('4a', { dir_name_same: true, name_same: true }), matchedFingerprintId: nameMatch.id, reason: '未能完成内容比对,退回名称+目录名判据（均相同 → 拒绝）' }
    }
    return { action: 'allow_with_warning', step: '4b', signals: baseSignals('4b'), matchedFingerprintId: null, reason: '未能完成内容比对,要求用户确认' }
  }

  return { action: 'allow', step: '3c', signals: baseSignals('3c'), matchedFingerprintId: null, reason: '新项目（无任何匹配信号）' }
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export interface ImportCheckResult {
  decision: ImportDecision
  fingerprint: ProjectFingerprint
  /** 需要与图创建同事务落库的指纹计划（I6）；reject 时为 undefined。 */
  plan?: FingerprintPlan
}

/** 导入被查重拒绝——message 面向用户,decision 供渲染层展示命中项明细。 */
export class ImportRejectedError extends Error {
  constructor(public readonly decision: Extract<ImportDecision, { action: 'reject' }>) {
    super(`导入被拒绝：${decision.reason}（判定步骤 ${decision.step}，相似度 ${decision.signals.similarity ?? 'n/a'}）`)
    this.name = 'ImportRejectedError'
  }
}

/** UNIQUE(root_path) 并发冲突判定（§2.2.2 S1-d TOCTOU 兜底）。 */
export function isRootPathConflict(err: unknown): boolean {
  return /UNIQUE constraint failed: project_fingerprints\.root_path/.test(
    err instanceof Error ? err.message : String(err),
  )
}

export interface FingerprintPlan {
  action: ImportDecision['action']
  matchedFingerprintId: string | null
  /** 在图创建事务内调用：插入新指纹或复用/更新既有指纹的 graph_ids_json（§2.6 规则 6）。 */
  commitFingerprint: (db: BetterSqlite3.Database, graphIds: string[]) => void
}

export class ImportDedupService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private readStored(): StoredFingerprint[] {
    return this.db
      .prepare('SELECT id, root_path, dir_name, project_name, sample_files_json, sample_count, graph_ids_json FROM project_fingerprints')
      .all() as StoredFingerprint[]
  }

  private activeAllowanceDirs(): Set<string> {
    const rows = this.db
      .prepare('SELECT fingerprint_id, dir_name FROM import_allowances WHERE revoked_at IS NULL')
      .all() as Array<{ fingerprint_id: string; dir_name: string }>
    return new Set(rows.map((r) => `${r.fingerprint_id}::${normalizeDirName(r.dir_name)}`))
  }

  /**
   * 导入检查（I5：在任何 graph/node/chat_threads 写入之前调用）。
   * 指纹采集在事务外；DB 判定读取不持事务（并发写风险由 GraphService 事务内的
   * 指纹 UNIQUE(root_path) 冲突兜底 → 回滚并按"同路径重复导入"拒绝，§2.2.2 S1-d）。
   */
  async check(input: {
    projectRoot: string
    projectName?: string
    interactive?: boolean
    rememberAllowance?: boolean
    /** §9.2 project:import:preview:只判定不落任何行(决策记录/放行规则都不写)。 */
    preview?: boolean
  }): Promise<ImportCheckResult> {
    const fingerprint = await collectFingerprint(input.projectRoot, input.projectName)
    const stored = this.readStored()
    const decision = decideImport({
      fingerprint,
      stored,
      interactive: input.interactive ?? false,
      rememberAllowance: input.rememberAllowance,
      activeAllowanceDirs: this.activeAllowanceDirs(),
      graphExists: (graphId) =>
        this.db.prepare('SELECT 1 FROM graphs WHERE id = ?').get(graphId) != null,
    })

    if (input.preview) {
      // 预览模式（§9.2）：只返回判定与命中证据,不写任何行。
      return { decision, fingerprint }
    }
    if (decision.action === 'reject' || decision.action === 'allow_with_warning' || decision.action === 'allow_branch_variant') {
      // 决策留痕：拒绝 + 两类放行（allowed_branch / allowed_with_warning,§2.6 表注）。
      // reject 无任何图行（I5）；放行继续走指纹计划。
      this.recordDecision(fingerprint, decision)
      if (decision.action === 'reject') {
        return { decision, fingerprint }
      }
    }

    const plan = this.buildPlan(decision, fingerprint)
    if (decision.step === '3a-this_time' && input.rememberAllowance) {
      this.writeAllowance(decision.matchedFingerprintId, fingerprint.dirName)
    }
    return { decision, fingerprint, plan }
  }

  private buildPlan(decision: ImportDecision, fp: ProjectFingerprint): FingerprintPlan {
    const insertNew = (db: BetterSqlite3.Database, graphIds: string[]): void => {
      const id = `pf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO project_fingerprints
           (id, project_name, dir_name, root_path, last_modified_at, sample_files_json, sample_count, signature_hash, graph_ids_json, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        id,
        fp.projectName,
        fp.dirName,
        fp.rootPath,
        fp.lastModifiedAt ?? null,
        JSON.stringify(fp.samples),
        fp.sampleCount,
        JSON.stringify(graphIds),
        now,
        now,
      )
    }
    if (decision.action === 'allow_rebuild' && decision.matchedFingerprintId) {
      const id = decision.matchedFingerprintId
      return {
        action: decision.action,
        matchedFingerprintId: id,
        // §2.6 规则 6：重建复用原指纹,更新 graph_ids_json 与 last_seen_at,不新建 lineage
        commitFingerprint: (db, graphIds) => {
          const existing = db.prepare('SELECT graph_ids_json FROM project_fingerprints WHERE id = ?').get(id) as { graph_ids_json: string } | undefined
          if (!existing) {
            insertNew(db, graphIds)
            return
          }
          const merged = [...new Set([...safeParseStringArray(existing.graph_ids_json), ...graphIds])]
          db.prepare('UPDATE project_fingerprints SET graph_ids_json = ?, last_seen_at = ? WHERE id = ?').run(
            JSON.stringify(merged),
            new Date().toISOString(),
            id,
          )
        },
      }
    }
    return {
      action: decision.action,
      matchedFingerprintId: decision.matchedFingerprintId,
      commitFingerprint: (db, graphIds) => insertNew(db, graphIds),
    }
  }

  /** 决策记录：拒绝/放行明细（90 天清理），matched_signals 必含四项（S1-d）。 */
  private recordDecision(fp: ProjectFingerprint, decision: ImportDecision): void {
    try {
      this.db
        .prepare(
          `INSERT INTO import_rejections
             (id, attempted_root_path, attempted_name, attempted_dir_name, matched_fingerprint_id, matched_signals_json, decision, allowance_source, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `ir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          fp.rootPath,
          fp.projectName,
          fp.dirName,
          decision.matchedFingerprintId,
          JSON.stringify(decision.signals),
          decision.action === 'reject' ? 'rejected' : decision.action === 'allow_branch_variant' ? 'allowed_branch' : 'allowed_with_warning',
          decision.step === '3a-remembered' ? 'remembered_rule' : decision.step === '3a-this_time' ? 'this_time' : null,
          decision.reason,
          new Date().toISOString(),
        )
    } catch (err) {
      logger.warn('import decision record failed:', err)
    }
  }

  /** 记住规则：只在用户显式勾选时写入；撤销=更新 revoked_at,不物理删除。 */
  private writeAllowance(fingerprintId: string, dirName: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO import_allowances (id, fingerprint_id, dir_name, granted_by, granted_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(fingerprint_id, dir_name) DO UPDATE SET revoked_at = NULL, revoked_by = NULL`,
        )
        .run(`ia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, fingerprintId, dirName, 'local-user', new Date().toISOString())
    } catch (err) {
      logger.warn('import allowance write failed:', err)
    }
  }

  /** 记住规则列表（IPC project:import:allowance:list）。 */
  listAllowances(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT a.id, a.fingerprint_id, a.dir_name, a.granted_by, a.granted_at, a.note,
                a.revoked_at, f.project_name, f.root_path
           FROM import_allowances a LEFT JOIN project_fingerprints f ON f.id = a.fingerprint_id
          ORDER BY a.granted_at DESC`,
      )
      .all() as Array<Record<string, unknown>>
  }

  /** 撤销记住规则（更新 revoked_at/revoked_by,不物理删除）。 */
  revokeAllowance(id: string, revokedBy: string): void {
    this.db
      .prepare('UPDATE import_allowances SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), revokedBy, id)
  }

  /**
   * 保留策略（S1-d）：启动期 + 每日一次,删除 90 天前明细;删除前聚合写
   * map_migration_reports(kind='import_dedup', stage='retention'),聚合永久保留。
   * import_allowances 不受影响。
   */
  runRetention(now = new Date()): { deleted: number } {
    const cutoff = new Date(now.getTime() - IMPORT_DEDUP_DEFAULTS.rejectionRetentionDays * 24 * 3600 * 1000).toISOString()
    const aggregate = this.db
      .prepare("SELECT decision, COUNT(*) AS c FROM import_rejections WHERE created_at < ? GROUP BY decision")
      .all(cutoff) as Array<{ decision: string; c: number }>
    const result = this.db.prepare('DELETE FROM import_rejections WHERE created_at < ?').run(cutoff)
    const deleted = Number(result.changes)
    this.db
      .prepare(
        `INSERT INTO map_migration_reports
           (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json)
         VALUES (?, 'import_dedup', 'retention', NULL, ?, ?, ?, 'ok', ?)`,
      )
      .run(
        `ir_ret_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        now.toISOString(),
        now.toISOString(),
        process.pid,
        JSON.stringify({ deleted, by_decision: aggregate, retention_days: IMPORT_DEDUP_DEFAULTS.rejectionRetentionDays }),
      )
    return { deleted }
  }

  /**
   * S1.6（§8.3 第 7 步）：为 S1 之前已产生的重复导入（同 project_path 下多张同类型图）
   * 写历史 lineage 报告——**只报告，不自动删除、不自动合并**，由用户决定保留哪一套。
   * 无重复时不写行（避免报告行噪音）。
   */
  reportHistoricalDuplicateLineages(now = new Date()): { duplicate_groups: number } {
    const groups = this.db
      .prepare(
        `SELECT project_path, type, COUNT(*) AS c
           FROM graphs
          WHERE project_path IS NOT NULL AND project_path != ''
          GROUP BY project_path, type
         HAVING c > 1`,
      )
      .all() as Array<{ project_path: string; type: string; c: number }>
    if (groups.length === 0) return { duplicate_groups: 0 }

    const details: Array<Record<string, unknown>> = []
    for (const g of groups) {
      const graphs = this.db
        .prepare(
          'SELECT id, name, type, created_at FROM graphs WHERE project_path = ? AND type = ? ORDER BY created_at ASC, id ASC',
        )
        .all(g.project_path, g.type)
      details.push({ project_path: g.project_path, graph_type: g.type, count: g.c, graphs })
    }
    const nowIso = now.toISOString()
    this.db
      .prepare(
        `INSERT INTO map_migration_reports
           (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json, details_json)
         VALUES (?, 'import_dedup', 'historical_lineage', NULL, ?, ?, ?, 'ok', ?, ?)`,
      )
      .run(
        `ir_hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        nowIso,
        nowIso,
        process.pid,
        JSON.stringify({ duplicate_groups: groups.length, action: 'report_only' }),
        JSON.stringify(details),
      )
    logger.warn(`historical duplicate lineages found: ${groups.length} group(s) — report only, no merge/delete`)
    return { duplicate_groups: groups.length }
  }
}
