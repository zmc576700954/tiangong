/**
 * 翻默认（第六轮）：按后端能力门控 + 总开关回退 + UNSAFE 降级标记。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_KERNEL_ENV,
  AGENT_KERNEL_BACKENDS_ENV,
  AGENT_KERNEL_UNSAFE_ENV,
  backendFamilyOf,
  getKernelBackendPolicy,
  getKernelBackends,
  isAgentKernelEnabled,
} from '../feature-flags'

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of [AGENT_KERNEL_ENV, AGENT_KERNEL_BACKENDS_ENV, AGENT_KERNEL_UNSAFE_ENV]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of [AGENT_KERNEL_ENV, AGENT_KERNEL_BACKENDS_ENV, AGENT_KERNEL_UNSAFE_ENV]) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Kernel 默认开启与后端能力门控', () => {
  it('默认：总开关 on，claude 走 kernel；codex / opencode 留在旧路径', () => {
    expect(isAgentKernelEnabled()).toBe(true)
    expect(getKernelBackends()).toEqual(['claude'])

    expect(getKernelBackendPolicy('claude-code')).toMatchObject({ kernel: true, degraded: false, reasonKind: 'enabled' })
    expect(getKernelBackendPolicy('codex')).toMatchObject({
      kernel: false,
      degraded: false,
      reasonKind: 'no-approval-capability',
    })
    expect(getKernelBackendPolicy('opencode')).toMatchObject({
      kernel: false,
      degraded: false,
      reasonKind: 'no-approval-capability',
    })
    expect(getKernelBackendPolicy('codex').reason).toContain('no forced pre-write approval')
  })

  it('适配器名归一：claude-code → claude', () => {
    expect(backendFamilyOf('claude-code')).toBe('claude')
    expect(backendFamilyOf('claude')).toBe('claude')
    expect(backendFamilyOf('codex')).toBe('codex')
  })

  it('BIZGRAPH_AGENT_KERNEL=0：连 UNSAFE 也不能启用，全部回旧路径，且 reason 不得写成「无审批能力」', () => {
    process.env[AGENT_KERNEL_ENV] = '0'
    process.env[AGENT_KERNEL_UNSAFE_ENV] = '1'
    expect(isAgentKernelEnabled()).toBe(false)
    for (const backend of ['claude-code', 'codex', 'opencode']) {
      const policy = getKernelBackendPolicy(backend)
      expect(policy.kernel).toBe(false)
      expect(policy.reasonKind).toBe('switch-disabled')
      // 第 2 项：总开关关闭时日志/文案不能说「该后端尚未启用写前审批」。
      expect(policy.reason).not.toContain('no forced pre-write approval')
      expect(policy.reason).toContain('总开关关闭')
    }
  })

  it('白名单是完全指定（替换）：BACKENDS=codex 时 Claude 因未列出而回退，理由必须如实', () => {
    process.env[AGENT_KERNEL_BACKENDS_ENV] = 'codex'
    expect(getKernelBackends()).toEqual(['codex'])
    const claude = getKernelBackendPolicy('claude-code')
    expect(claude.kernel).toBe(false)
    expect(claude.reasonKind).toBe('whitelist-excluded')
    expect(claude.reason).toContain('未列出而回退')
    // codex 本身无审批能力，理由独立且真实。
    const codex = getKernelBackendPolicy('codex')
    expect(codex.kernel).toBe(false)
    expect(codex.reasonKind).toBe('no-approval-capability')
  })

  it('UNSAFE=1 强制 codex 走 kernel 时必须标记 degraded 并给出原因', () => {
    process.env[AGENT_KERNEL_UNSAFE_ENV] = '1'
    const policy = getKernelBackendPolicy('codex')
    expect(policy.kernel).toBe(true)
    expect(policy.degraded).toBe(true)
    expect(policy.reasonKind).toBe('unsafe-degraded')
    expect(policy.reason).toContain('no forced pre-write approval')
    expect(policy.reason).toContain('UNSAFE')
    // 已具备审批的 claude 不因 UNSAFE 被误标降级
    expect(getKernelBackendPolicy('claude-code').degraded).toBe(false)
  })

  it('UNSAFE=1 不会把具备审批能力的 Claude 重新拉回 kernel，也不会标为 degraded', () => {
    process.env[AGENT_KERNEL_BACKENDS_ENV] = 'codex'
    process.env[AGENT_KERNEL_UNSAFE_ENV] = '1'
    const claude = getKernelBackendPolicy('claude-code')
    expect(claude.kernel).toBe(false)
    expect(claude.degraded).toBe(false)
    expect(claude.reasonKind).toBe('whitelist-excluded')
  })
})
