/**
 * C3 Harness：三条判据的可执行验收物（macOS）。
 *
 * (a) allow 命令确实在沙箱内执行：这里用真实 `sandbox-exec -p <profile> -- git` 复现
 *     生产 spawn 形态；沙箱不可用时整组 skip（不能把「不可用」当通过）。
 * (b) 毒化配置/仓库状态矩阵：工作区外无 marker、gitdir 关键文件哈希不变。
 * (c) `allow 集 ⊆ 沙箱安全集`：allow 集里的每个子命令都在毒化仓库里跑一遍。
 * 另外：良性仓库上沙箱内 stdout 与不开沙箱一致（防止「全部失败也算安全」的假绿）。
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getSandboxCapability } from '../capability'
import { buildSandboxProfile } from '../profile'

const available = process.platform === 'darwin' && getSandboxCapability().available
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const GIT = '/usr/bin/git'

function gitEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, 'missing-global'),
    GIT_CONFIG_SYSTEM: join(home, 'missing-system'),
  }
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(GIT, args, { cwd, env, encoding: 'utf-8', timeout: 20_000 })
}

function sandboxedGit(
  profile: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(SANDBOX_EXEC, ['-p', profile, '--', GIT, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 20_000,
  })
}

function sandboxedShell(profile: string, script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(SANDBOX_EXEC, ['-p', profile, '--', '/bin/sh', '-c', script], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 20_000,
  })
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

interface Fixture {
  root: string
  repo: string
  outside: string
  marker: string
  insideMarker: string
  hookMarker: string
  hookInsideMarker: string
  env: NodeJS.ProcessEnv
}

const cleanup: string[] = []

function initFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bizgraph-sbx-harness-')))
  cleanup.push(root)
  const repo = join(root, 'repo')
  const outside = join(root, 'outside')
  mkdirSync(repo)
  mkdirSync(outside)
  const env = gitEnv(root)
  git(['init', '-q'], repo, env)
  git(['config', 'user.email', 'a@b.c'], repo, env)
  git(['config', 'user.name', 'a'], repo, env)
  writeFileSync(join(repo, 'a.txt'), 'hi\n')
  git(['add', 'a.txt'], repo, env)
  git(['commit', '-qm', 'init'], repo, env)
  git(['tag', '-a', 'v1', '-m', 'v1'], repo, env)
  return {
    root,
    repo,
    outside,
    marker: join(root, 'marker-fsmonitor'),
    insideMarker: join(repo, '.sbx-fsmonitor-marker'),
    hookMarker: join(root, 'marker-hook'),
    hookInsideMarker: join(repo, '.sbx-hook-marker'),
    env,
  }
}

function poisonFsmonitor(fixture: Fixture): string {
  const script = join(fixture.outside, 'fsmon.sh')
  // 同时写「工作区外」和「工作区内」两个 marker：
  // - 外部 marker 证明写面收敛；
  // - 内部 marker 证明脚本**根本没被执行**（exec 白名单生效），而不是「执行了但写不出去」。
  writeFileSync(
    script,
    `#!/bin/sh\nprintf x >> "${fixture.marker}"\nprintf x >> "${fixture.insideMarker}"\n`,
    { mode: 0o700 },
  )
  chmodSync(script, 0o700)
  git(['config', 'core.fsmonitor', script], fixture.repo, fixture.env)
  return script
}

function poisonHooksPath(fixture: Fixture): string {
  const hooks = join(fixture.outside, 'hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'post-index-change')
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf x >> "${fixture.hookMarker}"\nprintf x >> "${fixture.hookInsideMarker}"\n`,
    { mode: 0o700 },
  )
  chmodSync(hook, 0o700)
  git(['config', 'core.hooksPath', hooks], fixture.repo, fixture.env)
  return hooks
}

afterAll(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

describe.skipIf(!available)('C3 Harness（macOS sandbox-exec）', () => {
  it('(a) fsmonitor 毒化：不开沙箱真实生成 marker，沙箱内 exit 0 且 marker 不存在', () => {
    const fixture = initFixture()
    poisonFsmonitor(fixture)
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: fixture.repo }).text

    // 对照组：证明毒化配置真的会执行外部程序（否则后面的「无 marker」是假绿）。
    rmSync(fixture.marker, { force: true })
    rmSync(fixture.insideMarker, { force: true })
    const control = git(['status', '--porcelain=v1'], fixture.repo, fixture.env)
    expect(control.status).toBe(0)
    expect(existsSync(fixture.marker)).toBe(true)
    expect(existsSync(fixture.insideMarker)).toBe(true)

    rmSync(fixture.marker, { force: true })
    rmSync(fixture.insideMarker, { force: true })
    const guarded = sandboxedGit(profile, ['status', '--porcelain=v1'], fixture.repo, fixture.env)
    expect(guarded.status).toBe(0)
    expect(existsSync(fixture.marker)).toBe(false)
    expect(existsSync(fixture.insideMarker)).toBe(false)
  })

  it('(a) hooksPath 毒化：describe --dirty 触发 hook，沙箱内 marker 不存在', () => {
    const fixture = initFixture()
    poisonHooksPath(fixture)
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: fixture.repo }).text

    rmSync(fixture.hookMarker, { force: true })
    rmSync(fixture.hookInsideMarker, { force: true })
    const control = git(['describe', '--dirty'], fixture.repo, fixture.env)
    expect(control.status).toBe(0)
    expect(existsSync(fixture.hookMarker)).toBe(true)
    expect(existsSync(fixture.hookInsideMarker)).toBe(true)

    rmSync(fixture.hookMarker, { force: true })
    rmSync(fixture.hookInsideMarker, { force: true })
    const guarded = sandboxedGit(profile, ['describe', '--dirty'], fixture.repo, fixture.env)
    expect(guarded.status).toBe(0)
    expect(existsSync(fixture.hookMarker)).toBe(false)
    expect(existsSync(fixture.hookInsideMarker)).toBe(false)
  })

  it('(b) gitdir 写入被拒：config 与 config.lock 写不进，哈希不变', () => {
    const fixture = initFixture()
    const config = join(fixture.repo, '.git', 'config')
    const before = sha256(config)
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: fixture.repo }).text

    const shell = sandboxedShell(
      profile,
      `printf '\\n[core]\\n\\tfsmonitor = /tmp/evil\\n' >> .git/config`,
      fixture.repo,
      fixture.env,
    )
    expect(shell.status).not.toBe(0)

    const gitConfig = sandboxedGit(profile, ['config', 'core.fsmonitor', '/tmp/evil'], fixture.repo, fixture.env)
    expect(gitConfig.status).not.toBe(0)

    expect(sha256(config)).toBe(before)
    // 工作区普通文件仍可写，证明不是「全部写都拒」。
    const normal = sandboxedShell(profile, 'printf ok > normal.txt', fixture.repo, fixture.env)
    expect(normal.status).toBe(0)
  })

  it('(b) include 目标被拒：工作区内 include 目标不可写，同名未 include 文件可写', () => {
    const fixture = initFixture()
    git(['config', 'include.path', '../inc.inc'], fixture.repo, fixture.env)
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: fixture.repo }).text

    const includeWrite = sandboxedShell(profile, 'printf evil > inc.inc', fixture.repo, fixture.env)
    expect(includeWrite.status).not.toBe(0)
    expect(existsSync(join(fixture.repo, 'inc.inc'))).toBe(false)

    const otherWrite = sandboxedShell(profile, 'printf ok > not-included.txt', fixture.repo, fixture.env)
    expect(otherWrite.status).toBe(0)
  })

  it('(c) allow 集 ⊆ 沙箱安全集：毒化仓库里 18 条只读子命令都无外部 marker、gitdir 哈希不变', () => {
    const fixture = initFixture()
    poisonFsmonitor(fixture)
    poisonHooksPath(fixture)
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: fixture.repo }).text
    const config = join(fixture.repo, '.git', 'config')
    const hooksProtected = join(fixture.repo, '.git', 'hooks')
    const beforeConfig = sha256(config)

    const cases: Array<[string, string[]]> = [
      ['status', ['--porcelain=v1']],
      ['log', ['-1', '--oneline']],
      ['diff', []],
      ['show', ['--stat', 'HEAD']],
      ['rev-parse', ['HEAD']],
      ['blame', ['a.txt']],
      ['ls-files', []],
      ['describe', ['--dirty', '--tags']],
      ['shortlog', ['-s', 'HEAD']],
      ['cat-file', ['-t', 'HEAD']],
      ['show-ref', []],
      ['for-each-ref', []],
      ['whatchanged', ['-1', '--oneline']],
      ['merge-base', ['HEAD', 'HEAD']],
      ['name-rev', ['HEAD']],
      ['rev-list', ['--count', 'HEAD']],
      ['count-objects', []],
      ['fsck', ['--no-progress']],
    ]

    for (const [sub, args] of cases) {
      rmSync(fixture.marker, { force: true })
      rmSync(fixture.insideMarker, { force: true })
      rmSync(fixture.hookMarker, { force: true })
      rmSync(fixture.hookInsideMarker, { force: true })
      const result = sandboxedGit(profile, [sub, ...args], fixture.repo, fixture.env)
      expect(result.status, `${sub} 在沙箱内应正常执行`).toBe(0)
      expect(existsSync(fixture.marker), `${sub} 未生成工作区外 marker`).toBe(false)
      expect(existsSync(fixture.insideMarker), `${sub} 未执行 fsmonitor 脚本（工作区内 marker 也不该出现`).toBe(false)
      expect(existsSync(fixture.hookMarker), `${sub} 未触发工作区外 hook marker`).toBe(false)
      expect(existsSync(fixture.hookInsideMarker), `${sub} 未执行 hook 脚本（工作区内 marker 也不该出现）`).toBe(false)
      expect(sha256(config), `${sub} 后 .git/config 未变`).toBe(beforeConfig)
      expect(existsSync(hooksProtected), '.git/hooks 目录仍在').toBe(true)
    }
  })

  it('良性仓库：沙箱内 stdout 与不开沙箱一致（读功能没被弄坏）', () => {
    const fixture = initFixture()
    const profile = buildSandboxProfile({ target: 'claude', workspaceDir: fixture.repo }).text

    for (const args of [
      ['status', '--porcelain=v1'],
      ['log', '-1', '--oneline'],
      ['diff'],
      ['show', '--stat', 'HEAD'],
      ['rev-parse', 'HEAD'],
      ['ls-files'],
      ['describe', '--tags'],
    ]) {
      const plain = git(args, fixture.repo, fixture.env)
      const guarded = sandboxedGit(profile, args, fixture.repo, fixture.env)
      expect(guarded.status, `${args.join(' ')} exit 0`).toBe(0)
      expect(guarded.stdout, `${args.join(' ')} stdout 一致`).toBe(plain.stdout)
    }
  })
})
