/**
 * 默认模型选择（按适配器分档）
 *
 * 背景：`settings.defaultModel` 这一个字段过去同时承担三个互不相干的角色 ——
 * claude-code 的模型、MCP 适配器的 provider 推断依据、以及用户心里「给 codex 用的
 * 模型」（codex 实际走 SDK 自己的默认模型）。
 *
 * 用户把默认模型改成给 codex 用的 `gpt-5` 时，claude-code 会拿到一个它不认识的
 * 模型名；MCP 那边则被这个模型名的前缀带着走 —— `resolveApiKey` 按前缀挑 provider，
 * 于是一个本该只管 codex 的字段决定了 MCP 打给哪家 API。
 *
 * 拆成 `claudeCode` / `codex` / `mcp` 三个独立档位后，每个适配器只读自己那一档。
 */

import type { BizGraphSettings } from '@shared/types'

/** 支持独立默认模型档位的适配器。 */
export type ModelSelectionAdapter = 'claude-code' | 'codex' | 'mcp'

/** 适配器 → 设置里的档位字段名。 */
const TIER_KEY: Record<ModelSelectionAdapter, keyof NonNullable<BizGraphSettings['defaultModels']>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  mcp: 'mcp',
}

/**
 * 取出某个适配器要用的默认模型。
 *
 * 语义：
 * - 优先取 `defaultModels[档位]`。
 * - 档位为空时，**只有 `claude-code` 回落到旧的 `defaultModel`**（向后兼容）；
 *   `codex` 与 `mcp` 回落到 `undefined`，各自用自己的默认模型。
 *
 * `mcp` 绝不回落到旧的 `defaultModel`：那个字段里可能是一个 claude 模型名，
 * `resolveApiKey` 会按前缀把它误判成 anthropic 的 provider —— 正是本次拆分要
 * 消灭的 bug。
 */
export function resolveModelForAdapter(
  settings: Pick<BizGraphSettings, 'defaultModels' | 'defaultModel'>,
  adapter: ModelSelectionAdapter,
): string | undefined {
  const tier = settings.defaultModels?.[TIER_KEY[adapter]]
  // settings.json 是用户可手改的：档位值必须是非空字符串才作数，
  // 免得脏数据被当成模型名下发给 SDK。
  if (typeof tier === 'string' && tier) return tier
  if (adapter === 'claude-code') return settings.defaultModel || undefined
  return undefined
}
