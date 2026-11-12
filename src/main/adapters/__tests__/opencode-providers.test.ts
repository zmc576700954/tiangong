/**
 * 国内 provider → opencode 配置的翻译。
 *
 * 这层存在的理由：用户手上通常没有官方订阅，只有厂商自己的 key 或一个自建
 * 网关。填进设置就该能跑，不该再要求他跑一遍 `opencode auth login`。
 */

import { describe, expect, it } from 'vitest'
import {
  buildOpencodeConfigContent,
  resolveDefaultOpencodeModel,
  OPENCODE_COMPATIBLE_PROVIDERS,
} from '../opencode-providers'

describe('buildOpencodeConfigContent', () => {
  it('把国产 key 翻成 openai-compatible provider 条目', () => {
    const content = buildOpencodeConfigContent([{ provider: 'deepseek', key: 'sk-ds' }])
    expect(content).toBeDefined()
    const parsed = JSON.parse(content!)
    expect(parsed.provider.deepseek).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' },
    })
    expect(Object.keys(parsed.provider.deepseek.models)).toContain('deepseek-chat')
  })

  it('用户显式指定的模型一并声明，否则 --model 会撞「模型不存在」', () => {
    const parsed = JSON.parse(
      buildOpencodeConfigContent([{ provider: 'zhipu', key: 'k' }], 'zhipu/glm-4.6-air')!,
    )
    expect(Object.keys(parsed.provider.zhipu.models)).toEqual(['glm-4.6', 'glm-4.6-air'])
  })

  it('自建网关：只有 baseUrl 也认，按 provider 名当 id', () => {
    const parsed = JSON.parse(
      buildOpencodeConfigContent([{ provider: 'openai', key: 'gw', baseUrl: 'http://10.0.0.2:8000/v1' }] as never)!,
    )
    expect(parsed.provider.openai.options.baseURL).toBe('http://10.0.0.2:8000/v1')
  })

  it('anthropic / gemini 不注入：不是 OpenAI 协议，硬塞只会 404', () => {
    expect(buildOpencodeConfigContent([{ provider: 'anthropic', key: 'a' }])).toBeUndefined()
    expect(buildOpencodeConfigContent([{ provider: 'gemini', key: 'g' }])).toBeUndefined()
  })

  it('没有任何可用 key 时返回 undefined —— 别设环境变量，让 opencode 用自身配置', () => {
    expect(buildOpencodeConfigContent([])).toBeUndefined()
    expect(buildOpencodeConfigContent([{ provider: 'deepseek', key: '' }])).toBeUndefined()
  })

  it('多家 key 同时存在时全部注入，互不覆盖', () => {
    const parsed = JSON.parse(
      buildOpencodeConfigContent([
        { provider: 'deepseek', key: 'a' },
        { provider: 'moonshot', key: 'b' },
        { provider: 'qwen', key: 'c' },
      ])!,
    )
    expect(Object.keys(parsed.provider).sort()).toEqual(['deepseek', 'moonshot', 'qwen'])
  })
})

describe('resolveDefaultOpencodeModel', () => {
  it('按国内编码场景的常见度选，不按字母序', () => {
    expect(
      resolveDefaultOpencodeModel([
        { provider: 'qwen', key: 'q' },
        { provider: 'deepseek', key: 'd' },
      ]),
    ).toBe('deepseek/deepseek-chat')
  })

  it('只有 Kimi 的 key 时用 Kimi 的默认模型', () => {
    expect(resolveDefaultOpencodeModel([{ provider: 'moonshot', key: 'm' }])).toBe(
      `moonshot/${OPENCODE_COMPATIBLE_PROVIDERS.moonshot.defaultModel}`,
    )
  })

  it('没有可使用 key 时返回 undefined（交给 opencode 自己决定）', () => {
    expect(resolveDefaultOpencodeModel([])).toBeUndefined()
    expect(resolveDefaultOpencodeModel([{ provider: 'anthropic', key: 'a' }])).toBeUndefined()
  })
})
