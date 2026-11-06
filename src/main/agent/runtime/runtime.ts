/**
 * D2/D3/D5 组合根：runNode（一节点一 turn）、取消、启动对账。
 *
 * 明确边界：
 * - 锁是显式上下文传参，不在调用栈里猜归属；
 * - 恢复只到「最后一个已持久化事件 + stepOutcomes 对账」；
 * - 取消先杀进程组，再 abort SDK，最后写 cancelled。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  AgentStorageStats,
  BackendDriver,
  CostRates,
  DriverExecuteRequest,
  DriverUsage,
  Fidelity,
  NormalizedEventEnvelope,
  RecoveryReport,
  ResidualRisk,
  RunNodeRequest,
  StepStatus,
  TurnOutcome,
  TurnStatus,
} from '@shared/types/agent-runtime'
import {
  AgentRepository,
  DEFAULT_EVENT_RETENTION,
  MAX_RETENTION_BATCH_SIZE,
  type AgentTurnRow,
  type EventRetentionPolicy,
  type EventRetentionResult,
} from './db/repository'
import { UsageLedger } from './cost/ledger'
import { loadPricing, costRatesToEntries } from './cost/pricing'
import { ApprovalGateway, type ApprovalNotifier } from './approval/gateway'
import { SessionBusyError, NodeBusyError, AgentRuntimeError } from './errors'
import { nodeLockKey, ROOT_LOCK_CONTEXT, SessionLockRegistry, sessionLockKey } from './locks/session-lock'
import { attestProcIdentity, ProcessReaper, type ProcIdentity, type ReapReport } from './process/reaper'
import {
  listProcRegistryRecords,
  readProcRegistryRecord,
  removeProcRegistryRecord,
  verifyProcRegistryFile,
} from '../../shared/process-supervisor'
import { applyRecoveryPlan, assertNoDangling, planRecovery } from './recovery/planner'
import { hashArgs, eventIdFor } from './util'
import { createLogger } from '../../shared/logger'

export interface AgentRuntimeOptions {
  db: BetterSqlite3.Database
  repo?: AgentRepository
  locks?: SessionLockRegistry
  reaper?: ProcessReaper
  approvals?: ApprovalGateway
  approvalNotifier?: ApprovalNotifier
  rates?: CostRates
  /** 事件保留策略（默认 90 天 / 每批 500 行）；enabled=false 时不启动定时清理 */
  retention?: Partial<EventRetentionPolicy> & { enabled?: boolean }
  /** 事件实时旁路（渲染层/IPC）；持久化永远先发生 */
  onEvent?: (event: NormalizedEventEnvelope) => void
  now?: () => number
}

interface TurnInputSnapshot {
  agentSessionId: string
  adapterSessionId: string
  prompt: string
  commandType: string
  workingDirectory: string
  executor: string
  nodeId: string
  graphId?: string
}

const TERMINAL: TurnStatus[] = ['completed', 'failed', 'cancelled', 'orphaned']

/** 后端是否真的报了用量：四项全 0 视为「没报」，避免落 0 值行。 */
function hasReportedUsage(usage: DriverUsage): boolean {
  return (
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0 ||
    (usage.cachedInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0
  )
}

/**
 * residual_risk 判定（§6.5 / 验收口径）：
 * - unconfirmed：有 pid/marker 线索，但归属证据不足，拒绝回收；
 * - possible：归属已证明，但 SIGKILL 后仍存活（未能确认退出）；
 * - none：已证明并确认不存在，或完全没有线索。
 */
function classifyResidual(report: ReapReport | null, hadMarker: boolean): ResidualRisk {
  if (report) {
    if (report.unresolved.length > 0) return 'unconfirmed'
    if (report.stillAlive.length > 0) return 'possible'
  }
  // 完全没有任何可核对句柄（SDK 隐式子进程）时，marker 只是线索，不能宣称残留为 0
  if (hadMarker && (!report || report.discovered === 0)) return 'unconfirmed'
  return 'none'
}

export class AgentRuntime {
  readonly repo: AgentRepository
  readonly locks: SessionLockRegistry
  readonly approvals: ApprovalGateway
  readonly reaper: ProcessReaper
  /** M1 成本账本：usage 落库 + 图日汇总/turn 明细只读查询 */
  readonly usageLedger: UsageLedger
  private readonly drivers = new Map<string, BackendDriver>()
  private readonly onEvent: ((event: NormalizedEventEnvelope) => void) | undefined
  private readonly now: () => number
  private readonly logger = createLogger('AgentRuntime')
  private readonly retentionPolicy: EventRetentionPolicy
  private readonly retentionEnabled: boolean
  private retentionTimer: NodeJS.Timeout | null = null

  constructor(options: AgentRuntimeOptions) {
    this.repo = options.repo ?? new AgentRepository(options.db)
    this.locks = options.locks ?? new SessionLockRegistry()
    this.reaper = options.reaper ?? new ProcessReaper()
    this.approvals =
      options.approvals ??
      new ApprovalGateway({
        db: options.db,
        repo: this.repo,
        notifier: options.approvalNotifier,
        now: options.now,
      })
    this.onEvent = options.onEvent
    this.now = options.now ?? Date.now
    this.retentionEnabled = options.retention?.enabled !== false
    this.retentionPolicy = AgentRuntime.normalizeRetention(options.retention)
    // rates（settings.agentRuntime.costRates）作为最高优先级的配置层；
    // 未配置的 (executor, model) 回落基础表（内置/BIZGRAPH_PRICING_PATH）。
    this.usageLedger = new UsageLedger(
      options.db,
      loadPricing(),
      options.rates ? costRatesToEntries(options.rates) : [],
    )
  }

  private static normalizeRetention(input?: Partial<EventRetentionPolicy>): EventRetentionPolicy {
    const days =
      typeof input?.retentionDays === 'number' && input.retentionDays > 0
        ? Math.floor(input.retentionDays)
        : DEFAULT_EVENT_RETENTION.retentionDays
    const batch =
      typeof input?.batchSize === 'number' && input.batchSize > 0
        ? Math.min(Math.floor(input.batchSize), MAX_RETENTION_BATCH_SIZE)
        : DEFAULT_EVENT_RETENTION.batchSize
    return { retentionDays: days, batchSize: batch }
  }

  /** 启动一次清理，然后每 24h 一次；重复调用不会叠加定时器。 */
  startEventRetention(intervalMs = 24 * 60 * 60 * 1000): void {
    if (!this.retentionEnabled || this.retentionTimer) return
    this.runEventRetentionNow()
    this.retentionTimer = setInterval(() => this.runEventRetentionNow(), intervalMs)
    this.retentionTimer.unref?.()
  }

  /**
   * 立即执行一次事件清理，并把结果（删除行数、时间范围、跳过原因）写入日志与一条系统事件。
   * 只清 `agent_events`；成本账本与审批台账不受影响。
   */
  runEventRetentionNow(): EventRetentionResult {
    const result = this.repo.runEventRetention(this.retentionPolicy, this.now())
    const range =
      result.oldestDeletedAt === null
        ? 'n/a'
        : `${new Date(result.oldestDeletedAt).toISOString()}..${new Date(result.newestDeletedAt!).toISOString()}`
    this.logger.info(
      `[retention] deleted=${result.deletedRows} rows batches=${result.batches} cutoff=${new Date(result.cutoff).toISOString()} range=${range} skipped=${result.skipped.length}`,
    )
    for (const skip of result.skipped) {
      this.logger.warn(`[retention] skip turn=${skip.turnId} reason=${skip.reason} rows=${skip.eventRows}`)
    }
    this.writeRetentionEvent(result)
    return result
  }

  /** 系统事件：保留策略的每次执行都留一条可查记录（无 turn 行 → 自身永不被清理）。 */
  private writeRetentionEvent(result: EventRetentionResult): void {
    try {
      const at = this.now()
      const runId = `system:retention:${at}`
      this.repo.appendEvents([
        {
          eventId: eventIdFor(runId, 1),
          runId,
          turnId: runId,
          seq: 1,
          type: 'retention.cleanup',
          source: 'kernel',
          fidelity: 'turn',
          payloadVersion: 1,
          payload: {
            cutoff: result.cutoff,
            retentionDays: result.retentionDays,
            batchSize: result.batchSize,
            deletedRows: result.deletedRows,
            batches: result.batches,
            oldestDeletedAt: result.oldestDeletedAt,
            newestDeletedAt: result.newestDeletedAt,
            skipped: result.skipped.slice(0, 50),
          },
          timestamp: at,
        },
      ])
    } catch (error) {
      this.logger.warn(`retention system event failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 存储统计 + 当前策略；不执行 VACUUM（SQLite 会复用空闲页，VACUUM 长时间锁库）。 */
  getStorageStats(): AgentStorageStats {
    return {
      ...this.repo.getEventStorageStats(),
      retentionDays: this.retentionPolicy.retentionDays,
      batchSize: this.retentionPolicy.batchSize,
    }
  }

  registerDriver(executor: string, driver: BackendDriver): void {
    this.drivers.set(executor, driver)
  }

  getDriver(executor: string): BackendDriver | undefined {
    return this.drivers.get(executor)
  }

  /**
   * kernel 正在执行（记账）的会话集合。
   *
   * 同一轮里 kernel 会从 driver 结果记一条 `turn:<turnId>`，而 legacy 的
   * `onAdapterUsage` 仍会透传同一次上报，形成 `legacy:<adapter>:<session>:<turnSeq>`
   * 的第二条记录（约 2x 虚高）。这里标记「kernel 记账中」，让 legacy 路径放弃本轮：
   * 同一轮只有一个记账 owner，不做放宽 dedupe 的合并。
   */
  private readonly kernelActiveSessions = new Map<string, number>()

  private retainKernelSessions(ids: Array<string | undefined>): void {
    for (const id of new Set(ids.filter((v): v is string => !!v))) {
      this.kernelActiveSessions.set(id, (this.kernelActiveSessions.get(id) ?? 0) + 1)
    }
  }

  private releaseKernelSessions(ids: Array<string | undefined>): void {
    for (const id of new Set(ids.filter((v): v is string => !!v))) {
      const next = (this.kernelActiveSessions.get(id) ?? 0) - 1
      if (next <= 0) this.kernelActiveSessions.delete(id)
      else this.kernelActiveSessions.set(id, next)
    }
  }

  async runNode(request: RunNodeRequest): Promise<TurnOutcome> {
    const ids = [request.agentSessionId, request.adapterSessionId ?? request.agentSessionId]
    this.retainKernelSessions(ids)
    try {
      return await this.runNodeInner(request)
    } finally {
      this.releaseKernelSessions(ids)
    }
  }

  /** 该会话是否有一颗 kernel turn 正在执行（供 legacy usage 路径去重）。 */
  hasActiveTurn(sessionId: string): boolean {
    return this.kernelActiveSessions.has(sessionId)
  }

  private async runNodeInner(request: RunNodeRequest): Promise<TurnOutcome> {
    const branchKey = request.branchKey ?? ''
    const attempt = request.attempt ?? 1
    const resumeMode = request.resumeMode ?? 'native'
    // 幂等键组成（统一以 session 开头）：
    //   显式 key  → `<session>:<callerKey>`（caller 重试仍命中，跨会话天然不同）
    //   缺省 key  → `<runId | dispatch:uuid>:<session>:<node>:<branch>:<attempt>:<promptHash>`
    // 缺省且无 runId 时用一次性 dispatchId：不传幂等键的调用等于「新请求」，
    // 否则同会话同 prompt 的第二次发送会命中上一条已终态 turn 被静默复用。
    // session 参与键 + findTurnByIdempotencyKey 再按 session 过滤 → 跨会话绝不命中。
    const dispatchScope = request.runId ?? `dispatch:${randomUUID()}`
    const idempotencyKey = request.idempotencyKey
      ? `${request.agentSessionId}:${request.idempotencyKey}`
      : `${dispatchScope}:${request.agentSessionId}:${request.nodeId}:${branchKey}:${attempt}:${hashArgs('prompt', { prompt: request.prompt })}`

    const existing = this.repo.findTurnByIdempotencyKey(idempotencyKey, request.agentSessionId)
    if (existing) {
      if (!TERMINAL.includes(existing.status)) {
        throw new SessionBusyError(`turn:${existing.id}`)
      }
      return this.outcomeFromTurn(existing, true)
    }

    // M1 产品决定：账本只记录，不因成本拒绝任何新 turn（无成本准入拦截）。
    const run = request.runId
      ? this.repo.getRun(request.runId)
      : this.repo.insertRun({
          threadId: request.threadId ?? `thread-${request.nodeId}`,
          nodeId: request.nodeId,
          graphId: request.graphId,
          executor: request.executor,
          now: this.now(),
        })
    if (!run) {
      throw new AgentRuntimeError('TURN_NOT_FOUND', `Run not found: ${request.runId}`)
    }

    // 会话行在拿到锁、通过节点预检之后才创建/激活：fail-fast 返回时不留下悬空 active 会话。
    const preExistingSession = this.repo.getSession(request.agentSessionId)
    const adapterSessionId = preExistingSession?.runtime_session_id ?? request.adapterSessionId ?? request.agentSessionId

    const driver = this.drivers.get(request.executor)
    if (!driver) {
      throw new AgentRuntimeError('EXECUTOR_CONFIG_INVALID', `No backend driver registered for ${request.executor}`)
    }

    const snapshot: TurnInputSnapshot = {
      agentSessionId: request.agentSessionId,
      adapterSessionId,
      prompt: request.prompt,
      commandType: request.commandType ?? 'implement',
      workingDirectory: request.workingDirectory,
      executor: request.executor,
      nodeId: request.nodeId,
      graphId: request.graphId,
    }

    return this.locks.withLock(sessionLockKey(snapshot.adapterSessionId), idempotencyKey, ROOT_LOCK_CONTEXT, async (sessionCtx) => {
      // 节点锁冲突属于 NODE_BUSY，不能与 SESSION_BUSY 混淆；此处无 await，检查与加锁原子
      if (this.locks.isBusy(nodeLockKey(request.nodeId, branchKey))) {
        throw new NodeBusyError(request.nodeId, branchKey)
      }
      return this.locks.withLock(nodeLockKey(request.nodeId, branchKey), idempotencyKey, sessionCtx, async () => {
        // 同节点并发：唯一索引兜底，先做友好预检
        if (this.repo.countActiveTurnsByNode(request.nodeId, branchKey) > 0) {
          throw new NodeBusyError(request.nodeId, branchKey)
        }

        const session =
          preExistingSession ??
          this.repo.insertSession({
            id: request.agentSessionId,
            graphId: request.graphId,
            nodeId: request.nodeId,
            threadId: request.threadId,
            executor: request.executor,
            runtimeSessionId: adapterSessionId,
            status: 'active',
            now: this.now(),
          })

        const turn = this.insertTurn(run.id, session.id, request, branchKey, attempt, resumeMode, idempotencyKey, snapshot)
        this.repo.updateSessionStatus(session.id, 'active', this.now())
        this.repo.touchSessionTurn(session.id, turn.id, this.now())
        this.repo.updateRunStatus(run.id, 'running', this.now())

        // P0-1：marker 唯一标识本轮，并真正落库（不再只存在于内存）
        const envMarker = `bizgraph-turn:${turn.id}`
        this.repo.updateSessionProcess(session.id, { envMarker }, this.now())
        this.reaper.registerProcess(turn.id, { envMarker })

        let seq = 0
        let finalStatus: TurnStatus = 'failed'
        let finalText: string | undefined
        const controller = new AbortController()
        this.abortControllers.set(turn.id, controller)

        const record = (events: NormalizedEventEnvelope[]) => {
          if (events.length === 0) return
          // P0-3：step 主键带 turn 作用域，防止第二轮覆盖第一轮同节点 step 行
          const normalized = events.map((event) => {
            seq += 1
            return {
              ...event,
              ...(event.stepId ? { stepId: scopeStepId(turn.id, event.stepId) } : {}),
              seq,
              eventId: eventIdFor(turn.id, seq),
              runId: run.id,
              turnId: turn.id,
            }
          })
          const assigned = this.repo.appendEvents(normalized)
          normalized.forEach((event, index) => {
            this.syncStepFromEvent(event)
            if (this.onEvent) {
              this.onEvent({ ...event, seq: assigned[index] })
            }
          })
        }

        record([
          {
            eventId: eventIdFor(turn.id, 1),
            runId: run.id,
            turnId: turn.id,
            seq: 0,
            type: 'turn.started',
            source: 'kernel',
            fidelity: 'turn',
            payloadVersion: 1,
            payload: { attempt, resumeMode, branchKey, promptHash: hashArgs('prompt', { prompt: request.prompt }) },
            timestamp: this.now(),
          },
        ])

        const driverRequest: DriverExecuteRequest = {
          runId: run.id,
          turnId: turn.id,
          graphId: request.graphId,
          nodeId: request.nodeId,
          agentSessionId: snapshot.adapterSessionId,
          prompt: request.prompt,
          commandType: snapshot.commandType,
          workingDirectory: request.workingDirectory,
        }

        const context = {
          record,
          approvals: {
            request: (input: Omit<Parameters<ApprovalGateway['request']>[0], 'runId' | 'turnId'>) =>
              this.approvals.request({
                ...input,
                sessionId: session.id,
                ...(input.stepId ? { stepId: scopeStepId(turn.id, input.stepId) } : {}),
                runId: run.id,
                turnId: turn.id,
              }),
            peek: (input: Omit<Parameters<ApprovalGateway['request']>[0], 'runId' | 'turnId'>) =>
              this.approvals.peekSessionGrant({
                sessionId: session.id,
                toolName: input.toolName,
                args: input.args,
                cwd: input.cwd,
              }),
          },
          step: {
            ensure: (
              stepId: string,
              input: { kind: string; toolName?: string; argsHash?: string; fidelity: Fidelity; status: StepStatus },
            ) => {
              this.repo.upsertStep({
                id: scopeStepId(turn.id, stepId),
                turnId: turn.id,
                kind: input.kind,
                toolName: input.toolName,
                argsHash: input.argsHash,
                fidelity: input.fidelity,
                status: input.status,
              })
            },
            update: (
              stepId: string,
              status: StepStatus,
              extra?: { resultRef?: string; executingAt?: number; approvedAt?: number },
            ) => {
              this.repo.updateStepStatus(scopeStepId(turn.id, stepId), status, extra, this.now())
            },
          },
          signal: controller.signal,
          envMarker,
          registerProcess: (proc: {
            pid?: number
            pgid?: number
            envMarker?: string
            startedAt?: string
            startedAtHiRes?: string
            command?: string
          }) => {
            // 句柄一出现就抓取归属证据（start time + command）并落库：
            // 跨重启只能靠这两项证明归属，裸 pid 永远不足以回收（§6.5 b/c）。
            // Codex 的 pid/pgid/startedAt/command 来自监督进程自注册（SDK 不暴露 pid）。
            const identity = this.reaper.registerProcess(turn.id, proc)
            this.repo.updateSessionProcess(
              session.id,
              {
                pid: proc.pid,
                pgid: identity?.pgid ?? proc.pgid,
                command: identity?.command ?? proc.command ?? null,
                startedAt: identity?.startedAt ?? proc.startedAt ?? null,
                envMarker: proc.envMarker,
              },
              this.now(),
            )
          },
        }

        try {
          const result = await driver.execute(driverRequest, context)
          if (result.status === 'completed') {
            finalStatus = 'completed'
          } else if (result.status === 'cancelled' || controller.signal.aborted) {
            finalStatus = 'cancelled'
          } else {
            finalStatus = 'failed'
          }
          // 全 0 usage 视为「后端没给用量」：与 legacy 口径一致，不落 0 值行。
          // 否则账本会多出一条 provider 0-token 记录，UI 上又变成「真实 $0.00」。
          if (result.usage && hasReportedUsage(result.usage)) {
            this.recordUsage(turn, session.id, request, result.usage)
          } else {
            // 后端未上报 usage：如实记 unknown（tokens/cost 全 NULL），不静默丢。
            // 同一 dedupeKey 可被迟到的真实 usage 升级覆盖。
            this.usageLedger.record({
              turnId: turn.id,
              sessionId: session.id,
              executor: request.executor,
              graphId: request.graphId,
              nodeId: request.nodeId,
              source: 'unknown',
              attributionNote: 'backend_reports_no_usage',
              dedupeKey: `turn:${turn.id}`,
              recordedAt: this.now(),
            })
          }
          finalText = result.finalText
          if (result.errorCode || result.errorMessage) {
            seq += 1
            this.repo.appendEvents([
              {
                eventId: eventIdFor(turn.id, seq),
                runId: run.id,
                turnId: turn.id,
                seq,
                type: finalStatus === 'cancelled' ? 'turn.cancelled' : 'turn.failed',
                source: 'kernel',
                fidelity: 'turn',
                payloadVersion: 1,
                payload: {
                  errorCode: result.errorCode,
                  message: result.errorMessage,
                  status: result.status,
                },
                timestamp: this.now(),
              },
            ])
          }
        } catch (err) {
          finalStatus = controller.signal.aborted ? 'cancelled' : 'failed'
          seq += 1
          this.repo.appendEvents([
            {
              eventId: eventIdFor(turn.id, seq),
              runId: run.id,
              turnId: turn.id,
              seq,
              type: finalStatus === 'cancelled' ? 'turn.cancelled' : 'turn.failed',
              source: 'kernel',
              fidelity: 'turn',
              payloadVersion: 1,
              payload: { message: err instanceof Error ? err.message : String(err) },
              timestamp: this.now(),
            },
          ])
        } finally {
          this.abortControllers.delete(turn.id)
          const openSteps = this.repo.listOpenSteps(turn.id)
          if (finalStatus !== 'completed' && openSteps.length > 0) {
            this.repo.abortOpenSteps(turn.id, this.now())
          }
          this.repo.updateTurnStatus(
            turn.id,
            finalStatus,
            finalStatus === 'completed'
              ? { endedAt: this.now(), output: { finalStatus, finalText } }
              : { endedAt: this.now(), failureClass: finalStatus === 'cancelled' ? 'aborted' : 'runtime' },
            this.now(),
          )
          this.repo.projectRunStatus(run.id, this.now())

          // P0-1：正常完成路径**不**做全量 reap；只清理内存登记（进程由适配器/OS 收尾）。
          // 异常/取消路径则必须回收**本轮已登记**的句柄，否则自己 spawn 的子进程会泄漏。
          const stored = this.turnReapReports.get(turn.id)
          let reapReport: ReapReport | null = null
          let reapDurationMs = 0
          // 取消动作一旦发生（stored 存在），即使 driver 最终仍报告 completed，
          // 也必须记账/审计；不能因终态覆盖而丢掉已发生的回收。
          if (stored) {
            reapReport = stored.report
            reapDurationMs = stored.durationMs
          } else if (finalStatus !== 'completed') {
            const startedReap = this.now()
            reapReport = this.reaper.reap(turn.id, this.registryIdentity(turn.id))
            reapDurationMs = Math.max(0, this.now() - startedReap)
          }
          this.turnReapReports.delete(turn.id)
          this.reaper.forget(turn.id)
          // 本轮已收口：自注册文件不再需要（正常完成不 reap，只清台账）
          removeProcRegistryRecord(this.turnMarker(turn.id))

          // 终态显式清空句柄：陈旧 pid 不得跨 turn / 跨重启继续存活（COALESCE 会复活旧值）
          this.repo.clearSessionProcess(session.id, this.now())

          const residualRisk = reapReport ? classifyResidual(reapReport, true) : 'none'
          if (reapReport) {
            const unresolved = reapReport.unresolved.map((proof) => `${proof.pid}:${proof.reason}`)
            // 要求 5：recoveryKills 与实际回收次数一致；即使 residualRisk=none 也写 note。
            const note = `turn ${finalStatus} reclaim: killed=${reapReport.killed} unresolved=${unresolved.join(',') || '-'} missing=${reapReport.missing.join(',') || '-'} durationMs=${reapDurationMs} residualRisk=${residualRisk}`
            this.repo.recordSessionRecovery(
              session.id,
              { kills: reapReport.killed, note, clearProc: true, residualRisk },
              this.now(),
            )
            if (residualRisk === 'none') this.logger.info(note)
            else this.logger.warn(note)

            // 要求 1/2：动作发生即独立审计，与 residualRisk 无关。
            if (reapReport.killed > 0 || reapReport.unresolved.length > 0) {
              this.emitReclaimAudit({
                sessionId: session.id,
                turnId: turn.id,
                runId: run.id,
                reason: stored ? 'cancel' : 'abnormal-exit',
                report: reapReport,
                durationMs: reapDurationMs,
              })
            }
          }
        }

        const updated = this.repo.getTurn(turn.id)!
        return this.outcomeFromTurn(updated, false)
      })
    })
  }

  private readonly abortControllers = new Map<string, AbortController>()
  /** 取消时已执行的回收报告与耗时，交给 runNode 的 finally 统一落库/审计，避免重复判定覆盖。 */
  private readonly turnReapReports = new Map<string, { report: ReapReport; durationMs: number }>()

  private turnMarker(turnId: string): string {
    return `bizgraph-turn:${turnId}`
  }

  /**
   * 本轮监督进程的自注册身份（Codex 路径）。
   * 只接受**验签通过 + 文件属主/权限合规**的记录（C12）；验签失败一律忽略。
   */
  private registryIdentity(turnId: string): ProcIdentity[] {
    const record = readProcRegistryRecord(this.turnMarker(turnId))
    if (!record || !verifyProcRegistryFile(record)) return []
    const fields = {
      pid: record.pid,
      pgid: record.pgid,
      startedAt: record.startedAt,
      startedAtHiRes: record.startedAtHiRes,
      command: record.command,
    }
    return [{ ...fields, attestation: attestProcIdentity(fields) }]
  }

  /** marker 必须能映射到 DB 中已知的会话/轮次，否则不参与回收（C12 要求 3）。 */
  private isKnownMarker(marker: string, known: ReadonlySet<string>): boolean {
    if (known.has(marker)) return true
    const prefix = 'bizgraph-turn:'
    if (!marker.startsWith(prefix)) return false
    return Boolean(this.repo.getTurn(marker.slice(prefix.length)))
  }

  /**
   * 独立审计：缓存到既有 append-only `agent_events`（`process.reclaimed`），
   * 与 residualRisk 无关。payload 只含 id/pid/pgid/枚举/计数，**不含命令行、
   * 路径、密钥或 nonce**（满足要求 3/4）。
   */
  private emitReclaimAudit(input: {
    sessionId: string
    turnId: string
    runId: string
    reason: 'cancel' | 'abnormal-exit' | 'startup-reclaim'
    report: ReapReport | null
    durationMs: number
    extraUnresolved?: Array<{ pid: number; reason: string; matched: string[] }>
  }): void {
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
    const payload = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason: input.reason,
      method,
      pids,
      pgids,
      success,
      unresolved,
      durationMs: input.durationMs,
      evidence: report?.evidence ?? [],
    }
    try {
      const seq =
        this.repo.listTurnEvents(input.turnId).reduce((max, event) => Math.max(max, event.seq), 0) + 1
      this.repo.appendEvents([
        {
          eventId: eventIdFor(input.turnId, seq),
          runId: input.runId,
          turnId: input.turnId,
          seq,
          type: 'process.reclaimed',
          source: 'kernel',
          fidelity: 'turn',
          payloadVersion: 1,
          payload,
          timestamp: this.now(),
        },
      ])
    } catch (error) {
      // 审计失败不得影响回收/收口；只记录内部告警（不含 payload 敏感内容）。
      this.logger.warn(`process.reclaimed audit append failed: ${String(error)}`)
    }
  }

  /** UI 停止按钮：按 adapter session 找到当前未终态的 turn 并取消。 */
  async cancelActiveTurnBySession(sessionId: string, reason = 'user'): Promise<boolean> {
    const active = this.repo
      .listTurnsBySession(sessionId)
      .find((turn) => !TERMINAL.includes(turn.status))
    if (!active) return false
    return this.cancelTurn(active.id, reason)
  }

  /** session 结束：撤销会话级授权（UI 的 terminateSession 调用）。 */
  endSession(sessionId: string): boolean {
    return this.approvals.endSession(sessionId)
  }

  async cancelTurn(turnId: string, reason = 'user'): Promise<boolean> {
    const turn = this.repo.getTurn(turnId)
    if (!turn || TERMINAL.includes(turn.status)) return false
    this.repo.updateTurnStatus(turnId, 'cancelling', undefined, this.now())
    this.repo.projectRunStatus(turn.run_id, this.now())

    // 只回收**本轮内存中真实登记**且归属可证明的句柄，再 abort SDK。
    // 绝不读取落库的裸 pid/pgid：那是上一轮/上一条生命周期的证据，PID 复用时会误杀无关进程。
    // Codex 的句柄来自本轮自注册文件；取消可能早于内存登记，故按 marker 补齐。
    const startedReap = this.now()
    const report = this.reaper.reap(turnId, this.registryIdentity(turnId))
    this.turnReapReports.set(turnId, { report, durationMs: Math.max(0, this.now() - startedReap) })
    this.abortControllers.get(turnId)?.abort()

    const driver = this.drivers.get(this.executorFromSnapshot(turn))
    if (driver) {
      try {
        await driver.cancel(this.requestFromTurn(turn))
      } catch {
        // Driver 取消失败不阻塞状态收口
      }
    }
    this.repo.abortOpenSteps(turnId, this.now())
    this.repo.updateTurnStatus(turnId, 'cancelled', { endedAt: this.now(), failureClass: 'aborted', output: { reason } }, this.now())
    this.repo.projectRunStatus(turn.run_id, this.now())
    return true
  }

  /** 启动对账：按落库的 marker/pid/pgid 回收残留 → 对账 → 断言无悬空 → 重推 pending 审批。 */
  async reconcileOnStartup(): Promise<RecoveryReport> {
    let reactiveKills = 0
    const reclaimedSessions: RecoveryReport['reclaimedSessions'] = []
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
      // 跨重启只认「带归属证据」的句柄：pid 必须配 started_at + cmd 才能证明。
      // 裸 pid（老数据/证据缺失）一律不杀，只告警（§6.5 c）。
      const expected: ProcIdentity[] = session.executor_pid
        ? [
            (() => {
              const fields = {
                pid: session.executor_pid!,
                pgid: session.executor_pgid ?? undefined,
                command: session.executor_cmd ?? undefined,
                startedAt: session.executor_started_at ?? undefined,
              }
              // DB 行是可信来源：铸造签名，避免把跨重启的合法身份误判为伪造。
              let attestation: string | undefined
              try {
                attestation = attestProcIdentity(fields)
              } catch {
                attestation = undefined
              }
              return { ...fields, attestation }
            })(),
          ]
        : []
      const startedReap = this.now()
      const report = expected.length > 0 ? this.reaper.killRegistered(expected, { marker: marker ?? undefined }) : null
      const reapDurationMs = Math.max(0, this.now() - startedReap)
      const killedPids = report?.killedPids ?? []
      const kills = killedPids.length
      reactiveKills += kills
      const residualRisk = classifyResidual(report, Boolean(marker))
      const unresolved = (report?.unresolved ?? []).map(
        (proof) => `${proof.pid}:${proof.matched.join('+') || 'none'}:${proof.reason}`,
      )
      // 注意：residual_risk 是会话级可见状态，不是 turn 状态；turn 状态机不受此影响。
      const note = `startup reclaim: marker=${marker ?? 'none'} pids=${killedPids.join(',') || '-'} groups=${(report?.killedGroups ?? []).join(',') || '-'} missing=${(report?.missing ?? []).join(',') || '-'} unresolved=${unresolved.join(',') || '-'} residualRisk=${residualRisk}`
      this.repo.recordSessionRecovery(session.id, { kills, note, clearProc: true, residualRisk }, this.now())
      if (residualRisk === 'none') this.logger.info(note)
      else this.logger.warn(note)
      // 要求 1/2：启动清扫的每次实际处置（含「证明不足未回收」）都独立留痕。
      if (report && (kills > 0 || report.unresolved.length > 0)) {
        const knownTurn = session.last_turn_id ? this.repo.getTurn(session.last_turn_id) : undefined
        const auditTurnId = knownTurn?.id ?? `startup:${session.id}:${this.now()}`
        this.emitReclaimAudit({
          sessionId: session.id,
          turnId: auditTurnId,
          runId: knownTurn?.run_id ?? auditTurnId,
          reason: 'startup-reclaim',
          report,
          durationMs: reapDurationMs,
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

    // D5 兜底：进程自注册文件（Codex 监督 shim 写的 pid/pgid/startedAt/command）。
    // 即使主进程在落库前被 kill -9，这里仍能凭 ≥2 项归属证据回收自有进程组。
    let registryKills = 0
    for (const record of listProcRegistryRecords()) {
      // 要求 3：只处理能映射到 DB 中已知会话/轮次的 marker；其余仅告警。
      if (!this.isKnownMarker(record.marker, knownMarkers)) {
        this.logger.warn(`ignore unknown registry record: marker=${record.marker} pid=${record.pid}`)
        continue
      }
      // 要求 2：验签 + 文件属主/权限校验；伪造/篡改记录一律不杀。
      if (!verifyProcRegistryFile(record)) {
        this.logger.warn(`ignore unverifiable registry record: marker=${record.marker} pid=${record.pid}`)
        const session = markerSessions.get(record.marker)
        const markerTurnId = record.marker.startsWith('bizgraph-turn:')
          ? record.marker.slice('bizgraph-turn:'.length)
          : undefined
        const markerTurn = markerTurnId ? this.repo.getTurn(markerTurnId) : undefined
        const knownTurn =
          markerTurn ?? (session?.last_turn_id ? this.repo.getTurn(session.last_turn_id) : undefined)
        const auditTurnId = knownTurn?.id ?? `startup:${record.marker}:${this.now()}`
        this.emitReclaimAudit({
          sessionId: knownTurn?.session_id ?? session?.id ?? 'unknown',
          turnId: auditTurnId,
          runId: knownTurn?.run_id ?? auditTurnId,
          reason: 'startup-reclaim',
          report: null,
          durationMs: 0,
          extraUnresolved: [{ pid: record.pid, reason: 'unverifiable-record', matched: [] }],
        })
        continue
      }
      const fields = {
        pid: record.pid,
        pgid: record.pgid,
        startedAt: record.startedAt,
        startedAtHiRes: record.startedAtHiRes,
        command: record.command,
      }
      const startedReap = this.now()
      const report = this.reaper.killRegistered(
        [{ ...fields, attestation: attestProcIdentity(fields) }],
        { marker: record.marker },
      )
      const reapDurationMs = Math.max(0, this.now() - startedReap)
      if (report.killedPids.length > 0 || report.unresolved.length > 0) {
        const session = markerSessions.get(record.marker)
        const markerTurnId = record.marker.startsWith('bizgraph-turn:')
          ? record.marker.slice('bizgraph-turn:'.length)
          : undefined
        const markerTurn = markerTurnId ? this.repo.getTurn(markerTurnId) : undefined
        const knownTurn =
          markerTurn ?? (session?.last_turn_id ? this.repo.getTurn(session.last_turn_id) : undefined)
        const auditTurnId = knownTurn?.id ?? `startup:${record.marker}:${this.now()}`
        this.emitReclaimAudit({
          sessionId: knownTurn?.session_id ?? session?.id ?? 'unknown',
          turnId: auditTurnId,
          runId: knownTurn?.run_id ?? auditTurnId,
          reason: 'startup-reclaim',
          report,
          durationMs: reapDurationMs,
        })
      }
      registryKills += report.killedPids.length
      reactiveKills += report.killedPids.length
      const note = `startup registry reclaim: marker=${record.marker} pids=${report.killedPids.join(',') || '-'} groups=${report.killedGroups.join(',') || '-'} missing=${report.missing.join(',') || '-'} unresolved=${report.unresolved.length}`
      if (report.killedPids.length > 0) this.logger.info(note)
      else this.logger.debug(note)
      // 要求 4：已处理（回收成功或进程已消失）的记录立即失效，防止重放。
      if (report.killedPids.length > 0 || report.missing.length > 0) {
        removeProcRegistryRecord(record.marker)
      }
    }

    const planned = planRecovery(this.repo)
    applyRecoveryPlan(this.repo, planned)
    assertNoDangling(this.repo)
    // 先扫一遍已过期的 pending（decided_by=timeout），避免它们被 startup 重放刷新有效期
    // ——这是 sweepExpired 的生产调用点，定时器只覆盖本进程内创建的审批。
    const sweptExpired = this.approvals.sweepExpired()
    if (sweptExpired > 0) {
      this.logger.info(`[approval] swept ${sweptExpired} expired pending approval(s) at startup`)
    }
    // P1-3：重启后旧 pending 审批已无人能兑现 → 统一 deny（decided_by=startup），
    // 且不再推 UI；只有所属 turn 仍存活的审批才会重推。
    const reconciled = this.approvals.reconcileStartup()

    return {
      plans: planned.plans,
      interruptedRuns: planned.interruptedRuns,
      abortedTurns: planned.abortedTurns,
      orphanedSessions: planned.orphanedSessions,
      pendingApprovals: reconciled.replayed.length,
      deniedStaleApprovals: reconciled.denied,
      reactiveKills,
      registryKills,
      reclaimedSessions,
      residualRiskSessions: reclaimedSessions.filter((session) => session.residualRisk !== 'none').length,
    }
  }

  dispose(): void {
    for (const controller of this.abortControllers.values()) controller.abort()
    this.abortControllers.clear()
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = null
    }
    this.approvals.dispose()
  }

  private insertTurn(
    runId: string,
    sessionId: string,
    request: RunNodeRequest,
    branchKey: string,
    attempt: number,
    resumeMode: 'native' | 'replay' | 'fresh',
    idempotencyKey: string,
    snapshot: TurnInputSnapshot,
  ): AgentTurnRow {
    try {
      return this.repo.insertTurn({
        runId,
        sessionId,
        graphId: request.graphId,
        nodeId: request.nodeId,
        branchKey,
        attempt,
        status: 'running',
        resumeMode,
        idempotencyKey,
        input: snapshot as unknown as Record<string, unknown>,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('NODE_BUSY')) throw new NodeBusyError(request.nodeId, branchKey)
      throw err
    }
  }

  private recordUsage(
    turn: AgentTurnRow,
    sessionId: string,
    request: RunNodeRequest,
    usage: DriverUsage,
  ): void {
    this.usageLedger.record({
      turnId: turn.id,
      sessionId,
      executor: request.executor,
      graphId: request.graphId,
      nodeId: request.nodeId,
      model: usage.model ?? null,
      source: usage.isEstimate ? 'estimated' : 'provider',
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
      dedupeKey: `turn:${turn.id}`,
      recordedAt: this.now(),
    })
  }

  private syncStepFromEvent(event: NormalizedEventEnvelope): void {
    if (!event.stepId) return
    const common = {
      id: event.stepId,
      turnId: event.turnId,
      kind: 'tool',
      fidelity: event.fidelity,
    }
    switch (event.type) {
      case 'tool.requested': {
        const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName : undefined
        this.repo.upsertStep({ ...common, toolName, status: 'running', startedAt: this.now() })
        break
      }
      case 'tool.result':
        this.repo.updateStepStatus(event.stepId, 'done', { resultRef: 'event' }, this.now())
        this.repo.setStepDisposition(event.stepId, 'completed')
        break
      case 'tool.failed':
        this.repo.updateStepStatus(event.stepId, 'failed', undefined, this.now())
        this.repo.setStepDisposition(event.stepId, 'needs-human')
        break
      case 'tool.aborted':
        // §5.1：aborted 不得宣称成功；处置为 unknown-needs-rerun
        this.repo.updateStepStatus(event.stepId, 'aborted', undefined, this.now())
        this.repo.setStepDisposition(event.stepId, 'unknown-needs-rerun')
        break
      case 'tool.unknown': {
        // C2：如实记录 unknown，不伪装成 failed。若后端直接上报未知 item，先补建 step 行。
        const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName : undefined
        this.repo.upsertStep({ ...common, toolName, status: 'unknown', startedAt: this.now() })
        this.repo.setStepDisposition(event.stepId, 'needs-human')
        break
      }
      case 'approval.required':
        this.repo.updateStepStatus(event.stepId, 'awaiting_approval', undefined, this.now())
        break
      case 'approval.resolved': {
        const decision = event.payload.decision
        this.repo.updateStepStatus(event.stepId, decision === 'allow' ? 'approved' : 'denied', undefined, this.now())
        break
      }
      default:
        break
    }
  }

  private outcomeFromTurn(turn: AgentTurnRow, reused: boolean): TurnOutcome {
    const output = parseOutput(turn.output_json)
    const status = TERMINAL.includes(turn.status)
      ? (turn.status as TurnOutcome['status'])
      : 'failed'
    return {
      runId: turn.run_id,
      turnId: turn.id,
      status,
      finalText: typeof output.finalText === 'string' ? output.finalText : undefined,
      reused,
      errorCode: turn.error_code ?? undefined,
    }
  }

  private executorFromSnapshot(turn: AgentTurnRow): string {
    const input = parseOutput(turn.input_json)
    return typeof input.executor === 'string' ? input.executor : ''
  }

  private requestFromTurn(turn: AgentTurnRow): DriverExecuteRequest {
    const input = parseOutput(turn.input_json)
    return {
      runId: turn.run_id,
      turnId: turn.id,
      graphId: turn.graph_id ?? undefined,
      nodeId: turn.node_id,
      agentSessionId: typeof input.adapterSessionId === 'string' ? input.adapterSessionId : turn.session_id,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      commandType: typeof input.commandType === 'string' ? input.commandType : 'implement',
      workingDirectory: typeof input.workingDirectory === 'string' ? input.workingDirectory : process.cwd(),
    }
  }
}

function parseOutput(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function scopeStepId(turnId: string, stepId: string): string {
  return stepId.startsWith(`${turnId}:`) ? stepId : `${turnId}:${stepId}`
}

