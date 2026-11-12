/**
 * G9-13：Windows 路径语义的**真实宿主**验证。
 *
 * 为什么单开一个文件：`project-path.test.ts` 只验纯函数（显式传 `windows=true`），
 * 证明的是「给定 Windows 形状的字符串，规范化结果对不对」；它证明不了
 * 「在真实 NTFS 上，`fs.realpathSync` 返回什么形态、`path.relative` 跨盘返回什么」。
 * 而后者才是线上会出问题的地方：
 *
 * - 大小写不敏感：`C:\Work\Proj` 与 `c:\work\proj` 是同一个目录。若只做字符串
 *   比较，用户的 `C:/Work/Proj` 永远匹配不上主进程 `realpath` 出来的
 *   `c:\work\proj`，范围校验会误拒合法路径；
 * - 盘符前缀旁路：`C:\project-evil` 以 `C:\project` 开头。`startsWith` 判据会把
 *   兄弟目录当成子目录 —— 这正是 `path-utils` 存在的理由；
 * - 跨盘：`path.relative('C:\\a', 'D:\\b')` 返回的是**绝对路径**，不是 `..\\..`。
 *   调用方若只判 `startsWith('..')` 就会漏判；
 * - 分隔符：主进程 `path.resolve` 输出 `C:\work\proj`，侧栏与实际路径是
 *   `C:/work/proj`，两条文本不同则相对路径算不出来。
 *
 * 本文件在 POSIX 上整体 skip（除一节跨平台不变量），由 CI 的
 * `platform-paths` job 在 windows-latest 上真跑 —— 这就是 G9-13 的
 * 「允许 Windows CI」路径，不需要人工准备一台机器。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { isPathWithin, isPathWithinSync, safeRealpathSync } from '../shared/path-utils'
import { normalizeProjectPath, toSafeRelativePath } from '@shared/project-path'

const IS_WINDOWS = process.platform === 'win32'

/** 取一个与 `root` 不同的盘符，用于验证跨盘判定（不假设某台机器一定有 D:）。 */
function otherDriveLetter(root: string): string {
  const current = root.slice(0, 1).toUpperCase()
  for (const letter of 'ZYXWVUTSRQPONMLKJIHGFEDCBA') {
    if (letter !== current) return letter
  }
  throw new Error('unreachable: 26 个字母里必有与当前盘符不同的一个')
}

describe('路径规范化 — 与平台无关的不变量', () => {
  it('对真实解析出的绝对路径幂等：二次规范化不改变结果', () => {
    const real = path.resolve(os.tmpdir())
    const once = normalizeProjectPath(real)
    expect(once).not.toBe('')
    expect(normalizeProjectPath(once)).toBe(once)
  })

  it('真实绝对路径规范化后不含反斜杠（跨进程比对的是同一把钥匙）', () => {
    const real = path.resolve(os.tmpdir())
    expect(normalizeProjectPath(real)).not.toContain('\\')
  })

  it('相对文件名里的反斜杠不会被当成目录分隔符而逃出根', () => {
    // POSIX 上 `..\evil` 是一个**文件名**；Windows 上它是越界路径。
    // 两边都必须拒绝把它当合法相对路径 —— 差别只在归一化，不在安全判定。
    expect(toSafeRelativePath('/work/proj', '..\\evil')).toBeNull()
    expect(toSafeRelativePath('/work/proj', '..\\..\\evil')).toBeNull()
  })
})

describe.skipIf(!IS_WINDOWS)('真实 Windows / NTFS 语义（G9-13）', () => {
  let tmpDir: string
  let projectDir: string
  let projectEvilDir: string
  let subDir: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-win-'))
    projectDir = path.join(tmpDir, 'project')
    projectEvilDir = path.join(tmpDir, 'project-evil')
    subDir = path.join(projectDir, 'src')
    await fs.mkdir(subDir, { recursive: true })
    await fs.mkdir(projectEvilDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'file.txt'), 'ok')
    await fs.writeFile(path.join(projectEvilDir, 'evil.txt'), 'evil')
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('子目录与子文件判定为「在项目内」', async () => {
    expect(await isPathWithin(projectDir, subDir)).toBe(true)
    expect(isPathWithinSync(projectDir, path.join(projectDir, 'file.txt'))).toBe(true)
    expect(isPathWithinSync(projectDir, projectDir)).toBe(true)
  })

  it('`..` 越界被拒，文件名以点开头的不是越界', async () => {
    expect(await isPathWithin(projectDir, path.join(projectDir, '..', 'outside.txt'))).toBe(false)
    const dotted = path.join(projectDir, '..foo.txt')
    await fs.writeFile(dotted, 'not traversal')
    expect(isPathWithinSync(projectDir, dotted)).toBe(true)
  })

  it('盘符前缀旁路：`project-evil` 不是 `project` 的子目录', () => {
    // 这是 `startsWith` 判据在 Windows 上的经典误判，也是 path-utils 的立项理由。
    expect(projectEvilDir.startsWith(projectDir)).toBe(true) // 前提成立：纯字符串确实骗得过
    expect(isPathWithinSync(projectDir, projectEvilDir)).toBe(false)
    expect(isPathWithinSync(projectDir, path.join(projectEvilDir, 'evil.txt'))).toBe(false)
  })

  it('大小写不敏感：同一目录的任意大小写写法都必须判为子路径', async () => {
    // realpath 会返回磁盘上的规范大小写；判定侧再统一小写比较（normalizeForCompare）。
    // 若只看字符串，`C:\Work\PROJ\src` 会被误判成「不在项目内」。
    expect(await isPathWithin(projectDir, subDir.toUpperCase())).toBe(true)
    expect(isPathWithinSync(projectDir.toUpperCase(), subDir)).toBe(true)
  })

  it('大小写不同的两种写法经 realpath 收敛到同一个键', async () => {
    // 注意：`normalizeProjectPath` **故意不折叠大小写** —— 它是展示/键名用的
    // 规范化，折叠会把项目名（取 basename）一起小写。真正让同一目录落到同一行的是
    // 调用方先 `fs.realpath`（link-service 就是这么做的）：realpath 返回磁盘上的
    // 规范大小写，两种写法因此得到同一串。
    const upper = await fs.realpath(projectDir.toUpperCase())
    const lower = await fs.realpath(projectDir.toLowerCase())
    expect(upper).toBe(lower)
    expect(normalizeProjectPath(upper)).toBe(normalizeProjectPath(lower))
  })

  it('正斜杠写法与反斜杠写法指向同一把钥匙', () => {
    const slashed = projectDir.replace(/\\/g, '/')
    expect(normalizeProjectPath(slashed)).toBe(normalizeProjectPath(projectDir))
    expect(isPathWithinSync(projectDir, `${slashed}/src`)).toBe(true)
  })

  it('真实绝对路径规范化后以盘符根开头、无反斜杠、无尾斜杠', () => {
    const normalized = normalizeProjectPath(path.resolve(projectDir))
    expect(normalized).toMatch(/^[A-Za-z]:\//)
    expect(normalized).not.toContain('\\')
    expect(normalized.endsWith('/')).toBe(false)
    // 盘符根自身保留斜杠
    expect(normalizeProjectPath(path.parse(projectDir).root)).toMatch(/^[A-Za-z]:\/$/)
  })

  it('跨盘：`path.relative` 返回绝对路径，判定必须拒绝', () => {
    const foreign = `${otherDriveLetter(path.parse(projectDir).root)}:\\definitely-not-here\\x`
    expect(path.relative(projectDir, foreign)).not.toMatch(/^\.\./)
    expect(isPathWithinSync(projectDir, foreign)).toBe(false)
  })

  it('`safeRealpathSync` 对尚未创建的文件也返回带盘符的规范路径', () => {
    const ghost = path.join(projectDir, 'not-yet', 'deep', 'file.txt')
    const resolved = safeRealpathSync(ghost)
    expect(path.isAbsolute(resolved)).toBe(true)
    // 最近的存在祖先已被 realpath，尾巴按原样拼回
    expect(resolved.toLowerCase()).toContain(path.join('project', 'not-yet', 'deep').toLowerCase())
  })

  it('`toSafeRelativePath`：反斜杠相对路径归一成 /，越界返回 null', () => {
    expect(toSafeRelativePath(projectDir, 'src\\file.txt')).toBe('src/file.txt')
    expect(toSafeRelativePath(projectDir, 'src\\..\\file.txt')).toBe('file.txt')
    expect(toSafeRelativePath(projectDir, '..\\evil.txt')).toBeNull()
    expect(toSafeRelativePath(projectDir, '\\\\server\\share\\x')).toBeNull()
    expect(toSafeRelativePath(projectDir, 'D:\\other\\x')).toBeNull()
  })
})
