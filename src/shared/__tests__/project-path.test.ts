import { describe, it, expect } from 'vitest'
import { normalizeProjectPath, toSafeRelativePath } from '../project-path'

/**
 * 路径规范化的**平台语义**。
 *
 * 关键差异：
 * - Windows 上 `\` 是**分隔符** → `C:\work\proj` 与 `C:/work/proj` 是同一个目录
 * - POSIX 上 `\` 是**合法文件名字符** → `/work/my\dir` 与 `/work/my/dir` 是两个目录
 *
 * 两边曾经各有一份实现、语义不同 —— 于是在 POSIX 上两个不同的目录落到同一行
 * （A 项目的范围默认值出现在 B 项目上），在 Windows 上同一个目录被判成两个。
 */

describe('normalizeProjectPath — POSIX 语义', () => {
  it('只把 / 当分隔符，反斜杠是合法文件名字符', () => {
    expect(normalizeProjectPath('/work/my\\dir', false)).toBe('/work/my\\dir')
    // 与 /work/my/dir 是**两个不同的目录** —— 不能归一到同一个
    expect(normalizeProjectPath('/work/my\\dir', false)).not.toBe(
      normalizeProjectPath('/work/my/dir', false),
    )
  })

  it('解析 . 与 .. 段、去掉尾斜杠', () => {
    expect(normalizeProjectPath('/work/proj/', false)).toBe('/work/proj')
    expect(normalizeProjectPath('/work/proj/./src', false)).toBe('/work/proj/src')
    expect(normalizeProjectPath('/work/proj/src/..', false)).toBe('/work/proj')
  })

  it('.. 不能吃掉根', () => {
    expect(normalizeProjectPath('/..', false)).toBe('/')
    expect(normalizeProjectPath('/a/../..', false)).toBe('/')
  })

  it('根路径不被吃成空串', () => {
    expect(normalizeProjectPath('/', false)).toBe('/')
  })
})

describe('normalizeProjectPath — Windows 语义', () => {
  it('盘符路径：保留盘符根，两种分隔符写法归一', () => {
    expect(normalizeProjectPath('C:\\work\\proj', true)).toBe('C:/work/proj')
    expect(normalizeProjectPath('C:/work/proj', true)).toBe('C:/work/proj')
    // 同一个目录 —— 两种写法必须归一到同一个键
    expect(normalizeProjectPath('C:\\work\\proj', true)).toBe(
      normalizeProjectPath('C:/work/proj', true),
    )
  })

  it('盘符根被保留', () => {
    expect(normalizeProjectPath('C:\\', true)).toBe('C:/')
  })

  it('UNC：保留 server/share 根，.. 不能吃掉它', () => {
    expect(normalizeProjectPath('\\\\server\\share\\dir', true)).toBe('//server/share/dir')
    expect(normalizeProjectPath('//server/share/dir', true)).toBe('//server/share/dir')
    expect(normalizeProjectPath('//server/share/../x', true)).toBe('//server/share/x')
  })
})

describe('toSafeRelativePath — 越界路径必须被拒', () => {
  it('项目内的路径 → 相对路径', () => {
    expect(toSafeRelativePath('/work/proj', 'src/app.ts')).toBe('src/app.ts')
    expect(toSafeRelativePath('/work/proj', './src/app.ts')).toBe('src/app.ts')
  })

  it('越界路径 → null', () => {
    expect(toSafeRelativePath('/work/proj', '../etc/passwd')).toBeNull()
    expect(toSafeRelativePath('/work/proj', '/etc/passwd')).toBeNull()
    expect(toSafeRelativePath('/work/proj', 'C:\\other\\f.ts')).toBeNull()
  })
})
