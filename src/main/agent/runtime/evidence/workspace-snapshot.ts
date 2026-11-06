/**
 * M1 ②：工作区快照与差分（合成文件变更证据）。
 *
 * 这是「文件变了」的证据，不是工具调用记录：
 * - 不依赖 git（非 git 目录同样可用）；
 * - 只扫描项目工作目录，项目外的写入（如 /tmp）不在范围内；
 * - 只能证明文件发生增/删/改，不能证明是哪个工具改的；
 * - 有忽略规则、文件数上限、大小上限与时间预算，超限时如实降级。
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import path from 'node:path'
import type {
  FileChangeEvidence,
  FileChangeEvidenceChange,
  WorkspaceScanTruncatedReason,
} from '@shared/types/agent'

/** 目录名命中即整体跳过（任意层级） */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
])

/** 文件名命中即跳过 */
const IGNORED_FILES = new Set(['.DS_Store'])

export interface WorkspaceFileEntry {
  size: number
  mtimeMs: number
  /** 小文件内容指纹；大文件为空，按 size+mtime 判定 */
  hash?: string
}

export interface WorkspaceSnapshot {
  root: string
  files: Map<string, WorkspaceFileEntry>
  scannedFiles: number
  unhashedFiles: number
  truncated: boolean
  truncatedReason?: WorkspaceScanTruncatedReason
  durationMs: number
}

export interface WorkspaceSnapshotOptions {
  /** 最多扫描的文件数（默认 4000） */
  maxFiles?: number
  /** 单次扫描时间预算，超出即停（默认 600ms） */
  timeBudgetMs?: number
  /**
   * 超过此大小不做内容指纹（默认 0：不做指纹，仅用 size+mtime 判定）。
   * 读文件指纹会显著拖慢 turn（实测 2734 文件从 ~45ms 升到 ~190ms/次），
   * 因此默认关闭；需要更强证据时可显式开启。
   */
  maxHashBytes?: number
  /** 最大目录深度（默认 24） */
  maxDepth?: number
}

export const DEFAULT_SNAPSHOT_OPTIONS: Required<WorkspaceSnapshotOptions> = {
  maxFiles: 4000,
  timeBudgetMs: 600,
  maxHashBytes: 0,
  maxDepth: 24,
}

export interface DiffOptions {
  /** 最多返回多少条变更（默认 50） */
  maxChanges?: number
}

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name)
}

function isIgnoredFile(name: string): boolean {
  return IGNORED_FILES.has(name)
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

async function hashFile(absolutePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(absolutePath)
    return crypto.createHash('sha1').update(content).digest('hex')
  } catch {
    // 读不到（权限/竞态）时退化为 size+mtime 判定，不让证据采集失败影响 turn
    return undefined
  }
}

/**
 * 采集工作区快照。
 *
 * 任何异常都不抛出：返回空快照并标记 root_unreadable，调用方按「证据不足」处理。
 */
export async function captureWorkspaceSnapshot(
  root: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const opts = { ...DEFAULT_SNAPSHOT_OPTIONS, ...options }
  const startedAt = Date.now()
  const files = new Map<string, WorkspaceFileEntry>()
  let scannedFiles = 0
  let unhashedFiles = 0
  let truncated = false
  let truncatedReason: WorkspaceScanTruncatedReason | undefined

  const deadline = startedAt + opts.timeBudgetMs

  const snapshot = (): WorkspaceSnapshot => ({
    root,
    files,
    scannedFiles,
    unhashedFiles,
    truncated,
    truncatedReason,
    durationMs: Date.now() - startedAt,
  })

  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      truncated = true
      truncatedReason = 'root_unreadable'
      return snapshot()
    }
  } catch {
    truncated = true
    truncatedReason = 'root_unreadable'
    return snapshot()
  }

  interface PendingDir {
    absolute: string
    depth: number
  }
  const stack: PendingDir[] = [{ absolute: root, depth: 0 }]

  while (stack.length > 0) {
    if (Date.now() > deadline) {
      truncated = true
      truncatedReason = 'time_budget'
      break
    }
    const current = stack.pop()!
    if (current.depth > opts.maxDepth) {
      truncated = true
      truncatedReason = truncatedReason ?? 'depth_limit'
      continue
    }

    let entries: Dirent[]
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true })
    } catch {
      // 某个子目录不可读不影响其它目录；只记录为扫描不完整
      truncated = true
      truncatedReason = truncatedReason ?? 'root_unreadable'
      continue
    }

    for (const entry of entries) {
      if (scannedFiles >= opts.maxFiles) {
        truncated = true
        truncatedReason = 'file_limit'
        break
      }
      if (Date.now() > deadline) {
        truncated = true
        truncatedReason = 'time_budget'
        break
      }

      if (entry.isSymbolicLink()) continue
      const absolute = path.join(current.absolute, entry.name)

      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) {
          stack.push({ absolute, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile() || isIgnoredFile(entry.name)) continue

      let fileStat: Stats
      try {
        fileStat = await fs.stat(absolute)
      } catch {
        continue
      }

      scannedFiles += 1
      const relative = toPosixRelative(root, absolute)
      let hash: string | undefined
      if (fileStat.size <= opts.maxHashBytes) {
        hash = await hashFile(absolute)
      } else {
        unhashedFiles += 1
      }
      files.set(relative, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, hash })
    }

    if (truncated && truncatedReason === 'file_limit') break
    if (truncated && truncatedReason === 'time_budget') break
  }

  return snapshot()
}

function isModified(before: WorkspaceFileEntry, after: WorkspaceFileEntry): boolean {
  if (before.size !== after.size) return true
  if (before.hash && after.hash) return before.hash !== after.hash
  // 大文件（无指纹）退化为 mtime 判定；只要时间戳变了就视为变化
  return before.mtimeMs !== after.mtimeMs
}

/**
 * 差分两次快照，产出「增/删/改」证据。
 *
 * 变更按路径排序后截断到 maxChanges；超出时 totalCount 仍为真实总数，
 * 由调用方在 UI 上如实标注「变更过多，仅显示前 N 个」。
 */
export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  options: DiffOptions = {},
): FileChangeEvidence {
  const limit = Math.max(1, options.maxChanges ?? 50)
  const changes: FileChangeEvidenceChange[] = []

  for (const [filePath, afterEntry] of after.files) {
    const beforeEntry = before.files.get(filePath)
    if (!beforeEntry) {
      changes.push({ path: filePath, changeType: 'add' })
      continue
    }
    if (isModified(beforeEntry, afterEntry)) {
      changes.push({ path: filePath, changeType: 'modify' })
    }
  }
  for (const filePath of before.files.keys()) {
    if (!after.files.has(filePath)) {
      changes.push({ path: filePath, changeType: 'delete' })
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path))
  const totalCount = changes.length

  const scanTruncated = before.truncated || after.truncated
  const scanTruncatedReason = before.truncatedReason ?? after.truncatedReason

  return {
    kind: 'workspace-snapshot-diff',
    changes: changes.slice(0, limit),
    totalCount,
    displayedCount: Math.min(totalCount, limit),
    limit,
    truncated: totalCount > limit,
    scanTruncated,
    scanTruncatedReason,
    scannedFiles: after.scannedFiles,
    unhashedFiles: after.unhashedFiles,
    durationMs: before.durationMs + after.durationMs,
    root: after.root || before.root,
    toolAttribution: 'unknown',
    outOfWorkspaceChanges: 'not-included',
  }
}

/** 是否需要为本次 turn 做工作区差分证据（只针对没有工具事件的长尾 CLI）。 */
const SYNTHETIC_EVIDENCE_BACKENDS = new Set([
  'opencode',
  'cline',
  'kilo-code',
  'kimi-code',
  'codebuddy',
  'qoder',
  'qwen-code',
])

export function shouldCaptureSyntheticFileEvidence(adapterName: string): boolean {
  return SYNTHETIC_EVIDENCE_BACKENDS.has(adapterName)
}
