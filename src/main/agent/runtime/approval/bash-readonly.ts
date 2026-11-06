/**
 * P3：Bash 策略（两档 + 空命令例外）。
 *
 * 产品口径：**危险决定交给用户，软件不做限制**。
 * - 命中只读白名单 → allow（免弹直接执行）；
 * - 其余一切 → ask（回到我们的审批网关，由用户决定）；
 * - 唯一例外：空命令/空白命令没有任何内容可审批 → blocked-empty（不放行并记审计）。
 *
 * 审批卡片可读性：
 * - 每条非 allow 的决定都带 rule（如 `pipe` / `redirect` / `shell-escape` / `not-in-whitelist`）
 *   与 risk（low/medium/high/critical），不只写「高风险」；
 * - command 保留**完整原文**，不做截断 —— 用户必须在卡片上看见自己批准的全部内容
 *   （例如不能只显示 `printf` 而藏掉 `> ~/.zshrc`）。
 *
 * 诚实边界：这是**可解释、可测试的规则**，不是完备沙箱。它只约束 Claude 的
 * Bash 工具入口（PreToolUse hook），不阻止 CLI 通过其他工具（如自定义 MCP）执行命令；
 * 也不改变 shell 本身的语义 —— 被 ask 的命令一旦批准，仍以用户权限原样执行。
 */

import { execFileSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { buildSafeEnv } from '../../../shared/env'
import type { RiskLevel } from '@shared/types/agent-runtime'

export type BashPolicyVerdict = 'allow' | 'ask' | 'blocked-empty'

export interface BashPolicyDecision {
  decision: BashPolicyVerdict
  /** 命中/命中的规则标识（审计与审批卡片展示用） */
  rule: string
  /** 可读原因（审计/日志/审批提示） */
  reason: string
  /** 原始命令（完整原文，不截断） */
  command: string
  /** 按规则给出的风险等级，供审批卡片分级 */
  risk: RiskLevel
}

export interface BashPolicyOptions {
  /** 评估时的工作目录：决定读取哪个仓库的 `.git/config`；默认 process.cwd() */
  cwd?: string
  /** 是否同时读取用户/系统 git 配置；默认 true（测试可关闭以保证确定性） */
  includeGlobalGitConfig?: boolean
}

interface PolicyContext {
  cwd: string
  includeGlobalGitConfig: boolean
}

/** 白名单/只读决定的统一风险。 */
const LOW: RiskLevel = 'low'
const MEDIUM: RiskLevel = 'medium'
const HIGH: RiskLevel = 'high'
const CRITICAL: RiskLevel = 'critical'

interface Lexed {
  tokens: string[]
  /** 出现的 shell 元字符规则名（按出现顺序） */
  metachars: string[]
  /** 是否出现命令替换 `$()` 或反引号 */
  substitution: boolean
  /** 单引号外出现 `$`：`$VAR` / `${...}` / `$'...'` / `$"..."` / `$#` 等，运行时会改写参数 */
  expansion: boolean
  /** 单引号外出现 `{` 或 `}`：brace expansion 与 `${}` 都覆盖 */
  brace: boolean
  /** 反斜杠 + 换行：续行会把两段拼成运行时参数 */
  continuation: boolean
  /** 单引号外反斜杠转义了会改变参数语义的字符（`\-`、`\,`、空白等） */
  backslash: boolean
  /** 单引号外出现 `*` / `?` / `[`：glob 由目录内容决定，静态不可知 */
  glob: boolean
  /** token 首或 `=`/`:` 之后的 `~`：展开为家目录 */
  tilde: boolean
  /** 引号未闭合等无法安全解析 */
  unparseable: boolean
}

/**
 * 反斜杠转义这些字符会改变参数语义（拼出标志、制造分隔、阻止展开等），
 * 单引号外一律 ask。普通字母前的反斜杠（`\a` = `a`）不改变语义，不在此列。
 */
const BACKSLASH_SEMANTIC_CHARS = new Set([
  ' ', '\t', '\n', '\r', '-', '{', '}', '*', '?', '[', ']', '~', '$', '"', "'",
  '`', '\\', '(', ')', ';', '&', '|', '<', '>', '#', '!', '=',
])

/** `&&` / `||` 识别为两个字符的复合操作符，避免误判。 */
function lex(command: string): Lexed {
  const tokens: string[] = []
  const metachars: string[] = []
  let substitution = false
  let expansion = false
  let brace = false
  let continuation = false
  let backslash = false
  let glob = false
  let tilde = false
  let current = ''
  let quote: "'" | '"' | null = null
  let i = 0
  const len = command.length

  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }

  while (i < len) {
    const ch = command[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      i += 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
        i += 1
        continue
      }
      if (ch === '\\' && i + 1 < len) {
        const next = command[i + 1]
        if (next === '\n' || next === '\r') {
          continuation = true
          i += 2
          continue
        }
        if (BACKSLASH_SEMANTIC_CHARS.has(next)) backslash = true
        current += next
        i += 2
        continue
      }
      // 双引号内 $ / 反引号仍然展开；花括号本身不展开，但按「单引号外一律 ask」
      // 的保守口径仍标记（宁可多弹，也不漏 `${}` 的拼接写法）。
      if (ch === '$') {
        expansion = true
        if (command[i + 1] === '(') substitution = true
      }
      if (ch === '`') substitution = true
      if (ch === '{' || ch === '}') brace = true
      current += ch
      i += 1
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < len) {
      const next = command[i + 1]
      if (next === '\n' || next === '\r') {
        continuation = true
        i += 2
        continue
      }
      if (BACKSLASH_SEMANTIC_CHARS.has(next)) backslash = true
      current += next
      i += 2
      continue
    }
    if (ch === '$') {
      expansion = true
      if (command[i + 1] === '(') substitution = true
      current += ch
      i += 1
      continue
    }
    if (ch === '`') {
      substitution = true
      current += ch
      i += 1
      continue
    }
    if (ch === '{' || ch === '}') {
      brace = true
      current += ch
      i += 1
      continue
    }
    if (ch === '*' || ch === '?' || ch === '[') {
      glob = true
      current += ch
      i += 1
      continue
    }
    if (ch === '~') {
      // 只有 token 首或赋值/路径分隔之后的 ~ 会被 shell 展开。
      const previous = current[current.length - 1]
      if (current.length === 0 || previous === '=' || previous === ':') tilde = true
      current += ch
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      i += 1
      continue
    }
    if (ch === '>') {
      flush()
      while (i < len && command[i] === '>') i += 1
      metachars.push('redirect')
      continue
    }
    if (ch === '<') {
      flush()
      metachars.push('redirect')
      i += 1
      continue
    }
    if (ch === '|') {
      flush()
      i += 1
      if (i < len && command[i] === '|') {
        i += 1
        metachars.push('or-chain')
      } else {
        metachars.push('pipe')
      }
      continue
    }
    if (ch === '&') {
      flush()
      i += 1
      if (i < len && command[i] === '&') {
        i += 1
        metachars.push('and-chain')
      } else {
        metachars.push('background')
      }
      continue
    }
    if (ch === ';') {
      flush()
      metachars.push('command-chain')
      i += 1
      continue
    }
    if (ch === '\n' || ch === '\r') {
      flush()
      metachars.push('newline')
      i += 1
      continue
    }
    if (ch === '(' || ch === ')') {
      flush()
      metachars.push('subshell')
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  if (quote) {
    return {
      tokens: [],
      metachars,
      substitution,
      expansion,
      brace,
      continuation,
      backslash,
      glob,
      tilde,
      unparseable: true,
    }
  }
  flush()
  return {
    tokens,
    metachars,
    substitution,
    expansion,
    brace,
    continuation,
    backslash,
    glob,
    tilde,
    unparseable: false,
  }
}

/** 会启动子进程 / 改变执行环境的「逃逸」命令：出现在任何位置都要审批。 */
const SHELL_ESCAPE_COMMANDS = new Set([
  'xargs', 'env', 'sudo', 'su', 'doas', 'sh', 'bash', 'zsh', 'dash', 'fish',
  'eval', 'exec', 'command', 'nohup', 'nice', 'timeout', 'watch', 'parallel', 'script',
])

/** 写类命令：出现在命令位即需审批。 */
const WRITE_COMMANDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'tee', 'dd', 'truncate', 'shred', 'chmod', 'chown',
  'chgrp', 'ln', 'mkdir', 'touch', 'install', 'kill', 'pkill', 'killall',
])

/** git 写子命令：白名单只放行读子命令。 */
const GIT_WRITE_SUBCOMMANDS = new Set([
  'commit', 'add', 'rm', 'mv', 'reset', 'checkout', 'switch', 'restore', 'merge',
  'rebase', 'pull', 'push', 'fetch', 'clone', 'init', 'apply', 'am', 'cherry-pick',
  'clean', 'gc', 'prune', 'config', 'worktree', 'submodule', 'notes', 'update-ref',
  'filter-branch', 'replace', 'bisect', 'reflog', 'prune-packed', 'repack',
])

/**
 * git 只读子命令：无参数限制地放行。
 * `grep` 故意不在其中：它支持 `-O/-iO.../--open-files-in-pager`，会把命中文件交给外部
 * pager 执行（短选项还能簇写，模式枚举修一次漏一次）。整条子命令一律 ask。
 */
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files',
  'describe', 'shortlog', 'cat-file', 'show-ref', 'for-each-ref', 'whatchanged',
  'merge-base', 'name-rev', 'rev-list', 'count-objects', 'fsck',
])

const FIND_DANGEROUS_ARGS = [
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls', '-fprint0',
]

/**
 * 参数白名单：每个放行命令都必须显式登记「哪些参数会写盘/执行外部程序」。
 * 新增白名单命令时若忘记登记，`bash-readonly.test.ts` 的覆盖测试会失败。
 *
 * 说明：`grep -f` 只是「从文件读取 pattern」，不写盘也不执行程序，因此不登记为危险参数；
 * `sort -o` / `uniq -o` / `xxd -o` / `awk` 的 `system()` / `tar -x` / `less !` 等命令
 * 本身不在白名单，一律 ask，无需在这里重复登记。
 */
export interface DangerousArgSpec {
  flag: string
  rule: string
  reason: string
  risk?: RiskLevel
  /**
   * 该选项只有带 `<name>=<value>` 才是真实危险形态。
   * 目前只有 git 全局 `-c` 用到：`git -c core.pager=cat status` 才是配置覆盖；
   * 不带等号的 `-c` 是子命令选项（`git log -c` = combined diff，只读），
   * 不应对它多弹一次。判定时会同时看紧邻的下一个 token。
   */
  requiresAssignment?: boolean
}

export const DANGEROUS_ARGS_BY_COMMAND: Record<string, DangerousArgSpec[]> = {
  ls: [],
  pwd: [],
  cat: [],
  head: [],
  tail: [],
  wc: [],
  grep: [],
  rg: [
    { flag: '--pre', rule: 'rg-pre', reason: 'rg --pre 会为每个文件执行外部程序', risk: CRITICAL },
    { flag: '-z', rule: 'rg-search-zip', reason: 'rg -z 会按文件类型调用外部解压程序', risk: HIGH },
    { flag: '--search-zip', rule: 'rg-search-zip', reason: 'rg --search-zip 会按文件类型调用外部解压程序', risk: HIGH },
  ],
  stat: [],
  file: [
    { flag: '-C', rule: 'file-compile', reason: 'file -C 会写出编译后的 magic 文件', risk: HIGH },
    { flag: '--compile', rule: 'file-compile', reason: 'file --compile 会写出编译后的 magic 文件', risk: HIGH },
  ],
  du: [],
  df: [],
  which: [],
  whoami: [],
  uname: [],
  date: [
    { flag: '-s', rule: 'date-set', reason: 'date -s 会修改系统时间', risk: HIGH },
    { flag: '--set', rule: 'date-set', reason: 'date --set 会修改系统时间', risk: HIGH },
  ],
  echo: [],
  find: FIND_DANGEROUS_ARGS.map((flag) => ({
    flag,
    rule: 'find-dangerous',
    reason: `find 参数 ${flag} 会写文件或执行命令`,
    risk: HIGH,
  })),
  node: [],
  git: [
    { flag: '--output', rule: 'git-output-file', reason: 'git --output=<file> 会写文件', risk: HIGH },
    {
      flag: '--submodule',
      rule: 'git-submodule-diff',
      reason: 'git --submodule=diff 会递归对比子模块，并执行子模块配置里的 diff.external / textconv',
      risk: HIGH,
    },
    { flag: '--ext-diff', rule: 'git-ext-diff', reason: 'git --ext-diff 会执行外部 diff 程序', risk: HIGH },
    { flag: '--textconv', rule: 'git-textconv', reason: 'git --textconv 会执行配置的转换程序', risk: HIGH },
    { flag: '--filters', rule: 'git-filters', reason: 'git --filters 会执行配置的 filter 程序', risk: HIGH },
    { flag: '--lost-found', rule: 'git-lost-found', reason: 'git fsck --lost-found 会写 .git/lost-found', risk: HIGH },
    { flag: '--show-signature', rule: 'git-show-signature', reason: 'git log/show --show-signature 会拉起 gpg 验证签名', risk: HIGH },
    {
      flag: '--alternate-refs',
      rule: 'git-alternate-refs',
      reason: 'git rev-list --alternate-refs 会执行 core.alternateRefsCommand 指定的外部程序',
      risk: HIGH,
    },
    {
      flag: '-c',
      rule: 'git-config-override',
      reason: 'git -c 可覆盖 core.pager / diff.external / core.fsmonitor 等会执行程序的配置',
      risk: HIGH,
      requiresAssignment: true,
    },
    { flag: '--config-env', rule: 'git-config-override', reason: 'git --config-env 可从环境注入会执行程序的配置', risk: HIGH },
    { flag: '--exec-path', rule: 'git-exec-path', reason: 'git --exec-path 会把子命令解析到任意目录', risk: HIGH },
    { flag: '--upload-pack', rule: 'git-upload-pack', reason: 'git --upload-pack 会执行指定的外部程序', risk: CRITICAL },
    { flag: '--receive-pack', rule: 'git-receive-pack', reason: 'git --receive-pack 会执行指定的外部程序', risk: CRITICAL },
  ],
}


/**
 * 会读取仓库/用户 git 配置并可能执行外部程序的只读子命令：
 * `diff.*.textconv` / `diff.*.command` / `diff.external`（diff/log/show/blame/whatchanged）、
 * `filter.*.clean|smudge|process`（status/diff）、`core.fsmonitor`（status/diff/blame/ls-files/fsck
 * 会刷新 index；实测这些命令会 fork hook）、`core.hooksPath`（status 回写 index 时触发
 * `post-index-change` 钩子）、`core.alternateRefsCommand`（rev-list `--alternate-refs`）
 * 与 `log.showSignature` / `gpg.*.program` / `%G` 格式（log/show/whatchanged/rev-list
 * 会调用 gpg）。配置命中即 ask。
 */
const GIT_CONFIG_EXEC_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'whatchanged', 'rev-list', 'ls-files', 'fsck',
])

/** git 布尔配置：false/no/off/0（含空值）为假；其余为真（路径类配置同样按真处理）。 */
function gitConfigBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off' && normalized !== '0'
}

/**
 * 全局 filter 只放行 git-lfs 的标准写法，避免「打开不可信仓库 + .gitattributes 指向
 * 全局自定义 filter」换取零审批执行，同时不给 LFS 用户增加弹窗。
 *
 * 匹配前做两种归一化：
 * - 去掉包裹的双引号（Git 允许 `"git-lfs clean -- %f"`）；
 * - 折叠连续空白（tab/多空格）。
 *
 * 二进制名允许路径前缀与 Windows `.exe`（`/usr/local/bin/git-lfs`、`git-lfs.exe`），
 * 只比较 basename；arg 形态必须精确为 `clean -- %f` / `smudge -- %f` / `filter-process`。
 * 误判风险：全局配置属于用户自己，攻击者若能改全局配置本就能用 diff.external 等键
 * 执行任意程序，因此按 basename 放行不扩大威胁面；但名字伪装成 git-lfs 的绝对路径
 * （如 `/tmp/git-lfs`）也会被放行，这是为了不同安装路径的 LFS 体验所做的取舍。
 */
function isStandardLfsFilterValue(key: string, value: string): boolean {
  const normalized = value.trim().replace(/^"(.*)"$/, '$1').replace(/\s+/g, ' ')
  const parts = normalized.split(' ')
  const binary = parts[0].split(/[\\/]/).pop()?.toLowerCase()
  if (binary !== 'git-lfs' && binary !== 'git-lfs.exe') return false
  if (key === 'process') return parts.length === 2 && parts[1] === 'filter-process'
  if (key === 'clean' || key === 'smudge') {
    return parts.length === 4 && parts[1] === key && parts[2] === '--' && parts[3] === '%f'
  }
  return false
}

/* ------------------------------------------------------------------------- *
 * git 配置探针（S1 影子 → S2 权威 → S3 唯一解析器）
 *
 * S1 影子对照 → S2 切为权威 → S3 删除手写解析器后，Git 自己解析是唯一口径：
 * 固定 argv 起一个 `git config` 子进程，读取扁平化的最终配置，再按「哪些键会执行外部程序」
 * 判定。include 深度、转义、子节写法、裸键、includeIf 条件求值全部交给 Git。
 * ------------------------------------------------------------------------- */

/** 探针失败分类。S2 起任何失败都必须 ask（fail-closed），分类只用于观测与告警。 */
export type GitConfigProbeFailure =
  | 'missing-git'
  | 'cwd-missing'
  | 'timeout'
  | 'non-zero-exit'
  | 'show-scope-unsupported'
  | 'empty-output'
  | 'invalid-nul-record'
  | 'io-error'

export interface GitConfigProbeEntry {
  /** `git config --list` 的扁平键名（小写），如 `diff.evil.textconv`。 */
  key: string
  value: string
  /** 裸键（无 `=`）：Git 语义等价 `true`。 */
  bare: boolean
  /** `--show-scope` 的 scope：local / worktree / global / system / command / unknown。 */
  scope: string
  /** `--show-origin` 的来源文件。 */
  origin: string
}

export interface GitConfigProbeResult {
  entries: GitConfigProbeEntry[]
  /** 非 null 即不可判定：S2 起必须 ask。 */
  failure: GitConfigProbeFailure | null
  latencyMs: number
}

/** 固定 argv，不做任何字符串拼接：探针自身不成为注入面，也不触发 pager。 */
const GIT_CONFIG_PROBE_ARGS = [
  '--no-pager',
  'config',
  '--list',
  '--null',
  '--show-origin',
  '--show-scope',
  '--includes',
] as const

const GIT_CONFIG_PROBE_TIMEOUT_MS = 250
const GIT_CONFIG_PROBE_MAX_BUFFER = 1024 * 1024

/**
 * 运行时止血开关：设为 `off` 时停用探针，退回「手写 + 一律 ask」。
 * 注意退不回到「手写 allow」——手写解析器自身有已知漏判，不能作为放行依据。
 */
const GIT_CONFIG_PROBE_DISABLE_ENV = 'BIZGRAPH_GIT_CONFIG_PROBE'

function gitConfigProbeDisabled(): boolean {
  return (process.env[GIT_CONFIG_PROBE_DISABLE_ENV] ?? '').trim().toLowerCase() === 'off'
}

/**
 * 用与应用同一执行环境的 PATH 解析 git 绝对路径（不写死 `/usr/bin/git`）。
 * Bash 工具里的 `git` 也是按 PATH 查找的，因此这里选到的就是实际会被调用的那一个。
 */
function resolveGitExecutable(): string | null {
  const pathEnv = process.env.PATH ?? ''
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
      : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `git${extension}`)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* 该候选不可执行，继续扫描 PATH */
      }
    }
  }
  return null
}

/**
 * 解析 `--null --show-origin --show-scope` 的输出：每条记录三个 NUL 结尾字段
 * （scope / origin / `key\nvalue`，裸键无换行、值可含换行）。
 */
function parseGitConfigProbeOutput(text: string): {
  entries: GitConfigProbeEntry[]
  failure: GitConfigProbeFailure | null
} {
  if (text.length === 0) return { entries: [], failure: 'empty-output' }
  const fields = text.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  if (fields.length % 3 !== 0) return { entries: [], failure: 'invalid-nul-record' }
  const entries: GitConfigProbeEntry[] = []
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index]
    const origin = fields[index + 1]
    const keyValue = fields[index + 2]
    if (!keyValue) return { entries: [], failure: 'invalid-nul-record' }
    const newline = keyValue.indexOf('\n')
    if (newline < 0) {
      entries.push({ key: keyValue.toLowerCase(), value: '', bare: true, scope, origin })
    } else {
      entries.push({
        key: keyValue.slice(0, newline).toLowerCase(),
        value: keyValue.slice(newline + 1),
        bare: false,
        scope,
        origin,
      })
    }
  }
  return { entries, failure: null }
}

/**
 * 跑一次探针。`includeGlobal=false` 时通过环境隔离只读仓库本地配置，
 * 与手写口径的 `includeGlobalGitConfig=false` 对齐（供测试使用）。
 */
export function probeGitConfig(
  cwd: string,
  includeGlobal: boolean,
  timeoutMs: number = GIT_CONFIG_PROBE_TIMEOUT_MS,
): GitConfigProbeResult {
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt
  const failed = (failure: GitConfigProbeFailure): GitConfigProbeResult => ({
    entries: [],
    failure,
    latencyMs: elapsed(),
  })

  const gitPath = resolveGitExecutable()
  if (!gitPath) return failed('missing-git')
  // cwd 不存在时 Git 根本起不来：与「找不到 git」分开，便于告警与排查。
  if (!existsSync(cwd)) return failed('cwd-missing')

  /**
   * 环境必须与真实 Bash 子进程一致：适配器用 buildSafeEnv() 派生环境，
   * 其中 `GIT_DIR` / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_COUNT` 等 `GIT_*` 均被剥离
   * （唯一放行的是白名单键 `GIT_EDITOR`）。直接继承 process.env 会让探针读到
   * 与真实命令不同的仓库，出现「探针 allow、真实执行 external」。
   */
  const env: NodeJS.ProcessEnv = buildSafeEnv()
  if (!includeGlobal) {
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_SYSTEM = '/dev/null'
    env.GIT_CONFIG_GLOBAL = '/dev/null'
    for (const key of Object.keys(env)) {
      if (
        key === 'GIT_CONFIG_COUNT' ||
        key.startsWith('GIT_CONFIG_KEY_') ||
        key.startsWith('GIT_CONFIG_VALUE_')
      ) {
        delete env[key]
      }
    }
  }

  const parsed = execGitConfigProbe(gitPath, GIT_CONFIG_PROBE_ARGS, cwd, env, timeoutMs)
  return { ...parsed, latencyMs: elapsed() }
}

/**
 * 真正的 spawn + 失败分类：主探针与子模块 `--file` 探针共用同一口径，
 * 避免子模块读取路径出现一套独立的错误处理。
 */
function execGitConfigProbe(
  gitPath: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): { entries: GitConfigProbeEntry[]; failure: GitConfigProbeFailure | null } {
  try {
    const stdout = execFileSync(gitPath, [...argv], {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: GIT_CONFIG_PROBE_MAX_BUFFER,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as Buffer
    return parseGitConfigProbeOutput(stdout.toString('utf8'))
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & {
      status?: number | null
      signal?: NodeJS.Signals | null
      stderr?: Buffer | string
    }
    const stderr = Buffer.isBuffer(detail.stderr)
      ? detail.stderr.toString('utf8')
      : (detail.stderr ?? '')
    if (/unknown option.*show-scope|unrecognized option.*show-scope|show-scope/i.test(stderr)) {
      return { entries: [], failure: 'show-scope-unsupported' }
    }
    if (detail.code === 'ETIMEDOUT') return { entries: [], failure: 'timeout' }
    if (detail.code === 'ENOENT') {
      // 预检查已确认 cwd 存在；此处 ENOENT 可能是 git 可执行文件在解析后被移除，
      // 也可能是 cwd 在检查与 spawn 之间被删除。后者单独分类，不与 missing-git 混淆。
      return { entries: [], failure: existsSync(cwd) ? 'missing-git' : 'cwd-missing' }
    }
    // 超过 1 MB 的 maxBuffer 截断：execFileSync 会以 ENOBUFS /
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER 抛出，且伴随 SIGTERM；必须先于信号判定，
    // 否则会被误分类为 timeout。
    if (
      detail.code === 'ENOBUFS' ||
      detail.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      return { entries: [], failure: 'io-error' }
    }
    if (detail.signal === 'SIGTERM') return { entries: [], failure: 'timeout' }
    if (typeof detail.status === 'number' && detail.status !== 0) {
      return { entries: [], failure: 'non-zero-exit' }
    }
    return { entries: [], failure: 'io-error' }
  }
}

/**
 * 用 `git config --file <path>` 读取单个配置文件（子模块配置）。仍由 Git 解析
 * include / 转义 / 裸键，不引入手写解析；环境与主探针一致（buildSafeEnv 派生）。
 */
export function probeGitConfigFile(
  configPath: string,
  timeoutMs: number = GIT_CONFIG_PROBE_TIMEOUT_MS,
): GitConfigProbeResult {
  const startedAt = Date.now()
  const failed = (failure: GitConfigProbeFailure): GitConfigProbeResult => ({
    entries: [],
    failure,
    latencyMs: Date.now() - startedAt,
  })

  const gitPath = resolveGitExecutable()
  if (!gitPath) return failed('missing-git')
  const configDir = dirname(configPath)
  if (!existsSync(configDir)) return failed('cwd-missing')
  if (!existsSync(configPath)) return failed('io-error')

  const argv = [
    '--no-pager',
    'config',
    '--file',
    configPath,
    ...GIT_CONFIG_PROBE_ARGS.slice(2),
  ] as const
  const parsed = execGitConfigProbe(gitPath, argv, configDir, buildSafeEnv(), timeoutMs)
  // `--file` 指向空文件是合法的「没有配置」，不是探针不可判定；主探针的
  // empty-output 仍按 fail-closed 处理（正常仓库至少会输出 core.repositoryformatversion）。
  if (parsed.failure === 'empty-output') return { entries: [], failure: null, latencyMs: Date.now() - startedAt }
  return { ...parsed, latencyMs: Date.now() - startedAt }
}

/** 会按 `diff.submodule=diff` 递归展示子模块差异的只读子命令。 */
const GIT_SUBMODULE_DIFF_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'whatchanged'])

const GIT_MODULE_SCAN_MAX_DEPTH = 8

/** 子模块 gitdir 内不可能是「模块命名空间」的目录，避免把对象库当配置扫。 */
const GIT_MODULE_SKIP_DIRS = new Set([
  'objects', 'refs', 'logs', 'hooks', 'info', 'branches', 'worktrees', 'index', 'pack',
])

export interface GitSubmoduleConfigProbeResult {
  results: GitConfigProbeResult[]
  /** 非 null 即不可枚举/不可读取：调用方必须 fail-closed ask。 */
  failure: GitConfigProbeFailure | null
}

/** `diff.submodule=diff` 是唯一会递归执行子模块 external/textconv 的取值。 */
export function gitConfigRequestsSubmoduleDiff(result: GitConfigProbeResult): boolean {
  if (result.failure) return true
  return result.entries.some(
    (entry) =>
      entry.key === 'diff.submodule' &&
      !entry.bare &&
      entry.value.trim().toLowerCase() === 'diff',
  )
}

/**
 * 从 index 读取 gitlink（mode 160000）路径。
 *
 * 只信任 Git 对 index 的解析；命令自带 `core.fsmonitor=false`，避免探针自己触发
 * 被审计的执行面（实测 `git ls-files` 会跑 fsmonitor）。`GIT_OPTIONAL_LOCKS=0`
 * 保证读命令不回写 index，也就不会触发 `post-index-change` 钩子。
 */
function listSubmoduleWorktrees(
  gitPath: string,
  topLevel: string,
  timeoutMs: number,
): { paths: string[]; failure: GitConfigProbeFailure | null } {
  try {
    const stdout = execFileSync(
      gitPath,
      ['-C', topLevel, '-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z'],
      {
        env: { ...buildSafeEnv(), GIT_OPTIONAL_LOCKS: '0' },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as Buffer
    const paths: string[] = []
    for (const record of stdout.toString('utf8').split('\0')) {
      if (!record) continue
      const tab = record.indexOf('\t')
      if (tab < 0) return { paths: [], failure: 'invalid-nul-record' }
      const mode = record.slice(0, tab).split(' ')[0]
      const path = record.slice(tab + 1)
      if (mode === '160000' && path) paths.push(path)
    }
    return { paths, failure: null }
  } catch {
    return { paths: [], failure: 'io-error' }
  }
}

/** 读一个子模块 gitdir 的 `config` 与 `config.worktree`；两者都交给 `git config --file`。 */
function probeModuleGitDir(
  gitDirPath: string,
  timeoutMs: number,
  results: GitConfigProbeResult[],
): GitConfigProbeFailure | null {
  const configPath = join(gitDirPath, 'config')
  if (!existsSync(configPath)) return 'io-error'
  const probe = probeGitConfigFile(configPath, timeoutMs)
  if (probe.failure) return probe.failure
  results.push(probe)
  const worktreeConfig = join(gitDirPath, 'config.worktree')
  if (existsSync(worktreeConfig)) {
    const worktreeProbe = probeGitConfigFile(worktreeConfig, timeoutMs)
    if (worktreeProbe.failure) return worktreeProbe.failure
    results.push(worktreeProbe)
  }
  return null
}

/**
 * 递归读取子模块配置，覆盖三种真实布局：
 * 1. 标准布局：`.git/modules/<name>/config`（含嵌套子模块的 `modules/modules`）；
 * 2. 现代 worktree 布局：子模块 worktree 的 `.git` 是 gitdir 文件，指向 1；
 * 3. 旧式布局：子模块 worktree 的 `.git` 是目录，配置直接在该目录内。
 *
 * - 枚举：`rev-parse --absolute-git-dir` / `--show-toplevel` 定位 gitdir 与工作区，
 *   `ls-files --stage`（含 mode 160000）拿 gitlink 路径，不依赖 `.gitmodules`（可被伪造/缺失）。
 * - 读取：每个配置文件都走 `git config --file`，不引入手写 INI 解析。
 * - 失败姿态：gitdir/topLevel/index 不可得、目录不可读、配置缺失或探针失败、
 *   符号链接（无法确定指向）一律返回 failure，调用方按 fail-closed ask。
 */
export function probeGitSubmoduleConfigs(
  cwd: string,
  timeoutMs: number = GIT_CONFIG_PROBE_TIMEOUT_MS,
): GitSubmoduleConfigProbeResult {
  const failed = (failure: GitConfigProbeFailure): GitSubmoduleConfigProbeResult => ({
    results: [],
    failure,
  })

  const gitPath = resolveGitExecutable()
  if (!gitPath) return failed('missing-git')
  if (!existsSync(cwd)) return failed('cwd-missing')

  let topLevel: string
  let gitDir: string
  try {
    topLevel = execFileSync(gitPath, ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      env: buildSafeEnv(),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    gitDir = execFileSync(gitPath, ['-C', cwd, 'rev-parse', '--absolute-git-dir'], {
      env: buildSafeEnv(),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return failed('io-error')
  }
  if (!topLevel || !gitDir || !existsSync(topLevel) || !existsSync(gitDir)) {
    return failed('io-error')
  }

  const results: GitConfigProbeResult[] = []
  const seen = new Set<string>()
  const probeGitDirOnce = (gitDirPath: string): GitConfigProbeFailure | null => {
    const key = resolve(gitDirPath)
    if (seen.has(key)) return null
    seen.add(key)
    return probeModuleGitDir(gitDirPath, timeoutMs, results)
  }

  const modulesDir = join(gitDir, 'modules')
  const walk = (dir: string, depth: number): GitConfigProbeFailure | null => {
    if (depth > GIT_MODULE_SCAN_MAX_DEPTH) return 'io-error'
    let info: ReturnType<typeof lstatSync>
    try {
      info = lstatSync(dir)
    } catch {
      return 'io-error'
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return 'io-error'

    let children: Dirent[]
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      return 'io-error'
    }
    // 有 config 的目录就是模块根；模块根只继续下钻 modules（嵌套子模块），
    // 不再扫 objects/refs 等，避免大仓库对象库拖慢探针。
    const isModuleRoot = children.some((child) => child.isFile() && child.name === 'config')
    for (const child of children) {
      if (child.isSymbolicLink()) return 'io-error'
      if (!child.isDirectory()) continue
      const full = join(dir, child.name)
      if (child.name === 'modules' || (!isModuleRoot && !GIT_MODULE_SKIP_DIRS.has(child.name))) {
        const failure = walk(full, depth + 1)
        if (failure) return failure
      }
    }
    return isModuleRoot ? probeGitDirOnce(dir) : null
  }

  if (existsSync(modulesDir)) {
    const failure = walk(modulesDir, 0)
    if (failure) return failed(failure)
  }

  const gitlinks = listSubmoduleWorktrees(gitPath, topLevel, timeoutMs)
  if (gitlinks.failure) return failed(gitlinks.failure)
  for (const relativePath of gitlinks.paths) {
    const worktreeDir = resolve(topLevel, relativePath)
    const dotGit = join(worktreeDir, '.git')
    let info: ReturnType<typeof lstatSync>
    try {
      info = lstatSync(dotGit)
    } catch (error) {
      // 未初始化的子模块没有 `.git`，git 不会进入它执行 external diff。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return failed('io-error')
    }
    if (info.isSymbolicLink()) return failed('io-error')
    if (info.isDirectory()) {
      const failure = probeGitDirOnce(dotGit)
      if (failure) return failed(failure)
      continue
    }
    if (!info.isFile()) return failed('io-error')
    let content: string
    try {
      content = readFileSync(dotGit, 'utf8')
    } catch {
      return failed('io-error')
    }
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
    if (!match) return failed('io-error')
    const moduleGitDir = resolve(worktreeDir, match[1])
    const failure = probeGitDirOnce(moduleGitDir)
    if (failure) return failed(failure)
  }

  return { results, failure: null }
}

/**
 * 会消费 `gpg.*.program` 与 `format.pretty` / `pretty.<name>` 的日志展示命令。
 * `git rev-list` 不读 `format.pretty`，但支持 `--format`（见下一组），因此分开放：
 * 配置面只对这组命令判，避免给普通 `git rev-list HEAD` 增加无意义弹窗。
 */
const GIT_GPG_CONFIG_SUBCOMMANDS = new Set(['log', 'show', 'whatchanged'])

/** 支持 `--format` / `--pretty` 且 `%G` 占位符会触发 gpg 的只读子命令。 */
const GIT_GPG_PRETTY_SUBCOMMANDS = new Set(['log', 'show', 'whatchanged', 'rev-list'])

/**
 * `--format` / `--pretty` 的取值含 `%G`（`%G?`、`%GS` 等）时会调用 gpg 验证签名。
 * 取值缺失或下一个 token 是另一个选项时无法判定，按 ask 处理（fail-closed）。
 */
export function gitPrettyUsesGpg(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') break
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    if (name !== '--format' && name !== '--pretty') continue
    if (equals >= 0) {
      if (arg.slice(equals + 1).includes('%G')) return true
      continue
    }
    const next = args[index + 1]
    if (!next || next.startsWith('-')) return true
    if (next.includes('%G')) return true
  }
  return false
}

/**
 * 与手写口径相同的「哪些键会执行外部程序」判定，输入是 Git 自己解析出的扁平键。
 */
export function probeGitConfigExecutes(result: GitConfigProbeResult, sub: string): boolean {
  // 探针失败 = 不可判定：S2 起必须 ask，不能把「没看到危险配置」当成安全。
  if (result.failure) return true
  for (const entry of result.entries) {
    const value = entry.bare ? 'true' : entry.value
    // 显式空值（`key =`）等价未设置。
    if (value === '') continue
    const parts = entry.key.split('.')
    const last = parts[parts.length - 1]
    // diff.external 与 diff.<driver>.textconv/command 会和手写口径一样执行外部程序。
    if (entry.key === 'diff.external') return true
    if (
      parts.length >= 3 &&
      parts[0] === 'diff' &&
      (last === 'textconv' || last === 'command')
    ) {
      return true
    }
    // fsmonitor：status/diff/blame/ls-files/fsck 实测会刷新 index 并调用 hook；
    // log/show 不刷新 index，不判。
    if (
      entry.key === 'core.fsmonitor' &&
      gitConfigBoolean(value) &&
      (sub === 'status' ||
        sub === 'diff' ||
        sub === 'blame' ||
        sub === 'ls-files' ||
        sub === 'fsck')
    ) {
      return true
    }
    // core.hooksPath：status 刷新并回写 index 时会触发 post-index-change 钩子
    // （实测 marker 生成）；diff/blame/ls-files/log 实测不触发，不额外判。
    if (entry.key === 'core.hookspath' && sub === 'status') {
      return true
    }
    // core.alternateRefsCommand：rev-list --alternate-refs 会用 shell 执行该命令。
    // 只对 rev-list 判定；其它只读子命令不会消费它。
    if (entry.key === 'core.alternaterefscommand' && sub === 'rev-list') {
      return true
    }
    // filter：仓库本地三项全 ask；全局/系统/命令作用域只放行 git-lfs 标准写法。
    if (
      (sub === 'status' || sub === 'diff') &&
      parts.length >= 3 &&
      parts[0] === 'filter' &&
      (last === 'clean' || last === 'smudge' || last === 'process')
    ) {
      const repoScoped = entry.scope === 'local' || entry.scope === 'worktree'
      if (repoScoped) return true
      if (!isStandardLfsFilterValue(last, value)) return true
    }
    // log.showSignature=true 让 log/show/whatchanged 自动调用 gpg。
    if (entry.key === 'log.showsignature' && gitConfigBoolean(value) && GIT_GPG_CONFIG_SUBCOMMANDS.has(sub)) {
      return true
    }
    // gpg.program / gpg.ssh.program / gpg.x509.program：`%G` 占位符或签名展示路径
    // 会调用它们。对象是否带签名无法静态判断，配置存在即 ask（宁多弹一次）。
    if (
      GIT_GPG_CONFIG_SUBCOMMANDS.has(sub) &&
      (entry.key === 'gpg.program' ||
        entry.key === 'gpg.ssh.program' ||
        entry.key === 'gpg.x509.program')
    ) {
      return true
    }
    // format.pretty / pretty.<name> 含 `%G` 时同样会走 gpg。
    if (
      GIT_GPG_CONFIG_SUBCOMMANDS.has(sub) &&
      (entry.key === 'format.pretty' || entry.key.startsWith('pretty.')) &&
      value.includes('%G')
    ) {
      return true
    }
  }
  return false
}

const GIT_CONFIG_PROBE_FAILURES: readonly GitConfigProbeFailure[] = [
  'missing-git',
  'cwd-missing',
  'timeout',
  'non-zero-exit',
  'show-scope-unsupported',
  'empty-output',
  'invalid-nul-record',
  'io-error',
]

interface GitConfigProbeDiagnosticsState {
  samples: number
  failures: Record<GitConfigProbeFailure, number>
  latencies: number[]
}

const gitConfigProbeDiagnosticsState: GitConfigProbeDiagnosticsState = {
  samples: 0,
  failures: Object.fromEntries(
    GIT_CONFIG_PROBE_FAILURES.map((failure) => [failure, 0]),
  ) as Record<GitConfigProbeFailure, number>,
  latencies: [],
}

const GIT_CONFIG_PROBE_LATENCY_WINDOW = 500

/**
 * 运行时观测（S1 影子期的差异对照已随手写解析器删除；S3 后只记录探针自身的
 * 失败分类与延迟，供 §17 的 7 天运营观察使用）。
 */
function recordGitConfigProbe(probe: GitConfigProbeResult): void {
  gitConfigProbeDiagnosticsState.samples += 1
  if (probe.failure) gitConfigProbeDiagnosticsState.failures[probe.failure] += 1
  gitConfigProbeDiagnosticsState.latencies.push(probe.latencyMs)
  if (gitConfigProbeDiagnosticsState.latencies.length > GIT_CONFIG_PROBE_LATENCY_WINDOW) {
    gitConfigProbeDiagnosticsState.latencies.shift()
  }
}

export interface GitConfigProbeDiagnostics {
  samples: number
  failures: Record<GitConfigProbeFailure, number>
  p95LatencyMs: number
  maxLatencyMs: number
}

/** 探针观测快照：失败分类、延迟分布（只读）。 */
export function getGitConfigProbeDiagnostics(): GitConfigProbeDiagnostics {
  const sorted = [...gitConfigProbeDiagnosticsState.latencies].sort((a, b) => a - b)
  const index = sorted.length === 0 ? -1 : Math.ceil(sorted.length * 0.95) - 1
  return {
    samples: gitConfigProbeDiagnosticsState.samples,
    failures: { ...gitConfigProbeDiagnosticsState.failures },
    p95LatencyMs: index < 0 ? 0 : sorted[index],
    maxLatencyMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  }
}

/** 仅测试使用：清空观测，避免用例间互相污染。 */
export function resetGitConfigProbeDiagnostics(): void {
  gitConfigProbeDiagnosticsState.samples = 0
  gitConfigProbeDiagnosticsState.latencies.length = 0
  for (const failure of GIT_CONFIG_PROBE_FAILURES) {
    gitConfigProbeDiagnosticsState.failures[failure] = 0
  }
}

/** 下载内容直接交给解释器执行：最高风险（只认命令位，避免把引号里的示例文本当成真实执行）。 */
const FETCH_AND_EXEC = /^(?:sudo\s+)?(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|fish|python[0-9.]*|node|perl|ruby)\b/

interface RuleVerdict {
  decision: 'allow' | 'ask'
  rule: string
  reason: string
  risk: RiskLevel
}

function allowRule(rule: string, reason = '只读白名单命中'): RuleVerdict {
  return { decision: 'allow', rule, reason, risk: LOW }
}

function askRule(rule: string, reason: string, risk: RiskLevel = MEDIUM): RuleVerdict {
  return { decision: 'ask', rule, reason, risk }
}

/** 写类命令按破坏力给风险：rm/dd/truncate/shred 的递归或强制形态最高。 */
function writeCommandRisk(name: string, args: string[]): RiskLevel {
  if (name === 'dd' || name === 'truncate' || name === 'shred') return CRITICAL
  if (name === 'rm' || name === 'rmdir') {
    const destructive = args.some(
      (arg) => arg.startsWith('-') && !arg.startsWith('--') && /[rRf]/.test(arg),
    )
    return destructive ? CRITICAL : HIGH
  }
  return HIGH
}

type RuleEvaluator = (args: string[], ctx: PolicyContext) => RuleVerdict

function simpleRule(name: string): RuleEvaluator {
  return () => allowRule(name)
}

/** `git branch` 只放行列举形态：任何位置参数都是「创建分支」。 */
const BRANCH_READ_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose',
  '--contains', '--merged', '--no-merged', '--points-at', '--sort', '--format',
  '--color', '--no-color', '--column', '--no-column', '-i', '--ignore-case', '--omit-empty',
])
/** 这些列举参数可以带一个值（pattern/排序键/格式串）；值本身不是创建分支。 */
const BRANCH_VALUE_FLAGS = new Set([
  '-l', '--list', '--contains', '--merged', '--no-merged', '--points-at', '--sort', '--format',
  '--color', '--column', '--omit-empty',
])

function branchRule(args: string[]): RuleVerdict {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith('-')) {
      if (BRANCH_VALUE_FLAGS.has(arg) && index + 1 < args.length && !args[index + 1].startsWith('-')) {
        index += 1 // 跳过列举参数的值
        continue
      }
      const flagName = arg.split('=')[0]
      if (BRANCH_READ_FLAGS.has(flagName) || BRANCH_READ_FLAGS.has(arg)) continue
      return askRule('git-branch-write', `git branch ${arg} 会改写分支`, HIGH)
    }
    // 位置参数 = 分支名 → 创建/删除分支
    return askRule('git-branch-create', `git branch ${arg} 会创建分支`, HIGH)
  }
  return allowRule('git:branch:list')
}

function nodeRule(args: string[]): RuleVerdict {
  // 只放行严格形态 `node --check <file>`：--check 本身只做语法解析、不执行脚本，
  // 但只要多出任何参数就可能在被检查脚本之前加载并执行代码（`-r/--require`、
  // `--import`、`--loader`、`--env-file` 等）。不做选项枚举——非严格形态一律 ask。
  if (args.length === 2 && args[0] === '--check') return allowRule('node:--check')
  return askRule('node:run', 'node 仅放行 `node --check <file>`；其余形态会执行脚本或加载模块，需人工审批')
}

function remoteRule(args: string[]): RuleVerdict {
  if (args.length === 0) return allowRule('git:remote:list')
  // `show` 会联系远端：实测会执行 `remote.<name>.uploadpack`，`protocol.ext.allow=always`
  // 时 `remote.<name>.url=ext::<cmd>` 也会执行 shell。它虽然名字像读，但执行面由配置决定，
  // 不在「命令 + 参数」可静态判定的范围，因此只放行不联网的列举/查询形态。
  if (args[0] === 'show') {
    return askRule(
      'git-remote-show',
      'git remote show 会联系远端并执行 remote.*.uploadpack / sshCommand / protocol.*.allow / ext:: 等配置指定的外部程序',
      HIGH,
    )
  }
  const readOnly = args[0] === '-v' || args[0] === '--verbose' || args[0] === 'get-url'
  if (readOnly) return allowRule('git:remote:read')
  return askRule('git-remote-write', `git remote ${args[0]} 会改写远端配置`, HIGH)
}

function stashRule(args: string[]): RuleVerdict {
  const readOnly = args[0] === 'list' || args[0] === 'show'
  if (readOnly) return allowRule('git:stash:read')
  return askRule('git-stash-write', 'git stash 除 list/show 外都会改写工作区', HIGH)
}

function tagRule(args: string[]): RuleVerdict {
  if (args.length === 0) return allowRule('git:tag:list')
  if (args[0] === '-l' || args[0] === '--list' || args[0] === '-n') return allowRule('git:tag:list')
  return askRule('git-tag-write', 'git tag 仅放行列举（-l/--list/-n）', HIGH)
}

function gitRule(args: string[], ctx: PolicyContext): RuleVerdict {
  const sub = args[0]
  if (!sub) return askRule('git:no-subcommand', '未指定 git 子命令，需人工审批')
  // 纯版本输出不拉起其它程序，保留放行。
  if (args.length === 1 && (sub === '--version' || sub === '-v')) return allowRule('git:meta')
  // help 形态会调用 man/browser/pager（`git help --web` 还会执行配置的 browser），一律 ask。
  // 覆盖裸 `git help` / `git --help` / `git -h` 以及 `git log --help` / `git diff -h`。
  if (
    sub === 'help' ||
    sub === '--help' ||
    sub === '-h' ||
    args.slice(1).includes('--help') ||
    args.slice(1).includes('-h')
  ) {
    return askRule('git-help', 'git help/--help 会调用 man 或 pager，可能执行外部程序', MEDIUM)
  }
  // `--no-pager` 只关闭分页，不执行任何外部程序；`-p/--paginate` 相反：强制调用 core.pager，
  // 而 core.pager 可来自仓库/用户配置。注意 `-p` 必须在子命令之前才是全局分页选项
  //（`git log -p` 是 patch，不影响）。
  if (sub === '--no-pager') return gitRule(args.slice(1), ctx)
  if (sub === '-p' || sub === '--paginate') {
    return askRule('git-paginate', 'git -p/--paginate 会强制调用 core.pager，可能执行外部程序', HIGH)
  }
  // git grep 的语义允许把命中文件交给外部 pager 执行（-O / --open-files-in-pager，
  // 且短选项可簇写为 -iOcat / -nOsh）。不做参数枚举，整条子命令移出只读白名单。
  if (sub === 'grep') {
    return askRule('git-grep', 'git grep 支持 -O/--open-files-in-pager 执行外部 pager，不纳入只读白名单', CRITICAL)
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    const subArgs = args.slice(1)
    // `--format/--pretty` 含 %G 时，git 会调用 gpg 验证签名（gpg 程序还可能是默认的
    // 外部程序）；命令行的格式无法由配置探针看到，单独在参数面拦截。
    if (GIT_GPG_PRETTY_SUBCOMMANDS.has(sub) && gitPrettyUsesGpg(subArgs)) {
      return askRule(
        'git-gpg-format',
        '--format/--pretty 含 %G 占位符会调用 gpg 验证签名，需人工审批',
        HIGH,
      )
    }
    // 仓库/用户配置可让 diff/log/show 执行 textconv/diff.command/external/filter，
    // 让 status 执行 fsmonitor/filter，让 log 调用 gpg；一次被批准的 Write 改写
    // .git/config 即可换取零审批执行，因此读配置后再决定。
    if (GIT_CONFIG_EXEC_SUBCOMMANDS.has(sub)) {
      if (gitConfigProbeDisabled()) {
        return askRule(
          'git-repo-config-exec',
          'git 配置探针被运行时开关（BIZGRAPH_GIT_CONFIG_PROBE=off）关闭，回退口径为一律 ask',
          HIGH,
        )
      }
      const probe = probeGitConfig(ctx.cwd, ctx.includeGlobalGitConfig)
      recordGitConfigProbe(probe)
      if (probe.failure) {
        return askRule(
          'git-repo-config-exec',
          `git 配置探针不可判定（${probe.failure}），按 fail-closed ask`,
          HIGH,
        )
      }
      if (probeGitConfigExecutes(probe, sub)) {
        return askRule(
          'git-repo-config-exec',
          '仓库或用户 git 配置含 textconv / diff.command / diff.external / filter / fsmonitor / hooksPath / alternateRefsCommand / gpg.program / showSignature，git 会执行外部程序',
          HIGH,
        )
      }
      // diff.submodule=diff 会递归对比子模块，并使用子模块自己的配置；主配置探针
      // 读不到 `.git/modules/*/config`，必须显式递归读取，读不到就 fail-closed。
      if (GIT_SUBMODULE_DIFF_SUBCOMMANDS.has(sub) && gitConfigRequestsSubmoduleDiff(probe)) {
        const modules = probeGitSubmoduleConfigs(ctx.cwd)
        if (modules.failure) {
          return askRule(
            'git-repo-config-exec',
            `diff.submodule=diff 且子模块配置不可判定（${modules.failure}），按 fail-closed ask`,
            HIGH,
          )
        }
        if (modules.results.some((moduleProbe) => probeGitConfigExecutes(moduleProbe, sub))) {
          return askRule(
            'git-repo-config-exec',
            'diff.submodule=diff 且子模块配置含 diff.external / textconv / filter / fsmonitor 等执行型键，git 会执行外部程序',
            HIGH,
          )
        }
      }
    }
    return allowRule(`git:${sub}`)
  }
  if (sub === 'branch') return branchRule(args.slice(1))
  if (sub === 'remote') return remoteRule(args.slice(1))
  if (sub === 'stash') return stashRule(args.slice(1))
  if (sub === 'tag') return tagRule(args.slice(1))
  if (GIT_WRITE_SUBCOMMANDS.has(sub)) {
    return askRule(`git-write-subcommand:${sub}`, `git ${sub} 是写子命令，只读白名单不放行`, HIGH)
  }
  // 未知子命令：不猜，交给人工审批。
  return askRule(`git:unknown:${sub}`, `git 子命令 ${sub} 不在只读白名单，需人工审批`)
}

/** 白名单条目：命令名 → 参数校验。 */
const WHITELIST: Record<string, RuleEvaluator> = {
  ls: simpleRule('ls'),
  pwd: simpleRule('pwd'),
  cat: simpleRule('cat'),
  head: simpleRule('head'),
  tail: simpleRule('tail'),
  wc: simpleRule('wc'),
  grep: simpleRule('grep'),
  rg: simpleRule('rg'),
  stat: simpleRule('stat'),
  file: simpleRule('file'),
  du: simpleRule('du'),
  df: simpleRule('df'),
  which: simpleRule('which'),
  whoami: simpleRule('whoami'),
  uname: simpleRule('uname'),
  date: simpleRule('date'),
  echo: simpleRule('echo'),
  find: simpleRule('find'),
  node: nodeRule,
  git: gitRule,
}

/**
 * 白名单命令清单从实际白名单派生：新增命令会自动进入覆盖测试，
 * 若忘记在 DANGEROUS_ARGS_BY_COMMAND 登记危险参数，测试会失败。
 */
export const WHITELIST_COMMANDS: string[] = Object.keys(WHITELIST)

/** 参数面判定：命中登记的危险参数即交给人工（allow 只属于「命令 + 参数」都干净的情况）。 */
function dangerousArgOf(
  command: string,
  args: string[],
  specs: readonly DangerousArgSpec[],
): { spec: DangerousArgSpec; arg: string } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const flagName = arg.split('=')[0]
    for (const spec of specs) {
      const matched =
        arg === spec.flag ||
        flagName === spec.flag ||
        isFlagInShortCluster(command, arg, spec.flag) ||
        isAbbreviatedLongFlag(flagName, spec.flag)
      if (!matched) continue
      // `git -c` 只有 `<name>=<value>` 形态才是配置覆盖；`git log -c` 的 -c 是
      // combined diff 子命令选项，不带等号就放回子命令规则判定。
      if (spec.requiresAssignment && !hasAssignmentValue(args, index, arg)) continue
      return { spec, arg }
    }
  }
  return null
}

/**
 * 选项是否携带 `<name>=<value>`：自身含 `=`（`-cname=value`）或紧邻的下一个
 * token 含 `=`（`-c name=value`）。git 的 `-c` 语义要求等号，缺少等号时
 * git 本身会报错，因此这里不会放走任何真实配置覆盖。
 */
function hasAssignmentValue(args: string[], index: number, arg: string): boolean {
  if (arg.includes('=')) return true
  const next = args[index + 1]
  return !!next && next.includes('=')
}

/**
 * 长选项唯一前缀缩写：GNU `getopt_long` 接受「无歧义前缀」，实测
 * `file --co -m test.magic` 等价 `--compile`（写出 7,273,344B magic.mgc）。
 * 因此精确比对不够，凡是危险长选项的前缀都按命中处理。
 *
 * 下限取「`--x`」（总长度 3）：
 * - 必须排除 `--`（长度恰为 2，是选项结束分隔符）；
 * - 再短没有意义；而两字母缩写 `--co` 已被实测接受，不能漏；
 * - 部分工具其实不支持缩写（实测 git diff/log、rg、find 都会拒绝），
 *   这里宁可多弹一次，也不按命令白名单逐个放宽（修一次漏一次）。
 * 大小写保持敏感：这些工具的长选项均大小写敏感，`--Comp` 不是 `--compile`。
 */
function isAbbreviatedLongFlag(flagName: string, specFlag: string): boolean {
  return (
    specFlag.startsWith('--') &&
    flagName.startsWith('--') &&
    flagName.length > 2 &&
    specFlag.startsWith(flagName)
  )
}

/**
 * 每个白名单命令里「短选项会吃掉紧随其后的字符作为取值」的字母集合。
 * 只用于解析单破折号短选项簇：遇到这些选项后，簇内剩余字符是它的值，
 * 不再当标志扫描（`file -mC` 的 C 是 magic 文件名；`rg -rnz` 的 nz 是替换串）。
 * 数据来源：各命令 `--help` 的实际短选项（file: -M/-m/-e/-f/-F/-P；rg: 见下；
 * git 全局: -C/-c，另加 git grep 的 -O（它会吃掉簇内剩余字符，git grep 本身已整条 ask）；
 * date: -d/-f/-I/-r/-s/-v）。
 */
const SHORT_OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  file: new Set(['M', 'm', 'e', 'f', 'F', 'P']),
  rg: new Set(['A', 'B', 'C', 'd', 'e', 'E', 'f', 'g', 'j', 'M', 'm', 'r', 't', 'T']),
  git: new Set(['C', 'c', 'O']),
  date: new Set(['d', 'f', 'I', 'r', 's', 'v']),
}

/**
 * 短选项簇内是否真的出现了危险标志字符。
 *
 * 算法：从 `arg[1]` 起逐个扫描字母；先比对目标标志字符（命中即真），
 * 再判断该字母是否为「需要取值」的选项——是则剩余字符全是它的取值，立即为假。
 * 这样 `file -bC` / `file -cC` / `rg -nz` / `rg -iz` 命中，
 * 而 `file -mC`（magic 文件名 C）/ `rg -eC`（pattern C）/ `rg -rnz`（替换串 nz）
 * 不会被误判成标志。`-c` 这类本身既危险又取值的选项，命中判定在取值判定之前。
 */
function isFlagInShortCluster(command: string, arg: string, flag: string): boolean {
  if (flag.length !== 2 || !flag.startsWith('-') || flag.startsWith('--')) return false
  if (!arg.startsWith('-') || arg.startsWith('--')) return false
  const valueFlags = SHORT_OPTIONS_WITH_VALUE[command]
  const wanted = flag[1]
  for (let index = 1; index < arg.length; index += 1) {
    const ch = arg[index]
    if (ch === wanted) return true
    if (valueFlags?.has(ch)) return false
  }
  return false
}

/**
 * 评估一条 Bash 命令。返回值映射到 Claude PreToolUse 的 permissionDecision：
 * allow → 免弹直接执行；ask → 强制回到我们的审批网关；blocked-empty → 不放行（无内容可批）。
 */
export function evaluateBashPolicy(
  rawCommand: unknown,
  options?: BashPolicyOptions,
): BashPolicyDecision {
  const command = typeof rawCommand === 'string' ? rawCommand.trim() : ''
  const ctx: PolicyContext = {
    cwd: options?.cwd ?? process.cwd(),
    includeGlobalGitConfig: options?.includeGlobalGitConfig ?? true,
  }

  if (!command) {
    return {
      decision: 'blocked-empty',
      rule: 'empty-command',
      reason: '空命令不放行：没有可审批的内容',
      command,
      risk: LOW,
    }
  }

  const lexed = lex(command)
  if (lexed.unparseable) {
    return {
      decision: 'ask',
      rule: 'unparseable',
      reason: '引号未闭合，无法解析；原样展示命令供人工判断',
      command,
      risk: HIGH,
    }
  }
  // 先于元字符判定：`curl ... | sh` 的具体风险比「有管道」更高。
  if (FETCH_AND_EXEC.test(command)) {
    return {
      decision: 'ask',
      rule: 'fetch-and-exec',
      reason: '下载内容直接交给解释器执行，需人工确认',
      command,
      risk: CRITICAL,
    }
  }
  if (lexed.substitution) {
    return {
      decision: 'ask',
      rule: 'shell-escape',
      reason: '含命令替换 $() 或反引号，实际执行内容在运行时才确定',
      command,
      risk: CRITICAL,
    }
  }
  if (lexed.metachars.length > 0) {
    const hit = lexed.metachars[0]
    return {
      decision: 'ask',
      rule: hit,
      reason: `含 shell 元字符（${lexed.metachars.join(', ')}），整条命令需一并审批`,
      command,
      risk: HIGH,
    }
  }

  const tokens = lexed.tokens
  if (tokens.length === 0) {
    return {
      decision: 'ask',
      rule: 'unparseable',
      reason: '无法解析出可执行命令，需人工确认',
      command,
      risk: HIGH,
    }
  }
  const head = tokens[0]

  // 逃逸命令出现在任何位置都需审批（如 `xargs rm`、`env rm`）。
  const escape = tokens.find((token) => SHELL_ESCAPE_COMMANDS.has(token))
  if (escape) {
    return {
      decision: 'ask',
      rule: `shell-escape:${escape}`,
      reason: `${escape} 可绕过白名单执行任意命令，需人工确认`,
      command,
      risk: CRITICAL,
    }
  }
  // 写类命令只检查命令位：元字符与逃逸命令已各自成规则，
  // 因此 `grep rm file` 这类把写类词当作参数的只读命令不会被误判。
  if (WRITE_COMMANDS.has(head)) {
    return {
      decision: 'ask',
      rule: `write-command:${head}`,
      reason: `${head} 是写类命令，需人工确认`,
      command,
      risk: writeCommandRisk(head, tokens.slice(1)),
    }
  }
  if (head === 'sed') {
    const inPlace = tokens.slice(1).find((arg) => arg === '--in-place' || arg.startsWith('--in-place=') || /^-i/.test(arg))
    if (inPlace) {
      return {
        decision: 'ask',
        rule: 'sed-in-place',
        reason: `sed ${inPlace} 会就地改写文件，需人工确认`,
        command,
        risk: HIGH,
      }
    }
  }

  const rule = WHITELIST[head]
  if (!rule) {
    return {
      decision: 'ask',
      rule: `not-in-whitelist:${head}`,
      reason: `${head} 不在只读白名单，需人工审批`,
      command,
      risk: MEDIUM,
    }
  }

  // 参数面：命令名只读 ≠ 参数只读。每个放行命令都必须登记危险参数，未登记一律 ask（fail-safe）。
  const specs = DANGEROUS_ARGS_BY_COMMAND[head]
  if (!specs) {
    return {
      decision: 'ask',
      rule: `unregistered-command:${head}`,
      reason: `${head} 缺少危险参数登记，无法确认参数安全，需人工审批`,
      command,
      risk: HIGH,
    }
  }
  const dangerous = dangerousArgOf(head, tokens.slice(1), specs)
  if (dangerous) {
    return {
      decision: 'ask',
      rule: dangerous.spec.rule,
      reason: dangerous.spec.reason,
      command,
      risk: dangerous.spec.risk ?? MEDIUM,
    }
  }

  // 策略看到的是 shell 展开前的字面量。凡是静态无法确定的展开形态，一律 ask：
  // 参数可能在运行时被拼成 `--compile` / `--pre=...` / `-delete` 等危险形态。
  const shellExpansion = shellExpansionVerdict(lexed)
  if (shellExpansion) {
    return {
      decision: 'ask',
      rule: shellExpansion.rule,
      reason: shellExpansion.reason,
      command,
      risk: shellExpansion.risk,
    }
  }

  const verdict = rule(tokens.slice(1), ctx)
  return { decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, command, risk: verdict.risk }
}

/** shell 展开/引号外构造的判定顺序：先信任度最低（运行时拼接）的形态。 */
function shellExpansionVerdict(
  lexed: Lexed,
): { rule: string; reason: string; risk: RiskLevel } | null {
  if (lexed.expansion) {
    return {
      rule: 'shell-expansion',
      reason: '含 $ 展开（$VAR / ${...} / $\'...\' 等），实际参数在运行时才确定',
      risk: HIGH,
    }
  }
  if (lexed.continuation) {
    return {
      rule: 'shell-continuation',
      reason: '含反斜杠续行，运行时会把多行拼接成一个参数',
      risk: HIGH,
    }
  }
  if (lexed.brace) {
    return {
      rule: 'shell-brace',
      reason: '含花括号（brace expansion / ${}），实际参数在运行时才确定',
      risk: HIGH,
    }
  }
  if (lexed.backslash) {
    return {
      rule: 'shell-backslash',
      reason: '反斜杠转义会改变参数语义（可拼出标志或制造分隔）',
      risk: HIGH,
    }
  }
  if (lexed.glob) {
    return {
      rule: 'shell-glob',
      reason: '含未加引号的 glob（* / ? / [），参数由目录内容决定',
      risk: HIGH,
    }
  }
  if (lexed.tilde) {
    return {
      rule: 'shell-tilde',
      reason: '含 ~ 展开，参数指向运行用户的家目录',
      risk: MEDIUM,
    }
  }
  return null
}

/**
 * 给审批网关/驱动用：只有 Bash 工具才评估策略；其他工具返回 undefined。
 * 与 evaluateBashPolicy 是同一套确定性规则，因此「卡片的规则」与「hook 的决定」必然一致。
 */
export function bashPolicyForTool(
  toolName: string,
  args: Record<string, unknown>,
  options?: BashPolicyOptions,
): BashPolicyDecision | undefined {
  if (toolName.trim().toLowerCase() !== 'bash') return undefined
  // cwd 必须是**会话/请求的工作目录**，不是主进程 process.cwd()：
  // 否则会话所在仓库的 .git/config 被读漏，配置驱动的执行会零审批放行。
  return evaluateBashPolicy(args.command, options)
}
