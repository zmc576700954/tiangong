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
  /** 引号未闭合等无法安全解析 */
  unparseable: boolean
}

/** `&&` / `||` 识别为两个字符的复合操作符，避免误判。 */
function lex(command: string): Lexed {
  const tokens: string[] = []
  const metachars: string[] = []
  let substitution = false
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
        current += command[i + 1]
        i += 2
        continue
      }
      // 双引号内命令替换/反引号仍然生效
      if (ch === '$' && command[i + 1] === '(') substitution = true
      if (ch === '`') substitution = true
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
      current += command[i + 1]
      i += 2
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      substitution = true
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
    return { tokens: [], metachars, substitution, unparseable: true }
  }
  flush()
  return { tokens, metachars, substitution, unparseable: false }
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

type RuleEvaluator = (args: string[]) => RuleVerdict

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

function gitRule(args: string[]): RuleVerdict {
  const sub = args[0]
  if (!sub) return askRule('git:no-subcommand', '未指定 git 子命令，需人工审批')
  // 只放行「单独出现」的元信息形态。`git help <cmd>` / `git --help <cmd>` 会调用
  // man/browser（`git help --web` 还会按仓库/用户配置执行 browser 命令），必须走审批。
  if (args.length === 1 && (sub === '--version' || sub === '-v' || sub === '--help' || sub === '-h' || sub === 'help')) {
    return allowRule('git:meta')
  }
  // `--no-pager` 只关闭分页，不执行任何外部程序；`-p/--paginate` 相反：强制调用 core.pager，
  // 而 core.pager 可来自仓库/用户配置。注意 `-p` 必须在子命令之前才是全局分页选项
  //（`git log -p` 是 patch，不影响）。
  if (sub === '--no-pager') return gitRule(args.slice(1))
  if (sub === '-p' || sub === '--paginate') {
    return askRule('git-paginate', 'git -p/--paginate 会强制调用 core.pager，可能执行外部程序', HIGH)
  }
  // git grep 的语义允许把命中文件交给外部 pager 执行（-O / --open-files-in-pager，
  // 且短选项可簇写为 -iOcat / -nOsh）。不做参数枚举，整条子命令移出只读白名单。
  if (sub === 'grep') {
    return askRule('git-grep', 'git grep 支持 -O/--open-files-in-pager 执行外部 pager，不纳入只读白名单', CRITICAL)
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) return allowRule(`git:${sub}`)
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
export function evaluateBashPolicy(rawCommand: unknown): BashPolicyDecision {
  const command = typeof rawCommand === 'string' ? rawCommand.trim() : ''

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

  const verdict = rule(tokens.slice(1))
  return { decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, command, risk: verdict.risk }
}

/**
 * 给审批网关/驱动用：只有 Bash 工具才评估策略；其他工具返回 undefined。
 * 与 evaluateBashPolicy 是同一套确定性规则，因此「卡片的规则」与「hook 的决定」必然一致。
 */
export function bashPolicyForTool(
  toolName: string,
  args: Record<string, unknown>,
): BashPolicyDecision | undefined {
  if (toolName.trim().toLowerCase() !== 'bash') return undefined
  return evaluateBashPolicy(args.command)
}
