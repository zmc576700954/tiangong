/**
 * AdaptiveConfig — 自适应配置框架
 *
 * 根据运行时指标自动调整配置参数，使系统在不同负载和场景下保持最优表现。
 * 每个配置项有默认值、上下界和可选的 adaptFn（基于收集的指标自动调整）。
 */

import * as fs from 'fs'

/** 指标样本：可以是简单数值，也可以是包含 ftsScore / embeddingScore 的搜索质量 */
type MetricSample = number | { ftsScore: number; embeddingScore: number }

interface ConfigSpec {
  default: number
  min: number
  max: number
  adaptFn?: (metrics: MetricSample[], currentValue: number) => number
}

const CONFIG_SPECS: Record<string, ConfigSpec> = {
  compressThresholdTokens: {
    default: 4000,
    min: 1000,
    max: 16000,
    adaptFn: (metrics, _current) => {
      if (metrics.length === 0) return _current
      const nums = metrics.map((m) => (typeof m === 'number' ? m : 0))
      const sorted = [...nums].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2
      return median * 2
    },
  },
  ftsWeight: {
    default: 0.5,
    min: 0,
    max: 1,
    adaptFn: (metrics, _current) => {
      if (metrics.length === 0) return _current
      const objects = metrics.filter(
        (m): m is { ftsScore: number; embeddingScore: number } =>
          typeof m === 'object' && m !== null,
      )
      if (objects.length === 0) return _current
      const avgFts = objects.reduce((s, m) => s + m.ftsScore, 0) / objects.length
      const avgEmb = objects.reduce((s, m) => s + m.embeddingScore, 0) / objects.length
      // If FTS quality is higher than embedding quality, increase weight toward FTS
      if (avgFts > avgEmb) {
        return Math.min(1, _current + 0.1)
      }
      return Math.max(0, _current - 0.1)
    },
  },
  memoryMaxItems: {
    default: 5000,
    min: 1000,
    max: 50000,
  },
  pruneHalfLifeDays: {
    default: 30,
    min: 7,
    max: 180,
  },
}

const MAX_SAMPLES_PER_KEY = 100

export class AdaptiveConfig {
  private values: Map<string, number> = new Map()
  private metrics: Map<string, MetricSample[]> = new Map()

  constructor() {
    this.reset()
  }

  /** 返回当前值或默认值 */
  get(key: string): number {
    if (this.values.has(key)) {
      return this.values.get(key)!
    }
    const spec = CONFIG_SPECS[key]
    return spec ? spec.default : 0
  }

  /** 设置值，自动 clamp 到 [min, max] */
  override(key: string, value: number): void {
    const spec = CONFIG_SPECS[key]
    if (!spec) return
    const clamped = Math.min(spec.max, Math.max(spec.min, value))
    this.values.set(key, clamped)
  }

  /** 记录指标样本（每个 key 最多保留 100 条） */
  recordMetric(key: string, value: MetricSample): void {
    if (!CONFIG_SPECS[key]) return
    const samples = this.metrics.get(key) ?? []
    samples.push(value)
    // 保留最近 MAX_SAMPLES_PER_KEY 条
    if (samples.length > MAX_SAMPLES_PER_KEY) {
      samples.splice(0, samples.length - MAX_SAMPLES_PER_KEY)
    }
    this.metrics.set(key, samples)
  }

  /** 运行所有 adaptFn，根据收集的指标调整配置值 */
  adapt(): void {
    for (const [key, spec] of Object.entries(CONFIG_SPECS)) {
      if (!spec.adaptFn) continue
      const samples = this.metrics.get(key) ?? []
      const current = this.get(key)
      const adjusted = spec.adaptFn(samples, current)
      this.override(key, adjusted)
    }
  }

  /** 恢复所有默认值并清空指标 */
  reset(): void {
    this.values.clear()
    this.metrics.clear()
    for (const [key, spec] of Object.entries(CONFIG_SPECS)) {
      this.values.set(key, spec.default)
    }
  }

  /** 导出当前配置快照 */
  snapshot(): Record<string, number> {
    const result: Record<string, number> = {}
    for (const key of Object.keys(CONFIG_SPECS)) {
      result[key] = this.get(key)
    }
    return result
  }

  /** Persist current values and metrics to a JSON file */
  save(filePath: string): void {
    const data = {
      values: Object.fromEntries(this.values),
      metrics: Object.fromEntries(this.metrics),
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  /** Restore values and metrics from a previously saved JSON file */
  load(filePath: string): void {
    if (!fs.existsSync(filePath)) return
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw)
      if (data.values && typeof data.values === 'object') {
        for (const [key, value] of Object.entries(data.values)) {
          if (typeof value === 'number') {
            this.values.set(key, value)
          }
        }
      }
      if (data.metrics && typeof data.metrics === 'object') {
        for (const [key, samples] of Object.entries(data.metrics)) {
          if (Array.isArray(samples)) {
            const validSamples = (samples as unknown[]).filter((s): s is MetricSample => {
              if (typeof s === 'number') return Number.isFinite(s)
              if (typeof s === 'object' && s !== null && 'ftsScore' in s && 'embeddingScore' in s) {
                return typeof (s as Record<string, unknown>).ftsScore === 'number' && typeof (s as Record<string, unknown>).embeddingScore === 'number'
              }
              return false
            })
            this.metrics.set(key, validSamples)
          }
        }
      }
    } catch {
      // Corrupted file — silently skip; defaults remain in place
    }
  }

  /** Start auto-saving at a regular interval; returns the timer for cleanup */
  startAutoSave(filePath: string, intervalMs = 300_000): NodeJS.Timeout {
    return setInterval(() => {
      try {
        this.save(filePath)
      } catch {
        // Best-effort; don't crash on write failure
      }
    }, intervalMs)
  }

  /** Stop auto-save by clearing the timer returned by startAutoSave */
  stopAutoSave(timer: NodeJS.Timeout): void {
    clearInterval(timer)
  }
}

// Singleton
let _instance: AdaptiveConfig | null = null

export function getAdaptiveConfig(): AdaptiveConfig {
  if (!_instance) {
    _instance = new AdaptiveConfig()
  }
  return _instance
}
