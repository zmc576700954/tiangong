/**
 * §6.8.1 允许清单（allow-list）纪律清单 — G4-6 harness 的单一数据源。
 *
 * 纪律：每一条 allow 类命令都必须在此登记“决策实际读取的配置键”与守护断言；
 * 清单不是手写自由列表，而是由 `WHITELIST_COMMANDS` 派生后做**精确集合比对**，
 * 因此新增/删除白名单命令而不更新本文件会立即失败（防止清单自身腐化）。
 *
 * 注意：这里登记的是**审批决策（evaluateBashPolicy）实际读取**的配置键，
 * 不是命令运行时会碰到的全部文件（后者由各命令自身行为决定，与本纪律无关）。
 */

export interface AllowListEntry {
  /** 审批决策实际读取的配置键；空数组表示“纯参数解析，不读配置文件” */
  decisionConfigKeys: string[]
  /** 守护该条目的断言（必须能在 harness 内按标题检索到） */
  guardedBy: string
  /** 为什么这些配置键会影响 allow/ask 判定 */
  note: string
}

export const ALLOW_LIST_MANIFEST: Record<string, AllowListEntry> = {
  ls: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  pwd: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  cat: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验（危险参数另行登记）' },
  head: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  tail: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  wc: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  grep: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  rg: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: 'RIPGREP_CONFIG_PATH 由 rg 运行时读取，不参与审批决策' },
  stat: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  file: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  du: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  df: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  which: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  whoami: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  uname: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  date: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  echo: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  find: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '纯参数校验' },
  node: { decisionConfigKeys: [], guardedBy: '非 git 命令的决策不读配置', note: '策略只看参数；NODE_OPTIONS 不在决策面' },
  git: {
    decisionConfigKeys: [
      '.git/config',
      '~/.gitconfig',
      'core.fsmonitor',
      'core.hooksPath',
      'core.alternateRefsCommand',
      'diff.external',
      'gpg.program',
      'remote.*.uploadpack',
    ],
    guardedBy: 'git 决策读取 .git/config（fsmonitor 存在时收紧为 ask）',
    note: 'git 配置可触发外部程序，故决策必须读取仓库配置',
  },
}

/**
 * 计划中“允许类测试命令”清单。当前 §6.8.1 的测试命令网关（TestCommandGateway）
 * 尚未实施，这些命令一律走 ask；禁止在网关与配置键断言落地前擅自改成 allow。
 */
export const TEST_COMMAND_PREFIXES = [
  'npm test',
  'npm run test',
  'npx vitest',
  'pnpm test',
  'yarn test',
  'pytest',
  'go test',
  'cargo test',
  'jest',
  'mvn test',
  'gradle test',
] as const

/** 白名单命令数下限：防止 WHITELIST 与清单同时被“静默缩减” */
export const EXPECTED_ALLOW_COUNT = 20
