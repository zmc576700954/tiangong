import { describe, it, expect } from 'vitest'
import { errorText } from '../error-text'

/**
 * errorText 的三种输入形状（src/renderer/lib/error-text.ts）。
 *
 * 主进程把 BizGraphError / InvalidStateTransitionError 以 `toJSON()` 的
 * **plain object** 抛过 IPC，preload 原样透传 —— renderer 拿到的不是 Error 实例。
 * 只认 `instanceof Error` 的实现会把这类错误渲染成 "[object Object]"。
 */
describe('errorText — 把任意抛出物转成可读文本', () => {
  it('Error 实例取 message', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
  })

  it('IPC 抛来的 plain object（toJSON 形状）取 message —— 不再渲染成 "[object Object]"', () => {
    // createTypedHandle 在 IPC 边界 throw err.toJSON()（src/main/ipc/utils.ts），
    // 渲染层接到的就是这个形状：普通对象、message 是字符串
    const ipcErr = { code: 'NODE_UPDATE_FAILED', message: '节点更新失败' }
    expect(errorText(ipcErr)).toBe('节点更新失败')
  })

  it('无 message 字段的输入退回 String(err)', () => {
    expect(errorText({ code: 'SOMETHING' })).toBe('[object Object]')
    expect(errorText(42)).toBe('42')
  })

  it('字符串 / null / undefined 等非对象也给出可读文本', () => {
    expect(errorText('plain string')).toBe('plain string')
    expect(errorText(null)).toBe('null')
    expect(errorText(undefined)).toBe('undefined')
  })
})
