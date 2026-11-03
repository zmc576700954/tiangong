import { describe, it, expect } from 'vitest'
import { toSafeRelative, fromRelative, toRelative } from '../project-paths'

/**
 * 范围路径的互转与校验。
 *
 * 断言的是**语义**（同一个目录必须得到同一个相对路径；越界路径必须被拒），
 * 而不是「当前实现返回什么字符串」—— 后者会把一个语义错误的行为钉成期望。
 */

describe('toSafeRelative — 用户输入 → 规范相对路径', () => {
  it('项目内的路径 → 相对路径', () => {
    expect(toSafeRelative('/work/proj', 'src/app.ts')).toBe('src/app.ts')
    expect(toSafeRelative('/work/proj', 'src/deep/nested/a.ts')).toBe('src/deep/nested/a.ts')
  })

  it('非规范写法被规范化成同一个相对路径（删除比对才成立）', () => {
    // 这三个必须归一到同一个值 —— 否则「删除」按字符串比对会失效
    expect(toSafeRelative('/work/proj', './src/app.ts')).toBe('src/app.ts')
    expect(toSafeRelative('/work/proj', 'src/./app.ts')).toBe('src/app.ts')
    expect(toSafeRelative('/work/proj', 'src/app.ts/')).toBe('src/app.ts')
  })

  it('POSIX 上反斜杠是合法文件名字符，不能改写成路径分隔符', () => {
    // `src\app.ts` 在 POSIX 上是一个**文件名**，不是 src/app.ts ——
    // 改写成 'src/app.ts' 会指向另一个文件（更糟：静默绑错地方）
    expect(toSafeRelative('/work/proj', 'src\\app.ts')).toBe('src\\app.ts')
  })

  it('越界的路径被拒绝（否则整个项目的所有会话都会启动失败）', () => {
    expect(toSafeRelative('/work/proj', '../etc/passwd')).toBeNull()
    expect(toSafeRelative('/work/proj', '../../etc/passwd')).toBeNull()
    expect(toSafeRelative('/work/proj', 'a/../../escape')).toBeNull()
  })

  it('绝对路径不是「相对项目根的路径」', () => {
    expect(toSafeRelative('/work/proj', '/etc/passwd')).toBeNull()
    expect(toSafeRelative('/work/proj', '/work/proj/src/a.ts')).toBeNull()
    expect(toSafeRelative('/work/proj', 'C:\\other\\f.ts')).toBeNull()
    expect(toSafeRelative('/work/proj', '\\\\server\\share\\f.ts')).toBeNull()
  })

  it('空输入与项目根本身都不构成一条文件范围', () => {
    expect(toSafeRelative('/work/proj', '')).toBeNull()
    expect(toSafeRelative('/work/proj', '   ')).toBeNull()
    expect(toSafeRelative('/work/proj', '.')).toBeNull()
    expect(toSafeRelative('', 'src/a.ts')).toBeNull()
  })
})

describe('fromRelative — 相对路径 → 绝对路径', () => {
  it('拼到项目根之下', () => {
    expect(fromRelative('/work/proj', 'src/app.ts')).toBe('/work/proj/src/app.ts')
  })

  it('已经是绝对路径的原样返回', () => {
    expect(fromRelative('/work/proj', '/abs/a.ts')).toBe('/abs/a.ts')
  })
})

describe('toRelative — 绝对路径 → 相对路径', () => {
  it('项目下的文件 → 相对路径', () => {
    expect(toRelative('/work/proj', '/work/proj/src/a.ts')).toBe('src/a.ts')
  })

  it('项目根有尾斜杠时也能匹配', () => {
    expect(toRelative('/work/proj/', '/work/proj/src/a.ts')).toBe('src/a.ts')
  })

  it('不在项目下的文件 → null（该路径该被拒绝，不是变成 ../..）', () => {
    expect(toRelative('/work/proj', '/other/place/a.ts')).toBeNull()
    // 前缀相同但不是子目录
    expect(toRelative('/work/proj', '/work/proj2/a.ts')).toBeNull()
  })

  it('项目根本身 → null（它不是一条文件范围）', () => {
    expect(toRelative('/work/proj', '/work/proj')).toBeNull()
  })
})

describe('往返一致', () => {
  it('相对 → 绝对 → 相对 得到同一个值', () => {
    const rel = 'src/deep/a.ts'
    expect(toRelative('/work/proj', fromRelative('/work/proj', rel))).toBe(rel)
  })

  it('非规范写法经往返后归一到规范形态（删除比对据此成立）', () => {
    const rel = toSafeRelative('/work/proj', './src/app.ts')
    expect(rel).not.toBeNull()
    expect(toRelative('/work/proj', fromRelative('/work/proj', rel!))).toBe(rel)
  })
})
