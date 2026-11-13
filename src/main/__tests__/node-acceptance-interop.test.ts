/**
 * 节点验收项 → work_item acceptance_json 的互通测试（FR-S1-02 · AC-02-5）。
 *
 * 目的只有一个：证明 `src/shared/acceptance.ts` 产出的 JSON 被**真实执行器**
 * `evaluateAcceptance` 接受。第一版共享类型曾把 `text` 当必填、`expected` 只给
 * manual 用，执行器会直接判 `acceptance_expected_missing`——纯函数单测全绿也发现不了。
 *
 * 因此这里不 mock 执行器的解析逻辑，只注入 runCommand / readFile 两个副作用点。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveAcceptanceTexts,
  normalizeAcceptanceItems,
  serializeAcceptanceItems,
  type AcceptanceItem,
} from '../../shared/acceptance'
import { evaluateAcceptance, type AcceptanceCommandRunner } from '../map/acceptance-executor'

const TMP_ROOTS: string[] = []

afterEach(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true })
  TMP_ROOTS.length = 0
})

function makeProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-acceptance-'))
  TMP_ROOTS.push(dir)
  return dir
}

const okRunner: AcceptanceCommandRunner = async () => ({
  exitCode: 0,
  stdout: 'all passed',
  timedOut: false,
})

describe('legacy 字符串节点 → 执行器', () => {
  it('归一化后的 manual 条目被接受为「待人工确认」，而不是形状错误', async () => {
    const project = makeProject()
    const legacy = ['页面能打开', '提交后列表出现新记录']
    const json = serializeAcceptanceItems(normalizeAcceptanceItems(legacy))

    const verdict = await evaluateAcceptance({ acceptanceJson: json, projectPath: project })

    // 关键断言：没有出现形状类缺失码（曾因字段名不符导致）
    expect(verdict.missing).toEqual([])
    expect(verdict.pending).toEqual(['acceptance_manual_pending:0', 'acceptance_manual_pending:1'])
    expect(verdict.ok).toBe(false) // manual 不自动通过
    expect(verdict.pendingItems.map((item) => item.id)).toEqual(['acc_0', 'acc_1'])
    expect(verdict.pendingItems.map((item) => item.expected)).toEqual(legacy)
  })
})

describe('结构化条目 → 执行器', () => {
  it('command 条目按 expected 执行并以退出码判定', async () => {
    const project = makeProject()
    const items: AcceptanceItem[] = [
      { type: 'command', expected: 'npm test', stdout_contains: 'passed', timeout_ms: 30_000 },
    ]

    const verdict = await evaluateAcceptance({
      acceptanceJson: serializeAcceptanceItems(items),
      projectPath: project,
      runCommand: okRunner,
    })

    expect(verdict.ok).toBe(true)
    expect(verdict.checked).toBe(1)
    expect(verdict.items[0]?.outcome).toBe('pass')
  })

  it('command 退出码非 0 时 fail 且带缺失码', async () => {
    const project = makeProject()
    const failing: AcceptanceCommandRunner = async () => ({
      exitCode: 2,
      stdout: '',
      timedOut: false,
    })

    const verdict = await evaluateAcceptance({
      acceptanceJson: serializeAcceptanceItems([{ type: 'command', expected: 'npm test' }]),
      projectPath: project,
      runCommand: failing,
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_command_exit:0:2'])
  })

  it('file_check 条目按 expected 的相对路径判定存在性与内容', async () => {
    const project = makeProject()
    mkdirSync(path.join(project, 'src'), { recursive: true })
    writeFileSync(path.join(project, 'src', 'feature.ts'), 'export const ok = true\n', 'utf8')

    const pass = await evaluateAcceptance({
      acceptanceJson: serializeAcceptanceItems([
        { type: 'file_check', expected: 'src/feature.ts', content_contains: 'export const ok' },
      ]),
      projectPath: project,
    })
    expect(pass.ok).toBe(true)

    const missingFile = await evaluateAcceptance({
      acceptanceJson: serializeAcceptanceItems([{ type: 'file_check', expected: 'src/nope.ts' }]),
      projectPath: project,
    })
    expect(missingFile.missing).toEqual(['acceptance_file_missing:0'])
  })

  it('混合列表：机器条目通过 + manual 待确认 → 整体未通过但无形状错误', async () => {
    const project = makeProject()
    writeFileSync(path.join(project, 'README.md'), '# demo\n', 'utf8')

    const items: AcceptanceItem[] = [
      { type: 'command', expected: 'npm test' },
      { type: 'file_check', expected: 'README.md' },
      { type: 'manual', expected: '产品确认文案无误', id: 'manual-1' },
    ]

    const verdict = await evaluateAcceptance({
      acceptanceJson: serializeAcceptanceItems(items),
      projectPath: project,
      runCommand: okRunner,
    })

    expect(verdict.items.map((item) => item.outcome)).toEqual(['pass', 'pass', 'pending'])
    expect(verdict.checked).toBe(2)
    expect(verdict.pending).toEqual(['acceptance_manual_pending:2'])
  })
})

describe('派生摘要保持既有人读口径', () => {
  it('结构化节点派生出的字符串数组与画布/提示词消费方兼容', () => {
    const items: AcceptanceItem[] = [
      { type: 'command', expected: 'npm test', text: '单测全绿' },
      { type: 'file_check', expected: 'src/feature.ts' },
    ]
    expect(deriveAcceptanceTexts(items)).toEqual(['单测全绿', 'src/feature.ts'])
  })
})
