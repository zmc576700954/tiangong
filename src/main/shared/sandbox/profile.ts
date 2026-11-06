/**
 * C3（macOS 首版）：SBPL profile 生成。
 *
 * 设计口径（对应用户本轮范围）：
 * - **读放开**：`(allow default)` + 只做写/exec 收敛，避免 deny default 把 CLI 的
 *   mach / DNS / keychain 访问一并拒掉（那会让 Agent 本身不可用）。
 * - **写只限工作区**：`(deny file-write*)` 之后只放行工作区、用户临时目录、
 *   CLI 自身状态目录（Claude/Codex/OpenCode 必须写自己的会话文件），以及 MCP 的缓存目录。
 * - **`.git` 敏感写面**：`config` / `config.lock` / `config.worktree` / `hooks/**` /
 *   `info/exclude` 以及当前配置里的 include 目标，在工作区整体可写之上单独 deny。
 * - **exec 只放行必要项**：系统工具目录（/bin、/usr/bin、/usr/sbin、/usr/libexec、
 *   /System/Library）+ git 安装根 + 运行时解析到的白名单命令 + 调用方显式传入的入口。
 *   工作区内脚本（fsmonitor/hook 常放这里）不在白名单 → 读类命令拉不起它们。
 * - **路径 realpath 归一**：`/tmp` 与 `/private/tmp` 不一致会让 `subpath` 误拒/误放，
 *   所有写规则与目标比较都先 `resolveRealPath`。
 *
 * 明确不覆盖（本轮）：网络收敛（CLI 要连模型 API、MCP 自带网络）、读白名单、
 * 工作区内合法写入的内容校验。见 `docs/architecture/agent-sandbox-c3.md` §8。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSafeEnv } from '../env'
import { resolveRealPath } from '../../agent/runtime/approval/write-paths'

export type SandboxTarget = 'claude' | 'codex' | 'opencode' | 'mcp'

export interface SandboxProfileInput {
  target: SandboxTarget
  /** 会话工作目录（写白名单）；缺失时退回进程 cwd。 */
  workspaceDir?: string
  /** 调用方显式放行的可执行文件（CLI 入口等）。 */
  extraExecutables?: readonly string[]
  /** 额外可写目录（例如 MCP server 的缓存）。 */
  extraWritableDirs?: readonly string[]
}

export interface SandboxProfile {
  text: string
  workspace: string
  gitDirs: string[]
  /** 被单独 deny 的写目标（审计/测试用）。 */
  protectedWrites: string[]
  /** profile 无法表达或刻意不做的部分（进日志/报告）。 */
  notes: string[]
}

/** 系统工具目录：macOS 自带，不含 Homebrew 的 gpg 等第三方程序。 */
const SYSTEM_EXEC_SUBPATHS = ['/bin', '/usr/bin', '/usr/sbin', '/usr/libexec', '/System/Library']

/** 白名单命令：策略允许在 Bash 里跑的命令，profile 只放行它们解析后的真实路径。 */
const TOOL_COMMANDS = [
  'git', 'node', 'rg', 'ls', 'cat', 'grep', 'find', 'file', 'du', 'df',
  'stat', 'head', 'tail', 'wc', 'which', 'whoami', 'uname', 'date', 'pwd',
]

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function realPath(input: string): string {
  return resolveRealPath(path.resolve(input))
}

/** 在 PATH 中解析命令真实路径（不执行命令本身）。 */
function whichSync(command: string): string | undefined {
  const rawPath = process.env.PATH ?? ''
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      if (statSync(candidate).isFile()) return realPath(candidate)
    } catch {
      /* 继续找下一个 PATH 目录 */
    }
  }
  return undefined
}

/** 解析 CLI 入口：裸命令名按 PATH 解析，绝对路径直接 realpath。 */
export function resolveExecutablePath(command: string): string | undefined {
  if (command.includes('/') || command.includes(path.sep)) {
    const resolved = realPath(command)
    return existsSync(resolved) ? resolved : undefined
  }
  return whichSync(command)
}

function runGit(workspace: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf-8',
      timeout: 2000,
      env: buildSafeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return undefined
  }
}

interface GitLayout {
  gitDirs: string[]
  execPath?: string
  /** git 安装根（含 bin/git 与 libexec），用于 exec 白名单；不是整个家目录。 */
  execRoot?: string
}

/**
 * 发现 gitdir（含 linked worktree / `.git` 文件 / `.git` symlink），并解析 git 安装根。
 * 探测失败不是错误：非 git 工作区是常态，此时 profile 只有工作区写规则。
 */
export function discoverGitLayout(workspace: string): GitLayout {
  const gitDirs: string[] = []
  const output = runGit(workspace, ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'])
  if (output) {
    for (const line of output.split('\n')) {
      const value = line.trim()
      if (value.length > 0) gitDirs.push(realPath(value))
    }
  } else {
    // 回退：git 不可用时仍要保护明显的 `.git` 布局。
    const dotGit = path.join(workspace, '.git')
    try {
      const stat = lstatSync(dotGit)
      if (stat.isDirectory()) {
        gitDirs.push(realPath(dotGit))
      } else if (stat.isSymbolicLink()) {
        gitDirs.push(realPath(dotGit))
      } else if (stat.isFile()) {
        const content = readFileSync(dotGit, 'utf-8')
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
        if (match) {
          const target = match[1]
          gitDirs.push(realPath(path.isAbsolute(target) ? target : path.join(workspace, target)))
        }
      }
    } catch {
      /* 不是 git 仓库 */
    }
  }

  let execPath: string | undefined
  let execRoot: string | undefined
  try {
    const env = buildSafeEnv()
    const raw = execFileSync('git', ['--exec-path'], {
      encoding: 'utf-8',
      timeout: 2000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (raw) {
      execPath = realPath(raw)
      // git-core → libexec → usr → 安装根（CLT / Homebrew Cellar / 其它）
      execRoot = realPath(path.join(execPath, '..', '..', '..'))
    }
  } catch {
    /* git 不可用 */
  }
  return { gitDirs: unique(gitDirs), execPath, execRoot }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

/**
 * 当前配置里 `include.path` / `includeIf.*.path` 的解析后目标（含链式 include）。
 * 用 Git 自己解析（`--includes --show-origin`）：相对路径按「发现该 include 的文件
 * 所在目录」解析，链式 include 的 origin 由 git 给出，不手写 INI。
 */
export function discoverIncludeTargets(workspace: string): string[] {
  const output = runGit(workspace, [
    'config',
    '--includes',
    '--show-origin',
    '--get-regexp',
    '^include(if\\..*)?\\.path$',
  ])
  if (!output) return []
  const targets: string[] = []
  for (const line of output.split('\n')) {
    // 形如 `file:.git/config\tinclude.path local.inc`
    const match = /^(?:file:)?(.*?)\t(.*)$/.exec(line)
    if (!match) continue
    const origin = match[1].trim()
    const assignment = match[2].trim()
    const space = assignment.indexOf(' ')
    if (space < 0) continue
    const rawValue = assignment.slice(space + 1).trim().replace(/^"(.*)"$/, '$1')
    if (!rawValue) continue
    const expanded = rawValue.startsWith('~/')
      ? path.join(os.homedir(), rawValue.slice(2))
      : rawValue
    const base = origin.length > 0
      ? (path.isAbsolute(origin) ? origin : path.resolve(workspace, origin))
      : workspace
    const target = path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(base), expanded)
    targets.push(realPath(target))
  }
  return unique(targets)
}

/** CLI 自身必须写的状态目录（否则会话文件/统计写不进去，CLI 直接不可用）。 */
function stateDirsFor(target: SandboxTarget): string[] {
  const home = os.homedir()
  switch (target) {
    case 'claude':
      return [path.join(home, '.claude')]
    case 'codex':
      return [path.join(home, '.codex')]
    case 'opencode':
      return [
        path.join(home, '.local', 'share', 'opencode'),
        path.join(home, '.config', 'opencode'),
      ]
    case 'mcp':
      return []
  }
}

/** CLI 状态目录里**不能**被 agent 改写的配置文件（改了等于改下一次会话的权限/hooks）。 */
function stateConfigFilesFor(target: SandboxTarget): string[] {
  const home = os.homedir()
  switch (target) {
    case 'claude':
      return [
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.claude', 'settings.local.json'),
        path.join(home, '.claude.json'),
      ]
    case 'codex':
      return [path.join(home, '.codex', 'config.toml')]
    case 'opencode':
      return [
        path.join(home, '.config', 'opencode', 'opencode.json'),
        path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      ]
    case 'mcp':
      return []
  }
}

/** MCP server 通常要写自己的缓存；只放开明确的缓存目录，不放开整个家目录。 */
function cacheDirsFor(target: SandboxTarget): string[] {
  if (target !== 'mcp') return []
  return [path.join(os.homedir(), 'Library', 'Caches'), path.join(os.homedir(), '.cache')]
}

function gitDirProtectedWrites(gitDirs: readonly string[], workspace: string): {
  literals: string[]
  subpaths: string[]
} {
  const literals: string[] = []
  const subpaths: string[] = []
  for (const dir of gitDirs) {
    literals.push(
      path.join(dir, 'config'),
      path.join(dir, 'config.lock'),
      path.join(dir, 'config.worktree'),
      path.join(dir, 'info', 'exclude'),
    )
    subpaths.push(path.join(dir, 'hooks'))
  }
  // `.git` 是文件/symlink 时，改写它等于改写 gitdir 指针。
  const dotGit = path.join(workspace, '.git')
  try {
    const stat = lstatSync(dotGit)
    if (stat.isFile() || stat.isSymbolicLink()) literals.push(realPath(dotGit))
  } catch {
    /* 无 .git */
  }
  return { literals: unique(literals), subpaths: unique(subpaths) }
}

/**
 * 生成会话 profile。写入规则顺序即语义：先整体禁写 → 放行工作区等 → 再单独 deny
 * 敏感面（SBPL 最后匹配者生效，POC 已实测）。
 */
export function buildSandboxProfile(input: SandboxProfileInput): SandboxProfile {
  const workspace = realPath(input.workspaceDir ?? process.cwd())
  const layout = discoverGitLayout(workspace)
  const includeTargets = discoverIncludeTargets(workspace)
  const { literals: protectedLiterals, subpaths: protectedSubpaths } = gitDirProtectedWrites(
    layout.gitDirs,
    workspace,
  )

  const writableDirs = unique([
    workspace,
    // CLI 不放开用户临时目录：临时目录是跨会话共享的持久面，放开等于「工作区外可写」。
    // MCP server 需要临时目录（pyc/解压等），作为已知缺口显式记录。
    ...(input.target === 'mcp' ? [realPath(os.tmpdir())] : []),
    ...stateDirsFor(input.target).map(realPath),
    ...cacheDirsFor(input.target).map(realPath),
    ...(input.extraWritableDirs ?? []).map(realPath),
  ])

  // 敏感写面：gitdir 关键文件/hooks、include 目标、CLI 状态目录里的配置文件。
  const deniedLiterals = unique([
    ...protectedLiterals,
    ...includeTargets,
    ...stateConfigFilesFor(input.target).map(realPath),
  ])

  const notes: string[] = [
    '网络未收敛：CLI 需要连模型 API、MCP server 自带网络，本轮只做写/exec 收敛',
    '读未收敛：按要求读放开，工作区外文件仍可读（数据外传风险见 C3 §8）',
    'CLI 自身状态目录（~/.claude、~/.codex 等）是必要写面；其中的配置文件已单独 deny',
  ]
  if (input.target === 'mcp') {
    notes.push('MCP profile 放开用户临时目录与缓存目录（server 运行时需要），属已知写面缺口')
  }

  const lines: string[] = []
  lines.push('(version 1)')
  lines.push('(allow default)')
  lines.push('')
  lines.push('; 写只限工作区与必要运行目录')
  lines.push('(deny file-write*)')
  lines.push(
    `(allow file-write* ${writableDirs.map((dir) => `(subpath ${sbplString(dir)})`).join(' ')} ` +
      `(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))`,
  )
  if (protectedSubpaths.length > 0) {
    lines.push(
      `(deny file-write* ${protectedSubpaths.map((dir) => `(subpath ${sbplString(dir)})`).join(' ')})`,
    )
  }
  if (deniedLiterals.length > 0) {
    lines.push(
      `(deny file-write* ${deniedLiterals.map((file) => `(literal ${sbplString(file)})`).join(' ')})`,
    )
  }

  if (input.target !== 'mcp') {
    // exec 白名单：系统工具 + git 安装根 + 策略白名单命令的真实路径 + 显式入口。
    const execPaths = unique([
      ...SYSTEM_EXEC_SUBPATHS,
      ...(layout.execPath ? [layout.execPath] : []),
      ...(layout.execRoot ? [layout.execRoot] : []),
      ...TOOL_COMMANDS.map((command) => whichSync(command)).filter((value): value is string => !!value),
      ...(input.extraExecutables ?? [])
        .map(resolveExecutablePath)
        .filter((value): value is string => !!value),
    ])
    lines.push('')
    lines.push('; exec 只放行必要项：工作区脚本不在白名单')
    lines.push('(deny process-exec)')
    lines.push(
      `(allow process-exec ${execPaths.map((execPath) => `(subpath ${sbplString(execPath)})`).join(' ')})`,
    )
  } else {
    notes.push('MCP server 未做 exec 收敛：需要执行自身 runtime/子进程，只收敛写入面')
  }

  return {
    text: lines.join('\n'),
    workspace,
    gitDirs: layout.gitDirs,
    protectedWrites: unique([...deniedLiterals, ...protectedSubpaths]),
    notes,
  }
}
