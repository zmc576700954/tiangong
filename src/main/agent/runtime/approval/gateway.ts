/**
 * D4：审批通道。
 *
 * 约束（agent-decisions.md D-B）：
 * - 交互 120s / 无人值守 30s；
 * - pending 保留，重启重推并重计时；
 * - 超时写 denied + decided_by='timeout'；
 * - 决定幂等；
 * - argsHash 必须参与匹配（防 TOCTOU）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { hasRedactionMeta } from '../../../shared/redaction'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  ApprovalDecisionInput,
  ApprovalMode,
  ApprovalOutcome,
  ApprovalRequestInput,
  ApprovalRequestPayload,
  ApprovalResolutionPayload,
  RiskLevel,
  SessionGrantInfo,
} from '@shared/types/agent-runtime'
import { AgentRepository, type AgentApprovalRow } from '../db/repository'
import { createLogger } from '../../../shared/logger'
import { AgentRuntimeError } from '../errors'
import { eventIdFor, hashArgs, newId } from '../util'
import { bashPolicyForTool } from './bash-readonly'

const logger = createLogger('ApprovalGateway')

export const INTERACTIVE_TIMEOUT_MS = 120_000
export const UNATTENDED_TIMEOUT_MS = 30_000

/**
 * 「活 turn」判据：这些状态下 turn 仍在等待工具结果，审批才可能被兑现。
 * 注意与 unique 索引 `(node_id, branch_key)` 活跃状态保持一致。
 */
const LIVE_TURN_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting_approval', 'cancelling'])

/** 从落库的 args_json 还原 Bash 策略信息；解析失败则退化为无规则。 */
function parseArgsJson(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 审批卡片要能说明「在批什么」：Bash 工具附带命中的规则名与按规则的风险等级。
 * 规则是确定性纯函数，因此重启重放也能还原出同一 rule。
 */
function bashPolicyFields(
  toolName: string,
  args: Record<string, unknown>,
): { policyRule: string; policyReason: string; risk: RiskLevel } | undefined {
  const policy = bashPolicyForTool(toolName, args)
  if (!policy) return undefined
  return { policyRule: policy.rule, policyReason: policy.reason, risk: policy.risk }
}

export interface ApprovalNotifier {
  onRequest(payload: ApprovalRequestPayload): void
  onResolved(payload: ApprovalResolutionPayload): void
}

/** 会话级授权未命中的原因（写审计事件时必须可解释）。 */
export type GrantMissReason = 'tool' | 'path' | 'revoked' | 'session'

interface GrantMatch {
  grant: SessionGrantInfo | null
  reason?: GrantMissReason
  /** 本次调用解析到的目标路径（仅审计用） */
  targets: string[]
}

/** 会话仍存活的状态：closed / orphaned 一律视为不可再用授权。 */
const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(['starting', 'active', 'idle'])

interface PendingWaiter {
  resolve: (outcome: ApprovalOutcome) => void
  reject: (error: Error) => void
}

export interface ApprovalGatewayOptions {
  db: BetterSqlite3.Database
  repo?: AgentRepository
  interactiveTimeoutMs?: number
  unattendedTimeoutMs?: number
  notifier?: ApprovalNotifier
  now?: () => number
}

/** 保守的工具风险分类：只用于 UI 提示，不替代用户决定。 */
export function classifyToolRisk(toolName: string, args: Record<string, unknown>): RiskLevel {
  const name = toolName.toLowerCase()
  if (/bash|shell|exec|command|terminal/.test(name)) return 'critical'
  if (/write|edit|delete|remove|patch|apply/.test(name)) return 'high'
  if (/fetch|web|http|mcp/.test(name)) return 'medium'
  if (/read|grep|glob|list|search|view/.test(name)) return 'low'
  if (typeof args.path === 'string' || typeof args.file_path === 'string') return 'medium'
  return 'medium'
}

/**
 * 会话级授权只覆盖「写类工具」，绝不覆盖 Bash/Shell/网络类工具。
 * 这是产品边界：一次会话授权不能退化成任意命令免审。
 */
const WRITE_TOOL_PATTERN = /^(write|edit|multiedit|notebookedit|create|delete|remove|move|rename|patch|apply_patch|str_replace|str_replace_editor)$/i

export function isWriteScopedTool(toolName: string): boolean {
  return WRITE_TOOL_PATTERN.test(toolName.trim())
}

/** 单个路径字段（Claude 用 file_path；其他适配器可能用 path/notebook_path）。 */
const SINGLE_PATH_KEYS = ['file_path', 'notebook_path', 'path', 'target_file', 'targetPath']
/** 多路径字段：一次调用写多个目标时，任一越界都必须重新弹窗。 */
const MULTI_PATH_KEYS = ['paths', 'files', 'file_paths', 'targets', 'edits']

function pushPath(targets: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    targets.push(value)
    return
  }
  // edits 等数组元素可能是对象：继续按路径字段取
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    collectPaths(value as Record<string, unknown>, targets)
  }
}

function collectPaths(args: Record<string, unknown>, targets: string[]): void {
  for (const key of SINGLE_PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) targets.push(value)
  }
  for (const key of MULTI_PATH_KEYS) {
    const value = args[key]
    if (Array.isArray(value)) {
      for (const item of value) pushPath(targets, item)
    }
  }
}

/**
 * 收集一次调用里的**全部**目标路径。写类工具没有可解析路径时返回空数组，
 * 调用方必须视为「不可验证」→ 回到审批（不得静默放行）。
 */
export function targetPathsOf(args: Record<string, unknown>): string[] {
  const targets: string[] = []
  collectPaths(args, targets)
  return [...new Set(targets)]
}

/**
 * realpath 归一，解析 symlink 别名（macOS 的 /tmp → /private/tmp 是最常见的例子）。
 * 路径不存在时返回 null，由调用方决定回退方式。
 */
function tryRealpath(input: string): string | null {
  try {
    return fs.realpathSync(input)
  } catch {
    return null
  }
}

/**
 * 解析「真实路径」：目标常常尚不存在（写新文件），因此自底向上寻找最近的
 * 已存在祖先并 realpath 归一，再把缺失后缀拼回去。
 *
 * 这样能识别**中间目录是 symlink** 的逃逸：`root/link -> /outside` 时，
 * `root/link/new.txt` 即使文件不存在也会落到 `/outside/new.txt`。
 * 注意这是调用时的快照，不跨调用缓存（两次调用之间文件系统可能变化）。
 */
function resolveRealPath(input: string): string {
  const abs = path.resolve(input)
  const direct = tryRealpath(abs)
  if (direct) return direct
  let current = abs
  const missing: string[] = []
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) return abs
    missing.unshift(path.basename(current))
    const realParent = tryRealpath(parent)
    if (realParent) return path.join(realParent, ...missing)
    current = parent
  }
}

/** macOS 默认大小写不敏感：比较前统一小写，避免大小写变体绕过作用域。 */
function comparablePath(value: string): string {
  return process.platform === 'darwin' ? value.toLowerCase() : value
}

/**
 * 作用域判断：root 与目标路径都做 realpath 归一（每次调用重新计算）。
 * 尾部分隔符、大小写变体与 symlink 别名都在这里统一。
 */
export function isPathInside(root: string, candidate: string): boolean {
  if (root.length === 0 || candidate.length === 0) return false
  const rootAbs = path.resolve(root)
  const rootReal = comparablePath(resolveRealPath(rootAbs))
  const targetAbs = path.resolve(rootAbs, candidate)
  const targetReal = comparablePath(resolveRealPath(targetAbs))
  const rel = path.relative(rootReal, targetReal)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class ApprovalGateway {
  private readonly repo: AgentRepository
  private readonly interactiveTimeoutMs: number
  private readonly unattendedTimeoutMs: number
  private readonly now: () => number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly waiters = new Map<string, PendingWaiter[]>()
  /**
   * 会话级授权：仅进程内存，重启不继承；session 结束/手动撤销/dispose 即失效。
   * 作用域 = 写类工具 + 会话工作目录内的路径。
   */
  private readonly sessionGrants = new Map<string, SessionGrantInfo>()
  /**
   * 撤销墓碑：授权被删除后仍能解释「为什么这次没命中」，供审计事件使用。
   * 建立新授权时清除；仅进程内存，重启即消失（与授权本身一致）。
   */
  private readonly revokedGrants = new Map<string, 'revoked' | 'session-ended'>()
  /** 本次决议刚建立的授权（用于把 sessionGranted 带回 driver 事件） */
  private readonly sessionGrantedApprovals = new Set<string>()
  private notifier: ApprovalNotifier | undefined
  private disposed = false

  constructor(options: ApprovalGatewayOptions) {
    this.repo = options.repo ?? new AgentRepository(options.db)
    this.interactiveTimeoutMs = options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS
    this.unattendedTimeoutMs = options.unattendedTimeoutMs ?? UNATTENDED_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.notifier = options.notifier
  }

  setNotifier(notifier: ApprovalNotifier | undefined): void {
    this.notifier = notifier
  }

  /**
   * 写前拦截入口：调用方拿到 allow 结果之前，工具不得执行。
   * policyDecision='allow'/'deny' 时由宿主策略直接落定；否则挂起等待用户。
   */
  async request(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const mode: ApprovalMode = input.mode ?? 'interactive'
    const timeoutMs = this.timeoutFor(mode)
    const argsHash = hashArgs(input.toolName, input.args)
    const policyDecision = input.policyDecision ?? 'ask'
    const bashPolicy = bashPolicyFields(input.toolName, input.args)
    const risk = input.risk ?? bashPolicy?.risk ?? classifyToolRisk(input.toolName, input.args)
    const id = newId('appr')
    const createdAt = this.now()

    // 命中会话级授权：不弹窗，但落一条 allowed 审批行并把来源 approval id 写进 grant_source。
    // 审计要求：即使是自动放行，也必须能追溯「哪一次用户授权覆盖了本次操作」。
    //
    // P0-1：命中必须**每次重新校验**（工具类别 / 全部目标路径 realpath / 授权未撤销 / 会话存活）。
    // 任一不满足就回到审批（ask），而不是静默 deny —— 用户要看见「这次跑出了授权范围」。
    const match = this.matchSessionGrant(input.sessionId, input.toolName, input.args)
    if (policyDecision === 'ask' && match.reason) {
      this.auditGrantMiss(input, match)
    }
    if (match.grant && policyDecision === 'ask') {
      const row = this.repo.insertApproval({
        id,
        runId: input.runId,
        turnId: input.turnId,
        stepId: input.stepId,
        toolName: input.toolName,
        argsJson: JSON.stringify(input.args),
        argsHash,
        risk,
        policyDecision: 'allow',
        status: 'allowed',
        expiresAt: createdAt + timeoutMs,
        mode,
        timeoutMs,
        cwd: input.cwd,
        grantSource: match.grant.approvalId,
      })
      const outcome = this.outcomeFromRow(row, true)
      this.notifier?.onResolved(this.resolutionFromRow(row))
      return outcome
    }

    const row = this.repo.insertApproval({
      id,
      runId: input.runId,
      turnId: input.turnId,
      stepId: input.stepId,
      toolName: input.toolName,
      argsJson: JSON.stringify(input.args),
      argsHash,
      risk,
      policyDecision,
      status: policyDecision === 'allow' ? 'allowed' : policyDecision === 'deny' ? 'denied' : 'pending',
      expiresAt: createdAt + timeoutMs,
      mode,
      timeoutMs,
      cwd: input.cwd,
    })

    if (row.status !== 'pending') {
      const outcome = this.outcomeFromRow(row)
      this.notifier?.onResolved(this.resolutionFromRow(row))
      return outcome
    }

    const payload: ApprovalRequestPayload = {
      approvalId: row.id,
      runId: row.run_id,
      turnId: row.turn_id,
      sessionId: input.sessionId,
      stepId: row.step_id ?? undefined,
      toolName: row.tool_name,
      // 待审批期间展示用内存原文：DB 里的 args_json 已脱敏，卡片不能读它。
      argsJson: JSON.stringify(input.args),
      argsHash: row.args_hash,
      risk: row.risk,
      status: 'pending',
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      mode: row.mode,
      timeoutMs: row.timeout_ms,
      // 非写类工具不允许“允许本会话”：否则等于用一次命令授权换取写类工具免审。
      sessionGrantable: isWriteScopedTool(row.tool_name),
      ...(bashPolicy ? { policyRule: bashPolicy.policyRule, policyReason: bashPolicy.policyReason } : {}),
    }
    this.notifier?.onRequest(payload)
    this.armTimer(row.id, row.expires_at)

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const list = this.waiters.get(row.id) ?? []
      list.push({ resolve, reject })
      this.waiters.set(row.id, list)
    })
  }

  /** 用户/IPC 决策。argsHash 不匹配直接拒绝（不写决策）。 */
  decide(input: ApprovalDecisionInput): ApprovalOutcome {
    const row = this.repo.getApproval(input.approvalId)
    if (!row) {
      throw new AgentRuntimeError('APPROVAL_NOT_FOUND', `Approval not found: ${input.approvalId}`)
    }
    this.assertDecisionOwnership(row, input)
    if (input.argsHash !== row.args_hash) {
      throw new AgentRuntimeError(
        'APPROVAL_ARGS_MISMATCH',
        `APPROVAL_ARGS_MISMATCH: args changed after request: ${input.approvalId}`,
      )
    }
    if (row.status !== 'pending') {
      // 幂等：返回既有结果，不重复发事件
      return this.outcomeFromRow(row)
    }
    const decidedBy = input.decidedBy ?? 'user'

    // 僵尸审批防线：批准必须真的能被兑现。
    // 判据：该审批所属 turn 仍是活 turn（running / waiting_approval / cancelling）。
    // turn 已终结（重启对账后的 orphaned、用户取消等）时本进程不存在 waiter，
    // 直接写 allowed 只会得到「DB 记 allowed 但命令不执行」的静默失败。
    if (input.decision === 'allow' && !this.isFulfillable(row)) {
      const updated = this.repo.decideApproval(
        row.id,
        'deny',
        'system',
        this.now(),
        `turn ${row.turn_id} is not live; an allow decision could never execute (auto-denied)`,
      )
      this.clearTimer(row.id)
      if (updated) {
        this.notifier?.onResolved(this.resolutionFromRow(updated))
        this.settleWaiters(updated)
      }
      throw new AgentRuntimeError(
        'APPROVAL_STALE',
        '该审批所属轮次已结束，批准不会执行（已自动置为 denied）。请重新发送命令以触发新的审批。',
      )
    }

    const updated = this.repo.decideApproval(row.id, input.decision, decidedBy, this.now())
    if (!updated) {
      throw new AgentRuntimeError('APPROVAL_NOT_FOUND', `Approval disappeared: ${input.approvalId}`)
    }

    // 「允许本次会话」：建立内存授权；来源即本次 approval id，供后续自动放行审计。
    // 只有「写类工具 + 能定位 session + 知道工作目录」才建立，否则退化为「仅本次」。
    //
    // 阻断项：会话授权的作用域是写类工具，因此只能由写类工具的批准建立。
    // 若 Bash 等非写类工具也能建立，用户批的是一条命令，实际拿到的却是
    // 「本会话任意写文件免审」——文案与权限不一致。
    if (
      input.decision === 'allow' &&
      input.scope === 'session' &&
      updated.status === 'allowed' &&
      isWriteScopedTool(updated.tool_name)
    ) {
      const turn = this.repo.getTurn(updated.turn_id)
      const sessionId = turn?.session_id
      if (sessionId && updated.cwd) {
        this.sessionGrants.set(sessionId, {
          sessionId,
          approvalId: updated.id,
          grantedAt: this.now(),
          toolName: updated.tool_name,
          toolScope: 'write',
          cwd: updated.cwd,
        })
        this.revokedGrants.delete(sessionId)
        this.sessionGrantedApprovals.add(updated.id)
      }
    }

    this.clearTimer(row.id)
    this.notifier?.onResolved(this.resolutionFromRow(updated))
    this.settleWaiters(updated)
    return this.outcomeFromRow(updated)
  }

  /**
   * 决议归属校验：session / turn / run 三者只要提供了就必须与落库行一致。
   * 只校验 argsHash 无法区分「谁在决定」：其它窗口/会话拿到 approval id 与 hash
   * 就能对一个不属于自己的审批下单。校验失败显式报错，绝不静默改写状态。
   */
  private assertDecisionOwnership(row: AgentApprovalRow, input: ApprovalDecisionInput): void {
    if (input.turnId !== undefined && input.turnId !== row.turn_id) {
      throw new AgentRuntimeError(
        'APPROVAL_NOT_OWNED',
        `该审批不属于指定轮次（approval=${row.id}，期望 turn=${row.turn_id}，收到 turn=${input.turnId}）。`,
      )
    }
    if (input.runId !== undefined && input.runId !== row.run_id) {
      throw new AgentRuntimeError(
        'APPROVAL_NOT_OWNED',
        `该审批不属于指定 run（approval=${row.id}，期望 run=${row.run_id}，收到 run=${input.runId}）。`,
      )
    }
    if (input.sessionId !== undefined) {
      const turn = this.repo.getTurn(row.turn_id)
      if (!turn || turn.session_id !== input.sessionId) {
        throw new AgentRuntimeError(
          'APPROVAL_NOT_OWNED',
          `该审批不属于指定会话（approval=${row.id}，收到 session=${input.sessionId}），可能属于其它窗口或已结束的会话。`,
        )
      }
    }
  }

  /** 只读预判：本次请求是否会命中会话级授权。 */
  peekSessionGrant(input: {
    sessionId?: string
    toolName: string
    args: Record<string, unknown>
    cwd?: string
  }): { grantSourceApprovalId: string } | null {
    const match = this.matchSessionGrant(input.sessionId, input.toolName, input.args)
    return match.grant ? { grantSourceApprovalId: match.grant.approvalId } : null
  }

  listSessionGrants(): SessionGrantInfo[] {
    return [...this.sessionGrants.values()].map((grant) => ({ ...grant }))
  }

  revokeSessionGrant(sessionId: string): boolean {
    const deleted = this.sessionGrants.delete(sessionId)
    if (deleted) this.revokedGrants.set(sessionId, 'revoked')
    return deleted
  }

  /** session 结束（terminateSession / 关闭会话）→ 授权立即失效。 */
  endSession(sessionId: string): boolean {
    const deleted = this.sessionGrants.delete(sessionId)
    if (deleted) this.revokedGrants.set(sessionId, 'session-ended')
    return deleted
  }

  /**
   * 每次调用都重新校验（不缓存 realpath）：
   *   1) 会话存在且仍存活；
   *   2) 工具属于写类集合；
   *   3) 本次调用的**每个**目标路径 realpath 后都在授权 cwd 内。
   * 未命中时给出原因（tool / path / revoked / session），供审计与 UI 说明。
   */
  private matchSessionGrant(
    sessionId: string | undefined,
    toolName: string,
    args: Record<string, unknown>,
  ): GrantMatch {
    const targets = targetPathsOf(args)
    if (!sessionId) return { grant: null, targets }
    const grant = this.sessionGrants.get(sessionId)
    if (!grant) {
      const revocation = this.revokedGrants.get(sessionId)
      if (revocation) return { grant: null, reason: revocation === 'revoked' ? 'revoked' : 'session', targets }
      return { grant: null, targets }
    }
    if (!this.isSessionAlive(sessionId)) return { grant: null, reason: 'session', targets }
    // 授权必须由写类工具建立（旧进程/非法来源留下的非写类授权一律不认）。
    if (!isWriteScopedTool(grant.toolName)) return { grant: null, reason: 'tool', targets }
    if (!isWriteScopedTool(toolName)) return { grant: null, reason: 'tool', targets }
    // 没有可解析路径，或任一路径越界 → 不命中（多路径场景任一越界即整体回到审批）
    if (targets.length === 0 || !targets.every((target) => isPathInside(grant.cwd, target))) {
      return { grant: null, reason: 'path', targets }
    }
    return { grant, targets }
  }

  /** 会话存活校验：DB 无该会话，或已 closed/orphaned 时授权不再可信（失败即不命中）。 */
  private isSessionAlive(sessionId: string): boolean {
    try {
      const session = this.repo.getSession(sessionId)
      return Boolean(session && LIVE_SESSION_STATUSES.has(session.status))
    } catch {
      return false
    }
  }

  /**
   * 授权未命中的审计事件：只记录本次调用的工具类别、原因与目标路径，
   * 不落原始参数（避免把文件内容写进事件库）。失败不阻塞审批流程。
   */
  private auditGrantMiss(
    input: ApprovalRequestInput,
    match: GrantMatch,
  ): void {
    try {
      const seq = this.repo.listTurnEvents(input.turnId).reduce((max, event) => Math.max(max, event.turn_seq), 0) + 1
      this.repo.appendEvents([
        {
          eventId: eventIdFor(input.turnId, seq),
          runId: input.runId,
          turnId: input.turnId,
          seq,
          type: 'approval.grant_miss',
          source: 'kernel',
          fidelity: 'turn',
          payloadVersion: 1,
          payload: {
            sessionId: input.sessionId,
            toolName: input.toolName,
            reason: match.reason,
            targets: match.targets,
          },
          timestamp: this.now(),
          ...(input.stepId ? { stepId: input.stepId } : {}),
        },
      ])
    } catch (error) {
      // 审计失败不得改变审批结果
      logger.warn(`grant miss audit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 启动/周期扫描：pending 且到期 → denied + timeout。返回处理数量。 */
  sweepExpired(at = this.now()): number {
    const expired = this.repo.listExpiredApprovals(at)
    let count = 0
    for (const row of expired) {
      const updated = this.repo.decideApproval(row.id, 'deny', 'timeout', at)
      if (!updated) continue
      this.clearTimer(row.id)
      this.notifier?.onResolved(this.resolutionFromRow(updated))
      this.settleWaiters(updated)
      count += 1
    }
    return count
  }

  /**
   * 启动对账：把重启前遗留的 pending 审批结清。
   *
   * 可兑现判据（唯一）：该 pending 所属 turn 在当前进程内仍存活
   * （`running` / `waiting_approval` / `cancelling`）。只有这种 turn 上可能还挂着
   * 本进程的 waiter；重启后旧进程已消失，且 startup planner 会把所有在途 turn
   * 对账为 `orphaned`，因此持久化残留的 pending 一律不可兑现 → deny + decided_by=startup。
   *
   * 不可兑现的审批只落库终态，**不再推送 UI**（避免重启后弹出一个点了也没用的弹窗）。
   */
  reconcileStartup(at = this.now()): { denied: number; replayed: ApprovalRequestPayload[] } {
    const pending = this.repo.listPendingApprovals()
    const replayed: ApprovalRequestPayload[] = []
    let denied = 0
    for (const row of pending) {
      if (this.isFulfillable(row)) {
        replayed.push(this.replayRow(row, at))
        continue
      }
      const updated = this.repo.decideApproval(
        row.id,
        'deny',
        'startup',
        at,
        'startup reconcile: previous process ended; no waiter can execute this approval',
      )
      this.clearTimer(row.id)
      if (updated) denied += 1
    }
    return { denied, replayed }
  }

  /** 该 pending 是否还有可能被兑现（所属 turn 仍是活 turn）。 */
  private isFulfillable(row: AgentApprovalRow): boolean {
    const turn = this.repo.getTurn(row.turn_id)
    return Boolean(turn && LIVE_TURN_STATUSES.has(turn.status))
  }

  private replayRow(row: AgentApprovalRow, at: number): ApprovalRequestPayload {
    const expiresAt = at + row.timeout_ms
    this.repo.refreshApprovalExpiry(row.id, expiresAt, row.timeout_ms)
    const redacted = hasRedactionMeta(row.args_json)
    // 脱敏后的参数无法可靠复算策略规则，重放时不展示规则，避免给出误导性的「命中规则」。
    const policy = redacted ? null : bashPolicyFields(row.tool_name, parseArgsJson(row.args_json))
    const payload: ApprovalRequestPayload = {
      approvalId: row.id,
      runId: row.run_id,
      turnId: row.turn_id,
      sessionId: this.repo.getTurn(row.turn_id)?.session_id,
      stepId: row.step_id ?? undefined,
      toolName: row.tool_name,
      // 重启重放：DB 里只有脱敏后的 args_json，无法还原原文（也不提供还原）。
      argsJson: row.args_json,
      argsRedacted: hasRedactionMeta(row.args_json),
      argsHash: row.args_hash,
      risk: row.risk,
      status: 'pending',
      expiresAt,
      createdAt: row.created_at,
      mode: row.mode,
      timeoutMs: row.timeout_ms,
      sessionGrantable: isWriteScopedTool(row.tool_name),
      ...(policy ? { policyRule: policy.policyRule, policyReason: policy.policyReason } : {}),
    }
    this.notifier?.onRequest(payload)
    this.armTimer(row.id, expiresAt)
    return payload
  }

  get pendingCount(): number {
    return this.repo.listPendingApprovals().length
  }

  /** 只读列出 pending（不重推、不重计时）。 */
  listPendingPayloads(): ApprovalRequestPayload[] {
    return this.repo.listPendingApprovals().map((row) => {
      const redacted = hasRedactionMeta(row.args_json)
      const policy = redacted ? null : bashPolicyFields(row.tool_name, parseArgsJson(row.args_json))
      return {
        approvalId: row.id,
        runId: row.run_id,
        turnId: row.turn_id,
        sessionId: this.repo.getTurn(row.turn_id)?.session_id,
        stepId: row.step_id ?? undefined,
        toolName: row.tool_name,
        argsJson: row.args_json,
        argsRedacted: hasRedactionMeta(row.args_json),
        argsHash: row.args_hash,
        risk: row.risk,
        status: 'pending' as const,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        mode: row.mode,
        timeoutMs: row.timeout_ms,
        sessionGrantable: isWriteScopedTool(row.tool_name),
        ...(policy ? { policyRule: policy.policyRule, policyReason: policy.policyReason } : {}),
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.sessionGrants.clear()
    this.revokedGrants.clear()
    this.sessionGrantedApprovals.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        waiter.reject(new AgentRuntimeError('APPROVAL_NOT_FOUND', 'Approval gateway disposed'))
      }
    }
    this.waiters.clear()
  }

  private timeoutFor(mode: ApprovalMode): number {
    const configured = mode === 'unattended' ? this.unattendedTimeoutMs : this.interactiveTimeoutMs
    return Math.max(1, configured)
  }

  private armTimer(approvalId: string, expiresAt: number): void {
    this.clearTimer(approvalId)
    if (this.disposed) return
    const delay = Math.max(0, expiresAt - this.now())
    const timer = setTimeout(() => {
      this.timers.delete(approvalId)
      const row = this.repo.getApproval(approvalId)
      if (!row || row.status !== 'pending') return
      const updated = this.repo.decideApproval(approvalId, 'deny', 'timeout', this.now())
      if (!updated) return
      this.notifier?.onResolved(this.resolutionFromRow(updated))
      this.settleWaiters(updated)
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.set(approvalId, timer)
  }

  private clearTimer(approvalId: string): void {
    const timer = this.timers.get(approvalId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(approvalId)
    }
  }

  private settleWaiters(row: AgentApprovalRow): void {
    const waiters = this.waiters.get(row.id) ?? []
    this.waiters.delete(row.id)
    const outcome = this.outcomeFromRow(row)
    for (const waiter of waiters) waiter.resolve(outcome)
  }

  private outcomeFromRow(row: AgentApprovalRow, autoGranted = false): ApprovalOutcome {
    const grantSourceApprovalId = row.grant_source ?? (this.sessionGrantedApprovals.has(row.id) ? row.id : undefined)
    return {
      approvalId: row.id,
      decision: row.status === 'allowed' ? 'allow' : 'deny',
      decidedBy: row.decided_by ?? 'system',
      argsHash: row.args_hash,
      decidedAt: row.decided_at ?? row.created_at,
      ...(this.sessionGrantedApprovals.has(row.id) ? { sessionGranted: true } : {}),
      ...(grantSourceApprovalId ? { grantSourceApprovalId } : {}),
      ...(autoGranted ? { autoGranted: true } : {}),
    }
  }

  private resolutionFromRow(row: AgentApprovalRow): ApprovalResolutionPayload {
    const granted = this.sessionGrantedApprovals.has(row.id)
    const grantSourceApprovalId = row.grant_source ?? (granted ? row.id : undefined)
    return {
      approvalId: row.id,
      runId: row.run_id,
      turnId: row.turn_id,
      decision: row.status === 'allowed' ? 'allow' : 'deny',
      decidedBy: row.decided_by ?? 'system',
      argsHash: row.args_hash,
      decidedAt: row.decided_at ?? row.created_at,
      ...(granted ? { sessionGranted: true } : {}),
      ...(grantSourceApprovalId ? { grantSourceApprovalId } : {}),
    }
  }
}
