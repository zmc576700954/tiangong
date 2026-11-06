/**
 * Kernel 路径开关与后端白名单。
 *
 * 默认状态（2026-11-05 起）：**开启**，但只对「已具备写前强制审批」的后端生效
 * （当前白名单 = claude）。其余后端（codex / opencode / …）继续走旧路径，
 * 启动日志会明确打印「该后端尚未启用写前审批」。
 *
 * 环境变量：
 * - BIZGRAPH_AGENT_KERNEL=0/false/off/no  总开关关闭，全部回到旧路径（运行时回退）
 * - BIZGRAPH_AGENT_KERNEL_BACKENDS=claude 后端白名单（逗号分隔），默认即能力集
 * - BIZGRAPH_AGENT_KERNEL_UNSAFE=1        强制未具备审批的后端也走 kernel（降级运行）
 *
 * 一行回退：把 isAgentKernelEnabled() 改成 `return false` 后重新构建。
 */

export const AGENT_KERNEL_ENV = 'BIZGRAPH_AGENT_KERNEL'
export const AGENT_KERNEL_BACKENDS_ENV = 'BIZGRAPH_AGENT_KERNEL_BACKENDS'
export const AGENT_KERNEL_UNSAFE_ENV = 'BIZGRAPH_AGENT_KERNEL_UNSAFE'

/** 已具备「写前强制审批」的后端（PreToolUse 强制 ask → canUseTool）。 */
export const KERNEL_APPROVAL_CAPABLE_BACKENDS: readonly string[] = ['claude']

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

/** 总开关：未设置 = 开启；显式关闭值 = 全部回旧路径。 */
export function isAgentKernelEnabled(): boolean {
  const raw = process.env[AGENT_KERNEL_ENV]
  if (raw === undefined || raw.trim() === '') return true
  return TRUTHY.has(raw.trim().toLowerCase())
}

/** 适配器名 → 后端家族（claude-code → claude）。 */
export function backendFamilyOf(adapterName: string): string {
  const name = adapterName.trim().toLowerCase()
  if (name === 'claude-code' || name === 'claude' || name.startsWith('claude-')) return 'claude'
  return name
}

/** 后端白名单：环境变量优先，否则使用能力集默认值。 */
export function getKernelBackends(): string[] {
  const raw = process.env[AGENT_KERNEL_BACKENDS_ENV]
  if (raw && raw.trim() !== '') {
    return raw
      .split(',')
      .map((item) => backendFamilyOf(item))
      .filter(Boolean)
  }
  return [...KERNEL_APPROVAL_CAPABLE_BACKENDS]
}

/** 逃生口：只有显式设置才返回 true，绝不做默认值。 */
export function isKernelUnsafeOverrideEnabled(): boolean {
  const raw = process.env[AGENT_KERNEL_UNSAFE_ENV]
  if (!raw) return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

export function hasKernelApprovalCapability(adapterName: string): boolean {
  return KERNEL_APPROVAL_CAPABLE_BACKENDS.includes(backendFamilyOf(adapterName))
}

/** 三类回退原因必须可区分：不得把「开关关闭」写成「无审批能力」。 */
export type KernelBackendReason =
  | 'enabled'
  | 'switch-disabled'
  | 'whitelist-excluded'
  | 'no-approval-capability'
  | 'unsafe-degraded'

export interface KernelBackendPolicy {
  adapter: string
  family: string
  kernel: boolean
  /** true = 未具备写前审批却被 UNSAFE 强制走 kernel，必须打日志/留痕。 */
  degraded: boolean
  reasonKind: KernelBackendReason
  reason: string
}

export function getKernelBackendPolicy(adapterName: string): KernelBackendPolicy {
  const family = backendFamilyOf(adapterName)
  if (!isAgentKernelEnabled()) {
    return {
      adapter: adapterName,
      family,
      kernel: false,
      degraded: false,
      reasonKind: 'switch-disabled',
      reason: `${AGENT_KERNEL_ENV}=0（总开关关闭）`,
    }
  }
  const capable = hasKernelApprovalCapability(adapterName)
  const listed = getKernelBackends().includes(family)
  if (capable && listed) {
    return {
      adapter: adapterName,
      family,
      kernel: true,
      degraded: false,
      reasonKind: 'enabled',
      reason: 'forced pre-write approval available',
    }
  }
  if (capable) {
    // 白名单是「完全指定」：显式列出即视为替换默认集合，未列出的能力后端如实回退。
    return {
      adapter: adapterName,
      family,
      kernel: false,
      degraded: false,
      reasonKind: 'whitelist-excluded',
      reason: `backend "${family}" 因 ${AGENT_KERNEL_BACKENDS_ENV} 未列出而回退（该变量是完全指定，不是追加）`,
    }
  }
  // 未具备审批能力的后端：只有显式 UNSAFE 才能进 kernel，且必须标降级。
  if (isKernelUnsafeOverrideEnabled()) {
    return {
      adapter: adapterName,
      family,
      kernel: true,
      degraded: true,
      reasonKind: 'unsafe-degraded',
      reason: `backend "${family}" has no forced pre-write approval; forced by ${AGENT_KERNEL_UNSAFE_ENV}=1`,
    }
  }
  return {
    adapter: adapterName,
    family,
    kernel: false,
    degraded: false,
    reasonKind: 'no-approval-capability',
    reason: `backend "${family}" has no forced pre-write approval; staying on legacy path`,
  }
}

/** 显式关闭值的名字，仅用于日志可读性。 */
export function isKernelExplicitlyDisabled(): boolean {
  const raw = process.env[AGENT_KERNEL_ENV]
  return raw !== undefined && FALSY.has(raw.trim().toLowerCase())
}
