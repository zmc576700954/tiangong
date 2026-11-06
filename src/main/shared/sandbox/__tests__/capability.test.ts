/**
 * C3：能力探测。判据是「真跑 canary」，不是系统版本号。
 * 探测结果必须单例缓存：启动与每次 spawn 前读到同一结论。
 */

import { describe, expect, it } from 'vitest'
import {
  getSandboxCapability,
  probeSandboxCapability,
  resetSandboxCapabilityForTests,
} from '../capability'

describe('sandbox capability', () => {
  it('非 macOS 明确判为不可用（本轮只做 macOS）', () => {
    if (process.platform === 'darwin') return
    resetSandboxCapabilityForTests()
    const capability = getSandboxCapability()
    expect(capability.available).toBe(false)
    expect(capability.reason).toBe('platform-unsupported')
  })

  it.skipIf(process.platform !== 'darwin')(
    'sandbox-exec 不存在时判为不可用（binary-missing）',
    () => {
      const capability = probeSandboxCapability({ sandboxExecPath: '/nonexistent/sandbox-exec' })
      expect(capability.available).toBe(false)
      expect(capability.reason).toBe('binary-missing')
    },
  )

  it.skipIf(process.platform !== 'darwin')('真实 canary：可用且多次读取一致', () => {
    resetSandboxCapabilityForTests()
    const first = getSandboxCapability()
    const second = getSandboxCapability()
    expect(first.available).toBe(true)
    expect(first.reason).toBe('ok')
    // 同一个单例对象：启动期探测与 spawn 前读取不会分叉。
    expect(second).toBe(first)
  })

  it.skipIf(process.platform !== 'darwin')('canary 可重复执行（无临时目录残留依赖）', () => {
    const first = probeSandboxCapability()
    const second = probeSandboxCapability()
    expect(first.available).toBe(second.available)
    expect(first.reason).toBe(second.reason)
  })
})
