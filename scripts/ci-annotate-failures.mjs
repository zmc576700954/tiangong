#!/usr/bin/env node
/**
 * 把测试失败清单压成 GitHub Actions 注解。
 *
 * 为什么需要它：Actions 的 job 日志 API 对非 admin 是 403（`Must have admin rights`），
 * 而 check-run 注解可以匿名读——CI 上唯一的观测通道。但每个 step 的 error 注解上限是
 * 10 条，所以这里按「文件去重、错误首行」压缩，再补一条带计数的汇总。
 *
 * 用法：
 *   node scripts/ci-annotate-failures.mjs vitest /tmp/vitest.json
 *   node scripts/ci-annotate-failures.mjs playwright /tmp/pw.json
 *
 * 退出码始终为 0：它只负责上报，判定失败由上游步骤的 pipefail 决定。
 */

import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'

const MAX_ANNOTATIONS = 8
const CWD = process.cwd()

function esc(text) {
  // 注解值里的换行必须转义，否则会把一条注解截成多条
  return String(text ?? '')
    .replace(/%/g, '%25')
    .replace(/\r?\n/g, '%0A')
    .replace(/\r/g, '%0D')
    .slice(0, 800)
}

function rel(file) {
  if (!file) return 'tests'
  const r = relative(CWD, file)
  return r.startsWith('..') ? file : r
}

function firstLine(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('at ')) ?? ''
}

function emit(level, file, message) {
  console.log(`::${level} file=${rel(file)}::${esc(message)}`)
}

function readJson(path) {
  if (!existsSync(path)) {
    console.log(`::warning::未找到报告文件 ${path}，无法生成失败注解`)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.log(`::warning::报告文件 ${path} 解析失败：${esc(error.message)}`)
    return null
  }
}

/** vitest 的 json reporter（jest 兼容格式） */
function summarizeVitest(report) {
  const files = report?.testResults ?? []
  const failedFiles = files.filter((f) => f.status === 'failed')
  /** @type {{file: string, label: string, message: string}[]} */
  const entries = []

  for (const file of failedFiles) {
    const cases = (file.assertionResults ?? []).filter((a) => a.status === 'failed')
    if (cases.length === 0) {
      // 收集阶段就失败（import 报错）：整文件一条，没有用例级信息
      entries.push({
        file: file.name,
        label: '（整文件收集失败）',
        message: firstLine(file.message),
      })
      continue
    }
    for (const c of cases) {
      entries.push({
        file: file.name,
        label: c.fullName || c.title || '(unnamed)',
        message: firstLine((c.failureMessages ?? [])[0]),
      })
    }
  }

  const seen = new Set()
  let emitted = 0
  for (const e of entries) {
    if (emitted >= MAX_ANNOTATIONS) break
    const key = `${e.file}::${e.label}`
    if (seen.has(key)) continue
    seen.add(key)
    emit('error', e.file, `${e.label} — ${e.message}`)
    emitted++
  }

  const total = report?.numTotalTests ?? 0
  const failed = report?.numFailedTests ?? entries.length
  console.log(
    `::error file=tests::vitest 失败 ${failed} 例 / ${failedFiles.length} 文件` +
      (entries.length > emitted ? `（另 ${entries.length - emitted} 条未列出，详见本轮修复记录）` : '') +
      `；总计 ${total} 例`,
  )
  return failedFiles.length
}

/** Playwright 的 json reporter：spec 嵌在 suite 树里 */
function summarizePlaywright(report) {
  /** @type {{file: string, line: number, label: string, message: string}[]} */
  const entries = []

  const visitSuite = (suite) => {
    for (const spec of suite?.specs ?? []) {
      const results = spec.tests?.flatMap((t) => t.results ?? []) ?? []
      const failed = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped')
      if (spec.ok || failed.length === 0) continue
      const last = failed[failed.length - 1]
      entries.push({
        file: spec.file,
        line: spec.line ?? 1,
        label: [suite.title, spec.title].filter(Boolean).join(' › '),
        message: firstLine(last?.error?.message ?? last?.errors?.[0]?.message),
      })
    }
    for (const child of suite?.suites ?? []) visitSuite(child)
  }
  for (const suite of report?.suites ?? []) visitSuite(suite)

  let emitted = 0
  for (const e of entries) {
    if (emitted >= MAX_ANNOTATIONS) break
    emit('error', e.file, `${e.label} — ${e.message}`)
    emitted++
  }

  const stats = report?.stats ?? {}
  console.log(
    `::error file=tests/e2e::e2e 失败 ${stats.unexpected ?? entries.length} 例 / ` +
      `通过 ${stats.expected ?? 0} 例` +
      (entries.length > emitted ? `（另 ${entries.length - emitted} 条未列出）` : ''),
  )
  return entries.length
}

const [kind, path] = process.argv.slice(2)
if (!kind || !path) {
  console.log('::warning::用法 node scripts/ci-annotate-failures.mjs <vitest|playwright> <report.json>')
  process.exit(0)
}

const report = readJson(path)
if (report) {
  if (kind === 'vitest') summarizeVitest(report)
  else if (kind === 'playwright') summarizePlaywright(report)
  else console.log(`::warning::未知报告类型 ${esc(kind)}`)
}
