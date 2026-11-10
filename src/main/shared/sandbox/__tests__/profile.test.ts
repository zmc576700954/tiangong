/**
 * C3：profile 生成单测（不执行 git 命令，只检查规则文本与路径归一）。
 * 真实执行面的断言在 harness.test.ts。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSandboxProfile, discoverIncludeTargets, NETWORK_EXEC_COMMANDS, SYSTEM_EXEC_LITERALS, SYSTEM_EXEC_SUBPATHS } from '../profile'

function makeRepo(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bizgraph-sbx-profile-')))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: repo })
  writeFileSync(join(repo, 'a.txt'), 'hi\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
  return { root, repo }
}

describe('sandbox profile', () => {
  it('工作区路径 realpath 归一（/tmp 与 /private/tmp 不混用）', () => {
    const repo = mkdtempSync(join(tmpdir(), 'bizgraph-sbx-real-'))
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: repo })
    const real = realpathSync(repo)
    expect(profile.workspace).toBe(real)
    expect(profile.text).toContain(`(subpath "${real}")`)
    if (process.platform === 'darwin' && repo.startsWith('/tmp/')) {
      // 未归一时 `/tmp/...` 与 `/private/tmp/...` 会让 SBPL subpath 失配。
      expect(profile.text).not.toContain(`(subpath "${repo}")`)
    }
  })

  it('gitdir 敏感写面与 include 目标进入 deny', () => {
    const { repo } = makeRepo()
    // 相对 .git/config 解析：../inc.inc → 工作区根 inc.inc
    execFileSync('git', ['config', 'include.path', '../inc.inc'], { cwd: repo })
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: repo })

    expect(profile.gitDirs.length).toBeGreaterThan(0)
    expect(profile.text).toContain('(deny file-write*)')
    expect(profile.protectedWrites).toEqual(
      expect.arrayContaining([
        join(profile.gitDirs[0], 'config'),
        join(profile.gitDirs[0], 'config.lock'),
        join(profile.gitDirs[0], 'info', 'exclude'),
        join(profile.workspace, 'inc.inc'),
      ]),
    )
    expect(profile.text).toContain(`(subpath "${join(profile.gitDirs[0], 'hooks')}")`)
  })

  it('include 目标解析走 git 自己（含相对路径）', () => {
    const { repo } = makeRepo()
    execFileSync('git', ['config', 'include.path', '../inc.inc'], { cwd: repo })
    const targets = discoverIncludeTargets(repo)
    expect(targets).toContain(join(realpathSync(repo), 'inc.inc'))
  })

  it('exec 收敛为 literal：不再整目录放行 /bin、/usr/bin，网络命令不在名单', () => {
    const { repo } = makeRepo()
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: repo })
    expect(profile.text).toContain('(deny process-exec)')
    const execSection = profile.text.split('(deny process-exec)')[1] ?? ''

    // 目录级只剩 /System/Library；四个命令目录一律不再以 subpath 出现。
    for (const dir of ['/bin', '/usr/bin', '/usr/sbin', '/usr/libexec']) {
      expect(execSection).not.toContain(`(subpath "${dir}")`)
    }
    if (process.platform === 'darwin') {
      expect(execSection).toContain('(subpath "/System/Library")')
    }

    // 产品必需与白名单命令按 literal 放行。
    expect(execSection).toContain('(literal "/bin/sh")')
    expect(execSection).toContain('(literal "/usr/bin/env")')
    expect(execSection).toMatch(/\(literal "[^"]*\/git"\)/)
    expect(execSection).not.toContain(`(literal "${profile.workspace}")`)
    expect(execSection).not.toContain('(subpath "/opt/homebrew/bin")')
    expect(execSection).not.toContain('(subpath "/usr/local/bin")')

    // G7-7 收口：arch 无调用方已删除。
    expect(execSection).not.toContain('(literal "/usr/bin/arch")')
    // npm/npx 是 symlink，exec 检查落在 realpath（*-cli.js）；删除会让 npm 126，必须保留。
    expect(execSection).toMatch(/-cli\.js"/)

    // git 只放行 git-core（subpath）与 git 本体（literal），不再整根放行安装根。
    const gitCore = realpathSync(execFileSync('git', ['--exec-path'], { encoding: 'utf-8' }).trim())
    const installRoot = realpathSync(join(gitCore, '..', '..', '..'))
    const gitBin = realpathSync(join(gitCore, '..', '..', 'bin', 'git'))
    expect(execSection).toContain(`(subpath "${gitCore}")`)
    expect(execSection).toContain(`(literal "${gitBin}")`)
    expect(execSection).not.toContain(`(subpath "${installRoot}")`)

    // 网络类命令即使被审批放行，也不得进入沙箱 exec 名单。
    for (const command of NETWORK_EXEC_COMMANDS) {
      expect(execSection).not.toMatch(new RegExp(`\\(literal "[^"]*/${command}"\\)`))
    }
    // 拒绝不是静默的：notes 必须写明 EPERM 失败表现。
    expect(profile.notes.join(' ')).toContain('Operation not permitted')
  })

  it('exec 名单快照：安全边界改动必须撞测试', () => {
    expect(SYSTEM_EXEC_LITERALS).toEqual([
      '/bin/sh',
      '/bin/bash',
      '/bin/zsh',
      '/usr/bin/env',
      '/usr/bin/xcrun',
    ])
    expect(SYSTEM_EXEC_SUBPATHS).toEqual(['/System/Library'])
    expect(NETWORK_EXEC_COMMANDS).toEqual(['ssh', 'scp', 'curl', 'wget', 'nc'])
  })

  it('MCP profile 只收敛写入面，不做 exec 收敛', () => {
    const { repo } = makeRepo()
    const profile = buildSandboxProfile({ target: 'mcp', workspaceDir: repo })
    expect(profile.text).not.toContain('(deny process-exec)')
    expect(profile.text).toContain('(deny file-write*)')
  })
})
