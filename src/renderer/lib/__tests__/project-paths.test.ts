import { describe, it, expect } from 'vitest'
import { toProjectRelative, fromProjectRelative } from '../project-paths'

describe('项目路径的相对 ↔ 绝对互转', () => {
  it('项目下的绝对路径 → 相对路径', () => {
    expect(toProjectRelative('/work/proj', '/work/proj/src/a.ts')).toBe('src/a.ts')
  })

  it('相对路径 → 绝对路径', () => {
    expect(fromProjectRelative('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts')
  })

  it('往返一致', () => {
    const abs = '/work/proj/src/deep/a.ts'
    expect(fromProjectRelative('/work/proj', toProjectRelative('/work/proj', abs))).toBe(abs)
  })

  it('尾斜杠不影响结果', () => {
    expect(toProjectRelative('/work/proj/', '/work/proj/src/a.ts')).toBe('src/a.ts')
    expect(fromProjectRelative('/work/proj/', 'src/a.ts')).toBe('/work/proj/src/a.ts')
  })

  it('项目根目录本身原样返回（它不以「根 + /」开头；两种写法最终都指向根）', () => {
    expect(toProjectRelative('/work/proj', '/work/proj')).toBe('/work/proj')
  })

  it('不在项目下的路径原样返回（越界的文件该被 ScopeGuard 拒绝，不该被转成 ../..）', () => {
    expect(toProjectRelative('/work/proj', '/other/place/a.ts')).toBe('/other/place/a.ts')
  })

  it('已经是绝对路径的相对路径转换结果原样返回', () => {
    expect(fromProjectRelative('/work/proj', '/abs/a.ts')).toBe('/abs/a.ts')
  })

  it('前缀相同但不是子目录的路径不被误判', () => {
    // '/work/proj2' 不是 '/work/proj' 的子目录
    expect(toProjectRelative('/work/proj', '/work/proj2/a.ts')).toBe('/work/proj2/a.ts')
  })

  it('项目路径为空时原样返回', () => {
    expect(toProjectRelative('', '/work/proj/a.ts')).toBe('/work/proj/a.ts')
    expect(fromProjectRelative('', 'src/a.ts')).toBe('src/a.ts')
  })
})
