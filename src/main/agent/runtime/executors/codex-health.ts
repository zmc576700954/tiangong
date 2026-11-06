/**
 * C6：Codex 配置前置校验。
 *
 * 不修改 ~/.codex/config.toml。只调用 `codex doctor --json` 并解析
 * checks["config.load"]；失败时给出可读报错，避免 CLI exit 1 变成神秘故障。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { AgentRuntimeError } from '../errors'

const execFileAsync = promisify(execFile)

interface DoctorCheck {
  id?: string
  status?: string
  summary?: string
  notes?: string[]
  remediation?: string
}

interface DoctorReport {
  overallStatus?: string
  checks?: Record<string, DoctorCheck>
}

export interface CodexHealthResult {
  ok: boolean
  reason?: string
  rawStatus?: string
}

export function parseCodexDoctorReport(json: string): CodexHealthResult {
  let report: DoctorReport
  try {
    report = JSON.parse(json) as DoctorReport
  } catch {
    return { ok: false, reason: 'codex doctor returned invalid JSON' }
  }
  const check = report.checks?.['config.load']
  if (!check) {
    return { ok: false, reason: 'codex doctor did not report checks["config.load"]' }
  }
  if (check.status !== 'fail') {
    return { ok: true, rawStatus: check.status }
  }
  const details = [...(check.notes ?? [])]
  if (check.summary) details.unshift(check.summary)
  if (check.remediation) details.push(check.remediation)
  return {
    ok: false,
    rawStatus: check.status,
    reason: `Codex config failed to load: ${details.join('; ')}`,
  }
}

function resolveCodexCli(): string | null {
  try {
    const require = createRequire(import.meta.url)
    return require.resolve('@openai/codex/bin/codex.js')
  } catch {
    return null
  }
}

export class CodexHealthChecker {
  private cached: CodexHealthResult | null = null

  constructor(
    private readonly options: { cliPath?: string; timeoutMs?: number; cache?: boolean } = {},
  ) {}

  async check(): Promise<CodexHealthResult> {
    if (this.options.cache !== false && this.cached) return this.cached
    const cli = this.options.cliPath ?? resolveCodexCli()
    if (!cli) {
      const result: CodexHealthResult = { ok: false, reason: '@openai/codex CLI not found; run npm install' }
      this.cached = result
      return result
    }
    try {
      const { stdout } = await execFileAsync(process.execPath, [cli, 'doctor', '--json'], {
        timeout: this.options.timeoutMs ?? 20_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      const result = parseCodexDoctorReport(stdout)
      this.cached = result
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const result: CodexHealthResult = { ok: false, reason: `codex doctor failed to run: ${message}` }
      this.cached = result
      return result
    }
  }

  async assertHealthy(): Promise<void> {
    const result = await this.check()
    if (!result.ok) {
      throw new AgentRuntimeError(
        'EXECUTOR_CONFIG_INVALID',
        result.reason ?? 'Codex configuration is invalid',
      )
    }
  }
}
