/**
 * FallbackRouter — 适配器回退链路由器
 *
 * 职责：
 * 1. 构建回退链（去重 + 健康度优先重排）
 * 2. 依次尝试链中的每个适配器，记录健康度与连续超时次数
 * 3. 健康度为 unhealthy 时跳过并触发健康恢复检查（onUnhealthy hook）
 * 4. 健康度为 degraded 时缩短超时
 * 5. 任一适配器成功后返回结果；全部失败抛 AdapterError
 *
 * 此模块替代 AgentManager.startSession 中除「会话状态写入 / 沙箱准备 /
 * 节点状态推进 / 回调触发」以外的纯路由逻辑。AgentManager 仍负责把
 * 解析后的 session 注册到自己的状态映射并通知渲染端。
 */

import type { AgentSession, AgentSessionConfig, AdapterFallbackAttempt } from '@shared/types'
import { AdapterError } from '../errors'
import type { AdapterHealthMonitor } from './adapter-health-monitor'
import type { AdapterRegistry } from './adapter-registry'
import { createLogger } from '../shared/logger'

const logger = createLogger('FallbackRouter')

/** FallbackRouter 解析成功后返回的载荷 */
export interface ResolvedAdapterSession {
  /** 适配器返回的会话对象（已 startSession 成功） */
  session: AgentSession
  /** 最终选中的适配器名 */
  adapterUsed: string
  /** 是否走了回退（与 primary 不同） */
  isFallback: boolean
  /** 回退链中每一步的尝试记录 */
  fallbackHistory: AdapterFallbackAttempt[]
  /** 实际下发给适配器的 config（degraded 适配器已缩短超时） */
  config: AgentSessionConfig
}

/** 连续超时阈值：达到此次数后跳过该适配器 */
const CONSECUTIVE_TIMEOUT_THRESHOLD = 2

export class FallbackRouter {
  /** 连续超时计数器：每个适配器失败次数，达到阈值后丢弃（移到下一个） */
  private adapterTimeoutCounts = new Map<string, number>()

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly healthMonitor: AdapterHealthMonitor,
    /** 当某个适配器判定为 unhealthy 时触发——通常由 AgentManager 接入 RecoveryOrchestrator 的 startRecoveryCheck */
    private readonly onUnhealthyAdapter?: (adapterName: string) => void,
  ) {}

  /**
   * 获取连续超时计数（只读），方便上层诊断
   */
  getTimeoutCounts(): Map<string, number> {
    return this.adapterTimeoutCounts
  }

  /**
   * 构建去重后的回退链；非 forceAdapter 时按健康度重排（健康者优先）
   */
  buildChain(primary: string, fallbackOrder: string[], forceAdapter = false): string[] {
    const rawChain = [primary, ...fallbackOrder.filter((a) => a !== primary)]

    const seen = new Set<string>()
    const unique = rawChain.filter((a) => {
      if (seen.has(a)) return false
      seen.add(a)
      return true
    })

    if (!forceAdapter) {
      const healthiest = this.healthMonitor.getHealthiestAdapter(unique)
      if (healthiest && healthiest !== unique[0]) {
        return [healthiest, ...unique.filter((n) => n !== healthiest)]
      }
    }

    return unique
  }

  /**
   * 依次尝试链中每个适配器，返回首个成功的会话或抛 AdapterError
   *
   * 副作用：
   * - 成功调用记录到 AdapterHealthMonitor
   * - 失败调用记录到 AdapterHealthMonitor（含 error reason）
   * - 连续失败次数累计到 adapterTimeoutCounts；达到阈值后下一次丢弃（但不立即跳过）
   *   —— 本方法每次调用都从头走 chain；累计仅用于「当下一次进入此方法时快速跳过」。
   *   现有行为与原 AgentManager 保持一致：达到 2 次连续失败时移到下一个，不立即跳过。
   * - 命中 unhealthy 时跳过并回调 onUnhealthyAdapter
   * - 命中 degraded 时将 config.timeoutMs 减半
   */
  async resolveSession(
    primary: string,
    chain: string[],
    initialConfig: AgentSessionConfig,
  ): Promise<ResolvedAdapterSession> {
    const fallbackHistory: AdapterFallbackAttempt[] = []

    for (const candidate of chain) {
      const adapter = this.registry.get(candidate)
      if (!adapter) {
        fallbackHistory.push({
          adapter: candidate,
          reason: `Adapter ${candidate} not registered`,
          success: false,
        })
        logger.warn(`Adapter ${candidate} not registered, trying next...`)
        continue
      }

      const isInstalled = await adapter.checkInstalled()
      if (!isInstalled) {
        fallbackHistory.push({
          adapter: candidate,
          reason: `${candidate} not installed`,
          success: false,
        })
        logger.warn(`Adapter ${candidate} not installed, trying next...`)
        continue
      }

      // Health-driven auto-degradation: skip unhealthy, shorten timeout for degraded
      const health = this.healthMonitor.getHealth(candidate)
      if (health && health.status === 'unhealthy') {
        fallbackHistory.push({
          adapter: candidate,
          reason: `${candidate} is unhealthy (score: ${health.healthScore}), skipping`,
          success: false,
        })
        logger.warn(
          `Adapter ${candidate} is unhealthy (score: ${health.healthScore}), skipping and starting recovery check`,
        )
        this.onUnhealthyAdapter?.(candidate)
        continue
      }

      let config = initialConfig
      if (health && health.status === 'degraded') {
        const originalTimeout = config.timeoutMs ?? 120_000
        config = { ...config, timeoutMs: Math.floor(originalTimeout * 0.5) }
        logger.info(
          `Adapter ${candidate} is degraded, reducing timeout from ${originalTimeout}ms to ${config.timeoutMs}ms`,
        )
      }

      const startTime = Date.now()
      try {
        const session = await adapter.startSession(config)

        // Reset consecutive timeout counter on success
        this.adapterTimeoutCounts.delete(candidate)

        fallbackHistory.push({ adapter: candidate, reason: '', success: true })

        // 记录成功调用到健康监控
        this.healthMonitor.recordCall(candidate, true, Date.now() - startTime)

        const isFallback = candidate !== primary
        return {
          session,
          adapterUsed: candidate,
          isFallback,
          fallbackHistory,
          config,
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        fallbackHistory.push({
          adapter: candidate,
          reason: `startSession failed: ${reason}`,
          success: false,
        })

        // 记录失败调用到健康监控
        this.healthMonitor.recordCall(candidate, false, Date.now() - startTime, reason)

        // Consecutive timeout tracking: after N consecutive failures, skip to next adapter
        const currentCount = this.adapterTimeoutCounts.get(candidate) ?? 0
        this.adapterTimeoutCounts.set(candidate, currentCount + 1)
        if (currentCount + 1 >= CONSECUTIVE_TIMEOUT_THRESHOLD) {
          this.adapterTimeoutCounts.delete(candidate)
          logger.warn(
            `Adapter ${candidate} failed ${currentCount + 1} consecutive times, moving to next adapter`,
          )
          continue
        }

        logger.warn(`Adapter ${candidate} startSession failed: ${reason}, trying next...`)
        continue
      }
    }

    throw new AdapterError(
      `No adapter available. Tried: ${chain.join(', ')}. Details: ${fallbackHistory.map((f) => `${f.adapter} (${f.reason})`).join('; ')}`,
      primary,
    )
  }
}