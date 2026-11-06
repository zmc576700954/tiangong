/**
 * C3 沙箱入口：能力单例 + profile 生成 + spawn 包装。
 *
 * 接入点只有一个口径：**宿主 spawn 出的、可能执行 agent 工具的进程**
 * （Claude SDK spawn 钩子 / Codex shim / OpenCode / MCP server）。
 * 工具名（`mcp__*` / `write_file`）不做判定依据——进程在笼子里，工具叫什么都受限。
 *
 * 一致性：`sandboxLaunch()` 与启动期 `initSandboxCapability()` 读同一个缓存结论，
 * 不会出现「判定可用、spawn 时未包」。
 */

import { getSandboxCapability, SANDBOX_EXEC_PATH, type SandboxCapability } from './capability'
import {
  buildSandboxProfile,
  type SandboxProfile,
  type SandboxTarget,
} from './profile'

export interface SandboxLaunchInput {
  /** 会话工作目录（profile 的写白名单）。 */
  workspaceDir?: string
  command: string
  args: readonly string[]
  extraExecutables?: readonly string[]
  extraWritableDirs?: readonly string[]
}

export interface SandboxLaunch {
  /** 实际 spawn 的 command（沙箱不可用时原样返回）。 */
  command: string
  args: string[]
  sandboxed: boolean
  capability: SandboxCapability
  profile?: SandboxProfile
}

/**
 * 生成一次 spawn 的启动计划：
 * 沙箱可用 → `sandbox-exec -p <profile> -- <原命令> <原参数>`；
 * 不可用 → 原样返回（调用方仍需把 allow 集退回 ask，见 `evaluateBashPolicy`）。
 */
export function sandboxLaunch(target: SandboxTarget, input: SandboxLaunchInput): SandboxLaunch {
  const capability = getSandboxCapability()
  if (!capability.available) {
    return { command: input.command, args: [...input.args], sandboxed: false, capability }
  }
  const profile = buildSandboxProfile({
    target,
    workspaceDir: input.workspaceDir,
    extraExecutables: [input.command, ...(input.extraExecutables ?? [])],
    extraWritableDirs: input.extraWritableDirs,
  })
  return {
    command: SANDBOX_EXEC_PATH,
    args: ['-p', profile.text, '--', input.command, ...input.args],
    sandboxed: true,
    capability,
    profile,
  }
}

/**
 * Codex shim 需要把 profile 经 env 传进 shim（shim 自己决定何时 exec sandbox-exec）。
 * 返回 undefined 表示沙箱不可用，shim 不得自行套壳。
 */
export function sandboxProfileText(
  target: SandboxTarget,
  input: Omit<SandboxLaunchInput, 'command' | 'args'>,
): string | undefined {
  if (!getSandboxCapability().available) return undefined
  return buildSandboxProfile({
    target,
    workspaceDir: input.workspaceDir,
    extraExecutables: input.extraExecutables,
    extraWritableDirs: input.extraWritableDirs,
  }).text
}

export { getSandboxCapability, initSandboxCapability, resetSandboxCapabilityForTests } from './capability'
export { SANDBOX_EXEC_PATH } from './capability'
export type { SandboxCapability }
export type { SandboxTarget }
