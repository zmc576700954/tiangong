/**
 * 工作区文件变更采集（W1/G1-7：文件变更 → change_sets）。
 *
 * 代码事实：ScopeGuard 只判定越界，不暴露「本次改了哪些文件/多少行」；
 * 编排层能拿到的真实变更来源只有项目工作区的 git 状态。本模块只做采集，
 * 不决定业务口径；采集失败返回 null，调用方不得写空行假装「无变更」。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeFileEntry, GitRunner } from './work-run-service'

export interface WorkspaceChangeSnapshot {
  headCommit: string | null
  files: ChangeFileEntry[]
  dirty: boolean
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim()
  } catch {
    return null
  }
}

/** 受控 git 能力：只读 HEAD 与 porcelain 状态（ChangeSetService 的生产实现）。 */
export class GitWorkspaceChangeRunner implements GitRunner {
  revParseHEAD(cwd: string): string | null {
    const out = git(cwd, ['rev-parse', '--verify', 'HEAD'])
    return out !== null && out !== '' ? out : null
  }

  statusPorcelain(cwd: string): string[] | null {
    const out = git(cwd, ['status', '--porcelain', '-uall'])
    if (out === null) throw new Error('git status unavailable（非 git 仓库或 git 不可用）')
    return out.split('\n').filter((line) => line.trim() !== '')
  }
}

interface NumstatEntry {
  additions: number
  deletions: number
}

function parseNumstat(raw: string | null): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>()
  if (raw === null || raw === '') return out
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [add, del] = parts
    // 重命名统计形如 `old => new`；--no-renames 下不会出现，防御性保留原样。
    const file = parts.slice(2).join('\t')
    out.set(file, {
      additions: add === '-' ? 0 : Number(add) || 0,
      deletions: del === '-' ? 0 : Number(del) || 0,
    })
  }
  return out
}

function countLines(projectPath: string, file: string): number {
  try {
    const buf = readFileSync(join(projectPath, file))
    let lines = 0
    for (const byte of buf) {
      if (byte === 0x0a) lines++
    }
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++
    return lines
  } catch {
    return 0
  }
}

function parsePorcelain(
  lines: string[],
): Array<{ path: string; oldPath?: string; change: ChangeFileEntry['change'] }> {
  const out: Array<{ path: string; oldPath?: string; change: ChangeFileEntry['change'] }> = []
  for (const line of lines) {
    const code = line.slice(0, 2)
    const rest = line.slice(3).trim()
    if (rest === '') continue
    const renamed = rest.includes(' -> ')
    const [first, second] = renamed ? rest.split(' -> ') : [rest, undefined]
    const path = (second ?? first).trim()
    if (code === '??') {
      out.push({ path, change: 'added' })
    } else if (renamed) {
      out.push({ path, oldPath: first.trim(), change: 'renamed' })
    } else if (code[0] === 'A') {
      out.push({ path, change: 'added' })
    } else if (code[0] === 'D' || code[1] === 'D') {
      out.push({ path, change: 'deleted' })
    } else {
      out.push({ path, change: 'modified' })
    }
  }
  return out
}

function parseNameStatus(raw: string | null): Array<{ path: string; change: ChangeFileEntry['change'] }> {
  const out: Array<{ path: string; change: ChangeFileEntry['change'] }> = []
  if (raw === null || raw === '') return out
  for (const line of raw.split('\n')) {
    const [code, ...rest] = line.split('\t')
    const file = rest.join('\t').trim()
    if (file === '') continue
    if (code === 'A') out.push({ path: file, change: 'added' })
    else if (code === 'D') out.push({ path: file, change: 'deleted' })
    else out.push({ path: file, change: 'modified' })
  }
  return out
}

/**
 * 采集本次 run 的文件变更快照。
 *
 * - 以 baseCommit（run 开始时 HEAD）为基线；
 * - 若执行过程中产生了新提交，再叠加 `base..HEAD` 的提交差异；
 * - 未跟踪文件按 added 计入，行数按文件内容统计（二进制按 0 行）。
 *
 * 非 git / git 异常返回 null（不伪造成「0 变更」）。
 */
export function collectWorkspaceChanges(
  projectPath: string,
  baseCommit: string | null,
): WorkspaceChangeSnapshot | null {
  const runner = new GitWorkspaceChangeRunner()
  let porcelain: string[] | null
  try {
    porcelain = runner.statusPorcelain(projectPath)
  } catch {
    return null
  }
  if (porcelain === null) return null
  const headCommit = runner.revParseHEAD(projectPath)

  const files = new Map<string, ChangeFileEntry>()
  const addEntry = (entry: ChangeFileEntry): void => {
    const existing = files.get(entry.path)
    if (!existing) {
      files.set(entry.path, entry)
      return
    }
    // 同一路径可能同时命中工作区状态与提交差异：行数累加，变更类型取先到者。
    files.set(entry.path, {
      ...existing,
      additions: existing.additions + entry.additions,
      deletions: existing.deletions + entry.deletions,
    })
  }

  const worktreeStats = parseNumstat(git(projectPath, ['diff', '--numstat', '--no-renames', 'HEAD']))
  for (const entry of parsePorcelain(porcelain)) {
    const stats = worktreeStats.get(entry.path)
    const additions = stats?.additions ?? (entry.change === 'added' ? countLines(projectPath, entry.path) : 0)
    const deletions = stats?.deletions ?? 0
    addEntry({ path: entry.path, ...(entry.oldPath ? { old_path: entry.oldPath } : {}), change: entry.change, additions, deletions })
  }

  if (baseCommit !== null && headCommit !== null && baseCommit !== headCommit) {
    const commitStats = parseNumstat(git(projectPath, ['diff', '--numstat', '--no-renames', baseCommit, headCommit]))
    const commitNameStatus = parseNameStatus(git(projectPath, ['diff', '--name-status', '--no-renames', baseCommit, headCommit]))
    for (const entry of commitNameStatus) {
      const stats = commitStats.get(entry.path)
      addEntry({
        path: entry.path,
        change: entry.change,
        additions: stats?.additions ?? 0,
        deletions: stats?.deletions ?? 0,
      })
    }
  }

  const dirty = porcelain.length > 0 || (baseCommit !== null && headCommit !== null && baseCommit !== headCommit)
  return { headCommit, files: [...files.values()], dirty }
}
