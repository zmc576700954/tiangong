/**
 * W5-A：启动恢复的执行层。
 *
 * 复用 `recovery/planner` 的只读规划（`planRecovery` → `applyRecoveryPlan` → `assertNoDangling`），
 * 在规划之前补两件事：
 * 1. 进程残留回收：**只处理可证明归属者**（pid + 持久化句柄证据 + env marker）。
 *    证据不足时绝不调用 `killRegistered`，因此 `killCalls` 必须为 0；
 * 2. 产出启动报告并落库（`startup.reconcile` 系统事件，可被现有事件查询看到）。
 *
 * 归属证据的最低要求与 `process/reaper` 一致：至少两项独立证据且至少一项是内容证据
 * （完整命令行 / marker），或「可信句柄 + 精确 startedAt + 自有进程组组长」的结构绑定。
 * 不要把裸 pid 当凭证。
 */

import type { NormalizedEventEnvelope, RecoveryReport, ResidualRisk } from '@shared/types/agent-runtime'
import type { AgentRepository } from './db/repository'
import type { ProcIdentity, ProcInfo, ProcessReaper, ReapReport } from './process/reaper'
import { attestProcIdentity, captureHiResStart, listProcesses, proveOwnership } from './process/reaper'
import { applyRecoveryPlan, assertNoDangling, planRecovery } from './recovery/planner'
import { eventIdFor } from './util'
import { createLogger } from '../../shared/logger'
import {
  listProcRegistryRecords,
  removeProcRegistryRecord,
  verifyProcRegistryFile,
  type ProcRegistryRecord,
} from '../../shared/process-supervisor'

const logger = createLogger('StartupReconciler')

/** `killRegistered` 的最小依赖面：便于测试注入计数 spy。 */
export type Reclaimer = Pick<ProcessReaper, 'killRegistered'>

export interface StartupReconcilerOptions {
  repo: AgentRepository
  reaper: Reclaimer
  /** 实时进程表（默认 `listProcesses`）；测试可注入。 */
  listProcesses?: () => ProcInfo[]
  /** 进程自注册记录（默认 `listProcRegistryRecords`）。 */
  listRegistryRecords?: () => ProcRegistryRecord[]
  verifyRegistryRecord?: (record: ProcRegistryRecord) => boolean
  removeRegistryRecord?: (marker: string) => void
  /**
   * 事件落地：默认直接 `repo.appendEvents`。
   * Runtime 会注入事件批写器，保证启动事件与后续事件同一写入序列。
   */
  eventSink?: (events: NormalizedEventEnvelope[]) => void
  /** planRecovery 之前执行（Runtime 用它收口启动前已过期的 running turn）。 */
  beforePlan?: () => void
  now?: () => number
}

export interface StartupReconcileResult extends RecoveryReport {
  /**
   * 本次启动实际调用 `killRegistered` 的次数。
   * 归属证据不足的候选不会进入该计数——验收断言「无法证明时 kill 调用数 = 0」。
   */
  killCalls: number
}

interface AuditInput {
  sessionId: string
  turnId: string
  runId: string
  report: ReapReport | null
  durationMs: number
  extraUnresolved?: Array<{ pid: number; reason: string; matched: string[] }>
}

export class StartupReconciler {
  private readonly repo: AgentRepository
  private readonly reaper: Reclaimer
  private readonly list: () => ProcInfo[]
  private readonly registryRecords: () => ProcRegistryRecord[]
  private readonly verifyRecord: (record: ProcRegistryRecord) => boolean
  private readonly removeRecord: (marker: string) => void
  private readonly eventSink: (events: NormalizedEventEnvelope[]) => void
  private readonly beforePlan: (() => void) | undefined
  private readonly now: () => number

  constructor(options: StartupReconcilerOptions) {
    this.repo = options.repo
    this.reaper = options.reaper
    this.list = options.listProcesses ?? listProcesses
    this.registryRecords = options.listRegistryRecords ?? listProcRegistryRecords
    this.verifyRecord = options.verifyRegistryRecord ?? verifyProcRegistryFile
    this.removeRecord = options.removeRegistryRecord ?? removeProcRegistryRecord
    this.eventSink = options.eventSink ?? ((events) => this.repo.appendEvents(events))
    this.beforePlan = options.beforePlan
    this.now = options.now ?? Date.now
  }

  /**
   * 执行启动恢复。顺序：残留回收 → beforePlan（过期 turn 收口）→ planRecovery → apply → assert。
   */
  reconcile(): StartupReconcileResult {
    let reactiveKills = 0
    let registryKills = 0
    let killCalls = 0
    const reclaimedSessions: RecoveryReport['reclaimedSessions'] = []
    const live = this.list()

    const candidates = [
      ...this.repo.listSessionsByStatus('orphaned'),
      ...this.repo.listSessionsByStatus('active'),
      ...this.repo.listSessionsByStatus('starting'),
    ]
    const knownMarkers = new Set(
      candidates.map((session) => session.executor_env_marker).filter((value): value is string => Boolean(value)),
    )
    const markerSessions = new Map<string, (typeof candidates)[number]>()
    for (const session of candidates) {
      if (session.executor_env_marker) markerSessions.set(session.executor_env_marker, session)
    }

    const seen = new Set<string>()
    for (const session of candidates) {
      if (seen.has(session.id)) continue
      seen.add(session.id)
      const marker = session.executor_env_marker
      const identity = sessionIdentity(session)
      const startedReap = this.now()

      let report: ReapReport | null = null
      let dispatched = false
      let proof: ReturnType<typeof proveOwnership> | null = null

      if (identity) {
        const current = live.find((proc) => proc.pid === identity.pid)
        proof = proveOwnership(identity, current, marker ?? undefined, currentHiResOf(identity))
        const provable = isProvable(identity, proof, current)
        if (provable) {
          dispatched = true
          killCalls += 1
          report = this.reaper.killRegistered([identity], { marker: marker ?? undefined })
        }
      }

      const reapDurationMs = Math.max(0, this.now() - startedReap)
      const killedPids = report?.killedPids ?? []
      const kills = killedPids.length
      reactiveKills += kills
      // 分层回收的残缺口径：
      // - 有本轮句柄且可证明 → 按回收报告判定；
      // - 无句柄但有 marker → unconfirmed（有线索但不可证明）；
      // - 无句柄且无 marker，但已经跑过 turn（或 Codex 旧路径）→ 同样 unconfirmed：
      //   旧路径不写 env marker / 不登记句柄，无法证明残留为 0，必须让风险可见。
      const legacyUnregistered =
        !identity &&
        !marker &&
        (isLegacyCodexExecutor(session.executor) || Boolean(session.last_turn_id))
      const residualRisk = report
        ? classifyResidual(report, Boolean(marker))
        : proof?.reason === 'not-found'
          ? 'none'
          : proof
            ? 'unconfirmed'
            : legacyUnregistered
              ? 'unconfirmed'
              : classifyResidual(null, Boolean(marker))
      const unresolved = report
        ? report.unresolved.map((item) => `${item.pid}:${item.matched.join('+') || 'none'}:${item.reason}`)
        : proof && proof.reason !== 'not-found'
          ? `${proof.pid}:${proof.matched.join('+') || 'none'}:${proof.reason}`
          : ''
      const note = `startup reclaim: marker=${marker ?? 'none'} dispatched=${dispatched} pids=${killedPids.join(',') || '-'} groups=${(report?.killedGroups ?? []).join(',') || '-'} missing=${(report?.missing ?? []).join(',') || '-'} unresolved=${unresolved || '-'} residualRisk=${residualRisk}`
      this.repo.recordSessionRecovery(session.id, { kills, note, clearProc: true, residualRisk }, this.now())
      if (residualRisk === 'none') logger.info(note)
      else logger.warn(note)

      // 实际处置（含「证明不足未回收」）都独立留痕。
      if (report && (kills > 0 || report.unresolved.length > 0)) {
        const knownTurn = session.last_turn_id ? this.repo.getTurn(session.last_turn_id) : undefined
        this.emitReclaimAudit({
          sessionId: session.id,
          turnId: knownTurn?.id ?? `startup:${session.id}:${this.now()}`,
          runId: knownTurn?.run_id ?? `startup:${session.id}:${this.now()}`,
          report,
          durationMs: reapDurationMs,
        })
      } else if (!dispatched && proof && proof.reason !== 'not-found') {
        const knownTurn = session.last_turn_id ? this.repo.getTurn(session.last_turn_id) : undefined
        this.emitReclaimAudit({
          sessionId: session.id,
          turnId: knownTurn?.id ?? `startup:${session.id}:${this.now()}`,
          runId: knownTurn?.run_id ?? `startup:${session.id}:${this.now()}`,
          report: null,
          durationMs: reapDurationMs,
          extraUnresolved: [{ pid: proof.pid, reason: proof.reason, matched: proof.matched }],
        })
      }

      reclaimedSessions.push({
        sessionId: session.id,
        marker,
        killed: kills,
        killedPids,
        killedGroups: report?.killedGroups ?? [],
        residualRisk,
        note,
      })
    }

    // 进程自注册文件兜底（Codex 监督 shim 写的 pid/pgid/startedAt/command）。
    for (const record of this.registryRecords()) {
      if (!this.isKnownMarker(record.marker, knownMarkers)) {
        logger.warn(`ignore unknown registry record: marker=${record.marker} pid=${record.pid}`)
        continue
      }
      if (!this.verifyRecord(record)) {
        logger.warn(`ignore unverifiable registry record: marker=${record.marker} pid=${record.pid}`)
        this.auditRegistryRecord(record, markerSessions, null, [{ pid: record.pid, reason: 'unverifiable-record', matched: [] }])
        continue
      }

      const fields = {
        pid: record.pid,
        pgid: record.pgid,
        startedAt: record.startedAt,
        startedAtHiRes: record.startedAtHiRes,
        command: record.command,
      }
      const identity = withAttestation(fields)
      const current = live.find((proc) => proc.pid === identity.pid)
      const proof = proveOwnership(identity, current, record.marker, currentHiResOf(identity))
      if (!isProvable(identity, proof, current)) {
        // 证据不足 → 不杀，只告警 + 审计。
        logger.warn(
          `registry record not provable: marker=${record.marker} pid=${record.pid} matched=${proof.matched.join('+') || 'none'}`,
        )
        this.auditRegistryRecord(record, markerSessions, null, [
          { pid: record.pid, reason: proof.reason, matched: proof.matched },
        ])
        continue
      }

      killCalls += 1
      const report = this.reaper.killRegistered([identity], { marker: record.marker })
      registryKills += report.killedPids.length
      reactiveKills += report.killedPids.length
      if (report.killedPids.length > 0 || report.unresolved.length > 0) {
        this.auditRegistryRecord(record, markerSessions, report, undefined)
      }
      const note = `startup registry reclaim: marker=${record.marker} pids=${report.killedPids.join(',') || '-'} groups=${report.killedGroups.join(',') || '-'} missing=${report.missing.join(',') || '-'} unresolved=${report.unresolved.length}`
      if (report.killedPids.length > 0) logger.info(note)
      else logger.debug(note)
      // 已处理（回收成功或进程已消失）的记录立即失效，防止重放。
      if (report.killedPids.length > 0 || report.missing.length > 0) {
        this.removeRecord(record.marker)
      }
    }

    this.beforePlan?.()

    const planned = planRecovery(this.repo)
    applyRecoveryPlan(this.repo, planned)
    assertNoDangling(this.repo)

    return {
      plans: planned.plans,
      interruptedRuns: planned.interruptedRuns,
      abortedTurns: planned.abortedTurns,
      orphanedSessions: planned.orphanedSessions,
      pendingApprovals: planned.pendingApprovals,
      reactiveKills,
      registryKills,
      reclaimedSessions,
      residualRiskSessions: reclaimedSessions.filter((session) => session.residualRisk !== 'none').length,
      killCalls,
    }
  }

  /**
   * 启动报告落库：写一条 `startup.reconcile` 系统事件。
   * 系统事件没有对应 turn 行，因此不会被事件保留策略清理，可长期审计。
   */
  persistReport(report: RecoveryReport & { killCalls?: number }): void {
    const at = this.now()
    const anchor = `system:startup:${at}`
    const plans = report.plans.slice(0, 200)
    try {
      this.eventSink([
        {
          eventId: eventIdFor(anchor, 1),
          runId: anchor,
          turnId: anchor,
          seq: 1,
          type: 'startup.reconcile',
          source: 'kernel',
          fidelity: 'turn',
          payloadVersion: 1,
          payload: {
            interruptedRuns: report.interruptedRuns,
            abortedTurns: report.abortedTurns,
            orphanedSessions: report.orphanedSessions,
            pendingApprovals: report.pendingApprovals,
            deniedStaleApprovals: report.deniedStaleApprovals ?? 0,
            reactiveKills: report.reactiveKills,
            registryKills: report.registryKills ?? 0,
            residualRiskSessions: report.residualRiskSessions,
            killCalls: report.killCalls ?? 0,
            planCount: report.plans.length,
            plansTruncated: report.plans.length > plans.length,
            plans,
            reclaimedSessions: report.reclaimedSessions,
          },
          timestamp: at,
        },
      ])
    } catch (error) {
      logger.warn(`startup report persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private isKnownMarker(marker: string, known: ReadonlySet<string>): boolean {
    if (known.has(marker)) return true
    const prefix = 'bizgraph-turn:'
    if (!marker.startsWith(prefix)) return false
    return Boolean(this.repo.getTurn(marker.slice(prefix.length)))
  }

  private auditRegistryRecord(
    record: ProcRegistryRecord,
    markerSessions: Map<string, { id: string; last_turn_id: string | null }>,
    report: ReapReport | null,
    extraUnresolved?: AuditInput['extraUnresolved'],
  ): void {
    const session = markerSessions.get(record.marker)
    const markerTurnId = record.marker.startsWith('bizgraph-turn:')
      ? record.marker.slice('bizgraph-turn:'.length)
      : undefined
    const markerTurn = markerTurnId ? this.repo.getTurn(markerTurnId) : undefined
    const knownTurn = markerTurn ?? (session?.last_turn_id ? this.repo.getTurn(session.last_turn_id) : undefined)
    this.emitReclaimAudit({
      sessionId: knownTurn?.session_id ?? session?.id ?? 'unknown',
      turnId: knownTurn?.id ?? `startup:${record.marker}:${this.now()}`,
      runId: knownTurn?.run_id ?? `startup:${record.marker}:${this.now()}`,
      report,
      durationMs: 0,
      extraUnresolved,
    })
  }

  /**
   * 独立审计：缓存到既有 append-only `agent_events`（`process.reclaimed`），
   * 失败不影响回收/收口。
   */
  private emitReclaimAudit(input: AuditInput): void {
    const report = input.report
    const unresolved = [
      ...(report?.unresolved.map((proof) => ({
        pid: proof.pid,
        reason: proof.reason,
        matched: proof.matched,
      })) ?? []),
      ...(input.extraUnresolved ?? []),
    ]
    const pids = report?.killedPids ?? []
    const pgids = report?.killedGroups ?? []
    const method = pgids.length > 0 ? 'pgid' : pids.length > 0 ? 'pid-tree' : 'none'
    const success = unresolved.length === 0 && (report?.stillAlive.length ?? 0) === 0
    try {
      const seq = this.repo.listTurnEvents(input.turnId).reduce((max, event) => Math.max(max, event.seq), 0) + 1
      this.eventSink([
        {
          eventId: eventIdFor(input.turnId, seq),
          runId: input.runId,
          turnId: input.turnId,
          seq,
          type: 'process.reclaimed',
          source: 'kernel',
          fidelity: 'turn',
          payloadVersion: 1,
          payload: {
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: 'startup-reclaim',
            method,
            pids,
            pgids,
            success,
            unresolved,
            durationMs: input.durationMs,
            evidence: report?.evidence ?? [],
          },
          timestamp: this.now(),
        },
      ])
    } catch (error) {
      logger.warn(`process.reclaimed audit append failed: ${String(error)}`)
    }
  }
}

/**
 * §6.5：`unconfirmed` 表示有 pid/marker 线索但证据不足；`possible` 表示已证明归属
 * 但 SIGKILL 后仍存活；`none` 表示无迹象或已确认不存在。
 */
export function classifyResidual(report: ReapReport | null, hadMarker: boolean): ResidualRisk {
  if (report) {
    if (report.unresolved.length > 0) return 'unconfirmed'
    if (report.stillAlive.length > 0) return 'possible'
  }
  // 完全没有任何可核对句柄时，marker 只是线索，不能宣称残留为 0。
  if (hadMarker && (!report || report.discovered === 0)) return 'unconfirmed'
  return 'none'
}

/**
 * Codex 旧路径：没有 env marker、也没有把真实句柄落库，重启后无法证明子进程归属。
 * 这类 session 的 residual_risk 必须显式为 unconfirmed，不能因为「查不到 pid」就报 none。
 */
function isLegacyCodexExecutor(executor: string | null | undefined): boolean {
  if (!executor) return false
  return /^codex/i.test(executor)
}

function sessionIdentity(session: {
  executor_pid: number | null
  executor_pgid: number | null
  executor_cmd: string | null
  executor_started_at: string | null
}): ProcIdentity | null {
  if (!session.executor_pid) return null
  return withAttestation({
    pid: session.executor_pid,
    pgid: session.executor_pgid ?? undefined,
    command: session.executor_cmd ?? undefined,
    startedAt: session.executor_started_at ?? undefined,
  })
}

function withAttestation(fields: {
  pid: number
  pgid?: number
  startedAt?: string
  startedAtHiRes?: string
  command?: string
}): ProcIdentity {
  try {
    return { ...fields, attestation: attestProcIdentity(fields) }
  } catch {
    return { ...fields }
  }
}

/** Linux 高精度启动标识；其它平台返回 undefined（与 reaper 口径一致）。 */
function currentHiResOf(identity: ProcIdentity): string | undefined {
  if (identity.startedAtHiRes === undefined) return undefined
  return captureHiResStart(identity.pid)
}

/**
 * 预检：至少两项证据且含内容证据（proof.proved），或可信句柄的结构绑定
 * （精确 startedAt + pgid === pid 且实时仍是组长）。两者都不成立 → 不调用 kill。
 */
function isProvable(
  identity: ProcIdentity,
  proof: ReturnType<typeof proveOwnership>,
  current: ProcInfo | undefined,
): boolean {
  if (proof.reason === 'not-found') return false
  if (proof.proved) return true
  // 可信句柄的结构绑定：精确 startedAt + pgid === pid 且实时仍是同一组长。
  return (
    proof.matched.includes('startedAt') &&
    identity.pgid !== undefined &&
    identity.pgid === identity.pid &&
    current?.pgid === identity.pid
  )
}
