/**
 * AgentHealthHousekeeper — owns background timers and lifecycle house-keeping
 * extracted from AgentManager.
 *
 * Responsibilities (D1a):
 *  - Periodic health check timer (adaptive: 5/7/10 minutes based on load)
 *  - RSS-based memory pressure detection + oldest-session cleanup
 *  - Health-driven recovery check (probe unhealthy adapter until installed)
 *  - Fallback recovery check (probe preferred adapter after fallback until healthy)
 *  - Stale memory cleanup (claude-mem style periodic prune)
 *
 * AgentManager retains the lifecycle facade (start/stop/destroy) but delegates
 * the timer bookkeeping + cleanup logic here.
 */

import type { AdapterRegistry } from './adapter-registry'
import type { AdapterHealthMonitor } from './adapter-health-monitor'
import type { SessionLifecycleManager } from './session-lifecycle-manager'
import type { MemoryStore } from '../memory'
import { createLogger } from '../shared/logger'
import os from 'node:os'

const logger = createLogger('AgentHealthHousekeeper')

/** 健康检查间隔：每 10 分钟输出一次诊断日志 */
export const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000
/** RSS 内存警告阈值（MB）：自适应计算，基于系统总内存的 25%，范围 [1024, 8192] */
export const RSS_WARNING_THRESHOLD_MB = Math.max(1024, Math.min(8192, Math.floor((os.totalmem() / 1024 / 1024) * 0.25)))
/** RSS 内存危险阈值（MB）：自适应计算，基于系统总内存的 40%，范围 [2048, 12288] */
export const RSS_CRITICAL_THRESHOLD_MB = Math.max(2048, Math.min(12288, Math.floor((os.totalmem() / 1024 / 1024) * 0.4)))

export interface MemoryStats {
  rssMB: number
  heapTotalMB: number
  heapUsedMB: number
  externalMB: number
}

export interface AgentHealthHousekeeperDeps {
  registry: AdapterRegistry
  healthMonitor: AdapterHealthMonitor
  lifecycle: SessionLifecycleManager
  /** Lazy: only invoked when needed. Lets AgentManager defer DB access. */
  getMemoryStore: () => MemoryStore
  maxSessions: number
  /** Returns process memory stats in MB. Provided by AgentManager. */
  getMemoryStats: () => MemoryStats
  /** Callback to terminate a session (avoid circular dep on AgentManager.terminateSession). */
  terminateSession: (sessionId: string, reason: 'error') => Promise<void>
}

/**
 * AgentHealthHousekeeper — bundle of background timers + cleanup logic.
 *
 * Not an EventEmitter; the lifecycle orchestrator owns it via composition.
 */
export class AgentHealthHousekeeper {
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackRecoveryTimers = new Map<string, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>()
  private recoveryCheckIntervals = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private readonly deps: AgentHealthHousekeeperDeps) {}

  /**
   * Start the periodic health check timer. Self-rescheduling — each tick
   * re-evaluates the interval based on current memory pressure + session load.
   */
  start(): void {
    if (this.healthCheckTimer) return
    this.scheduleNext()
  }

  /** Stop the health check timer and clear all background intervals. */
  stop(): void {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
    for (const interval of this.recoveryCheckIntervals.values()) {
      clearInterval(interval)
    }
    this.recoveryCheckIntervals.clear()
    for (const timers of this.fallbackRecoveryTimers.values()) {
      clearInterval(timers.interval)
      clearTimeout(timers.timeout)
    }
    this.fallbackRecoveryTimers.clear()
  }

  /** Terminate the N oldest active sessions (by startTime) during memory pressure. */
  cleanupOldestSessions(count: number): void {
    const sorted = Array.from(this.deps.lifecycle.listActive())
      .map((id) => ({ id, state: this.deps.lifecycle.getSessionState(id) }))
      .filter(({ state }) => state !== undefined)
      .sort((a, b) => (a.state!.startTime - b.state!.startTime))
      .slice(0, count)
    for (const { id } of sorted) {
      logger.info(`Memory pressure cleanup: terminating session ${id}`)
      this.deps.terminateSession(id, 'error').catch((err) => {
        logger.warn(`Failed to terminate session ${id} during memory cleanup:`, err)
      })
    }
  }

  /** Check RSS against warning/critical thresholds; trigger cleanup if needed. */
  checkMemoryPressure(): void {
    const stats = this.deps.getMemoryStats()
    if (stats.rssMB > RSS_CRITICAL_THRESHOLD_MB) {
      logger.error(`CRITICAL: RSS ${stats.rssMB}MB exceeds critical threshold (${RSS_CRITICAL_THRESHOLD_MB}MB), force cleaning oldest sessions`)
      this.cleanupOldestSessions(5)
    } else if (stats.rssMB > RSS_WARNING_THRESHOLD_MB) {
      logger.warn(`WARNING: RSS ${stats.rssMB}MB exceeds warning threshold (${RSS_WARNING_THRESHOLD_MB}MB), consider reducing active sessions`)
      this.cleanupOldestSessions(2)
    }
  }

  /** Probe an unhealthy adapter periodically until it reports installed. */
  startRecoveryCheck(adapterName: string): void {
    if (this.recoveryCheckIntervals.has(adapterName)) return // already running
    const interval = setInterval(async () => {
      const adapter = this.deps.registry.get(adapterName)
      if (!adapter) {
        const active = this.recoveryCheckIntervals.get(adapterName)
        if (active) {
          clearInterval(active)
          this.recoveryCheckIntervals.delete(adapterName)
        }
        return
      }
      const installed = await adapter.checkInstalled()
      if (installed) {
        this.deps.healthMonitor.recordCall(adapterName, true, 0, 'recovery-check')
        const active = this.recoveryCheckIntervals.get(adapterName)
        if (active) {
          clearInterval(active)
          this.recoveryCheckIntervals.delete(adapterName)
        }
      }
    }, 60_000)
    this.recoveryCheckIntervals.set(adapterName, interval)
  }

  /**
   * Periodically probe the preferred adapter after a fallback. When it reports
   * installed + healthy again, the timer stops itself. Auto-cancels after 5
   * minutes to avoid indefinite probing.
   */
  startFallbackRecoveryCheck(preferredAdapter: string, intervalMs = 60_000): void {
    if (this.fallbackRecoveryTimers.has(preferredAdapter)) return
    const interval = setInterval(async () => {
      const adapter = this.deps.registry.get(preferredAdapter)
      if (!adapter) {
        clearInterval(interval)
        const timers = this.fallbackRecoveryTimers.get(preferredAdapter)
        if (timers) clearTimeout(timers.timeout)
        this.fallbackRecoveryTimers.delete(preferredAdapter)
        return
      }
      const installed = await adapter.checkInstalled()
      const health = this.deps.healthMonitor.getHealth(preferredAdapter)
      if (installed && health && health.status === 'healthy') {
        logger.info(`Preferred adapter ${preferredAdapter} is healthy again`)
        const timers = this.fallbackRecoveryTimers.get(preferredAdapter)
        if (timers) { clearInterval(timers.interval); clearTimeout(timers.timeout) }
        this.fallbackRecoveryTimers.delete(preferredAdapter)
      }
    }, intervalMs)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      this.fallbackRecoveryTimers.delete(preferredAdapter)
    }, 5 * 60_000)
    timeout.unref()
    this.fallbackRecoveryTimers.set(preferredAdapter, { interval, timeout })
  }

  /**
   * Periodically prune stale memory items (claude-mem style) and run the next
   * tick. The interval length adapts to current load.
   */
  private scheduleNext(): void {
    const interval = this.computeAdaptiveInterval()
    this.healthCheckTimer = setTimeout(() => {
      try {
        this.deps.getMemoryStore().pruneStale(90)
      } catch (err) {
        logger.warn('Memory pruneStale failed:', err)
      }
      this.checkMemoryPressure()
      this.scheduleNext()
    }, interval)
    if (this.healthCheckTimer && typeof this.healthCheckTimer === 'object' && 'unref' in this.healthCheckTimer) {
      (this.healthCheckTimer as ReturnType<typeof setTimeout> & { unref(): void }).unref()
    }
  }

  /**
   * High load (memory >80% threshold or sessions >70% cap) → 5 minutes.
   * Medium load → 7 minutes. Otherwise default (HEALTH_CHECK_INTERVAL_MS).
   */
  private computeAdaptiveInterval(): number {
    const stats = this.deps.getMemoryStats()
    const sessionCount = this.deps.lifecycle.activeSessionCount
    if (stats.rssMB > RSS_WARNING_THRESHOLD_MB * 0.8 || sessionCount > this.deps.maxSessions * 0.7) {
      return 5 * 60 * 1000
    }
    if (stats.rssMB > RSS_WARNING_THRESHOLD_MB * 0.5 || sessionCount > this.deps.maxSessions * 0.5) {
      return 7 * 60 * 1000
    }
    return HEALTH_CHECK_INTERVAL_MS
  }

  /** Output diagnostic snapshot for logging / monitoring. */
  logDiagnostics(): void {
    const mem = this.deps.getMemoryStats()
    logger.info('AgentManager diagnostics', {
      activeSessions: this.deps.lifecycle.activeSessionCount,
      cleanupInProgress: this.deps.lifecycle.cleanupInProgressCount,
      memory: mem,
    })
  }

  /** Test-only: probe intervals for health-driven recovery checks. */
  getRecoveryCheckIntervals(): Map<string, ReturnType<typeof setInterval>> {
    return this.recoveryCheckIntervals
  }
}