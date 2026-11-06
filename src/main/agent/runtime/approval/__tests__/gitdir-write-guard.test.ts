/**
 * D1：写类工具不得写入 git 元数据目录。
 *
 * 口径：命中 gitdir / commonDir / modules / 外部 gitdir / `.git` 指针 → **deny**（不是 ask）；
 * symlink、hardlink、macOS 大小写变体、`..`、不存在路径都要覆盖；
 * 探测失败 fail-closed；`BIZGRAPH_GITDIR_WRITE_GUARD=ask|off` 可回退。
 */

import { execFileSync } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateGitDirWriteGuard } from '../gitdir-write-guard'

function makeTemp(prefix = 'gitdir-guard-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo(root: string, name = 'repo'): string {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'a@b.c'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, ['add', 'a.txt'])
  git(repo, ['commit', '-qm', 'init'])
  return repo
}

function guard(targets: string[], cwd: string, toolName = 'Write') {
  return evaluateGitDirWriteGuard(toolName, { file_path: targets[0], paths: targets.slice(1) }, { cwd })
}

const tempDirs: string[] = []
function temp(): string {
  const dir = makeTemp()
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.BIZGRAPH_GITDIR_WRITE_GUARD
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('D1 · gitdir 写保护：命中即 deny', () => {
  it('写 .git/config / config.worktree / hooks / index → deny（不是 ask）', () => {
    const root = temp()
    const repo = makeRepo(root)
    const targets = [
      join(repo, '.git', 'config'),
      join(repo, '.git', 'config.worktree'),
      join(repo, '.git', 'hooks', 'pre-commit'),
      join(repo, '.git', 'index'),
    ]
    for (const target of targets) {
      const result = guard([target], repo)
      expect(result.verdict, target).toBe('block')
      expect(result.reason).toContain('git 元数据目录')
    }
  })

  it('目标是 `.git` 目录本身（含尾随斜杠）→ deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    for (const target of [join(repo, '.git'), `${join(repo, '.git')}/`]) {
      const result = guard([target], repo)
      expect(result.verdict, target).toBe('block')
    }
  })

  it('路径含 .. / . / 重复分隔符时仍 deny（path.resolve 归一）', () => {
    const root = temp()
    const repo = makeRepo(root)
    const targets = [
      join(repo, '.git', '..', '.git', 'config'),
      `${repo}//.git///config`,
      join(repo, '.', '.git', './config'),
      join(repo, '.git', 'config', '..', 'hooks', 'x'),
    ]
    for (const target of targets) {
      expect(guard([target], repo).verdict, target).toBe('block')
    }
  })

  it('目标尚不存在：父目录存在（hooks/new-hook）与父目录不存在（.git/newdir/x）都 deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    expect(guard([join(repo, '.git', 'hooks', 'new-hook')], repo).verdict).toBe('block')
    expect(guard([join(repo, '.git', 'newdir', 'x')], repo).verdict).toBe('block')
  })

  it('symlink：文件 symlink、目录 symlink、祖先目录 symlink 都 deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    // 文件 symlink：repo/config-link -> .git/config
    symlinkSync(join(repo, '.git', 'config'), join(repo, 'config-link'))
    expect(guard([join(repo, 'config-link')], repo).verdict).toBe('block')
    // 目录 symlink：repo/git-dir-link -> .git
    symlinkSync(join(repo, '.git'), join(repo, 'git-dir-link'))
    expect(guard([join(repo, 'git-dir-link', 'config')], repo).verdict).toBe('block')
    expect(guard([join(repo, 'git-dir-link', 'does-not-exist')], repo).verdict).toBe('block')
    // 祖先目录是 symlink：repo/hooks-link -> .git/hooks
    symlinkSync(join(repo, '.git', 'hooks'), join(repo, 'hooks-link'))
    expect(guard([join(repo, 'hooks-link', 'post-commit')], repo).verdict).toBe('block')
  })

  it('hardlink：与 .git/config 同 inode 的外部路径 → deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    const hardlink = join(root, 'same-inode')
    linkSync(join(repo, '.git', 'config'), hardlink)
    const result = guard([hardlink], repo)
    expect(result.verdict).toBe('block')
    expect(result.rule).toBe('gitdir-hardlink')
  })

  it('大小写变体（macOS APFS）：.GIT/config → deny；非 darwin 跳过', () => {
    if (process.platform !== 'darwin') return
    const root = temp()
    const repo = makeRepo(root)
    expect(guard([join(repo, '.GIT', 'config')], repo).verdict).toBe('block')
    expect(guard([join(repo, '.GiT', 'hooks', 'x')], repo).verdict).toBe('block')
  })

  it('目标属于另一个仓库（cwd 是 repo A，目标是 repo B 的 .git/config）→ deny', () => {
    const root = temp()
    const repoA = makeRepo(root, 'a')
    const repoB = makeRepo(root, 'b')
    expect(guard([join(repoB, '.git', 'config')], repoA).verdict).toBe('block')
  })

  it('外部 gitdir（.git 是 gitdir 文件）及其 modules → deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    const external = join(root, 'external.git')
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    mkdirSync(external, { recursive: true })
    git(repo, ['init', '-q', '--separate-git-dir', external])
    expect(readFileSync(join(repo, '.git'), 'utf8')).toContain('gitdir:')
    expect(guard([join(external, 'config')], repo).verdict).toBe('block')
    expect(guard([join(external, 'hooks', 'pre-commit')], repo).verdict).toBe('block')
    mkdirSync(join(external, 'modules', 'sub'), { recursive: true })
    writeFileSync(join(external, 'modules', 'sub', 'config'), '[core]\n')
    expect(guard([join(external, 'modules', 'sub', 'config')], repo).verdict).toBe('block')
  })

  it('linked worktree：commonDir 的 config / worktrees/*/config → deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    const wt = join(root, 'wt')
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', wt])
    const worktreesDir = join(repo, '.git', 'worktrees')
    const wtName = readdirSync(worktreesDir)[0]
    const wtGitDir = join(worktreesDir, wtName)
    // 从 linked worktree 视角写 commonDir 的 config
    expect(guard([join(repo, '.git', 'config')], wt).verdict).toBe('block')
    // 写 worktree 自己的 gitdir
    expect(guard([join(wtGitDir, 'config.worktree')], wt).verdict).toBe('block')
    expect(guard([join(wtGitDir, 'index')], wt).verdict).toBe('block')
  })

  it('非写类工具不拦截', () => {
    const root = temp()
    const repo = makeRepo(root)
    expect(guard([join(repo, '.git', 'config')], repo, 'Read').verdict).toBe('allow')
    expect(guard([join(repo, '.git', 'config')], repo, 'Bash').verdict).toBe('allow')
  })

  it('探测失败 fail-closed：git 不可用 / cwd 不存在 → block', () => {
    const root = temp()
    const repo = makeRepo(root)
    const normal = join(repo, 'notes.md')
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      const result = guard([normal], repo)
      expect(result.verdict).toBe('block')
      expect(result.rule).toBe('gitdir-probe-failed')
      expect(result.reason).toContain('fail-closed')
    } finally {
      process.env.PATH = previousPath
    }
    const missingCwd = guard([normal], join(root, 'no-such-dir'))
    expect(missingCwd.verdict).toBe('block')
    expect(missingCwd.rule).toBe('gitdir-probe-failed')
  })

  it('回退开关：ask 时同一条路径降级为 ask，off 时完全放行', () => {
    const root = temp()
    const repo = makeRepo(root)
    const target = join(repo, '.git', 'config')
    process.env.BIZGRAPH_GITDIR_WRITE_GUARD = 'ask'
    expect(guard([target], repo).verdict).toBe('ask')
    process.env.BIZGRAPH_GITDIR_WRITE_GUARD = 'off'
    expect(guard([target], repo).verdict).toBe('allow')
  })
})

describe('D1-1 · dangling symlink 与 symlink 终点', () => {
  it('gitdir 内文件是指向不存在终点的 symlink：写终点 → deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    const outside = join(root, 'outside-config')
    rmSync(join(repo, '.git', 'config'))
    // .git/config -> root/outside-config（终点不存在）
    symlinkSync(outside, join(repo, '.git', 'config'))
    const result = guard([outside], repo)
    expect(result.verdict).toBe('block')
    expect(result.rule).toBe('gitdir-symlink-target')
  })

  it('工作区 symlink 指向 gitdir 内不存在的钩子：写 symlink 本身 → deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    // repo/evil -> .git/hooks/pre-commit（终点不存在）
    symlinkSync(join(repo, '.git', 'hooks', 'pre-commit'), join(repo, 'evil'))
    const result = guard([join(repo, 'evil')], repo)
    expect(result.verdict).toBe('block')
    expect(result.rule).toBe('gitdir-write-block')
  })

  it('symlink 指向 gitdir 外已存在文件：写终点 → deny；指向工作区普通文件 → allow', () => {
    const root = temp()
    const repo = makeRepo(root)
    const outside = join(root, 'outside-existing')
    writeFileSync(outside, 'x\n')
    rmSync(join(repo, '.git', 'info', 'exclude'))
    symlinkSync(outside, join(repo, '.git', 'info', 'exclude'))
    expect(guard([outside], repo).verdict).toBe('block')

    const workspace = join(repo, 'a.txt')
    symlinkSync(workspace, join(repo, 'alias.txt'))
    expect(guard([join(repo, 'alias.txt')], repo).verdict).toBe('allow')
  })

  it('dangling symlink 指向与 gitdir 无关的外部路径：写 symlink 本身 → allow', () => {
    const root = temp()
    const repo = makeRepo(root)
    symlinkSync(join(root, 'not-git-meta'), join(repo, 'alias2'))
    const result = guard([join(repo, 'alias2')], repo)
    expect(result.verdict).toBe('allow')
  })
})

describe('D1-2 · include 目标', () => {
  it('include.path 目标 → deny；未被 include 的同目录文件 → allow', () => {
    const root = temp()
    const repo = makeRepo(root)
    git(repo, ['config', 'include.path', '../included.inc'])
    const result = guard([join(repo, 'included.inc')], repo)
    expect(result.verdict).toBe('block')
    expect(result.rule).toBe('gitdir-include-target')
    expect(guard([join(repo, 'unrelated.inc')], repo).verdict).toBe('allow')
  })

  it('链式 include：每一层目标都 deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    mkdirSync(join(repo, 'conf'), { recursive: true })
    git(repo, ['config', 'include.path', '../conf/one.inc'])
    writeFileSync(join(repo, 'conf', 'one.inc'), '[include]\n\tpath = two.inc\n')
    expect(guard([join(repo, 'conf', 'one.inc')], repo).verdict).toBe('block')
    expect(guard([join(repo, 'conf', 'two.inc')], repo).verdict).toBe('block')
  })

  it('include 目标在仓库外、或尚未创建 → 同样 deny', () => {
    const root = temp()
    const repo = makeRepo(root)
    const outside = join(root, 'outside.inc')
    git(repo, ['config', 'include.path', outside])
    expect(guard([outside], repo).verdict).toBe('block')

    git(repo, ['config', 'include.path', '../never.inc'])
    expect(guard([join(repo, 'never.inc')], repo).verdict).toBe('block')
  })
})

describe('D1 · 不得误伤普通工作区路径', () => {
  it('.gitignore / .gitattributes / .github / 普通文件 / src/.git/x → allow', () => {
    const root = temp()
    const repo = makeRepo(root)
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(repo, 'src', '.git'), { recursive: true })
    writeFileSync(join(repo, 'src', '.git', 'foo'), 'x')
    const allowed = [
      join(repo, 'notes.md'),
      join(repo, '.gitignore'),
      join(repo, '.gitattributes'),
      join(repo, '.github', 'workflows', 'ci.yml'),
      join(repo, 'src', '.git', 'foo'),
      join(repo, 'src', 'new.ts'),
      join(repo, 'another-dir', 'new.ts'),
    ]
    for (const target of allowed) {
      const result = guard([target], repo)
      expect(result.verdict, target).toBe('allow')
    }
  })

  it('路径在仓库外（不在任何 gitdir）→ allow', () => {
    const root = temp()
    const repo = makeRepo(root)
    const outside = makeTemp('gitdir-guard-outside-')
    tempDirs.push(outside)
    expect(guard([join(outside, 'plain.txt')], repo).verdict).toBe('allow')
  })

  it('多目标里任何一个命中 gitdir → 整体 deny（不能只看第一个）', () => {
    const root = temp()
    const repo = makeRepo(root)
    const result = guard([join(repo, 'ok.txt'), join(repo, '.git', 'config')], repo)
    expect(result.verdict).toBe('block')
  })

  it('目标尚不存在但父目录也不存在、且路径没有 .git 语义 → allow', () => {
    const root = temp()
    const repo = makeRepo(root)
    expect(guard([join(repo, 'a', 'b', 'c.txt')], repo).verdict).toBe('allow')
  })
})
