/**
 * C6：codex doctor --json 解析。
 *
 * 夹具来自本机真实输出（`node node_modules/@openai/codex/bin/codex.js doctor --json`，
 * 因用户 `~/.codex/config.toml` 的 `model_reasoning_effort="max"` 导致 CLI exit 1）。
 * 测试只验证解析逻辑，不修改用户配置。
 */

import { describe, expect, it } from 'vitest'
import { parseCodexDoctorReport } from '../executors/codex-health'

const REAL_FAILING_REPORT = JSON.stringify({
  overallStatus: 'fail',
  checks: {
    'config.load': {
      id: 'config.load',
      category: 'config',
      status: 'fail',
      summary: 'config could not be loaded',
      details: {},
      notes: ['failed to load Codex config'],
      remediation: 'Fix the reported config error, then rerun codex doctor.',
      durationMs: 0,
    },
  },
})

describe('parseCodexDoctorReport (C6)', () => {
  it('reports the config.load failure with readable notes', () => {
    const result = parseCodexDoctorReport(REAL_FAILING_REPORT)
    expect(result.ok).toBe(false)
    expect(result.rawStatus).toBe('fail')
    expect(result.reason).toContain('config could not be loaded')
    expect(result.reason).toContain('failed to load Codex config')
  })

  it('accepts a passing config.load check', () => {
    const result = parseCodexDoctorReport(
      JSON.stringify({ overallStatus: 'ok', checks: { 'config.load': { id: 'config.load', status: 'ok' } } }),
    )
    expect(result).toMatchObject({ ok: true, rawStatus: 'ok' })
  })

  it('treats missing checks["config.load"] as invalid', () => {
    expect(parseCodexDoctorReport(JSON.stringify({ overallStatus: 'ok', checks: {} })).ok).toBe(false)
    expect(parseCodexDoctorReport('not-json').ok).toBe(false)
  })
})
