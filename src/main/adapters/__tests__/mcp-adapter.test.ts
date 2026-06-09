/**
 * MCP Adapter 单元测试
 * 覆盖：parseResponse 各 provider、resolveApiKey、ApiRateLimiter
 */

import { describe, it, expect } from 'vitest'
import {
  parseAnthropicResponse,
  parseOpenAiResponse,
  parseGeminiResponse,
  resolveApiKey,
  ApiRateLimiter,
} from '../mcp-adapter'
import type { ApiKeyConfig } from '@shared/types'

// ============================================
// parseAnthropicResponse
// ============================================

describe('parseAnthropicResponse', () => {
  it('解析纯文本响应', () => {
    const result = parseAnthropicResponse({
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
    })
    expect(result.text).toBe('Hello world')
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('解析多段文本', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
      stop_reason: 'end_turn',
    })
    expect(result.text).toBe('Part 1\nPart 2')
  })

  it('解析 tool_use 响应', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'text', text: 'Let me search...' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'test' } },
      ],
      stop_reason: 'tool_use',
    })
    expect(result.text).toBe('Let me search...')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toEqual({ id: 'tu_1', name: 'search', arguments: { query: 'test' } })
    expect(result.stopReason).toBe('tool_use')
  })

  it('解析纯 tool_use 无文本', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { path: '/a.ts' } },
      ],
      stop_reason: 'tool_use',
    })
    expect(result.text).toBe('')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.stopReason).toBe('tool_use')
  })

  it('content 缺失时抛出 AdapterError', () => {
    expect(() => parseAnthropicResponse({})).toThrow('Anthropic API returned unexpected response shape')
    expect(() => parseAnthropicResponse(null)).toThrow('Anthropic API returned unexpected response shape')
    expect(() => parseAnthropicResponse({ content: 'not-array' })).toThrow('Anthropic API returned unexpected response shape')
  })

  it('忽略无效 block（缺少 type/id/name）', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'unknown' },
        { type: 'tool_use' }, // 缺少 id 和 name
        { type: 'text' },     // 缺少 text
      ],
      stop_reason: 'end_turn',
    })
    expect(result.text).toBe('')
    expect(result.toolCalls).toEqual([])
  })
})

// ============================================
// parseOpenAiResponse
// ============================================

describe('parseOpenAiResponse', () => {
  it('解析纯文本响应', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: { content: 'Hello from OpenAI' },
        finish_reason: 'stop',
      }],
    })
    expect(result.text).toBe('Hello from OpenAI')
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('解析 tool_calls 响应', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('get_weather')
    expect(result.toolCalls[0].arguments).toEqual({ city: 'Beijing' })
    expect(result.stopReason).toBe('tool_use')
  })

  it('tool_calls 中 JSON 解析失败时降级为空对象', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_2',
            function: { name: 'bad_tool', arguments: '{invalid json' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].arguments).toEqual({})
  })

  it('choices 缺失时抛出 AdapterError', () => {
    expect(() => parseOpenAiResponse({})).toThrow('OpenAI API returned unexpected response shape')
    expect(() => parseOpenAiResponse(null)).toThrow('OpenAI API returned unexpected response shape')
  })

  it('message 为 null 时不崩溃', () => {
    const result = parseOpenAiResponse({
      choices: [{ message: null, finish_reason: 'stop' }],
    })
    expect(result.text).toBe('')
    expect(result.toolCalls).toEqual([])
  })
})

// ============================================
// parseGeminiResponse
// ============================================

describe('parseGeminiResponse', () => {
  it('解析正常响应', () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] } }],
    })
    expect(result.text).toBe('Gemini says hi')
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('candidates 为空数组时返回空文本', () => {
    const result = parseGeminiResponse({ candidates: [] })
    expect(result.text).toBe('')
  })

  it('null 输入抛出 AdapterError', () => {
    expect(() => parseGeminiResponse(null)).toThrow('Gemini API returned empty response')
  })

  it('空对象输入返回空文本', () => {
    const result = parseGeminiResponse({})
    expect(result.text).toBe('')
  })
})

// ============================================
// resolveApiKey
// ============================================

describe('resolveApiKey', () => {
  const keys: ApiKeyConfig[] = [
    { provider: 'anthropic', key: 'sk-ant-123' },
    { provider: 'openai', key: 'sk-oai-456' },
    { provider: 'deepseek', key: 'sk-ds-789' },
    { provider: 'gemini', key: 'gem-key-000' },
  ]

  it('根据 claude 模型匹配 anthropic key', () => {
    const result = resolveApiKey(keys, 'claude-3-5-sonnet-20241022')
    expect(result?.provider).toBe('anthropic')
    expect(result?.key).toBe('sk-ant-123')
  })

  it('根据 gpt 模型匹配 openai key', () => {
    expect(resolveApiKey(keys, 'gpt-4o')?.provider).toBe('openai')
  })

  it('根据 o1 模型匹配 openai key', () => {
    expect(resolveApiKey(keys, 'o1-preview')?.provider).toBe('openai')
  })

  it('根据 deepseek 模型匹配 deepseek key', () => {
    expect(resolveApiKey(keys, 'deepseek-chat')?.provider).toBe('deepseek')
  })

  it('根据 gemini 模型匹配 gemini key', () => {
    expect(resolveApiKey(keys, 'gemini-1.5-flash')?.provider).toBe('gemini')
  })

  it('未匹配模型时回退到第一个有效 key', () => {
    const result = resolveApiKey(keys, 'unknown-model-xyz')
    expect(result?.provider).toBe('anthropic') // 第一个有 config 的 key
  })

  it('无 defaultModel 时返回第一个有效 key', () => {
    const result = resolveApiKey(keys)
    expect(result?.provider).toBe('anthropic')
  })

  it('key 为空字符串时跳过', () => {
    const emptyKeys: ApiKeyConfig[] = [
      { provider: 'anthropic', key: '' },
      { provider: 'openai', key: 'sk-valid' },
    ]
    const result = resolveApiKey(emptyKeys, 'claude-3-5-sonnet-20241022')
    // anthropic key 为空，跳过；回退到 openai
    expect(result?.provider).toBe('openai')
  })

  it('全部 key 为空时返回 undefined', () => {
    const emptyKeys: ApiKeyConfig[] = [
      { provider: 'anthropic', key: '' },
    ]
    expect(resolveApiKey(emptyKeys, 'claude-3-5-sonnet')).toBeUndefined()
  })

  it('无任何 key 时返回 undefined', () => {
    expect(resolveApiKey([], 'gpt-4o')).toBeUndefined()
  })

  it('不因模型名含 "open" 误匹配 openai（前缀精确匹配）', () => {
    // "open-source-model" 不应匹配 openai
    const result = resolveApiKey(keys, 'open-source-model')
    // 不以 gpt/o1/o3/o4 开头，回退到第一个有效 key
    expect(result?.provider).toBe('anthropic')
  })
})

// ============================================
// ApiRateLimiter
// ============================================

describe('ApiRateLimiter', () => {
  it('首次调用允许', () => {
    const limiter = new ApiRateLimiter()
    expect(limiter.check('s1').allowed).toBe(true)
  })

  it('短时间内超过 3 次被限制', () => {
    const limiter = new ApiRateLimiter()
    for (let i = 0; i < 3; i++) limiter.check('s2')
    const result = limiter.check('s2')
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('不同 session 互不影响', () => {
    const limiter = new ApiRateLimiter()
    for (let i = 0; i < 3; i++) limiter.check('s3')
    expect(limiter.check('s4').allowed).toBe(true)
  })

  it('cleanup 后重新允许', () => {
    const limiter = new ApiRateLimiter()
    for (let i = 0; i < 3; i++) limiter.check('s5')
    expect(limiter.check('s5').allowed).toBe(false)
    limiter.cleanup('s5')
    expect(limiter.check('s5').allowed).toBe(true)
  })
})
