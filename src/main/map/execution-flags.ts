/**
 * L2 执行触发开关（主进程 tick + IPC 写通道共用）。
 *
 * 默认关闭：未设置或非 truthy 一律关闭。关闭时通道仍然存在（preload 暴露、
 * IPC handler 注册），但调用必须被明确拒绝，不得静默降级为可执行。
 * 取值风格与 `agent/runtime/feature-flags.ts` 一致：只有显式 truthy 才开启。
 *
 * - BIZGRAPH_MAP_EXECUTION=1           打开执行触发（tick + 写通道）
 * - BIZGRAPH_MAP_EXECUTION_ADAPTER=…   编排用 pinned adapter；未配置即无路由结论，
 *                                      tick 不得猜一个执行器
 */

export const MAP_EXECUTION_ENV = 'BIZGRAPH_MAP_EXECUTION'
export const MAP_EXECUTION_ADAPTER_ENV = 'BIZGRAPH_MAP_EXECUTION_ADAPTER'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

export function isMapExecutionEnabled(): boolean {
  const raw = process.env[MAP_EXECUTION_ENV]
  if (raw === undefined || raw.trim() === '') return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

export function mapExecutionAdapter(): string | undefined {
  const raw = process.env[MAP_EXECUTION_ADAPTER_ENV]
  return raw && raw.trim() !== '' ? raw.trim() : undefined
}

export const MAP_EXECUTION_DISABLED_REASON =
  `${MAP_EXECUTION_ENV} 未开启（默认关闭），执行触发通道拒绝执行`
