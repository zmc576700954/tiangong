/**
 * D1：写类工具不得写入 git 元数据目录。
 *
 * 为什么必须拦在「审批决策之前」而不是弹窗询问：
 * 一次被批准的 Write 改写 `.git/config`（hooksPath / fsmonitor / filter / diff.external）
 * 就能让后续读命令零审批执行外部程序 —— 弹窗文案永远无法让用户看见这层因果。
 * 因此命中 git 元数据目录时直接 deny（`policy` 决定），不是 ask。
 *
 * 口径：
 * - 真实路径（realpath，含 symlink 解析）+ macOS 大小写折叠后比较；
 * - 目标可以尚不存在：自底向上找最近已存在祖先再拼回缺失后缀；
 * - 覆盖 `git rev-parse --absolute-git-dir` / `--git-common-dir`（含 linked worktree）、
 *   `.git` 是 gitdir 文件的仓库（外部 gitdir）及其 `modules/`、以及「目标自身就在
 *   gitdir 目录里」的 bare / 外部布局；
 * - hardlink（不同路径同 inode）按 inode 比对已知 git 元数据文件；
 * - 探测失败 **fail-closed**（git 不可用 / cwd 不存在 / 无法解析 gitdir）→ 默认阻止；
 *   这是有意选择：无法证明安全时，不把「看不见危险配置」当成安全。
 * - 回退开关 `BIZGRAPH_GITDIR_WRITE_GUARD=ask|off`（默认 block）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { buildSafeEnv } from '../../../shared/env'
import { isWriteScopedTool, resolveRealPath, targetPathsOf } from './write-paths'
import { probeGitConfig, resolveGitExecutable } from './bash-readonly'

export type GitDirGuardVerdict = 'allow' | 'block' | 'ask'

export interface GitDirGuardResult {
  verdict: GitDirGuardVerdict
  /** 审计/审批卡片用的规则名 */
  rule: string
  /** 可读原因（会写进审计事件与工具 deny 消息） */
  reason: string
  /** 本次参与判定的目标真实路径（审计用，不含文件内容） */
  targets: string[]
  /** 判定命中的 git 元数据目录（审计用） */
  gitDirs: string[]
}

/** 回退开关：block（默认）/ ask（回到弹窗）/ off（完全停用）。 */
const GITDIR_GUARD_ENV = 'BIZGRAPH_GITDIR_WRITE_GUARD'

function guardMode(): 'block' | 'ask' | 'off' {
  const raw = (process.env[GITDIR_GUARD_ENV] ?? '').trim().toLowerCase()
  if (raw === 'off') return 'off'
  if (raw === 'ask') return 'ask'
  return 'block'
}

const PROBE_TIMEOUT_MS = 150
const MAX_PROTECTED_FILES = 256
const MAX_MODULE_DEPTH = 4

/** git 元数据目录中可能被用于注入的固定文件与目录。 */
const PROTECTED_GITDIR_FILES = ['config', 'config.worktree', 'HEAD', 'index', 'packed-refs', 'shallow', 'commondir']
const PROTECTED_GITDIR_DIRS = ['hooks', 'info']

interface GitDirsProbe {
  dirs: string[]
  /** 非 null 即探测失败（fail-closed）；「不是 git 仓库」是确定结论，不算失败。 */
  failure: string | null
}

/**
 * `git rev-parse --absolute-git-dir --git-common-dir`：拿仓库的真实 gitdir 与 common dir。
 * 注意用在目标自己的目录上，因此「写另一个仓库的 .git/config」也能被发现。
 */
function probeGitDirs(cwd: string): GitDirsProbe {
  const gitPath = resolveGitExecutable()
  if (!gitPath) return { dirs: [], failure: 'missing-git' }
  try {
    const stdout = execFileSync(
      gitPath,
      [
        '-C',
        cwd,
        'rev-parse',
        '--path-format=absolute',
        '--absolute-git-dir',
        '--git-common-dir',
      ],
      {
        env: buildSafeEnv(),
        timeout: PROBE_TIMEOUT_MS,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as Buffer
    const dirs = stdout
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // git 可能回显 `.git` 这个 symlink 路径；统一 realpath 才能与目标比较。
      .map((line) => resolveRealPath(resolve(line)))
    if (dirs.length === 0) return { dirs: [], failure: 'empty-output' }
    return { dirs, failure: null }
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer | string }
    const stderr = Buffer.isBuffer(detail.stderr) ? detail.stderr.toString('utf8') : (detail.stderr ?? '')
    // 明确的「不是仓库」是确定结论：该目录树里没有可保护的 gitdir。
    if (/not a git repository|not a git work tree/i.test(stderr)) return { dirs: [], failure: null }
    if (detail.code === 'ETIMEDOUT') return { dirs: [], failure: 'timeout' }
    if (detail.code === 'ENOENT') return { dirs: [], failure: 'missing-git' }
    return { dirs: [], failure: 'non-zero-exit' }
  }
}

/** 目录本身看起来就是一个 gitdir（bare / 外部 gitdir）：HEAD + (config 或 objects)。 */
function looksLikeGitDir(dir: string): boolean {
  try {
    if (!lstatSync(join(dir, 'HEAD')).isFile()) return false
    return existsSync(join(dir, 'config')) || existsSync(join(dir, 'objects'))
  } catch {
    return false
  }
}

/** 读 `.git` 文件里的 `gitdir:` 指向（旧式 worktree / 子模块的外部 gitdir）。 */
function readGitDirFile(file: string): string | null {
  try {
    const content = readFileSync(file, 'utf8')
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
    if (!match) return null
    const target = match[1]
    return resolve(isAbsolute(target) ? target : join(dirname(file), target))
  } catch {
    return null
  }
}

interface StructuralResult {
  dirs: string[]
  blocked: { rule: string; reason: string } | null
}

/**
 * 从目标路径向上走，按文件系统结构找出所有「目标可能落入」的 gitdir：
 * - 祖先目录自身像 gitdir（bare / 外部 gitdir，不依赖 git 可执行文件）；
 * - 祖先目录里有 `.git` 目录 → 该 gitdir；
 * - 祖先目录里有 `.git` 文件 → 读 `gitdir:`（linked worktree / 外部 gitdir）。
 * 目标 basename 恰为 `.git` 时也阻止：改写 gitdir 指针等于改写后续所有 git 行为的解析根。
 */
function structuralGitDirs(realTarget: string): StructuralResult {
  const dirs: string[] = []
  if (basename(realTarget) === '.git') {
    return {
      dirs,
      blocked: {
        rule: 'gitdir-pointer-write',
        reason: '目标是 .git（gitdir 指针/目录），改写它可把后续 git 操作重定向到任意配置与钩子',
      },
    }
  }
  let current = dirname(realTarget)
  while (true) {
    if (looksLikeGitDir(current)) {
      return {
        dirs: [...dirs, current],
        blocked: {
          rule: 'gitdir-write-block',
          reason: `目标位于 git 元数据目录内（${current}），可能是配置/钩子注入`,
        },
      }
    }
    const dotGit = join(current, '.git')
    try {
      const stat = lstatSync(dotGit)
      if (stat.isDirectory()) {
        // 只有「看起来是 gitdir」的 .git 目录才算元数据：`src/.git/foo` 这种
        // 恰好叫 .git 的普通目录不能被误伤（用户明确要求）。
        if (looksLikeGitDir(dotGit)) dirs.push(resolveRealPath(dotGit))
      } else if (stat.isFile()) {
        const pointer = readGitDirFile(dotGit)
        if (pointer) dirs.push(resolveRealPath(pointer))
      } else if (stat.isSymbolicLink()) {
        // `.git` 本身是 symlink（外部 gitdir 的另一种布局）：realpath 后按目录判定。
        const endpoint = resolveRealPath(dotGit)
        if (looksLikeGitDir(endpoint)) dirs.push(endpoint)
        else {
          const pointer = readGitDirFile(endpoint)
          if (pointer) dirs.push(resolveRealPath(pointer))
        }
      }
    } catch {
      /* 该祖先没有 .git，继续向上 */
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { dirs, blocked: null }
}

function isInsideDir(dir: string, realTarget: string): boolean {
  const rel = relative(comparable(dir), comparable(realTarget))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function comparable(value: string): string {
  return process.platform === 'darwin' ? value.toLowerCase() : value
}

/** 收集 gitdir 内可被 hardlink 绕过的元数据文件（数量有上限，避免大仓库拖慢审批）。 */
function collectProtectedFiles(dirs: readonly string[]): string[] {
  const files: string[] = []
  const push = (file: string): void => {
    if (files.length >= MAX_PROTECTED_FILES) return
    files.push(file)
  }
  for (const dir of dirs) {
    for (const name of PROTECTED_GITDIR_FILES) push(join(dir, name))
    for (const name of PROTECTED_GITDIR_DIRS) {
      try {
        const entries = readdirSync(join(dir, name), { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() || entry.isSymbolicLink()) push(join(dir, name, entry.name))
        }
      } catch {
        /* 目录不存在（常见） */
      }
    }
    // worktree 的 gitdir 都在 commonDir/worktrees/* 下；modules 递归读 config。
    const walk = (root: string, depth: number): void => {
      if (depth > MAX_MODULE_DEPTH) return
      let entries: Dirent[]
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'objects' || entry.name === 'refs' || entry.name === 'hooks') continue
        const child = join(root, entry.name)
        push(join(child, 'config'))
        push(join(child, 'config.worktree'))
        walk(child, depth + 1)
      }
    }
    walk(join(dir, 'worktrees'), 1)
    walk(join(dir, 'modules'), 1)
  }
  return files
}

/**
 * gitdir 内部对象目录不做配置注入，跳过以免大仓库拖慢审批。
 * `hooks` / `info` / `worktrees` / `modules` 必须扫描。
 */
const SKIP_SYMLINK_SCAN_DIRS = new Set(['objects', 'refs', 'logs', 'lost-found', 'rr-cache', 'svn'])

/**
 * D1-1：收集 gitdir 内部所有 symlink 的**终点**（即使终点不存在）。
 *
 * 攻击形态：`.git/config -> /tmp/evil`（或工作区 symlink -> `.git/hooks/x`）。
 * 只判定「目标是否在 gitdir 内」会漏掉「写 symlink 终点」这条路径——
 * 终点在 gitdir 外，但写入它等于改写配置/钩子。因此把 gitdir 内每个 symlink
 * 的终点也纳入保护面；写 symlink 本身（位于 gitdir 内）已由常规路径判定拦截。
 */
function collectSymlinkEndpoints(dirs: readonly string[]): string[] {
  const endpoints: string[] = []
  let visited = 0
  const walk = (root: string, depth: number): void => {
    if (depth > MAX_MODULE_DEPTH || visited >= MAX_PROTECTED_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_PROTECTED_FILES) return
      const child = join(root, entry.name)
      if (entry.isSymbolicLink()) {
        // resolveRealPath 会逐级 readlink，dangling 终点也能解析。
        endpoints.push(resolveRealPath(child))
        continue
      }
      if (entry.isDirectory() && !SKIP_SYMLINK_SCAN_DIRS.has(entry.name)) {
        walk(child, depth + 1)
      }
    }
  }
  for (const dir of dirs) walk(dir, 0)
  return endpoints
}

/** 同 inode 判定：hardlink 的不同路径 realpath 不同，但 dev+ino 相同。 */
function hardlinkedGitMetaFile(realTarget: string, dirs: readonly string[]): string | null {
  let targetStat: { dev: number; ino: number }
  try {
    const stat = statSync(realTarget)
    if (!stat.isFile()) return null
    targetStat = { dev: stat.dev, ino: stat.ino }
  } catch {
    // 目标尚不存在：不可能是 hardlink
    return null
  }
  for (const file of collectProtectedFiles(dirs)) {
    try {
      const stat = statSync(file)
      if (stat.isFile() && stat.dev === targetStat.dev && stat.ino === targetStat.ino) return file
    } catch {
      /* 不存在 */
    }
  }
  return null
}

interface IncludeProbe {
  /** 当前仓库配置里所有 include.path / includeIf.*.path 解析后的真实路径。 */
  targets: string[]
  /** 非 null 即无法判定 include 面（D1 fail-closed）。 */
  failure: string | null
}

/** `--show-origin` 的 origin 字段：`file:<path>`；其它（command line/blob）不当作文件。 */
function fileOriginPath(origin: string): string | null {
  const prefix = 'file:'
  if (!origin.startsWith(prefix)) return null
  const value = origin.slice(prefix.length).trim()
  return value.length > 0 ? value : null
}

/** Git 会展开 `~/`；这里同样处理，避免 include 目标被误判为「不存在」。 */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * D1-2：用 Git 自己解析 include 链，收集所有 include 目标。
 *
 * 只用 `git config --list --includes --show-origin` 的扁平结果，不手写 INI：
 * - 链式 include 的每一层都会作为独立 entry 出现，其 `origin` 给出声明文件；
 * - 相对路径按「声明该 include 的文件所在目录」解析（Git 语义）；
 * - includeIf 条件由 Git 求值；未命中的声明也会出现，按保守口径一并保护。
 *
 * 探针失败 = include 面不可判定 → 由调用方 fail-closed。
 */
function collectIncludeTargets(cwd: string): IncludeProbe {
  const probe = probeGitConfig(cwd, true)
  // 空配置（毫无 entry）不是失败：它就是「没有 include」。真正的失败
  // （timeout / missing-git / 输出损坏）才 fail-closed。
  if (probe.failure && probe.failure !== 'empty-output') {
    return { targets: [], failure: probe.failure }
  }
  const targets: string[] = []
  for (const entry of probe.entries) {
    if (entry.key !== 'include.path' && !/^includeif\..+\.path$/.test(entry.key)) continue
    const value = expandHome(entry.value.trim())
    if (value === '') continue
    const origin = fileOriginPath(entry.origin)
    // `--show-origin` 对仓库本地配置可能输出相对路径（`file:.git/config`），
    // 必须相对探针 cwd 还原为绝对路径，否则相对 include 会解析错目录。
    const originPath = origin ? (isAbsolute(origin) ? origin : resolve(cwd, origin)) : null
    const base = originPath ? dirname(originPath) : cwd
    const target = isAbsolute(value) ? value : resolve(base, value)
    targets.push(resolveRealPath(target))
  }
  return { targets: [...new Set(targets)], failure: null }
}

/** 目标最近的存在目录：git 探针必须在存在的目录里启动。 */
function nearestExistingDir(realTarget: string): string | null {
  let current = realTarget
  while (true) {
    try {
      if (statSync(current).isDirectory()) return current
    } catch {
      /* 继续向上 */
    }
    const parent = dirname(current)
    if (parent === current) return existsSync(current) ? current : null
    current = parent
  }
}

function verdictFor(mode: 'block' | 'ask' | 'off', base: GitDirGuardVerdict): GitDirGuardVerdict {
  if (mode === 'off') return 'allow'
  if (base === 'block' && mode === 'ask') return 'ask'
  return base
}

const ALLOW: GitDirGuardResult = {
  verdict: 'allow',
  rule: 'not-write-tool',
  reason: '非写类工具或守卫已关闭，不做 git 元数据拦截',
  targets: [],
  gitDirs: [],
}

/**
 * 审批前判定：写类工具的目标路径是否触及 git 元数据。
 * 纯函数 + 同步文件系统快照；不缓存，两次调用之间文件系统可能变化。
 */
export function evaluateGitDirWriteGuard(
  toolName: string,
  args: Record<string, unknown>,
  options?: { cwd?: string },
): GitDirGuardResult {
  const mode = guardMode()
  if (mode === 'off') return ALLOW
  if (!isWriteScopedTool(toolName)) return ALLOW
  const targets = targetPathsOf(args)
  // 没有可解析路径：会话授权与审批都会回到「不可验证 → ask」，无需额外拦截。
  if (targets.length === 0) return { ...ALLOW, rule: 'no-target', targets: [] }

  // 会话工作目录不存在 = 无法判定（有意 fail-closed）；只有未提供 cwd 时才退回进程 cwd。
  const baseCwd = options?.cwd ?? process.cwd()
  if (!existsSync(baseCwd)) {
    return {
      verdict: verdictFor(mode, 'block'),
      rule: 'gitdir-probe-failed',
      reason: `会话工作目录不存在（${baseCwd}），无法确认目标路径是否属于 git 元数据目录，按 fail-closed 阻止写入`,
      targets,
      gitDirs: [],
    }
  }
  const cwdProbe = probeGitDirs(baseCwd)
  if (cwdProbe.failure) {
    return {
      verdict: verdictFor(mode, 'block'),
      rule: 'gitdir-probe-failed',
      reason: `无法确认目标路径是否属于 git 元数据目录（工作目录探测失败：${cwdProbe.failure}），按 fail-closed 阻止写入`,
      targets,
      gitDirs: [],
    }
  }

  const allDirs = [...cwdProbe.dirs]
  const cwdIncludes = collectIncludeTargets(baseCwd)
  if (cwdIncludes.failure) {
    return {
      verdict: verdictFor(mode, 'block'),
      rule: 'gitdir-include-probe-failed',
      reason: `无法确认目标是否为 git 配置的 include 目标（配置探针失败：${cwdIncludes.failure}），按 fail-closed 阻止写入`,
      targets,
      gitDirs: allDirs,
    }
  }
  for (const target of targets) {
    const rawTarget = resolve(baseCwd, target)
    // 目标是 `.git` 指针本身（含 symlink 形态）：即使 realpath 后 basename 变了，
    // 改写它也能把后续 git 操作重定向到任意 gitdir。
    if (basename(rawTarget) === '.git') {
      return {
        verdict: verdictFor(mode, 'block'),
        rule: 'gitdir-pointer-write',
        reason: `目标是 .git（gitdir 指针/目录），改写它可把后续 git 操作重定向到任意配置与钩子（目标：${target}）`,
        targets,
        gitDirs: allDirs,
      }
    }
    const realTarget = resolveRealPath(rawTarget)
    const structural = structuralGitDirs(realTarget)
    allDirs.push(...structural.dirs)
    if (structural.blocked) {
      return {
        verdict: verdictFor(mode, 'block'),
        rule: structural.blocked.rule,
        reason: `${structural.blocked.reason}（目标：${target}）`,
        targets,
        gitDirs: allDirs,
      }
    }
    const probeDir = nearestExistingDir(realTarget)
    if (!probeDir) {
      return {
        verdict: verdictFor(mode, 'block'),
        rule: 'gitdir-probe-failed',
        reason: `目标路径没有可探测的存在目录，无法确认是否属于 git 元数据（目标：${target}）`,
        targets,
        gitDirs: allDirs,
      }
    }
    const targetProbe = probeGitDirs(probeDir)
    if (targetProbe.failure) {
      return {
        verdict: verdictFor(mode, 'block'),
        rule: 'gitdir-probe-failed',
        reason: `无法确认目标路径是否属于 git 元数据目录（目标所在仓库探测失败：${targetProbe.failure}，目标：${target}）`,
        targets,
        gitDirs: allDirs,
      }
    }
    allDirs.push(...targetProbe.dirs)
    for (const dir of [...cwdProbe.dirs, ...targetProbe.dirs, ...structural.dirs]) {
      if (isInsideDir(dir, realTarget)) {
        return {
          verdict: verdictFor(mode, 'block'),
          rule: 'gitdir-write-block',
          reason: `该路径属于 git 元数据目录（${dir}），可能是配置/钩子注入，已阻止（目标：${target}）`,
          targets,
          gitDirs: allDirs,
        }
      }
    }
    // D1-1：gitdir 内部 symlink 的终点也在保护面内（终点可以不存在）。
    const symlinkTargets = collectSymlinkEndpoints([
      ...cwdProbe.dirs,
      ...targetProbe.dirs,
      ...structural.dirs,
    ])
    for (const endpoint of symlinkTargets) {
      if (isInsideDir(endpoint, realTarget)) {
        return {
          verdict: verdictFor(mode, 'block'),
          rule: 'gitdir-symlink-target',
          reason: `目标是 git 元数据 symlink 的终点（${endpoint}），写入等同改写 git 配置/钩子，已阻止（目标：${target}）`,
          targets,
          gitDirs: allDirs,
        }
      }
    }
    // D1-2：写 include 目标 = 一次批准后把任意内容变成配置的一部分。
    const targetIncludes =
      comparable(probeDir) === comparable(baseCwd) ? cwdIncludes : collectIncludeTargets(probeDir)
    if (targetIncludes.failure) {
      return {
        verdict: verdictFor(mode, 'block'),
        rule: 'gitdir-include-probe-failed',
        reason: `无法确认目标是否为 git 配置的 include 目标（目标仓库配置探针失败：${targetIncludes.failure}，按 fail-closed 阻止写入）`,
        targets,
        gitDirs: allDirs,
      }
    }
    for (const includeTarget of [...cwdIncludes.targets, ...targetIncludes.targets]) {
      if (isInsideDir(includeTarget, realTarget)) {
        return {
          verdict: verdictFor(mode, 'block'),
          rule: 'gitdir-include-target',
          reason: `目标是 git 配置的 include 文件（${includeTarget}），写入会把它变成配置的一部分，已阻止（目标：${target}）`,
          targets,
          gitDirs: allDirs,
        }
      }
    }
    const hardlink = hardlinkedGitMetaFile(realTarget, allDirs)
    if (hardlink) {
      return {
        verdict: verdictFor(mode, 'block'),
        rule: 'gitdir-hardlink',
        reason: `目标与 git 元数据文件（${hardlink}）是同一 inode（hardlink），写入等同改写 git 配置/钩子（目标：${target}）`,
        targets,
        gitDirs: allDirs,
      }
    }
  }

  return { verdict: 'allow', rule: 'gitdir-clean', reason: '目标路径不在 git 元数据目录内', targets, gitDirs: allDirs }
}
