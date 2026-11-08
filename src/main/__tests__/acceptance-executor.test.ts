/**
 * D2 确定性验收执行器（§14.8）：command 退出码 / file_check 存在性。
 *
 * 覆盖正例与 fail-closed 反例：退出码、stdout 包含、超时、启动失败；
 * 文件存在/缺失/内容包含、绝对路径、根外逃逸、目录、不可读；
 * 非法/空 JSON、非结构化（存量形状）、未知类型、manual 待确认、project_path 缺失。
 * 所有反例断言 ok=false 且带具体缺失码——不得默认通过。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultAcceptanceCommandRunner,
  evaluateAcceptance,
  type AcceptanceCommandRunner,
} from '../map/acceptance-executor'

const TMP_ROOTS: string[] = []

afterEach(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true })
  TMP_ROOTS.length = 0
})

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'acceptance-'))
  TMP_ROOTS.push(dir)
  return dir
}

function acceptance(...entries: unknown[]): string {
  return JSON.stringify(entries)
}

function commandEntry(expected: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'a', type: 'command', expected, ...extra }
}

function fileEntry(expected: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'f', type: 'file_check', expected, ...extra }
}

const okRunner: AcceptanceCommandRunner = async () => ({ exitCode: 0, stdout: '', timedOut: false })

describe('evaluateAcceptance · command', () => {
  it('退出码 0 → ok', async () => {
    const root = makeRoot()
    const runCommand = vi.fn(okRunner)
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('npm test')),
      projectPath: root,
      runCommand,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.missing).toEqual([])
    expect(verdict.checked).toBe(1)
    expect(runCommand).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: root }))
  })

  it('退出码非 0 → 缺失码带退出码，不通过', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('npm test')),
      projectPath: root,
      runCommand: async () => ({ exitCode: 2, stdout: '', timedOut: false }),
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_command_exit:0:2'])
  })

  it('stdout_contains 命中 → ok；不命中 → 缺失码', async () => {
    const root = makeRoot()
    const base = {
      acceptanceJson: acceptance(commandEntry('npm test', { stdout_contains: 'passed' })),
      projectPath: root,
    }
    const hit = await evaluateAcceptance({
      ...base,
      runCommand: async () => ({ exitCode: 0, stdout: 'all tests passed', timedOut: false }),
    })
    expect(hit.ok).toBe(true)

    const miss = await evaluateAcceptance({
      ...base,
      runCommand: async () => ({ exitCode: 0, stdout: 'all tests failed', timedOut: false }),
    })
    expect(miss.ok).toBe(false)
    expect(miss.missing).toEqual(['acceptance_command_stdout_mismatch:0'])
  })

  it('超时 → acceptance_command_timeout，不通过', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('sleep 5', { timeout_ms: 100 })),
      projectPath: root,
      runCommand: async (_command, options) => {
        expect(options.timeoutMs).toBe(100)
        return { exitCode: -1, stdout: '', timedOut: true }
      },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_command_timeout:0'])
  })

  it('timeout_ms 非法 → 不执行命令，直接判缺失', async () => {
    const root = makeRoot()
    const runCommand = vi.fn(okRunner)
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('npm test', { timeout_ms: 0 })),
      projectPath: root,
      runCommand,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_command_timeout_invalid:0'])
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('命令启动失败（runner reject）→ spawn_failed', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('npm test')),
      projectPath: root,
      runCommand: async () => {
        throw new Error('ENOENT')
      },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_command_spawn_failed:0'])
  })

  it('默认 runner：真实退出码与超时', async () => {
    const root = makeRoot()
    const ok = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('echo ok', { stdout_contains: 'ok' })),
      projectPath: root,
      runCommand: defaultAcceptanceCommandRunner,
    })
    expect(ok.ok).toBe(true)

    const bad = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('exit 3')),
      projectPath: root,
      runCommand: defaultAcceptanceCommandRunner,
    })
    expect(bad.ok).toBe(false)
    expect(bad.missing).toEqual(['acceptance_command_exit:0:3'])
  })
})

describe('evaluateAcceptance · file_check', () => {
  it('路径存在 → ok；缺失 → 缺失码', async () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'a.txt'), 'hello')

    const hit = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry('a.txt')),
      projectPath: root,
    })
    expect(hit.ok).toBe(true)
    expect(hit.checked).toBe(1)

    const miss = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry('missing.txt')),
      projectPath: root,
    })
    expect(miss.ok).toBe(false)
    expect(miss.missing).toEqual(['acceptance_file_missing:0'])
  })

  it('content_contains 命中 → ok；不命中 → 缺失码', async () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'a.txt'), 'hello world')
    const base = {
      acceptanceJson: acceptance(fileEntry('a.txt', { content_contains: 'hello' })),
      projectPath: root,
    }
    expect((await evaluateAcceptance(base)).ok).toBe(true)

    const miss = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry('a.txt', { content_contains: 'goodbye' })),
      projectPath: root,
    })
    expect(miss.ok).toBe(false)
    expect(miss.missing).toEqual(['acceptance_file_content_mismatch:0'])
  })

  it('绝对路径 / 根外逃逸 → 拒绝，不通过', async () => {
    const root = makeRoot()
    const abs = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry(path.join(root, 'a.txt'))),
      projectPath: root,
    })
    expect(abs.ok).toBe(false)
    expect(abs.missing).toEqual(['acceptance_file_not_relative:0'])

    const escape = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry('../outside.txt')),
      projectPath: root,
    })
    expect(escape.ok).toBe(false)
    expect(escape.missing).toEqual(['acceptance_file_outside_root:0'])
  })

  it('路径是目录 → not_file', async () => {
    const root = makeRoot()
    mkdirSync(path.join(root, 'dir'))
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry('dir')),
      projectPath: root,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_file_not_file:0'])
  })

  it('存在但不可读 → unreadable（fail-closed）', async () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'a.txt'), 'hello')
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(fileEntry('a.txt', { content_contains: 'hello' })),
      projectPath: root,
      readFile: () => {
        throw new Error('EACCES')
      },
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_file_unreadable:0'])
  })
})

describe('evaluateAcceptance · 输入与 fail-closed', () => {
  it('project_path 缺失 / 不可解析 / 不是目录 → 对应缺失码', async () => {
    const missing = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('true')),
      projectPath: null,
    })
    expect(missing.ok).toBe(false)
    expect(missing.missing).toEqual(['project_path_missing'])

    const unresolvable = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('true')),
      projectPath: path.join(tmpdir(), 'acceptance-not-exist-xyz'),
    })
    expect(unresolvable.missing).toEqual(['project_path_unresolvable'])

    const root = makeRoot()
    const file = path.join(root, 'a.txt')
    writeFileSync(file, 'x')
    const notDir = await evaluateAcceptance({ acceptanceJson: acceptance(commandEntry('true')), projectPath: file })
    expect(notDir.missing).toEqual(['project_path_not_directory'])
  })

  it('非法 JSON / 空数组 → 不通过', async () => {
    const root = makeRoot()
    const invalid = await evaluateAcceptance({ acceptanceJson: '{not json', projectPath: root })
    expect(invalid.ok).toBe(false)
    expect(invalid.missing).toEqual(['acceptance_json_invalid'])

    const empty = await evaluateAcceptance({ acceptanceJson: '[]', projectPath: root })
    expect(empty.ok).toBe(false)
    expect(empty.missing).toEqual(['acceptance_json_empty'])
  })

  it('存量 [{id,text}] 非结构化 → 逐条缺失（不猜语义）', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: JSON.stringify([{ id: 'legacy', text: '人工描述' }]),
      projectPath: root,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_item_not_structured:0'])
  })

  it('未知 type / expected 缺失 → 对应缺失码', async () => {
    const root = makeRoot()
    const unknown = await evaluateAcceptance({
      acceptanceJson: acceptance({ id: 'x', type: 'deploy', expected: 'ship' }),
      projectPath: root,
    })
    expect(unknown.missing).toEqual(['acceptance_type_unknown:0'])

    const noExpected = await evaluateAcceptance({
      acceptanceJson: acceptance({ id: 'x', type: 'command', expected: '   ' }),
      projectPath: root,
    })
    expect(noExpected.missing).toEqual(['acceptance_expected_missing:0'])
  })

  it('仅 manual → ok=false + pending（待人工，不判 pass），并带可确认明细', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance({ id: 'm', type: 'manual', expected: '人工确认样式正确', text: '请看截图' }),
      projectPath: root,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual([])
    expect(verdict.pending).toEqual(['acceptance_manual_pending:0'])
    expect(verdict.pendingItems).toEqual([
      { id: 'm', expected: '人工确认样式正确', text: '请看截图' },
    ])
    expect(verdict.checked).toBe(0)
  })

  it('manual 缺 id → 无法关联确认事实，按缺失收口', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance({ type: 'manual', expected: '人工确认' }),
      projectPath: root,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual(['acceptance_manual_id_missing:0'])
    expect(verdict.pendingItems).toEqual([])
  })

  it('已确认 manual 视为通过（仅供确认入口重算），不再 pending', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(
        commandEntry('true'),
        { id: 'm1', type: 'manual', expected: '人工确认' },
      ),
      projectPath: root,
      confirmedManualEntryIds: ['m1'],
      runCommand: okRunner,
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.pending).toEqual([])
    expect(verdict.pendingItems).toEqual([])
    expect(verdict.checked).toBe(2)
  })

  it('混合：机器条目通过但仍有 manual → 整体不通过', async () => {
    const root = makeRoot()
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(commandEntry('true'), { id: 'm', type: 'manual', expected: '人工确认' }),
      projectPath: root,
      runCommand: okRunner,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual([])
    expect(verdict.pending).toEqual(['acceptance_manual_pending:1'])
    expect(verdict.pendingItems).toEqual([{ id: 'm', expected: '人工确认' }])
    expect(verdict.checked).toBe(1)
  })
})

describe('evaluateAcceptance · 逐条结果（诊断用）', () => {
  it('command / file_check / manual 各自 outcome 与 codes', async () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'ok.txt'), 'ok')
    const verdict = await evaluateAcceptance({
      acceptanceJson: acceptance(
        commandEntry('true'),
        fileEntry('missing.txt'),
        { id: 'm1', type: 'manual', expected: '人工确认' },
        fileEntry('ok.txt', { content_contains: 'ok' }),
      ),
      projectPath: root,
      runCommand: okRunner,
    })
    expect(verdict.items).toEqual([
      { index: 0, type: 'command', outcome: 'pass', codes: [] },
      { index: 1, type: 'file_check', outcome: 'fail', codes: ['acceptance_file_missing:1'] },
      { index: 2, id: 'm1', type: 'manual', outcome: 'pending', codes: ['acceptance_manual_pending:2'] },
      { index: 3, type: 'file_check', outcome: 'pass', codes: [] },
    ])
  })
})
