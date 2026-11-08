/**
 * G4-6 — §6.8.1 允许清单纪律的可重复检查（allow-list harness）。
 *
 * 清单落点：`tests/migration/allow-list.manifest.ts`（单一数据源）。
 * 防腐化：
 *   1. 清单键必须与源码 `WHITELIST_COMMANDS` **精确相等**（多/少立即失败）；
 *   2. 设白名单命令数下限，防两边同时静默缩减；
 *   3. 每条登记“决策实际读取的配置键”，并由本文件内可检索的断言守护；
 *   4. 计划中的测试命令必须仍是 ask —— 网关未落地前不得擅自放行。
 * 判失败即 CI 红灯，不允许只更新清单不改断言。
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateBashPolicy, WHITELIST_COMMANDS } from '../../src/main/agent/runtime/approval/bash-readonly'
import { ALLOW_LIST_MANIFEST, TEST_COMMAND_PREFIXES, EXPECTED_ALLOW_COUNT } from './allow-list.manifest'

function makeRepo(config: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'bizgraph-allow-harness-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  for (const [key, value] of Object.entries(config)) {
    execFileSync('git', ['config', key, value], { cwd: repo })
  }
  return repo
}

const ctx = (cwd: string) => ({ cwd, includeGlobalGitConfig: false, sandboxAvailable: true })
const pureCtx = (cwd: string) => ({ cwd, includeGlobalGitConfig: false })

describe('G4-6 allow-list harness', () => {
  it('清单键与 WHITELIST_COMMANDS 精确相等，且数量不低于下限', () => {
    expect(WHITELIST_COMMANDS.length).toBeGreaterThanOrEqual(EXPECTED_ALLOW_COUNT)
    expect(Object.keys(ALLOW_LIST_MANIFEST).sort()).toEqual([...WHITELIST_COMMANDS].sort())
  })

  it('每条条目结构完整，且 guardedBy 能在本文件检索到', () => {
    const source = readFileSync(new URL('./allow-list-harness.test.ts', import.meta.url), 'utf8')
    for (const [command, entry] of Object.entries(ALLOW_LIST_MANIFEST)) {
      expect(Array.isArray(entry.decisionConfigKeys), `${command} decisionConfigKeys`).toBe(true)
      expect(entry.note.length, `${command} note`).toBeGreaterThan(0)
      expect(source.includes(entry.guardedBy), `${command} guardedBy 未找到：${entry.guardedBy}`).toBe(true)
    }
  })

  it('git 决策读取 .git/config（fsmonitor 存在时收紧为 ask）', () => {
    const repo = makeRepo()
    try {
      expect(evaluateBashPolicy('git status', pureCtx(repo)).decision).toBe('allow')
      execFileSync('git', ['config', 'core.fsmonitor', '/bin/echo hi'], { cwd: repo })
      // 纯策略（无沙箱门）下 fsmonitor 存在性 → ask；沙箱在位时按 C3 放开
      expect(evaluateBashPolicy('git status', pureCtx(repo)).decision).toBe('ask')
      expect(evaluateBashPolicy('git status', ctx(repo)).decision).toBe('allow')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('非 git 命令的决策不读配置（RIPGREP_CONFIG_PATH 不改变 rg 判定）', () => {
    const repo = makeRepo()
    const original = process.env.RIPGREP_CONFIG_PATH
    process.env.RIPGREP_CONFIG_PATH = join(repo, 'rg.conf')
    try {
      expect(evaluateBashPolicy('rg foo', ctx(repo)).decision).toBe('allow')
      expect(evaluateBashPolicy('grep foo bar', ctx(repo)).decision).toBe('allow')
    } finally {
      if (original === undefined) delete process.env.RIPGREP_CONFIG_PATH
      else process.env.RIPGREP_CONFIG_PATH = original
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('计划中的测试命令一律 ask（网关未落地前禁止擅自放行）', () => {
    const repo = makeRepo()
    try {
      for (const command of TEST_COMMAND_PREFIXES) {
        expect(evaluateBashPolicy(command, ctx(repo)).decision, command).toBe('ask')
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
