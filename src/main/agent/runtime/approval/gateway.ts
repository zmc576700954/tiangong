/**
 * D4：审批通道。
 *
 * 约束（agent-decisions.md D-B）：
 * - 交互 120s / 无人值守 30s；
 * - pending 保留；启动对账只重推所属 turn 仍存活的审批（生产上在途 turn 已被
 *   orphaned，实际是统一 deny + decided_by='startup'，不推 UI、不重计时）；
 * - 超时写 denied + decided_by='timeout'；
 * - 决定幂等；
 * - argsHash 必须参与匹配（防 TOCTOU）。
 */

import { hasRedactionMeta } from '../../../shared/redaction'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  ApprovalDecisionInput,
  ApprovalMode,
  ApprovalOutcome,
  ApprovalRequestInput,
  ApprovalRequestPayload,
  ApprovalResolutionPayload,
  NormalizedEventEnvelope,
  RiskLevel,
  SessionGrantInfo,
} from '@shared/types/agent-runtime'
import { AgentRepository, type AgentApprovalRow } from '../db/repository'
import { createLogger } from '../../../shared/logger'
import { AgentRuntimeError } from '../errors'
import { eventIdFor, hashArgs, newId } from '../util'
import { bashPolicyForTool } from './bash-readonly'
import { getSandboxCapability } from '../../../shared/sandbox'
import { evaluateGitDirWriteGuard, type GitDirGuardResult } from './gitdir-write-guard'
import { legacySessionIdOf } from './legacy-ids'

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
  cwd?: string,
): { policyRule: string; policyReason: string; risk: RiskLevel } | undefined {
  // 与执行侧同一结论：沙箱不可用时 allow 集退回 ask，卡片原因也要一致。
  const capability = getSandboxCapability()
  const policy = bashPolicyForTool(toolName, args, {
    cwd,
    sandboxAvailable: capability.available,
    sandboxUnavailableReason: capability.reason,
  })
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
  /** P1-1：等待结束回调（settle/reject 时各调用一次，异常不外泄）。 */
  onSettled?: () => void
}

export interface ApprovalGatewayOptions {
  db: BetterSqlite3.Database
  repo?: AgentRepository
  interactiveTimeoutMs?: number
  unattendedTimeoutMs?: number
  notifier?: ApprovalNotifier
  now?: () => number
  /**
   * W5-A：审计事件写入通道。Runtime 注入事件批写器，保证审批事件
   * 与同一 run 的高频事件共享同一写入顺序（审批事件本身仍同步落库）。
   */
  eventSink?: (events: NormalizedEventEnvelope[]) => void
  /**
   * 计算 turn_seq 前先 flush 批写缓冲，避免「审计用 DB max+1」与
   * 尚未落盘的高频事件 seq 撞车（UNIQUE(turn_id, turn_seq)）。
   */
  beforeAudit?: () => void
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
 * 路径解析与写类工具识别集中在 `write-paths.ts`，这里只做对外导出，
 * 保证旧的 import 路径（driver / 测试）不变，同时避免 gateway 与 gitdir 守卫循环依赖。
 */
import { isPathInside, isWriteScopedTool, targetPathsOf } from './write-paths'

export { isPathInside, isWriteScopedTool, targetPathsOf }

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
  /**
   * 旧路径（无 turn）审批所属的活跃会话。仅进程内存；session 结束即移除。
   * 会话授权存活校验在 DB 无该 session 时以此为据（见 `isSessionAlive`）。
   */
  private readonly legacySessions = new Set<string>()
  private notifier: ApprovalNotifier | undefined
  private readonly eventSink: ((events: NormalizedEventEnvelope[]) => void) | undefined
  private readonly beforeAudit: (() => void) | undefined
  private disposed = false

  constructor(options: ApprovalGatewayOptions) {
    this.repo = options.repo ?? new AgentRepository(options.db)
    this.interactiveTimeoutMs = options.interactiveTimeoutMs ?? INTERACTIVE_TIMEOUT_MS
    this.unattendedTimeoutMs = options.unattendedTimeoutMs ?? UNATTENDED_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.notifier = options.notifier
    this.eventSink = options.eventSink
    this.beforeAudit = options.beforeAudit
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
    // 旧路径（无 turn）审批：登记活跃会话，供会话级授权的存活校验使用。
    // 启动对账时该集合为空，残留 pending 一律不可兑现 → deny（与 turn 判据一致）。
    const legacySessionId = legacySessionIdOf(input.runId ?? '', input.turnId ?? '')
    if (legacySessionId) this.legacySessions.add(legacySessionId)
    const policyDecision = input.policyDecision ?? 'ask'
    // 配置探针按审批请求所属会话的工作目录读取仓库配置，不能用进程 cwd。
    const bashPolicy = bashPolicyFields(input.toolName, input.args, input.cwd)
    const risk = input.risk ?? bashPolicy?.risk ?? classifyToolRisk(input.toolName, input.args)
    const id = newId('appr')
    const createdAt = this.now()

    // D1：写类工具的目标路径必须避开 git 元数据目录。
    // 这不是「多弹一次」：一旦允许写 `.git/config`，后续读命令就能零审批执行外部程序，
    // 弹窗文案无法让用户看见这层因果，因此默认直接 deny（宿主策略决定），
    // 只有 `BIZGRAPH_GITDIR_WRITE_GUARD=ask` 时才回到用户审批。
    const gitGuard = evaluateGitDirWriteGuard(input.toolName, input.args, { cwd: input.cwd })
    if (gitGuard.verdict === 'block') {
      const row = this.repo.insertApproval({
        id,
        runId: input.runId,
        turnId: input.turnId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        stepId: input.stepId,
        toolName: input.toolName,
        argsJson: JSON.stringify(input.args),
        argsHash,
        risk: 'critical',
        policyDecision: 'deny',
        status: 'denied',
        expiresAt: createdAt + timeoutMs,
        mode,
        timeoutMs,
        cwd: input.cwd,
        note: gitGuard.reason,
      })
      this.auditPolicyBlock(input, gitGuard)
      const outcome = this.outcomeFromRow(row)
      this.notifier?.onResolved(this.resolutionFromRow(row))
      return outcome
    }
    // 回退开关把 deny 降级为 ask 时，必须显式回到用户：不能又被会话级授权自动放行。
    const forcedAsk = gitGuard.verdict === 'ask' && policyDecision === 'ask'

    // 命中会话级授权：不弹窗，但落一条 allowed 审批行并把来源 approval id 写进 grant_source。
    // 审计要求：即使是自动放行，也必须能追溯「哪一次用户授权覆盖了本次操作」。
    //
    // P0-1：命中必须**每次重新校验**（工具类别 / 全部目标路径 realpath / 授权未撤销 / 会话存活）。
    // 任一不满足就回到审批（ask），而不是静默 deny —— 用户要看见「这次跑出了授权范围」。
    const match = this.matchSessionGrant(input.sessionId, input.toolName, input.args)
    if (policyDecision === 'ask' && match.reason) {
      this.auditGrantMiss(input, match)
    }
    if (match.grant && policyDecision === 'ask' && !forcedAsk) {
      const row = this.repo.insertApproval({
        id,
        runId: input.runId,
        turnId: input.turnId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
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
      // §7.1/D6：计划/任务级审批必须落 subject，否则 test_plan 审批在
      // agent_approvals 里会退化成无主体的 agent_turn 行，无法被 execute 校验。
      subjectType: input.subjectType,
      subjectId: input.subjectId,
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
      runId: row.run_id ?? null,
      turnId: row.turn_id ?? null,
      sessionId: input.sessionId,
      stepId: row.step_id ?? undefined,
      workItemId: this.workItemIdOf(row.step_id),
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
      ...(forcedAsk ? { policyRule: gitGuard.rule, policyReason: gitGuard.reason } : {}),
      ...(bashPolicy ? { policyRule: bashPolicy.policyRule, policyReason: bashPolicy.policyReason } : {}),
    }
    this.notifier?.onRequest(payload)
    this.armTimer(row.id, row.expires_at)
    // P1-1：审批已真实进入 pending，先让 runtime 冻结 turn deadline，再开始等待。
    // 回调异常不得阻塞审批本身（冻结失败最坏退化为原 F3-A 语义）。
    try {
      input.onPending?.()
    } catch (error) {
      logger.warn(`approval onPending hook failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const list = this.waiters.get(row.id) ?? []
      list.push({ resolve, reject, onSettled: input.onSettled })
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
      // S8/D6:subject 非 agent_turn(测试计划/任务级)没有 turn,不进会话级授权;
      // 旧路径自由聊天的合成 run/turn(legacy-* 前缀)仍走 legacySessionIdOf 反解
      const turn = updated.turn_id ? this.repo.getTurn(updated.turn_id) : undefined
      const sessionId =
        turn?.session_id ?? legacySessionIdOf(updated.run_id ?? '', updated.turn_id ?? '')
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
      // S8/D6:subject 审批(test_plan/work_item)无 turn——归属由 subject_id 本体承担
      if (!row.turn_id) return
      const turn = this.repo.getTurn(row.turn_id)
      // 旧路径没有 turn 行，归属从 run/turn 标识反解；反解失败则 fail-closed。
      const ownerSessionId =
        turn?.session_id ?? legacySessionIdOf(row.run_id ?? '', row.turn_id ?? '')
      if (!ownerSessionId || ownerSessionId !== input.sessionId) {
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
    this.legacySessions.delete(sessionId)
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
      if (session) return LIVE_SESSION_STATUSES.has(session.status)
      // 旧路径（自由聊天）不落 agent_sessions；以本进程登记且未 endSession 为准。
      return this.legacySessions.has(sessionId)
    } catch {
      return false
    }
  }

  /** 审计事件优先走 Runtime 注入的批写器；未注入时保持原有直接落库。 */
  private writeAuditEvents(events: NormalizedEventEnvelope[]): void {
    if (this.eventSink) {
      this.eventSink(events)
      return
    }
    this.repo.appendEvents(events)
  }

  /**
   * 授权未命中的审计事件：只记录本次调用的工具类别、原因与目标路径，
   * 不落原始参数（避免把文件内容写进事件库）。失败不阻塞审批流程。
   */
  private auditGrantMiss(
    input: ApprovalRequestInput,
    match: GrantMatch,
  ): void {
    // 旧路径没有 turn，不往 agent_events 写无归属的孤儿事件。
    if (legacySessionIdOf(input.runId ?? '', input.turnId ?? '') !== undefined) return
    try {
      // 先落盘缓冲中的高频事件，再按 DB max+1 计算 turn_seq。
      this.beforeAudit?.()
      const anchorTurn = input.turnId ?? input.subjectId ?? input.runId ?? 'no-turn'
      const seq = this.repo.listTurnEvents(anchorTurn).reduce((max, event) => Math.max(max, event.turn_seq), 0) + 1
      this.writeAuditEvents([
        {
          eventId: eventIdFor(anchorTurn, seq),
          // S8/D6:subject 审批无 run/turn,事件锚定到 subject(runId 同锚点)
          runId: input.runId ?? anchorTurn,
          turnId: input.turnId ?? anchorTurn,
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

  /**
   * D1 审计事件：写类工具被 git 元数据守卫直接否决。
   * 只记录工具名、命中规则、可读原因与目标路径（不落文件内容）。
   * 审计失败不得改变审批结果。
   */
  private auditPolicyBlock(input: ApprovalRequestInput, guard: GitDirGuardResult): void {
    // 旧路径没有 turn，不往 agent_events 写无归属的孤儿事件；拦截结果本身不受影响。
    if (legacySessionIdOf(input.runId ?? '', input.turnId ?? '') !== undefined) {
      logger.warn(`legacy policy block: ${input.toolName} ${guard.rule}: ${guard.reason}`)
      return
    }
    try {
      // 先落盘缓冲中的高频事件，再按 DB max+1 计算 turn_seq。
      this.beforeAudit?.()
      const anchorTurn = input.turnId ?? input.subjectId ?? input.runId ?? 'no-turn'
      const seq = this.repo.listTurnEvents(anchorTurn).reduce((max, event) => Math.max(max, event.turn_seq), 0) + 1
      this.writeAuditEvents([
        {
          eventId: eventIdFor(anchorTurn, seq),
          // S8/D6:subject 审批无 run/turn,事件锚定到 subject(runId 同锚点)
          runId: input.runId ?? anchorTurn,
          turnId: input.turnId ?? anchorTurn,
          seq,
          type: 'approval.policy_blocked',
          source: 'kernel',
          fidelity: 'turn',
          payloadVersion: 1,
          payload: {
            toolName: input.toolName,
            rule: guard.rule,
            reason: guard.reason,
            targets: guard.targets,
            gitDirs: guard.gitDirs,
          },
          timestamp: this.now(),
          ...(input.stepId ? { stepId: input.stepId } : {}),
        },
      ])
    } catch (error) {
      logger.warn(
        `policy block audit failed: ${error instanceof Error ? error.message : String(error)}`,
      )
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

  /** 该 pending 是否还有可能被兑现（所属 turn 仍是活 turn；旧路径则要求本进程仍在等待）。 */
  private isFulfillable(row: AgentApprovalRow): boolean {
    // S8/D6:subject 审批(test_plan/work_item)无 turn——可兑现性只看过期时间
    if (!row.turn_id) return row.expires_at > this.now()
    const turn = this.repo.getTurn(row.turn_id)
    if (turn) return LIVE_TURN_STATUSES.has(turn.status)
    // 旧路径没有 turn 行：只有本进程仍挂着 waiter 时才可能兑现。
    // 重启后 waiters 为空 → 与 turn 版本一致地判为不可兑现。
    return (
      legacySessionIdOf(row.run_id ?? '', row.turn_id ?? '') !== undefined && this.waiters.has(row.id)
    )
  }

  private replayRow(row: AgentApprovalRow, at: number): ApprovalRequestPayload {
    const expiresAt = at + row.timeout_ms
    this.repo.refreshApprovalExpiry(row.id, expiresAt, row.timeout_ms)
    const redacted = hasRedactionMeta(row.args_json)
    // 脱敏后的参数无法可靠复算策略规则，重放时不展示规则，避免给出误导性的「命中规则」。
    const policy = redacted
      ? null
      : bashPolicyFields(row.tool_name, parseArgsJson(row.args_json), row.cwd ?? undefined)
    const payload: ApprovalRequestPayload = {
      approvalId: row.id,
      runId: row.run_id ?? null,
      turnId: row.turn_id ?? null,
      sessionId:
        row.turn_id
          ? this.repo.getTurn(row.turn_id)?.session_id
          : legacySessionIdOf(row.run_id ?? '', row.turn_id ?? ''),
      stepId: row.step_id ?? undefined,
      workItemId: this.workItemIdOf(row.step_id),
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
      const policy = redacted ? null : bashPolicyFields(row.tool_name, parseArgsJson(row.args_json), row.cwd ?? undefined)
      return {
        approvalId: row.id,
        runId: row.run_id,
        turnId: row.turn_id,
        sessionId:
          row.turn_id
            ? this.repo.getTurn(row.turn_id)?.session_id
            : legacySessionIdOf(row.run_id ?? '', row.turn_id ?? ''),
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
    this.legacySessions.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const list of this.waiters.values()) {
      for (const waiter of list) {
        this.invokeOnSettled(waiter)
        waiter.reject(new AgentRuntimeError('APPROVAL_NOT_FOUND', 'Approval gateway disposed'))
      }
    }
    this.waiters.clear()
  }

  /** 只读展示辅助：编排步 → 所属任务（查不到即不展示，绝不影响审批判定）。 */
  private workItemIdOf(stepId: string | null | undefined): string | undefined {
    if (!stepId) return undefined
    return this.repo.getWorkItemIdByStep(stepId)
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
    for (const waiter of waiters) {
      this.invokeOnSettled(waiter)
      waiter.resolve(outcome)
    }
  }

  /** P1-1：等待结束回调异常不得改变审批结果。 */
  private invokeOnSettled(waiter: PendingWaiter): void {
    try {
      waiter.onSettled?.()
    } catch (error) {
      logger.warn(`approval onSettled hook failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private outcomeFromRow(row: AgentApprovalRow, autoGranted = false): ApprovalOutcome {
    const grantSourceApprovalId = row.grant_source ?? (this.sessionGrantedApprovals.has(row.id) ? row.id : undefined)
    return {
      approvalId: row.id,
      decision: row.status === 'allowed' ? 'allow' : 'deny',
      decidedBy: row.decided_by ?? 'system',
      argsHash: row.args_hash,
      decidedAt: row.decided_at ?? row.created_at,
      ...(row.decision_note ? { reason: row.decision_note } : {}),
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
      runId: row.run_id ?? null,
      turnId: row.turn_id ?? null,
      decision: row.status === 'allowed' ? 'allow' : 'deny',
      decidedBy: row.decided_by ?? 'system',
      argsHash: row.args_hash,
      decidedAt: row.decided_at ?? row.created_at,
      ...(granted ? { sessionGranted: true } : {}),
      ...(grantSourceApprovalId ? { grantSourceApprovalId } : {}),
    }
  }
}
