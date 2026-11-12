/**
 * 把「应用里配的 API Key」翻译成 opencode 的 provider 配置。
 *
 * 为什么需要这一层：
 * opencode 自己用 `opencode auth login` 管凭据，写的是它自己的凭据库；用户在
 * BizGraph 设置里填的 key 它读不到。国内用户多数没有官方订阅，手上就是厂商
 * 自己的 key（DeepSeek / Kimi / GLM / 通义），甚至只是一个自建网关的 baseURL ——
 * 如果要求他们再去 opencode 里重配一遍，等于把可用性砍掉一半。
 *
 * 做法：`opencode run` 认 `OPENCODE_CONFIG_CONTENT`（内联 JSON，v3.30 实测），
 * 我们把 key 拼成 `@ai-sdk/openai-compatible` 的 provider 条目，通过**子进程环境变量**
 * 传进去 —— 不落盘、不改用户的 opencode 配置、不影响他其它终端里的用法。
 *
 * 一个刻意的取舍：**不碰 anthropic / gemini**。这两家不是 OpenAI 兼容协议，
 * 硬塞进 openai-compatible 只会在第一次请求时报 404；opencode 原生支持它们，
 * 用户在那里配过就能直接用。
 */

import type { ApiKeyConfig } from '@shared/types'

export interface OpencodeProviderPreset {
  /** opencode 里的 provider id，同时也是 `--model` 的前半段 */
  id: string
  /** 界面上看得懂的名字 */
  name: string
  /** OpenAI 兼容端点（含 /v1 之类的前缀，opencode 会自己拼 /chat/completions） */
  baseUrl: string
  /** 缺省模型；厂商换代会过期，用户可在设置里覆盖 */
  defaultModel: string
}

/**
 * 支持「从应用设置直接注入」的国内厂商。
 *
 * 只列 OpenAI 兼容协议的。新增一家时改这张表 + `ALLOWED_API_PROVIDERS`，
 * 不用动适配器。
 */
export const OPENCODE_COMPATIBLE_PROVIDERS: Record<string, OpencodeProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.6',
  },
  qwen: {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    // 兼容模式地址；原生模式的 /api/v1 不是 OpenAI 协议
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-coder-plus',
  },
}

/** 协议不兼容、不参与注入的两家。 */
const INCOMPATIBLE_PROVIDERS = new Set(['anthropic', 'gemini'])

/**
 * 生成 `OPENCODE_CONFIG_CONTENT` 的值。
 *
 * @param apiKeys 设置里的 key 列表
 * @param resolvedModel 已解析出的 `provider/model`（可空）；同 provider 时一并暴露，
 *   否则用户填的模型名在 opencode 里不存在，`--model` 会被判为未知模型。
 * @returns 没有可注入的 provider 时返回 `undefined`（此时别设环境变量，
 *   让 opencode 用它自己的配置 —— 包括本地 Ollama 与它自带的免费模型）
 */
export function buildOpencodeConfigContent(
  apiKeys: ApiKeyConfig[],
  resolvedModel?: string,
): string | undefined {
  const providers: Record<string, unknown> = {}
  const [modelProvider, modelId] = splitModel(resolvedModel)

  for (const entry of apiKeys ?? []) {
    if (!entry || typeof entry.key !== 'string' || !entry.key) continue
    if (INCOMPATIBLE_PROVIDERS.has(entry.provider)) continue

    const preset = OPENCODE_COMPATIBLE_PROVIDERS[entry.provider]
    // 没有预设但给了 baseUrl 的：按「自建网关」处理，模型名交给调用方
    if (!preset && !entry.baseUrl) continue

    const id = preset?.id ?? entry.provider
    const models = new Set<string>()
    if (preset) models.add(preset.defaultModel)
    // 用户显式指定的模型也声明进去，否则 opencode 会因为「模型不存在」拒绝启动
    if (modelProvider === id && modelId) models.add(modelId)

    providers[id] = {
      npm: '@ai-sdk/openai-compatible',
      name: preset?.name ?? entry.provider,
      options: {
        baseURL: entry.baseUrl || preset!.baseUrl,
        apiKey: entry.key,
      },
      models: Object.fromEntries([...models].map((model) => [model, { name: model }])),
    }
  }

  if (Object.keys(providers).length === 0) return undefined
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: providers })
}

function splitModel(model?: string): [string | undefined, string | undefined] {
  if (typeof model !== 'string' || !model.includes('/')) return [undefined, undefined]
  const idx = model.indexOf('/')
  const provider = model.slice(0, idx)
  const id = model.slice(idx + 1)
  if (!provider || !id) return [undefined, undefined]
  return [provider, id]
}

/**
 * 没配模型时的兜底：有哪家的 key，就用哪家的默认模型。
 *
 * 顺序按「国内编码场景常见度」排，而不是按字母序 —— 用户只填了一个 key 时，
 * 命中的应该是他心里那个。
 */
const FALLBACK_ORDER = ['deepseek', 'zhipu', 'moonshot', 'qwen']

export function resolveDefaultOpencodeModel(apiKeys: ApiKeyConfig[]): string | undefined {
  for (const providerId of FALLBACK_ORDER) {
    const preset = OPENCODE_COMPATIBLE_PROVIDERS[providerId]
    const hit = (apiKeys ?? []).find((entry) => entry?.provider === providerId && entry.key)
    if (hit && preset) return `${preset.id}/${preset.defaultModel}`
  }
  // 自建网关：只知道 baseUrl，模型名只有用户知道 —— 交回 None，由 opencode 自己配
  return undefined
}
