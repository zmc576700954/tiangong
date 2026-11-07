/**
 * DeadlineReaper（F3-A）
 *
 * 定期扫描 agent_turns 中 status='running' 且 deadline_at>0 且已到期的 turn，
 * 逐个收口：runtime.expireTimedOutTurn（同 tick 杀进程组 + 单次终态 CAS
 * failed/'timeout'/DEADLINE_EXCEEDED）→ 会话级 terminateSession('timeout')。
 *
 * 归属 AgentManager（持 runtime 句柄，随 setRuntime 启动）；timer unref，
 * 不阻止进程退出。
 *
 * 防重复收口双保险：
 *  1. 进程内 in-flight 去重集合——同一 turn 的收口并发只进行一次；
 *  2. runtime 侧终态 CAS（WHERE status NOT IN terminal）——即便并发穿透，
 *     第二次收口也会因终态已写而返回 false，不做会话 terminate。
 *
 * waiting_approval 的 turn 不会被扫描（status 过滤）：P1-1 审批等待时 turn 真实写入
 * waiting_approval 并冻结 deadline，审批结束回到 running 后按剩余时限重算。
 *
 * P1-2：cancelling 也必须收敛。取消路径已给 driver.cancel 设时限；本 Reaper 再按
 * runtime 内存中的 cancelling 起点扫描超过 cancelTimeoutMs 的 turn，按
 * cancelled + cancel_timeout 收口。与 running 扫描共用 in-flight 去重与 sweep
 * 重入保护，终态 CAS 保证同一个 turn 只被收口一次。
 */

import type { TerminationReason } from '@shared/types'
import { createLogger } from '../../../shared/logger'

const logger = createLogger('DeadlineReaper')

/** 扫描到的过期 turn（repo 行的必要字段，依赖注入便于单测）。 */
export interface ExpiredTurnRef {
  id: string
  session_id: string
}

export interface DeadlineReaperDeps {
  /** repo.listExpiredRunningTurns —— 只返回 status='running' 且 deadline 已过期的 turn。 */
  listExpiredRunningTurns: (now: number) => ExpiredTurnRef[]
  /**
   * runtime.expireTimedOutTurn —— 杀进程组 + 单次终态 CAS。
   * 返回 false 表示该 turn 已被完成/取消抢先（终态唯一，保留先到者）。
   */
  expireTurn: (turnId: string) => Promise<boolean>
  /** agentManager.terminateSession —— 会话级收尾（沙箱钩子等）。 */
  terminateSession: (sessionId: string, reason: TerminationReason) => Promise<void>
  /** P1-2：本进程内进入 cancelling 且已超过取消时限的 turn。 */
  listOverdueCancellingTurns: (now: number) => ExpiredTurnRef[]
  /**
   * P1-2：runtime.convergeCancellingTurn —— 按 cancelled + cancel_timeout 收口。
   * 返回 false 表示已被原取消路径/终态抢先，不重复写。
   */
  convergeCancellingTurn: (turnId: string) => Promise<boolean>
}

export class DeadlineReaper {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly inFlight = new Set<string>()
  private sweeping = false

  constructor(
    private readonly deps: DeadlineReaperDeps,
    private readonly intervalMs = 5000,
  ) {}

  /** 启动周期扫描；重复调用不叠加定时器。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        logger.warn('deadline sweep failed:', err)
      })
    }, this.intervalMs)
    this.timer.unref?.()
    logger.info(`DeadlineReaper started (interval=${this.intervalMs}ms)`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info('DeadlineReaper stopped')
    }
  }

  /**
   * 执行一次扫描并逐个收口。返回本次真正收口（kill+CAS+terminate 全程走完）的
   * turn id 列表；被抢先/去重跳过的不在其中。公开以便单测直接驱动。
   */
  async sweep(now = Date.now()): Promise<string[]> {
    // 重入保护：上一轮 sweep 尚未结束时，本轮 tick 直接跳过（in-flight turn
    // 已被去重集合覆盖，这里防的是 sweep 级别的堆叠）。
    if (this.sweeping) return []
    this.sweeping = true
    const reaped: string[] = []
    try {
      const expired = this.deps.listExpiredRunningTurns(now)
      for (const turn of expired) {
        if (this.inFlight.has(turn.id)) continue
        this.inFlight.add(turn.id)
        try {
          const expiredNow = await this.deps.expireTurn(turn.id)
          if (!expiredNow) continue
          try {
            await this.deps.terminateSession(turn.session_id, 'timeout')
          } catch (err) {
            // 终态 CAS 已落，会话收尾失败只告警——不得回滚、不得重试掩盖终态。
            logger.warn(
              `turn ${turn.id}: post-expire terminateSession(${turn.session_id}) failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          reaped.push(turn.id)
        } finally {
          this.inFlight.delete(turn.id)
        }
      }

      // P1-2：取消路径卡住（driver.cancel 超过时限）→ cancelled/cancel_timeout。
      // 不 terminate 会话：取消 turn 不等于结束会话；会话收尾仍由调用方决定。
      const overdueCancelling = this.deps.listOverdueCancellingTurns(now)
      for (const turn of overdueCancelling) {
        if (this.inFlight.has(turn.id)) continue
        this.inFlight.add(turn.id)
        try {
          const converged = await this.deps.convergeCancellingTurn(turn.id)
          if (!converged) continue
          reaped.push(turn.id)
        } finally {
          this.inFlight.delete(turn.id)
        }
      }
    } finally {
      this.sweeping = false
    }
    if (reaped.length > 0) {
      logger.info(`deadline sweep reaped ${reaped.length} turn(s): ${reaped.join(', ')}`)
    }
    return reaped
  }
}
