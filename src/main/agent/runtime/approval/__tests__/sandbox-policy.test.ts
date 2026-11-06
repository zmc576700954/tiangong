/**
 * C3 策略联动：沙箱在位 → 放开 fsmonitor/hooksPath/alternateRefsCommand 的存在性 ask；
 * 沙箱不可用 → allow 集整体退回 ask（fail-closed），且 gpg 相关判定仍保持 ask。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateBashPolicy } from '../bash-readonly'

function makeRepo(config: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'bizgraph-sbx-policy-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  for (const [key, value] of Object.entries(config)) {
    execFileSync('git', ['config', key, value], { cwd: repo })
  }
  return repo
}

const base = { includeGlobalGitConfig: false } as const

describe('sandbox policy gate', () => {
  it('沙箱不可用 → allow 集整体退回 ask（rule=sandbox-unavailable）', () => {
    const repo = makeRepo()
    const decision = evaluateBashPolicy('git status', {
      cwd: repo,
      ...base,
      sandboxAvailable: false,
      sandboxUnavailableReason: 'platform-unsupported',
    })
    expect(decision).toMatchObject({ decision: 'ask', rule: 'sandbox-unavailable', risk: 'low' })
    expect(decision.reason).toContain('platform-unsupported')
  })

  it('沙箱不可用 → 非 git 的 allow 命令同样退回 ask', () => {
    const repo = makeRepo()
    const decision = evaluateBashPolicy('ls', { cwd: repo, ...base, sandboxAvailable: false })
    expect(decision).toMatchObject({ decision: 'ask', rule: 'sandbox-unavailable' })
  })

  it('未传 sandboxAvailable（纯策略评估）时保持原保守口径', () => {
    const repo = makeRepo({ 'core.fsmonitor': '/bin/echo hi' })
    expect(evaluateBashPolicy('git status', { cwd: repo, ...base }).decision).toBe('ask')
    expect(evaluateBashPolicy('ls', { cwd: repo, ...base }).decision).toBe('allow')
  })

  it('沙箱在位 → fsmonitor / hooksPath 的存在性 ask 放开', () => {
    const repo = makeRepo({ 'core.fsmonitor': '/bin/echo hi' })
    expect(
      evaluateBashPolicy('git status', { cwd: repo, ...base, sandboxAvailable: true }).decision,
    ).toBe('allow')

    execFileSync('git', ['config', 'core.hooksPath', join(repo, 'hooks')], { cwd: repo })
    expect(
      evaluateBashPolicy('git describe --dirty', { cwd: repo, ...base, sandboxAvailable: true }).decision,
    ).toBe('allow')
  })

  it('沙箱在位 → alternateRefsCommand 放开；未开支时仍 ask', () => {
    const repo = makeRepo({ 'core.alternateRefsCommand': '/bin/echo refs/heads/x' })
    expect(
      evaluateBashPolicy('git rev-list --count HEAD', { cwd: repo, ...base, sandboxAvailable: true }).decision,
    ).toBe('allow')
    expect(
      evaluateBashPolicy('git rev-list --count HEAD', { cwd: repo, ...base }).decision,
    ).toBe('ask')
  })

  it('沙箱在位也不放开 gpg.program / %G / log.showSignature', () => {
    const repo = makeRepo({ 'gpg.program': '/tmp/fake-gpg' })
    expect(
      evaluateBashPolicy("git log --format='%G?'", { cwd: repo, ...base, sandboxAvailable: true }),
    ).toMatchObject({ decision: 'ask', rule: 'git-gpg-format' })

    const repo2 = makeRepo({ 'log.showSignature': 'true' })
    expect(
      evaluateBashPolicy('git log -1', { cwd: repo2, ...base, sandboxAvailable: true }).decision,
    ).toBe('ask')

    const repo3 = makeRepo({ 'format.pretty': '%H %G?' })
    expect(
      evaluateBashPolicy('git log -1', { cwd: repo3, ...base, sandboxAvailable: true }).decision,
    ).toBe('ask')
  })

  it('沙箱在位也不放开 diff.external / textconv / filter 的执行型 ask', () => {
    const repo = makeRepo({ 'diff.external': '/tmp/fake-diff' })
    expect(
      evaluateBashPolicy('git diff', { cwd: repo, ...base, sandboxAvailable: true }).decision,
    ).toBe('ask')

    const repo2 = makeRepo({ 'filter.evil.clean': '/tmp/fake-clean' })
    expect(
      evaluateBashPolicy('git status', { cwd: repo2, ...base, sandboxAvailable: true }).decision,
    ).toBe('ask')
  })

  it('写入类命令不受沙箱放宽影响（仍 ask）', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'x.txt'), 'x')
    expect(
      evaluateBashPolicy('git config core.fsmonitor /tmp/evil', {
        cwd: repo,
        ...base,
        sandboxAvailable: true,
      }).decision,
    ).toBe('ask')
  })
})
