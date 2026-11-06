import { describe, expect, it } from 'vitest'
import { SessionExecutor } from '../src/concurrency/session-executor'

interface RoundResult {
  round: number
  iterations: number
  meanMs: number
  p50Ms: number
  p99Ms: number
  totalMs: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

async function measureRound(round: number, iterations: number): Promise<RoundResult> {
  const executor = new SessionExecutor()
  const durations: number[] = []
  const started = performance.now()
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now()
    await executor.submit('bench-run', `turn-${i}`, () => undefined)
    durations.push(performance.now() - t0)
  }
  const totalMs = performance.now() - started
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    round,
    iterations,
    meanMs: durations.reduce((a, b) => a + b, 0) / durations.length,
    p50Ms: percentile(sorted, 0.5),
    p99Ms: percentile(sorted, 0.99),
    totalMs,
  }
}

describe('锁开销测量（对应旧文档 V8 / 新文档 SessionExecutor）', () => {
  it('1000 次加锁/释放 × 3 轮：P99 < 5ms', async () => {
    const results: RoundResult[] = []
    for (let round = 1; round <= 3; round += 1) {
      results.push(await measureRound(round, 1_000))
    }
    // 报告原始数据，方便 README 引用；每个条件至少 3 次，不挑最好的一次
    console.log('[lock-overhead] ' + JSON.stringify(results))

    for (const result of results) {
      expect(result.p99Ms, `round ${result.round} p99`).toBeLessThan(5)
      expect(result.meanMs, `round ${result.round} mean`).toBeLessThan(1)
    }
  }, 60_000)
})
