/**
 * C3：profile 生成单测（不执行 git 命令，只检查规则文本与路径归一）。
 * 真实执行面的断言在 harness.test.ts。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSandboxProfile, discoverIncludeTargets } from '../profile'

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

  it('exec 白名单只放系统工具与 git 安装根，不含工作区', () => {
    const { repo } = makeRepo()
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: repo })
    expect(profile.text).toContain('(deny process-exec)')
    const execSection = profile.text.split('(deny process-exec)')[1] ?? ''
    expect(execSection).toContain('(subpath "/usr/bin")')
    expect(execSection).not.toContain(`(subpath "${profile.workspace}")`)
    // 外部程序（例如 Homebrew gpg）不在白名单；只允许具体解析出的工具文件。
    expect(execSection).not.toContain('(subpath "/opt/homebrew/bin")')
    expect(execSection).not.toContain('(subpath "/usr/local/bin")')
  })

  it('MCP profile 只收敛写入面，不做 exec 收敛', () => {
    const { repo } = makeRepo()
    const profile = buildSandboxProfile({ target: 'mcp', workspaceDir: repo })
    expect(profile.text).not.toContain('(deny process-exec)')
    expect(profile.text).toContain('(deny file-write*)')
  })
})
