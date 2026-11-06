/**
 * D5：进程回收与残留扫描（第二轮复核后重写，权威口径 agent-architecture.md §6.5）。
 *
 * 回收承诺分三层：
 * a) 同进程内：只按本轮**真实登记**的句柄回收（SIGTERM → 500ms → SIGKILL）；
 *    异常退出路径回收本轮已登记句柄；正常完成只 forget，不做启发式扫描。
 * b) 跨重启：只回收**可证明归属**的残留。至少两项不同证据成立、且至少一项是
 *    内容证据（完整命令行精确匹配 / 实时命令行含本应用专属标记）才允许 kill：
 *    `startedAt`（POSIX lstart 原始字符串；Linux 另需 /proc ticks 匹配）、
 *    `command`（完整命令行，绝不退化为 basename）、`marker`（可见且不与 command 重复）。
 *    证据不足 → 只告警不杀，由调用方写 `residual_risk='unconfirmed'` + `recovery_note`。
 * c) **禁止按裸持久化 pid/pgid 直接 kill**：`killRegistered` 只接受带证据的
 *    `ProcIdentity`，不提供 `number[]` 入口；pgid 本身不作为 kill 依据。
 *
 * d) **自有进程组回收（D5 修复）**：SDK 路径由我们以 `detached: true` spawn
 *    （Claude 走 `spawnClaudeCodeProcess`，Codex 走受控 shim），因此登记的身份
 *    满足「pgid === pid === 实时 pgid」，即我们自己创建的进程组组长。此时先做
 *    归属证明（≥2 项证据），证明通过后按 `kill(-pgid)` 回收整组；否则退回进程树
 *    回收。**证明在上、整组在后**，顺序不可颠倒。
 *
 * env marker 的现实：macOS `ps -axo command` 不含环境变量，`BIZGRAPH_TURN_ID`
 * 只用于同进程轮次关联、日志与排障，**不能作为跨重启认领凭证**。
 * Codex 的跨重启凭证来自进程自注册文件（pid/pgid/startedAt/command），不是 env。
 * `residualCount` / `scanResidual` 仅用于诊断与验收计数，不参与任何 kill 决策。
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { getRegistrySecret } from '../../../shared/process-supervisor'

export interface ProcInfo {
  pid: number
  ppid: number
  pgid: number
  /** `ps -o stat=`：Z（僵尸）不算残留进程 */
  state: string
  /** `ps -o lstart=` 归一化后的启动时间（如 `Nov 4 11:56:10 2026`） */
  startedAt: string
  command: string
}

/** 进程归属证据。缺省的字段表示「没有登记该维度」，不能用来证明归属。 */
export interface ProcIdentity {
  pid: number
  pgid?: number
  /** 登记时的完整命令行（用于与实时 `ps` 比对） */
  command?: string
  /** 登记时的启动时间（`ps -o lstart=` 原始字符串精确比较） */
  startedAt?: string
  /**
   * 高精度启动标识。Linux 为 `/proc/<pid>/stat` 的 starttime ticks；
   * macOS/Windows 无公开等价来源时为 undefined（此时 `startedAt` 不允许单独凑项）。
   */
  startedAtHiRes?: string
  /**
   * 身份完整性签名（安装级 HMAC）。由 `registerProcess` / Runtime 从可信来源
   * （内存登记、DB 行、验签通过的自注册记录）铸造。
   * - 有签名且验签通过 → 可信；
   * - 有签名但验签失败 → 一律拒绝（防篡改）；
   * - 无签名（外部/旧格式）→ 仅当目标已被孤儿化（`ppid === 1`）才允许，
   *   避免「写一份伪造 JSON 就能杀任意可观测进程」（C12）。
   */
  attestation?: string
}

type ProcIdentityFields = Pick<
  ProcIdentity,
  'pid' | 'pgid' | 'startedAt' | 'startedAtHiRes' | 'command'
>

function canonicalIdentity(fields: ProcIdentityFields): string {
  return [
    'bizgraph-proc-identity-v1',
    fields.pid,
    fields.pgid ?? '',
    fields.startedAt ?? '',
    fields.startedAtHiRes ?? '',
    fields.command ?? '',
  ].join('\n')
}

/** 为可信身份铸造签名（安装级密钥，0600）。 */
export function attestProcIdentity(
  fields: ProcIdentityFields,
  secret = getRegistrySecret(),
): string {
  return crypto.createHmac('sha256', secret).update(canonicalIdentity(fields)).digest('hex')
}

function verifyIdentity(
  identity: ProcIdentity,
  secret: string,
): 'trusted' | 'tampered' | 'unsigned' {
  if (identity.attestation === undefined) return 'unsigned'
  const expected = attestProcIdentity(identity, secret)
  if (expected.length !== identity.attestation.length) return 'tampered'
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(identity.attestation, 'hex'),
    )
      ? 'trusted'
      : 'tampered'
  } catch {
    return 'tampered'
  }
}

/**
 * 归属证据（每一项最多计一次）：
 * - `startedAt`：进程启动时间。POSIX 用 `ps -o lstart=` 的**原始字符串精确比较**；
 *   Linux 额外用 `/proc/<pid>/stat` 的 starttime ticks 做高精度校验（存在则必须匹配）。
 *   Windows 没有等价高精度来源 → `startedAt` **不计入**证据。
 * - `command`：**完整命令行**规范化空白后的精确相等（绝不退化为 basename 比较）。
 * - `marker`：轮次 marker 出现在**实时命令行**中，且**不在登记命令**里
 *   （否则就是 `command` 这一项的重复计数，不再单独计）。
 *
 * 计项规则：至少 2 项不同证据，且其中至少 1 项是「内容证据」（command / marker）。
 * 这条保证「同秒启动 + 同可执行名」永远无法凑够证据（C4b）。
 * `groupLeader` 不是证据，只用于证明通过后选择「整组回收 vs 进程树回收」的范围。
 */
export type OwnershipSignal = 'startedAt' | 'command' | 'marker'
const CONTENT_SIGNALS: ReadonlySet<OwnershipSignal> = new Set(['command', 'marker'])

export interface OwnershipProof {
  pid: number
  proved: boolean
  matched: OwnershipSignal[]
  reason: 'verified' | 'not-found' | 'insufficient-proof' | 'unsafe-pid'
}

export interface ReapReport {
  discovered: number
  killed: number
  killedPids: number[]
  /** 按自有进程组整组回收的 pgid（仅归属证明通过后才会出现） */
  killedGroups: number[]
  /** 仍存活、但证据不足无法回收的候选 */
  unresolved: OwnershipProof[]
  /** 候选 pid 已不存在（无需回收） */
  missing: number[]
  /** 已回收但 SIGKILL 后仍存活（residual_risk=possible） */
  stillAlive: number[]
  /** 审计用：每个实际处理的 pid 命中的归属证据项（不含命令行内容） */
  evidence: Array<{ pid: number; matched: OwnershipSignal[] }>
}

interface TurnProcessState {
  registered: Map<number, ProcIdentity>
  marker?: string
}

/** 归属证明所需的最少独立证据数（§6.5 b）。 */
const MIN_OWNERSHIP_SIGNALS = 2

export function listProcesses(): ProcInfo[] {
  let output = ''
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      // 强制英文月份/星期，避免本地化后 lstart 无法解析
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
  } catch {
    return []
  }
  const result: ProcInfo[] = []
  for (const line of output.split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3})\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.*)$/.exec(line)
    if (!match) continue
    result.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4],
      startedAt: `${match[6]} ${match[7]} ${match[8]} ${match[9]}`,
      command: match[10],
    })
  }
  return result
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/**
 * 只做**完整命令行**的精确比较（允许规范化空白）。
 * 已删除「退化为可执行文件名」的旧退路：那会让「同可执行名 + 同秒启动」凑成
 * 2 项证据并误杀无关进程（C4b 实测）。
 */
function commandMatches(expected: string, current: string): boolean {
  return normalizeCommand(expected) === normalizeCommand(current)
}

/**
 * Linux 高精度启动标识：`/proc/<pid>/stat` 第 22 字段 starttime（自 boot 的 ticks）。
 * macOS 无公开等价 API（`ps -o lstart` 只有秒级），Windows 未实现 → 返回 undefined。
 */
function captureHiResStart(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const rparen = raw.lastIndexOf(')')
    if (rparen < 0) return undefined
    // 跳过 pid 与 comm 后，state 是第 3 字段；starttime 是第 22 字段 → 下标 19
    const starttime = raw.slice(rparen + 2).trim().split(/\s+/)[19]
    return starttime ? `linux-starttime:${starttime}` : undefined
  } catch {
    return undefined
  }
}

function startedAtEvidence(
  expected: ProcIdentity,
  current: ProcInfo,
  currentHiRes: string | undefined,
): boolean {
  // Windows 没有可信的高精度来源：明确不计入，避免用弱时间证据凑项
  if (process.platform === 'win32') return false
  if (expected.startedAtHiRes) {
    // 有高精度标识时必须用它，秒级 lstart 不再兜底
    return currentHiRes !== undefined && expected.startedAtHiRes === currentHiRes
  }
  // POSIX 原始 lstart 字符串精确比较（不解析、不做秒级重排）
  return Boolean(expected.startedAt && current.startedAt && expected.startedAt === current.startedAt)
}

/**
 * 归属证明：至少 2 项**不同**证据，且至少 1 项为内容证据（command / marker）。
 * `marker` 只可能出现在命令行里才可见（macOS 的 `ps` 读不到 env）。
 * 这个「内容证据必选」规则让「PID 复用 + 同秒启动 + 同可执行名」永远无法成立。
 */
export function proveOwnership(
  expected: ProcIdentity,
  current: ProcInfo | undefined,
  marker?: string,
  currentHiRes?: string,
): OwnershipProof {
  if (!current) return { pid: expected.pid, proved: false, matched: [], reason: 'not-found' }
  const matched: OwnershipSignal[] = []
  if (startedAtEvidence(expected, current, currentHiRes)) matched.push('startedAt')
  if (expected.command && commandMatches(expected.command, current.command)) matched.push('command')
  // marker 若已包含在登记命令里，等价于 command 项，避免同一证据重复计数
  if (
    marker &&
    current.command.includes(marker) &&
    !(expected.command && expected.command.includes(marker))
  ) {
    matched.push('marker')
  }
  const hasContent = matched.some((signal) => CONTENT_SIGNALS.has(signal))
  const proved = matched.length >= MIN_OWNERSHIP_SIGNALS && hasContent
  return {
    pid: expected.pid,
    proved,
    matched,
    reason: proved ? 'verified' : 'insufficient-proof',
  }
}

export class ProcessReaper {
  private readonly states = new Map<string, TurnProcessState>()

  constructor(private readonly list: () => ProcInfo[] = listProcesses) {}

  /**
   * 登记本轮真实 spawn 的进程句柄，并尽可能立刻抓取启动时间与命令行。
   * 返回的 `ProcIdentity` 供 Runtime 落库（executor_started_at / executor_cmd）。
   */
  registerProcess(
    turnId: string,
    proc: {
      pid?: number
      pgid?: number
      envMarker?: string
      command?: string
      startedAt?: string
      startedAtHiRes?: string
    },
  ): ProcIdentity | undefined {
    const state = this.stateFor(turnId)
    if (proc.envMarker) state.marker = proc.envMarker
    if (!proc.pid || proc.pid <= 1 || proc.pid === process.pid) return undefined

    const observed = this.identify(proc.pid)
    const identity: ProcIdentity = {
      pid: proc.pid,
      pgid: observed?.pgid ?? proc.pgid,
      command: observed?.command ?? proc.command,
      startedAt: observed?.startedAt ?? proc.startedAt,
      startedAtHiRes: captureHiResStart(proc.pid) ?? proc.startedAtHiRes,
    }
    // 内存登记是可信来源：立即铸造签名，跨实例/跨重启仍可验签。
    identity.attestation = attestProcIdentity(identity)
    state.registered.set(proc.pid, identity)
    return identity
  }

  /** 正常结束时清理内存登记，避免长进程状态泄漏（不杀进程）。 */
  forget(turnId: string): void {
    this.states.delete(turnId)
  }

  /**
   * 取消轮次：只回收本轮登记过、且归属可证明的进程树。
   * 证据不足 → 不杀，放进 `unresolved`，由调用方写 residual_risk。
   */
  reap(turnId: string, extra: ProcIdentity[] = []): ReapReport {
    const state = this.states.get(turnId)
    const expected = [...(state?.registered.values() ?? [])]
    // Codex 的 PID 来自进程自注册文件；取消路径可能早于内存登记，允许调用方补入。
    for (const identity of extra) {
      if (!expected.some((item) => item.pid === identity.pid)) expected.push(identity)
    }
    this.states.delete(turnId)
    return this.reclaim(expected, state?.marker)
  }

  /**
   * 跨重启回收：调用方必须传入持久化的完整身份（pid + started_at + cmd）。
   * 只有至少两项证据成立才 kill；裸 pid（无 command/startedAt）永远不足以回收。
   */
  killRegistered(expected: ProcIdentity[], options: { marker?: string } = {}): ReapReport {
    return this.reclaim(expected, options.marker)
  }

  /** 诊断计数：命令行含 marker 的进程数。不参与 kill 决策。 */
  residualCount(marker: string): number {
    if (!marker) return 0
    return this.list().filter((proc) => proc.pid !== process.pid && proc.command.includes(marker)).length
  }

  /** 诊断扫描：命令行含 marker 的进程。macOS 上 env marker 不可见，故不用于跨重启认领。 */
  scanResidual(marker: string): ProcInfo[] {
    if (!marker) return []
    return this.list().filter((proc) => proc.pid !== process.pid && proc.command.includes(marker))
  }

  private reclaim(expected: ProcIdentity[], marker?: string): ReapReport {
    const all = this.list()
    const killedPids: number[] = []
    const killedGroups: number[] = []
    const unresolved: OwnershipProof[] = []
    const missing: number[] = []
    const evidence: Array<{ pid: number; matched: OwnershipSignal[] }> = []

    let secret = ''
    let secretUsable = false
    try {
      secret = getRegistrySecret()
      secretUsable = true
    } catch {
      // 密钥不可用（文件被篡改/权限过宽）→ 所有无签名身份都只走孤儿兜底
      secretUsable = false
    }

    for (const identity of expected) {
      if (!identity.pid || identity.pid <= 1 || identity.pid === process.pid) {
        unresolved.push({ pid: identity.pid, proved: false, matched: [], reason: 'unsafe-pid' })
        continue
      }
      const current = all.find((proc) => proc.pid === identity.pid)
      const currentHiRes = current ? captureHiResStart(identity.pid) : undefined
      const proof = proveOwnership(identity, current, marker, currentHiRes)
      if (proof.reason === 'not-found') {
        missing.push(identity.pid)
        continue
      }

      // 信任门（C12）：身份必须来自可信铸造（内存登记 / DB / 验签通过的注册记录）。
      // - 签名错误 → 拒绝（可能是伪造或字段被篡改）；
      // - 无签名 → 仅当目标已孤儿化（父进程已死）才允许。伪造记录通常瞄准
      //   仍被宿主持有的进程（ppid 存活），因此会被这一条挡下。
      const trust = secretUsable ? verifyIdentity(identity, secret) : 'unsigned'
      const orphaned = current !== undefined && current.ppid === 1

      // 可信身份的「结构性绑定」：pgid === pid 且实时仍是同一组长。
      // CLI 可能 exec 换镜像导致 `ps` 命令行变化（如 Codex 变为 `(node)`），
      // 此时精确 command 证据会失效；签名身份只保证**跨用户不可伪造、不可重放**
      // （同 uid 攻击者可读取安装级密钥并铸造合法签名，属同 uid 威胁模型内），
      // 因此再用 pid + 精确 startedAt + 自有组长三者绑定同一进程实例。
      // 该放宽**只对验签通过的身份生效**；无签名/伪造记录仍必须两项内容证据。
      const ownGroupLeader =
        identity.pgid !== undefined &&
        identity.pgid === identity.pid &&
        current !== undefined &&
        current.pgid === identity.pid
      const structurallyBound = trust === 'trusted' && proof.matched.includes('startedAt') && ownGroupLeader

      if (!proof.proved && !structurallyBound) {
        unresolved.push(proof)
        continue
      }
      if (trust === 'tampered' || (trust === 'unsigned' && !orphaned)) {
        unresolved.push({ ...proof, proved: false, reason: 'insufficient-proof' })
        continue
      }

      // D5：只有「证明通过 + 实时 pgid 仍等于登记的组长 pid」才整组回收。
      // 任何一项不满足都退回进程树回收，避免把第三方进程组一起带走。
      const handled = ownGroupLeader
        ? this.terminateGroup(identity.pid, killedGroups)
        : this.terminateTree(identity.pid, killedPids)
      evidence.push({ pid: identity.pid, matched: proof.matched })
      if (handled) {
        if (!killedPids.includes(identity.pid)) killedPids.push(identity.pid)
      } else if (!this.list().some((proc) => proc.pid === identity.pid)) {
        // 证明通过后在回收窗口内自行退出：如实记 missing，不伪造「未命中」。
        missing.push(identity.pid)
      } else {
        unresolved.push({ ...proof, proved: false })
      }
    }

    const uniqueKilled = [...new Set(killedPids)]
    const uniqueGroups = [...new Set(killedGroups)]
    // 僵尸进程（state=Z）已经退出，不属于残留；只有仍在运行的 pid/组成员才算 possible
    const after = this.list()
    return {
      discovered: expected.length,
      killed: uniqueKilled.length,
      killedPids: uniqueKilled,
      killedGroups: uniqueGroups,
      unresolved,
      missing,
      evidence,
      stillAlive: uniqueKilled.filter((pid) => {
        const proc = after.find((item) => item.pid === pid)
        if (proc && !proc.state.startsWith('Z')) return true
        return uniqueGroups.includes(pid) && after.some((item) => item.pgid === pid && !item.state.startsWith('Z'))
      }),
    }
  }

  /** 抓取进程实时身份；spawn 后短暂重试，避免 ps 尚未刷新导致证据缺失。 */
  private identify(pid: number): ProcInfo | undefined {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const found = this.list().find((proc) => proc.pid === pid)
      if (found) return found
      sleepSync(20)
    }
    return undefined
  }

  private stateFor(turnId: string): TurnProcessState {
    let state = this.states.get(turnId)
    if (!state) {
      state = { registered: new Map() }
      this.states.set(turnId, state)
    }
    return state
  }

  /** 杀掉 pid 及其全部后代（叶子优先），不会误伤主进程或其祖先。 */
  private terminateTree(rootPid: number, killed: number[]): boolean {
    if (rootPid <= 1 || rootPid === process.pid) return false
    const all = this.list()
    if (this.isAncestorOfSelf(rootPid, all)) return false
    if (!all.some((proc) => proc.pid === rootPid)) return false

    const children = new Map<number, number[]>()
    for (const proc of all) {
      const list = children.get(proc.ppid) ?? []
      list.push(proc.pid)
      children.set(proc.ppid, list)
    }
    const order: number[] = []
    const walk = (pid: number): void => {
      for (const child of children.get(pid) ?? []) walk(child)
      order.push(pid)
    }
    walk(rootPid)

    for (const pid of order) {
      if (pid === process.pid) continue
      if (this.terminatePid(pid)) killed.push(pid)
    }
    return true
  }

  /**
   * 按自有进程组回收：只允许回收我们自己创建的组（pgid === 组长 pid）。
   * 拒绝回收自身所在进程组；Windows 用 `taskkill /T` 做等价树杀。
   */
  private terminateGroup(leaderPid: number, killedGroups: number[]): boolean {
    if (leaderPid <= 1 || leaderPid === process.pid) return false
    const all = this.list()
    const self = all.find((proc) => proc.pid === process.pid)
    // 绝不对自己所在进程组发整组信号
    if (self?.pgid === leaderPid) return false
    if (!all.some((proc) => proc.pid === leaderPid)) return false

    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(leaderPid), '/T', '/F'], { stdio: 'ignore' })
        killedGroups.push(leaderPid)
        return true
      } catch {
        return false
      }
    }

    const signalGroup = (signal: NodeJS.Signals): boolean => {
      try {
        process.kill(-leaderPid, signal)
        return true
      } catch {
        // 组已不存在或组长已退出：退回单 pid
        try {
          process.kill(leaderPid, signal)
          return true
        } catch {
          return false
        }
      }
    }

    if (!signalGroup('SIGTERM')) return false
    // §6.5 a：SIGTERM → 500ms 宽限
    sleepSync(500)
    const remaining = this.list().filter((proc) => proc.pgid === leaderPid && !proc.state.startsWith('Z'))
    if (remaining.length > 0) {
      signalGroup('SIGKILL')
      sleepSync(100)
    }
    killedGroups.push(leaderPid)
    return true
  }

  private isAncestorOfSelf(pid: number, all: ProcInfo[]): boolean {
    const byPid = new Map(all.map((proc) => [proc.pid, proc]))
    let cursor = byPid.get(process.pid)?.ppid ?? 0
    const seen = new Set<number>()
    while (cursor > 1 && !seen.has(cursor)) {
      if (cursor === pid) return true
      seen.add(cursor)
      cursor = byPid.get(cursor)?.ppid ?? 0
    }
    return false
  }

  private terminatePid(pid: number): boolean {
    if (!isAlive(pid)) return false
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return false
    }
    // §6.5 a：SIGTERM → 500ms 宽限
    sleepSync(500)
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已退出
      }
      sleepSync(100)
    }
    return true
  }
}
