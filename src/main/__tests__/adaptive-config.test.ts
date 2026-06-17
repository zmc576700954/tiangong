import { describe, it, expect, beforeEach } from 'vitest'
import { AdaptiveConfig } from '../adaptive-config'

describe('AdaptiveConfig', () => {
  let config: AdaptiveConfig

  beforeEach(() => {
    config = new AdaptiveConfig()
  })

  it('returns default values initially', () => {
    expect(config.get('compressThresholdTokens')).toBe(4000)
    expect(config.get('ftsWeight')).toBe(0.5)
    expect(config.get('memoryMaxItems')).toBe(5000)
    expect(config.get('pruneHalfLifeDays')).toBe(30)
  })

  it('adapts compress threshold based on output size distribution', () => {
    // Record 20 small outputs (median ~500), adaptFn returns median * 2 ≈ 1000
    for (let i = 0; i < 20; i++) {
      config.recordMetric('compressThresholdTokens', 400 + (i % 3) * 100)
    }
    config.adapt()
    // median of [400,500,600 repeated] = 500, so threshold = 500 * 2 = 1000
    // Clamped to min 1000
    expect(config.get('compressThresholdTokens')).toBeLessThan(4000)
    expect(config.get('compressThresholdTokens')).toBeGreaterThanOrEqual(1000)
  })

  it('adapts fts weight based on search result quality', () => {
    // Record 10 high-FTS results where FTS score dominates embedding score
    for (let i = 0; i < 10; i++) {
      config.recordMetric('ftsWeight', { ftsScore: 0.9, embeddingScore: 0.3 })
    }
    config.adapt()
    // adaptFn should increase ftsWeight above the default 0.5
    expect(config.get('ftsWeight')).toBeGreaterThan(0.5)
  })

  it('clamps values within bounds', () => {
    config.override('ftsWeight', 1.5)
    expect(config.get('ftsWeight')).toBe(1.0)

    config.override('ftsWeight', -0.5)
    expect(config.get('ftsWeight')).toBe(0)

    config.override('compressThresholdTokens', 50000)
    expect(config.get('compressThresholdTokens')).toBe(16000)

    config.override('compressThresholdTokens', 100)
    expect(config.get('compressThresholdTokens')).toBe(1000)
  })

  it('reset restores defaults', () => {
    config.override('ftsWeight', 0.9)
    config.override('memoryMaxItems', 20000)
    config.recordMetric('compressThresholdTokens', 100)
    config.recordMetric('ftsWeight', { ftsScore: 0.8, embeddingScore: 0.2 })

    config.reset()

    expect(config.get('ftsWeight')).toBe(0.5)
    expect(config.get('memoryMaxItems')).toBe(5000)
    expect(config.get('compressThresholdTokens')).toBe(4000)
    expect(config.get('pruneHalfLifeDays')).toBe(30)
  })
})
