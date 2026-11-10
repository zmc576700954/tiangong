/**
 * G3-1 Tier 探测（session-map 蓝图 §5.9.5 / II-22）。
 *
 * 把「哪些后端可参与写编排」从按模型名/印象判断，变成一次可复核的能力解析：
 * 产出 `{tier, resume, approval_callback, structured_output, cancel, probe_error}`。
 *
 * 判定顺序（fail-closed）：
 * 1. 探测失败（缺 adapter / runtime 未装配 / driver 未注册）→ **Tier 3**；
 * 2. 四项齐全 → **Tier 1**（编排读 + 写的唯一入口）；
 * 3. 缺写前审批、但仍有续跑或结构化结果 → **Tier 2**（只允许只读编排）；
 * 4. 其余（无审批且无续跑/无结构化）→ **Tier 3**。
 *
 * 能力来源（如实标注，不把声明说成实测）：
 * - `approval_callback`：kernel 策略（是否具备写前强制审批且未被 UNSAFE 降级）
 *   + `DriverCapabilities.approval === 'pre-exec'`；
 * - `resume`：按 `agent-architecture.md` §10 的适配器矩阵**声明值**（代码里没有
 *   `adapterVersion`，也没有运行期 resume 探测）；
 * - `structured_output`：driver 是否提供结构化事件/结果（`toolEvents !== 'none'`），
 *   而不是只能抓 stdout 文本；
 * - `cancel`：`BackendDriver` 接口强制要求 `cancel()`，所有已注册 driver 均为真。
 *
 * 缓存：进程内按 `(adapter, adapterVersion)` 缓存；当前没有 adapterVersion 暴露，
 * 统一记 `unversioned`（妥协已登记蓝图 I.9.3）。
 */

import { getExecutorCapabilities } from '../agent/runtime/capabilities'
import { backendFamilyOf } from '../agent/runtime/feature-flags'
import type { DriverCapabilities } from '@shared/types/agent-runtime'

export type AdapterTier = 1 | 2 | 3

/** 续跑能力声明（来源：`agent-architecture.md` §10 能力矩阵，代码无运行期探测）。 */
export type ResumeSupport = 'native' | 'replay' | 'none'

const RESUME_BY_FAMILY: Readonly<Record<string, ResumeSupport>> = {
  claude: 'native',
  // Codex 的 thread id 只存内存：同进程可续，重启后不承诺。
  codex: 'native',
  // ACP 只有 session/new，没有 session/load，不能声明为可续跑。
  acp: 'none',
  opencode: 'none',
  mcp: 'replay',
  'mindmap-internal': 'none',
}

export interface TierProbeInput {
  adapterName: string
  /** `KernelCapabilityProbe.kernel`：写前强制审批可用且未被降级。 */
  kernelReady: boolean
  /** `KernelCapabilityProbe.runtime`：AgentRuntime（审批网关）已装配。 */
  runtimeReady: boolean
  /** `KernelCapabilityProbe.driver`：该 adapter 的 driver 已注册。 */
  driverRegistered: boolean
  /** 适配器版本（当前无来源，缺省 null）。 */
  adapterVersion?: string | null
  /** 测试注入；缺省按 adapterName 取能力矩阵。 */
  capabilities?: DriverCapabilities
}

export interface TierProbeResult {
  adapter: string
  adapterVersion: string | null
  tier: AdapterTier
  resume: boolean
  approval_callback: boolean
  structured_output: boolean
  cancel: boolean
  /** 探测失败原因；存在即 tier=3。 */
  probe_error?: string
}

const CAPABILITY_KEYS = ['approval_callback', 'resume', 'structured_output', 'cancel'] as const

/** 缺项列表（用于错误文案/审计），按固定顺序输出。 */
export function missingTierCapabilities(result: TierProbeResult): string[] {
  const missing: string[] = CAPABILITY_KEYS.filter((key) => !result[key])
  if (result.probe_error) missing.push(`probe_error:${result.probe_error}`)
  return missing
}

export function probeAdapterTier(input: TierProbeInput): TierProbeResult {
  const adapter = (input.adapterName ?? '').trim()
  const base: TierProbeResult = {
    adapter,
    adapterVersion: input.adapterVersion ?? null,
    tier: 3,
    resume: false,
    approval_callback: false,
    structured_output: false,
    cancel: false,
  }
  if (!adapter) return { ...base, probe_error: 'ADAPTER_MISSING' }

  const family = backendFamilyOf(adapter)
  const capabilities = input.capabilities ?? getExecutorCapabilities(adapter)
  const resume = (RESUME_BY_FAMILY[family] ?? 'none') !== 'none'
  const fields = {
    approval_callback: input.kernelReady && capabilities.approval === 'pre-exec',
    resume,
    structured_output: capabilities.toolEvents !== 'none',
    // 接口层面每个 driver 都必须实现 cancel()，这里不按厂商名猜。
    cancel: true,
  }

  // 探测失败优先于能力判定：运行期事实缺失时不允许落到 Tier 1。
  if (!input.runtimeReady) return { ...base, ...fields, probe_error: 'RUNTIME_UNAVAILABLE' }
  if (!input.driverRegistered) return { ...base, ...fields, probe_error: 'DRIVER_MISSING' }

  if (!fields.approval_callback) {
    // 缺写前审批：仍可做只读编排（Tier 2）；连续跑/结构化都没有则只能人工（Tier 3）。
    const tier: AdapterTier = fields.resume || fields.structured_output ? 2 : 3
    return { ...base, ...fields, tier }
  }
  const allPresent = fields.resume && fields.structured_output && fields.cancel
  return { ...base, ...fields, tier: allPresent ? 1 : 3 }
}

const cache = new Map<string, TierProbeResult>()

/** 进程内缓存；key = `(adapter, adapterVersion)`。 */
export function probeAdapterTierCached(input: TierProbeInput): TierProbeResult {
  const key = `${input.adapterName.trim()}@${input.adapterVersion ?? 'unversioned'}`
  const cached = cache.get(key)
  if (cached) return cached
  const result = probeAdapterTier(input)
  cache.set(key, result)
  return result
}

export function resetTierProbeCacheForTests(): void {
  cache.clear()
}
