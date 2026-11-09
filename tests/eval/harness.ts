/**
 * W5-D 评测 harness 公共件。
 *
 * 口径：
 * - PASS / FAIL 只来自本次真实执行；
 * - 缺依赖、缺凭据或不在适用平台时记 SKIP，并在 detail 写清「缺什么」，
 *   不把「没跑」写成 PASS，也不把 ABI 不匹配当成性能结论；
 * - 汇总落盘到 test-results/agent-eval-report.json（gitignore）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { it, type TestContext } from 'vitest'

export type EvalStatus = 'PASS' | 'FAIL' | 'SKIP'

export interface EvalResult {
  status: EvalStatus
  detail: string
  metrics?: Record<string, number | string>
}

export interface EvalRecord extends EvalResult {
  id: string
  title: string
}

const records: EvalRecord[] = []

export function itEval(
  id: string,
  title: string,
  fn: (ctx: TestContext) => EvalResult | Promise<EvalResult>,
): void {
  it(`${id} ${title}`, async (ctx) => {
    let result: EvalResult
    try {
      result = await fn(ctx)
    } catch (error) {
      result = {
        status: 'FAIL',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    records.push({ id, title, ...result })
    console.log(`[agent-eval] ${id} ${result.status} :: ${result.detail}`)
    if (result.status === 'SKIP') ctx.skip(result.detail)
    if (result.status === 'FAIL') throw new Error(`${id} FAIL: ${result.detail}`)
  })
}

export function writeEvalReport(): void {
  const dir = path.resolve('test-results')
  fs.mkdirSync(dir, { recursive: true })
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    nodeModuleVersion: process.versions.modules,
    electron: process.versions.electron ?? null,
    records,
  }
  fs.writeFileSync(path.join(dir, 'agent-eval-report.json'), `${JSON.stringify(report, null, 2)}\n`)

  const width = Math.max(...records.map((r) => r.id.length), 2)
  console.log('\n[agent-eval] summary')
  for (const record of records) {
    console.log(`  ${record.id.padEnd(width)}  ${record.status.padEnd(4)}  ${record.detail}`)
  }
  const count = (status: EvalStatus) => records.filter((r) => r.status === status).length
  console.log(
    `  total=${records.length} pass=${count('PASS')} fail=${count('FAIL')} skip=${count('SKIP')}\n`,
  )
}
