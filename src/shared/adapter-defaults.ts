/**
 * 适配器与 API provider 的默认值（单一真相源）
 *
 * 这些常量过去只住在 `src/main/settings.ts` 里，渲染进程拿不到 —— 于是
 * `adapterStore` / `agentStore` 各自抄了一份 `{defaultAdapter:'claude-code', ...}`，
 * 把真设置挡在外面。搬到 shared 层后主进程与渲染进程共用同一份定义。
 *
 * 放在 shared 而不是 main：渲染层的 DefaultsTab 页签要展示默认适配器、
 * Task 5 的 CLI 工具清单也要按同一份 provider 白名单渲染。
 */

import type { AdapterPreferences, ApiKeyConfig } from '@shared/types/agent'

/**
 * 默认适配器偏好。
 *
 * `fallbackOrder` 刻意**不含** `defaultAdapter` 本身：默认适配器失败后
 * 才按此顺序依次回退，把自己列进去等于白试一次。
 */
export const DEFAULT_ADAPTER_PREFERENCES: AdapterPreferences = {
  defaultAdapter: 'claude-code',
  fallbackOrder: ['codex', 'opencode', 'cline', 'kilo-code', 'kimi-code', 'qwen-code', 'codebuddy', 'qoder', 'cursor', 'mcp'],
}

/** 允许写入 API Key 的 provider 白名单。 */
export const ALLOWED_API_PROVIDERS: readonly ApiKeyConfig['provider'][] = [
  'anthropic',
  'openai',
  'deepseek',
  // 国内用户大多没有官方订阅，手上是厂商自己的 key —— 这三家覆盖了
  // 编码场景的主要选择（Kimi K2 / GLM / 通义千问）。都走 OpenAI 兼容端点。
  'moonshot',
  'zhipu',
  'qwen',
  'gemini',
]
