/**
 * 适配器健康监控
 * 为每个适配器维护健康评分：成功率、响应时间、错误率
 */

import { createLogger } from '../shared/logger'

const logger = createLogger('AdapterHealthMonitor')

/** 适配器健康指标 */
export interface AdapterHealthMetrics {
  /** 总调用次数 */
  totalCalls: number
  /** 成功次数 */
  successCalls: number
  /** 失败次数 */
  failedCalls: number
  /** 平均响应时间（毫秒） */
  avgResponseTimeMs: number
  /** 最近错误信息（最多保留 5 条） */
  recentErrors: string[]
  /** 最后调用时间 */
  lastCalledAt: number
}

/** 适配器健康评分结果 */
export interface AdapterHealthScore {
  adapterName: string
  /** 综合健康评分 0-100 */
  healthScore: number
  /** 成功率百分比 */
  successRate: number
  /** 平均响应时间 */
  avgResponseTimeMs: number
  /** 状态：healthy | degraded | unhealthy | unknown（零调用样本） */
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  /** 原始指标 */
  metrics: AdapterHealthMetrics
}

/** 健康评分阈值 */
const HEALTH_THRESHOLDS = {
  /** 评分 >= 80 为健康 */
  healthy: 80,
  /** 评分 >= 50 为降级，< 50 为不健康 */
  degraded: 50,
}

/** 响应时间评分权重 */
const RESPONSE_TIME_WEIGHTS = {
  excellent: 100, // < 1s
  good: 80,       // 1-3s
  fair: 60,       // 3-10s
  poor: 40,       // 10-30s
  bad: 20,        // > 30s
}

export class AdapterHealthMonitor {
  private metrics = new Map<string, AdapterHealthMetrics>()

  /**
   * 记录一次适配器调用结果
   */
  recordCall(adapterName: string, success: boolean, responseTimeMs: number, errorMessage?: string): void {
    let m = this.metrics.get(adapterName)
    if (!m) {
      m = {
        totalCalls: 0,
        successCalls: 0,
        failedCalls: 0,
        avgResponseTimeMs: 0,
        recentErrors: [],
        lastCalledAt: Date.now(),
      }
      this.metrics.set(adapterName, m)
    }

    m.totalCalls++
    if (success) {
      m.successCalls++
    } else {
      m.failedCalls++
      if (errorMessage) {
        m.recentErrors.push(errorMessage)
        if (m.recentErrors.length > 5) {
          m.recentErrors.shift()
        }
      }
    }

    // 指数移动平均更新响应时间
    const alpha = 0.3
    m.avgResponseTimeMs = m.avgResponseTimeMs * (1 - alpha) + responseTimeMs * alpha
    m.lastCalledAt = Date.now()

    logger.debug(`Recorded call for ${adapterName}: success=${success}, time=${responseTimeMs}ms`)
  }

  /**
   * 获取指定适配器的健康评分
   *
   * 零调用适配器视为 "unknown"（healthScore=undefined-like 但返回 status='unknown'）
   * 避免在 getHealthiestAdapter 中把"从没用过的"排在历史可靠适配器之前。
   */
  getHealth(adapterName: string): AdapterHealthScore | undefined {
    const m = this.metrics.get(adapterName)
    if (!m) return undefined

    // 无调用样本时不报告 100%，标记为 unknown 让上层路由不要优先选择它
    if (m.totalCalls === 0) {
      return {
        adapterName,
        healthScore: 0,
        successRate: 0,
        avgResponseTimeMs: 0,
        status: 'unknown',
        metrics: { ...m },
      }
    }

    const successRate = (m.successCalls / m.totalCalls) * 100
    const responseTimeScore = this.calculateResponseTimeScore(m.avgResponseTimeMs)

    // 综合评分：成功率 70% + 响应时间 30%
    const healthScore = Math.round(successRate * 0.7 + responseTimeScore * 0.3)

    let status: AdapterHealthScore['status']
    if (healthScore >= HEALTH_THRESHOLDS.healthy) {
      status = 'healthy'
    } else if (healthScore >= HEALTH_THRESHOLDS.degraded) {
      status = 'degraded'
    } else {
      status = 'unhealthy'
    }

    return {
      adapterName,
      healthScore,
      successRate: Math.round(successRate * 10) / 10,
      avgResponseTimeMs: Math.round(m.avgResponseTimeMs),
      status,
      metrics: { ...m },
    }
  }

  /**
   * 获取所有适配器的健康评分
   */
  getAllHealth(): AdapterHealthScore[] {
    return Array.from(this.metrics.keys())
      .map((name) => this.getHealth(name))
      .filter((h): h is AdapterHealthScore => h !== undefined)
  }

  /**
   * 获取最健康的适配器（用于智能路由）
   *
   * 过滤掉 unknown（零调用样本）适配器，避免历史可靠适配器被"从没用过的"挤掉。
   * 若所有候选都是 unknown，返回第一个 unknown 让上层有可用选择。
   */
  getHealthiestAdapter(adapterNames: string[]): string | undefined {
    const all = adapterNames
      .map((name) => this.getHealth(name))
      .filter((h): h is AdapterHealthScore => h !== undefined)

    if (all.length === 0) return undefined

    const measured = all.filter((h) => h.status !== 'unknown')
    if (measured.length === 0) {
      // 全部都是零调用，返回名义上第一个
      return all[0].adapterName
    }

    // 按健康评分降序排列，优先选择健康的适配器
    measured.sort((a, b) => b.healthScore - a.healthScore)

    // 如果最高分的适配器状态不是 healthy，记录警告
    if (measured[0].status !== 'healthy') {
      logger.warn(`No healthy adapter available, best option is ${measured[0].adapterName} with score ${measured[0].healthScore}`)
    }

    return measured[0].adapterName
  }

  /**
   * 清理长时间未使用的适配器指标（超过 7 天）
   */
  cleanupStaleMetrics(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
    const now = Date.now()
    for (const [name, m] of this.metrics) {
      if (now - m.lastCalledAt > maxAgeMs) {
        this.metrics.delete(name)
        logger.info(`Cleaned up stale metrics for adapter ${name}`)
      }
    }
  }

  /**
   * 重置指定适配器的指标
   */
  resetMetrics(adapterName: string): void {
    this.metrics.delete(adapterName)
  }

  private calculateResponseTimeScore(avgMs: number): number {
    if (avgMs < 1000) return RESPONSE_TIME_WEIGHTS.excellent
    if (avgMs < 3000) return RESPONSE_TIME_WEIGHTS.good
    if (avgMs < 10000) return RESPONSE_TIME_WEIGHTS.fair
    if (avgMs < 30000) return RESPONSE_TIME_WEIGHTS.poor
    return RESPONSE_TIME_WEIGHTS.bad
  }
}

/** 全局单例 */
export const adapterHealthMonitor = new AdapterHealthMonitor()
