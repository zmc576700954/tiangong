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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
    { flag: '--ext-diff', rule: 'git-ext-diff', reason: 'git --ext-diff 会执行外部 diff 程序', risk: HIGH },
    { flag: '--textconv', rule: 'git-textconv', reason: 'git --textconv 会执行配置的转换程序', risk: HIGH },
    { flag: '--filters', rule: 'git-filters', reason: 'git --filters 会执行配置的 filter 程序', risk: HIGH },
    { flag: '--lost-found', rule: 'git-lost-found', reason: 'git fsck --lost-found 会写 .git/lost-found', risk: HIGH },
    { flag: '--show-signature', rule: 'git-show-signature', reason: 'git log/show --show-signature 会拉起 gpg 验证签名', risk: HIGH },
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
 * `filter.*.clean|smudge|process`（status/diff）、`core.fsmonitor`（status 必调用，
 * diff/blame 与 index 刷新状态相关）与 `log.showSignature`（log/show/whatchanged 自动
 * 调用 gpg）。配置命中即 ask。
 */
const GIT_CONFIG_EXEC_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'whatchanged',
])

/**
 * 节名可能写成 `[diff]`、`[diff "evil"]`（现代式子节）或 `[diff.evil]`
 * （旧式子节，`git config --get diff.evil.textconv` 认可）。因此不能只取空格前的整串，
 * 必须按 `name` 后跟 `.` / 空白 / 结束 的前缀判定（`/^diff(\.|\s|$)/`）。
 */
function gitConfigSectionIs(section: string, name: string): boolean {
  return new RegExp(`^${name}(?:\\.|\\s|$)`).test(section)
}

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

/** git 配置值里的行内注释：`#`/`;` 只有在行首或前有空白时才是注释。 */
function stripGitConfigComment(value: string): string {
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '#' || ch === ';') && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim()
    }
  }
  return value.trim()
}

interface GitConfigEntry {
  /** 小写节名；现代式子节形如 `diff "evil"`，旧式子节形如 `diff.evil`。 */
  section: string
  /** 小写键名。 */
  key: string
  /** 值；裸键归一为 `true`，显式空值保留空串。 */
  value: string
  /** 该行只有键名、没有 `=`：Git 语义等价 `true`。 */
  bare: boolean
}

/**
 * 把 git 配置文本解析为规范化条目，供探测与 include 复用。
 *
 * 归一化规则（与 git config 实际解析器对齐）：
 * - 节头：`[name]`、`[name "sub"]`、`[name.sub]`；节名/键名大小写不敏感（统一小写），
 *   子节内容原样保留（Git 子节本身大小写敏感，但本探针只按节名前缀判定）。
 * - 节头允许尾随注释（`[diff "evil"] # note`），也允许同一行直接跟键值（`[t] x = 1`）。
 * - 行首缩进（空格 / `\t`）忽略；整行 `#` / `;` 注释忽略。
 * - `key = value` 取值；`key`（裸键）等价 `true`；`key =`（显式空值）保留空串
 *   （Git 对布尔判 false、对字符串判空，等价未设置）。
 * - 值内 `#` / `;` 只有「前有空白且不在双引号内」才是行内注释。
 * - 裸键后跟注释（`key # note`）在 Git 里是 fatal 解析错误，标记为不可解析。
 * - 键名只含字母/数字/连字符：Git 不接受带点或下划线的键名（`a.b=1`、`a_b=1` 均 fatal）。
 * - 行尾未转义反斜杠（Git 的续行语法）与无法归一的杂行一律标记为不可解析，由调用方 fail-closed。
 */
const GIT_CONFIG_SECTION_HEADER = /^\[\s*([^\s\]]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/
const GIT_CONFIG_KEY_VALUE = /^([A-Za-z0-9-]+)(?:\s*=\s*(.*))?$/

interface ParsedGitConfig {
  entries: GitConfigEntry[]
  /** 存在 Git 会 fatal 的无法解析行：策略按「不可判定」处理，不允许静默丢弃。 */
  invalid: boolean
}

/** Git 用行尾反斜杠续行；未建模的续行与 EOF 裸尾随反斜杠都按不可解析处理。 */
function gitConfigHasContinuation(value: string): boolean {
  let trailing = 0
  for (let i = value.length - 1; i >= 0 && value[i] === '\\'; i -= 1) trailing += 1
  return trailing % 2 === 1
}

function parseGitConfigEntries(text: string): ParsedGitConfig {
  const entries: GitConfigEntry[] = []
  let invalid = false
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = GIT_CONFIG_SECTION_HEADER.exec(line)
    if (sectionMatch) {
      const name = sectionMatch[1].toLowerCase()
      const subsection = sectionMatch[2]
      section = subsection === undefined ? name : `${name} "${subsection}"`
      line = sectionMatch[3].trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
    } else if (line.startsWith('[')) {
      invalid = true // 节头缺 `]` / 子节引号未闭合等，Git fatal
      continue
    }
    const kv = GIT_CONFIG_KEY_VALUE.exec(line)
    if (!kv) {
      invalid = true // 如 `"key" = v`、`a.b = 1`、裸键 + 注释
      continue
    }
    const bare = kv[2] === undefined
    const value = bare ? '' : kv[2]
    if (!bare && gitConfigHasContinuation(value.trim())) {
      invalid = true // 续行语义未建模；EOF 裸尾随反斜杠 Git fatal
      continue
    }
    entries.push({
      section,
      key: kv[1].toLowerCase(),
      value: bare ? 'true' : stripGitConfigComment(value),
      bare,
    })
  }
  return { entries, invalid }
}

/** 单个 git 配置文件文本里是否登记了会执行外部程序的值。 */
function gitConfigTextExecutes(text: string, sub: string, source: 'repo' | 'global'): boolean {
  const { entries, invalid } = parseGitConfigEntries(text)
  // 无法解析 = 不可判定：Git 自己会 fatal，但策略不能把「没看到危险配置」当成安全。
  if (invalid) return true
  for (const { section, key, value } of entries) {
    // 显式空值（`key =`）等价未设置：Git 对布尔返回 false，对字符串为空。
    if (value === '') continue
    // `diff.<driver>.command` 与 `diff.external` / `textconv` 一样会执行外部程序。
    if (gitConfigSectionIs(section, 'diff') && (key === 'textconv' || key === 'external' || key === 'command')) {
      return true
    }
    // fsmonitor：status 必调用；diff/blame 与 index 刷新状态相关（refresh index 时才调用）；
    // log/show 不刷新 index，不判。裸键 `fsmonitor` 归一为 `true`，与 `= true` 等价。
    if (
      gitConfigSectionIs(section, 'core') &&
      key === 'fsmonitor' &&
      gitConfigBoolean(value) &&
      (sub === 'status' || sub === 'diff' || sub === 'blame')
    ) {
      return true
    }
    // filter.<driver>.clean/smudge/process：status/diff 读取工作区时会调用外部过滤器。
    // 仓库本地配置维持三项全 ask（可在一次被批准的 Write 后改写，是 B2 的直接威胁面）；
    // 全局配置常见于 `git lfs install`，只放行 git-lfs 的标准写法，自定义值一律 ask
    // ——否则「打开不可信仓库 + .gitattributes 指向全局自定义 filter」即可零审批执行。
    if (
      (sub === 'status' || sub === 'diff') &&
      gitConfigSectionIs(section, 'filter') &&
      (key === 'clean' || key === 'smudge' || key === 'process')
    ) {
      if (source === 'repo') return true
      if (!isStandardLfsFilterValue(key, value)) return true
    }
    // log.showSignature=true 让 log/show/whatchanged 自动调用 gpg（gpg.program 可指向任意程序）。
    if (
      gitConfigSectionIs(section, 'log') &&
      key === 'showsignature' &&
      gitConfigBoolean(value) &&
      (sub === 'log' || sub === 'show' || sub === 'whatchanged')
    ) {
      return true
    }
  }
  return false
}

/** Git 的 `MAX_INCLUDE_DEPTH = 10`：根配置为 0，第 10 层 include 仍可用，第 11 层 fatal。 */
const MAX_GIT_CONFIG_INCLUDE_DEPTH = 10

interface GitConfigScan {
  files: string[]
  /** include 深度超限或存在环：Git 本身会 fatal，策略按不可判定处理，必须 ask。 */
  undecidable: boolean
}

/** 配置文件自身 + 递归 follows `include.path` / `includeIf.path`（条件不复判，按可能命中处理）。 */
function gitConfigPaths(file: string, depth = 0, chain: string[] = []): GitConfigScan {
  // 超限不再返回空（那等价“没发现危险配置”的 fail-open），而是标记不可判定。
  if (depth > MAX_GIT_CONFIG_INCLUDE_DEPTH) return { files: [], undecidable: true }
  // include 成环在 Git 里同样会一路递归到深度上限后 fatal。
  if (chain.includes(file)) return { files: [], undecidable: true }
  const scan: GitConfigScan = { files: [file], undecidable: false }
  if (!existsSync(file)) return scan
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return scan
  }
  for (const entry of parseGitConfigEntries(text).entries) {
    if (!(gitConfigSectionIs(entry.section, 'include') || gitConfigSectionIs(entry.section, 'includeif'))) {
      continue
    }
    if (entry.key !== 'path' || entry.bare) continue // 裸 `path` 在 Git 里是 missing value，不是合法 include
    let includePath = entry.value.replace(/^"|"$/g, '')
    if (!includePath) continue
    if (includePath.startsWith('~/')) includePath = join(homedir(), includePath.slice(2))
    else if (!isAbsolute(includePath)) includePath = resolve(dirname(file), includePath)
    const nested = gitConfigPaths(includePath, depth + 1, [...chain, file])
    scan.files.push(...nested.files)
    if (nested.undecidable) scan.undecidable = true
  }
  return scan
}

/** 任一配置文件登记了执行型配置即危险；文件存在但不可读按危险处理（fail-closed）。 */
function gitConfigFilesExecute(files: string[], sub: string, source: 'repo' | 'global'): boolean {
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      if (gitConfigTextExecutes(readFileSync(file, 'utf8'), sub, source)) return true
    } catch {
      return true
    }
  }
  return false
}

/** 从 cwd 向上找 `.git`（支持 worktree 的 gitdir 文件）。 */
function findGitDir(root: string): string | null {
  let dir = resolve(root)
  for (let depth = 0; depth < 30; depth += 1) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      try {
        if (!statSync(dotGit).isFile()) return dotGit
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
        if (!match) return null
        const gitDir = match[1].trim()
        return isAbsolute(gitDir) ? gitDir : resolve(dir, gitDir)
      } catch {
        return null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 是否开启 `extensions.worktreeConfig`。Git 只有在该扩展开启时才读 config.worktree；
 * 未开启仍去读会造成无谓 ask。文件不可读或含无法解析行按「可能开启」处理（fail-closed）。
 */
function gitConfigEnablesWorktreeConfig(files: string[]): boolean {
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const { entries, invalid } = parseGitConfigEntries(readFileSync(file, 'utf8'))
      if (invalid) return true
      for (const entry of entries) {
        if (
          gitConfigSectionIs(entry.section, 'extensions') &&
          entry.key === 'worktreeconfig' &&
          gitConfigBoolean(entry.value)
        ) {
          return true
        }
      }
    } catch {
      return true
    }
  }
  return false
}

/** 仓库配置（worktree 走 commondir + 按扩展开关读取 config.worktree）+ 递归 include。 */
function repoGitConfigFiles(gitDir: string): GitConfigScan {
  const scan = gitConfigPaths(join(gitDir, 'config'))
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (common) {
      const commonDir = isAbsolute(common) ? common : resolve(gitDir, common)
      const commonScan = gitConfigPaths(join(commonDir, 'config'))
      scan.files.push(...commonScan.files)
      if (commonScan.undecidable) scan.undecidable = true
    }
  } catch {
    // 非 worktree，没有 commondir
  }
  // extensions.worktreeConfig 开启后，per-worktree 配置才在 config.worktree；
  // core.fsmonitor 可按 worktree 设置，漏读该文件会放过配置驱动的执行。
  if (gitConfigEnablesWorktreeConfig(scan.files)) {
    const worktreeScan = gitConfigPaths(join(gitDir, 'config.worktree'))
    scan.files.push(...worktreeScan.files)
    if (worktreeScan.undecidable) scan.undecidable = true
  }
  return scan
}

/**
 * 用户/系统配置每次现读，不做进程内缓存：
 * 缓存会让「先判干净 allow、随后配置被改写」在同一进程内永远看不见，
 * 而单次读取实测约 0.05 ms，对交互路径无感。用 mtime+size 失效又会受
 * 文件系统时间戳精度与同尺寸改写的竞态影响，直接去缓存更简单且正确。
 */
function globalGitConfigExecutes(sub: string): boolean {
  const candidates = [
    process.env.GIT_CONFIG_GLOBAL,
    join(homedir(), '.gitconfig'),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git', 'config'),
    process.env.GIT_CONFIG_SYSTEM,
    '/etc/gitconfig',
  ].filter((value): value is string => Boolean(value))
  return candidates.some((file) => {
    const scan = gitConfigPaths(file)
    return scan.undecidable || gitConfigFilesExecute(scan.files, sub, 'global')
  })
}

function gitRepoConfigExecutes(root: string, includeGlobal: boolean, sub: string): boolean {
  if (includeGlobal && globalGitConfigExecutes(sub)) return true
  const gitDir = findGitDir(root)
  if (!gitDir) return false
  const scan = repoGitConfigFiles(gitDir)
  // include 深度超限/成环 → 不可判定，必须 ask，不能因为“没扫到危险配置”而放行。
  if (scan.undecidable) return true
  return gitConfigFilesExecute(scan.files, sub, 'repo')
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
  const readOnly = args[0] === '-v' || args[0] === '--verbose' || args[0] === 'show' || args[0] === 'get-url'
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
    // 仓库/用户配置可让 diff/log/show 执行 textconv/diff.command/external/filter，
    // 让 status 执行 fsmonitor/filter，让 log 调用 gpg；一次被批准的 Write 改写
    // .git/config 即可换取零审批执行，因此读配置后再决定。
    if (
      GIT_CONFIG_EXEC_SUBCOMMANDS.has(sub) &&
      gitRepoConfigExecutes(ctx.cwd, ctx.includeGlobalGitConfig, sub)
    ) {
      return askRule(
        'git-repo-config-exec',
        '仓库或用户 git 配置含 textconv / diff.command / diff.external / filter / fsmonitor / showSignature，git 会执行外部程序',
        HIGH,
      )
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
