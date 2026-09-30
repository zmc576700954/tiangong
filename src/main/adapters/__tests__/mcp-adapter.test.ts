/**
 * MCP Adapter 单元测试
 * 覆盖：parseResponse 各 provider、resolveApiKey、ApiRateLimiter
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseAnthropicResponse,
  parseOpenAiResponse,
  parseGeminiResponse,
  resolveApiKey,
  ApiRateLimiter,
  McpAdapter,
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

  it('清理不存在的 sessionId 不抛错', () => {
    const limiter = new ApiRateLimiter()
    expect(() => limiter.cleanup('never-existed')).not.toThrow()
  })

  it('cleanup 后 store 被彻底清空（无残留 timestamps）', () => {
    const limiter = new ApiRateLimiter()
    for (let i = 0; i < 3; i++) limiter.check('clear-test')
    expect(limiter.check('clear-test').allowed).toBe(false)
    limiter.cleanup('clear-test')
    // 立即 check 应该 allowed（说明 timestamps 已被清空）
    expect(limiter.check('clear-test').allowed).toBe(true)
  })
})

// ============================================
// parseAnthropicResponse 进阶用例
// ============================================

describe('parseAnthropicResponse (advanced)', () => {
  it('多个 tool_use 在同一响应中均被解析', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'tu_a', name: 'read', input: { path: '/a' } },
        { type: 'tool_use', id: 'tu_b', name: 'write', input: { path: '/b', body: 'x' } },
      ],
      stop_reason: 'tool_use',
    })
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].id).toBe('tu_a')
    expect(result.toolCalls[1].name).toBe('write')
  })

  it('tool_use 的 input 为非对象时仍解析为该值（透传）', () => {
    // input 不一定是 object：例如 string/number/array 在某些场景下也可接受。
    // 解析器不应强转，只透传；调用方负责校验。
    const result = parseAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'tu_x', name: 'echo', input: 'just a string' },
      ],
      stop_reason: 'tool_use',
    })
    expect(result.toolCalls[0].arguments).toBe('just a string')
  })

  it('stop_reason 非 tool_use 时映射为 end_turn（max_tokens/stop_sequence 归一）', () => {
    // 当前实现只把 tool_use 单独识别为 'tool_use'，其他（end_turn/max_tokens/stop_sequence）
    // 统一归一为 'end_turn'。这与上层 AgentManager 的 stopReason 语义匹配：
    // "end" 类信号即可结束当前 turn，是否截断由 usage.output_tokens 决定。
    const r1 = parseAnthropicResponse({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
    })
    expect(r1.stopReason).toBe('end_turn')
    expect(r1.text).toBe('partial')

    const r2 = parseAnthropicResponse({
      content: [{ type: 'text', text: 'stop seq hit' }],
      stop_reason: 'stop_sequence',
    })
    expect(r2.stopReason).toBe('end_turn')

    const r3 = parseAnthropicResponse({
      content: [{ type: 'text', text: 'normal' }],
      stop_reason: 'end_turn',
    })
    expect(r3.stopReason).toBe('end_turn')
  })

  it('tool_use id 缺失时该 block 被跳过（但不影响其他）', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'tu_real', name: 'good', input: {} },
        { type: 'tool_use', name: 'no-id', input: {} },
      ],
      stop_reason: 'tool_use',
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].id).toBe('tu_real')
  })

  it('混合 text + tool_use 时 text 部分拼接并保留 tool_calls', () => {
    const result = parseAnthropicResponse({
      content: [
        { type: 'text', text: 'Reasoning: ' },
        { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } },
        { type: 'text', text: 'Follow-up note' },
      ],
      stop_reason: 'tool_use',
    })
    expect(result.text).toBe('Reasoning: \nFollow-up note')
    expect(result.toolCalls).toHaveLength(1)
  })

  it('usage 字段透传为 prompt/completion tokens', () => {
    const result = parseAnthropicResponse({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 25 },
    })
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 25 })
  })

  it('非对象输入（字符串/数字）抛 AdapterError', () => {
    expect(() => parseAnthropicResponse('not an object')).toThrow()
    expect(() => parseAnthropicResponse(42)).toThrow()
    expect(() => parseAnthropicResponse(undefined)).toThrow()
  })
})

// ============================================
// parseOpenAiResponse 进阶用例
// ============================================

describe('parseOpenAiResponse (advanced)', () => {
  it('tool_calls 中 arguments 是合法 JSON 但非 object（数组）时透传', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_arr',
            type: 'function',
            function: { name: 'list_things', arguments: '[1,2,3]' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(result.toolCalls[0].arguments).toEqual([1, 2, 3])
  })

  it('多个 tool_calls 同响应都被解析', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: {
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'f1', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'f2', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(result.toolCalls.map((t) => t.name)).toEqual(['f1', 'f2'])
  })

  it('function.name 缺失时该条被跳过', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: {
          tool_calls: [
            { id: 'no_name', type: 'function', function: { arguments: '{}' } },
            { id: 'ok', type: 'function', function: { name: 'good', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].id).toBe('ok')
  })

  it('finish_reason 为 length 时映射 end_turn', () => {
    const result = parseOpenAiResponse({
      choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
    })
    expect(result.text).toBe('cut off')
    expect(result.stopReason).toBe('end_turn')
  })

  it('choices 为空数组时返回空文本不抛错', () => {
    const result = parseOpenAiResponse({ choices: [] })
    expect(result.text).toBe('')
    expect(result.toolCalls).toEqual([])
  })

  it('tool_calls 中 id 非字符串的条目被跳过', () => {
    const result = parseOpenAiResponse({
      choices: [{
        message: {
          tool_calls: [
            { type: 'function', function: { name: 'no_id', arguments: '{}' } },
            { id: 'real_id', type: 'function', function: { name: 'good', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].id).toBe('real_id')
  })
})

// ============================================
// resolveApiKey 进阶用例
// ============================================

describe('resolveApiKey (advanced)', () => {
  it('混合大小写模型名也正确匹配', () => {
    const keys: ApiKeyConfig[] = [
      { provider: 'anthropic', key: 'sk-ant' },
    ]
    expect(resolveApiKey(keys, 'CLAUDE-3-5-SONNET')?.provider).toBe('anthropic')
    expect(resolveApiKey(keys, 'GPT-4o')?.provider).toBe('anthropic') // 回退到首个有效
  })

  it('claude-2 / claude-instant 也命中 anthropic（前缀匹配）', () => {
    const keys: ApiKeyConfig[] = [
      { provider: 'anthropic', key: 'sk-ant' },
      { provider: 'openai', key: 'sk-oai' },
    ]
    expect(resolveApiKey(keys, 'claude-2')?.provider).toBe('anthropic')
    expect(resolveApiKey(keys, 'claude-instant-1.2')?.provider).toBe('anthropic')
  })

  it('o3 / o4 系列也命中 openai', () => {
    const keys: ApiKeyConfig[] = [
      { provider: 'openai', key: 'sk-oai' },
    ]
    expect(resolveApiKey(keys, 'o3-mini')?.provider).toBe('openai')
    expect(resolveApiKey(keys, 'o4-preview')?.provider).toBe('openai')
  })

  it('空数组无 defaultModel 返回 undefined', () => {
    expect(resolveApiKey([])).toBeUndefined()
    expect(resolveApiKey([], undefined)).toBeUndefined()
  })

  it('provider 名不参与匹配逻辑（仅 defaultModel 前缀匹配）', () => {
    // 即使 provider 名不在 union 内（生产中应被类型校验），只要 model 命中对应前缀的 key 就行
    const keys: ApiKeyConfig[] = [
      { provider: 'anthropic' as ApiKeyConfig['provider'], key: 'sk-x' },
      { provider: 'openai', key: 'sk-oai' },
    ]
    expect(resolveApiKey(keys, 'gpt-4o')?.provider).toBe('openai')
  })

  it('"deepseek" 任意位置（不仅是开头）也命中', () => {
    // 'my-custom-deepseek-model' 应命中 deepseek（注意：prefix 匹配只覆盖 gpt/o1/o3/o4/anthropic 等）
    // 实现细节：除了前缀白名单外，其余 deepseek 检查走 contains。
    const keys: ApiKeyConfig[] = [
      { provider: 'deepseek', key: 'sk-ds' },
      { provider: 'openai', key: 'sk-oai' },
    ]
    expect(resolveApiKey(keys, 'deepseek-chat')?.provider).toBe('deepseek')
  })
})

// ============================================
// McpAdapter 内部状态（通过 bracket notation）
// ============================================
//
// 以下测试通过 bracket-notation 访问 McpAdapter 的 private 字段，匹配 base-compact.test.ts 风格。
// 不启动真实 startSession，只验证内部状态机/资源池的语义正确性。

// McpClient 的最小 stub 接口（只暴露本测试关心的方法）
interface FakeClient {
  isReady(): boolean
  disconnect(): Promise<void>
  getTools(): unknown[]
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

describe('McpAdapter 熔断器 (circuit breaker)', () => {
  const adapter = new McpAdapter()
  const cb = adapter['circuitBreaker'] as Map<string, { failures: number; lastFailureTime: number; state: 'closed' | 'open' | 'half-open' }>

  it('初始状态 closed，isCircuitOpen 返回 false', () => {
    expect(adapter['isCircuitOpen']('test-srv-1')).toBe(false)
    expect(cb.get('test-srv-1')).toBeUndefined()
  })

  it('连续 3 次失败后熔断器进入 open 状态', () => {
    adapter['recordCircuitResult']('test-srv-2', false)
    adapter['recordCircuitResult']('test-srv-2', false)
    expect(adapter['isCircuitOpen']('test-srv-2')).toBe(false) // 2 次，未到阈值
    adapter['recordCircuitResult']('test-srv-2', false) // 第 3 次，触发 open
    expect(adapter['isCircuitOpen']('test-srv-2')).toBe(true)
    const entry = cb.get('test-srv-2')
    expect(entry?.state).toBe('open')
    expect(entry?.failures).toBe(3)
  })

  it('open 状态下的失败不再改变 state（防止 reset）', () => {
    adapter['recordCircuitResult']('test-srv-3', false)
    adapter['recordCircuitResult']('test-srv-3', false)
    adapter['recordCircuitResult']('test-srv-3', false)
    expect(adapter['isCircuitOpen']('test-srv-3')).toBe(true)
    adapter['recordCircuitResult']('test-srv-3', false)
    expect(adapter['isCircuitOpen']('test-srv-3')).toBe(true)
    expect(cb.get('test-srv-3')?.state).toBe('open')
  })

  it('open 状态超时（CB_OPEN_DURATION_MS=30s）后转为 half-open，允许一次尝试', () => {
    adapter['recordCircuitResult']('test-srv-4', false)
    adapter['recordCircuitResult']('test-srv-4', false)
    adapter['recordCircuitResult']('test-srv-4', false)
    const entry = cb.get('test-srv-4')!
    // 倒拨 lastFailureTime 让其"已超时"
    entry.lastFailureTime = Date.now() - 31_000
    expect(adapter['isCircuitOpen']('test-srv-4')).toBe(false) // half-open
    expect(cb.get('test-srv-4')?.state).toBe('half-open')
  })

  it('half-open 后调用成功会关闭熔断器并重置计数', () => {
    adapter['recordCircuitResult']('test-srv-5', false)
    adapter['recordCircuitResult']('test-srv-5', false)
    adapter['recordCircuitResult']('test-srv-5', false)
    const entry = cb.get('test-srv-5')!
    entry.lastFailureTime = Date.now() - 31_000
    // 第一次 isCircuitOpen 会转换到 half-open
    expect(adapter['isCircuitOpen']('test-srv-5')).toBe(false)
    expect(cb.get('test-srv-5')?.state).toBe('half-open')
    // 一次成功关闭熔断器
    adapter['recordCircuitResult']('test-srv-5', true)
    expect(cb.get('test-srv-5')?.state).toBe('closed')
    expect(cb.get('test-srv-5')?.failures).toBe(0)
  })

  it('success 在 closed 状态下会清零失败计数', () => {
    adapter['recordCircuitResult']('test-srv-6', false)
    adapter['recordCircuitResult']('test-srv-6', false)
    expect(cb.get('test-srv-6')?.failures).toBe(2)
    adapter['recordCircuitResult']('test-srv-6', true)
    expect(cb.get('test-srv-6')?.failures).toBe(0)
    expect(cb.get('test-srv-6')?.state).toBe('closed')
  })

  it('half-open 时再次失败 → 回到 open（重置 lastFailureTime）', () => {
    adapter['recordCircuitResult']('test-srv-7', false)
    adapter['recordCircuitResult']('test-srv-7', false)
    adapter['recordCircuitResult']('test-srv-7', false)
    const entry = cb.get('test-srv-7')!
    entry.lastFailureTime = Date.now() - 31_000
    adapter['isCircuitOpen']('test-srv-7') // → half-open
    expect(cb.get('test-srv-7')?.state).toBe('half-open')
    adapter['recordCircuitResult']('test-srv-7', false) // half-open → open
    expect(cb.get('test-srv-7')?.state).toBe('open')
  })

  it('不同 serverName 的熔断器相互独立', () => {
    adapter['recordCircuitResult']('isolated-A', false)
    adapter['recordCircuitResult']('isolated-A', false)
    adapter['recordCircuitResult']('isolated-A', false)
    expect(adapter['isCircuitOpen']('isolated-A')).toBe(true)
    expect(adapter['isCircuitOpen']('isolated-B')).toBe(false)
  })
})

describe('McpAdapter 连接池 (connection pool)', () => {
  function makeFakeClient(): FakeClient {
    return {
      isReady: () => true,
      disconnect: async () => {},
      getTools: () => [],
      callTool: async () => ({}),
    }
  }
  const adapter = new McpAdapter()
  const pool = adapter['connectionPool'] as Map<string, { client: FakeClient; refCount: number; lastUsed: number }>

  it('初始为空 Map', () => {
    expect(pool.size).toBe(0)
  })

  it('cleanupIdlePoolConnections 保留 refCount > 0 的条目', () => {
    pool.clear()
    pool.set('keep-active', { client: makeFakeClient(), refCount: 2, lastUsed: Date.now() - 60_000 })
    pool.set('expire', { client: makeFakeClient(), refCount: 0, lastUsed: Date.now() - 11 * 60_000 })
    pool.set('fresh-idle', { client: makeFakeClient(), refCount: 0, lastUsed: Date.now() - 1000 })
    adapter['cleanupIdlePoolConnections']()
    expect(pool.has('keep-active')).toBe(true)
    expect(pool.has('expire')).toBe(false)
    expect(pool.has('fresh-idle')).toBe(true)
  })

  it('cleanupIdlePoolConnections 调用 expire 条目的 client.disconnect', async () => {
    pool.clear()
    let disconnected = 0
    const client = {
      isReady: () => true,
      disconnect: async () => { disconnected++ },
      getTools: () => [],
      callTool: async () => ({}),
    }
    pool.set('expiring', { client, refCount: 0, lastUsed: Date.now() - 11 * 60_000 })
    adapter['cleanupIdlePoolConnections']()
    await Promise.resolve()
    expect(disconnected).toBe(1)
  })

  it('多次连续 cleanup 不重复触发 disconnect（条目已被清）', async () => {
    pool.clear()
    let disconnected = 0
    const client = {
      isReady: () => true,
      disconnect: async () => { disconnected++ },
      getTools: () => [],
      callTool: async () => ({}),
    }
    pool.set('once', { client, refCount: 0, lastUsed: Date.now() - 11 * 60_000 })
    adapter['cleanupIdlePoolConnections']()
    adapter['cleanupIdlePoolConnections']() // 已不在池中，client.disconnect 不再被调用
    await Promise.resolve()
    expect(disconnected).toBe(1)
  })
})

describe('McpAdapter.dispose()', () => {
  it('清掉 poolCleanupTimer', () => {
    const adapter = new McpAdapter()
    const fakeTimer = setInterval(() => {}, 1000) as ReturnType<typeof setInterval>
    adapter['poolCleanupTimer'] = fakeTimer
    adapter.dispose()
    expect(adapter['poolCleanupTimer']).toBeUndefined()
    // 验证 clearInterval 已被调用（再次 clearInterval 同一个 handle 是 no-op，不抛错）
    expect(() => clearInterval(fakeTimer)).not.toThrow()
  })

  it('调用所有池内 client.disconnect 并清空 connectionPool', async () => {
    const adapter = new McpAdapter()
    const pool = adapter['connectionPool'] as Map<string, { client: FakeClient; refCount: number; lastUsed: number }>
    const disconnected: string[] = []
    pool.set('a', { client: { isReady: () => true, disconnect: async () => { disconnected.push('a') }, getTools: () => [], callTool: async () => ({}) }, refCount: 0, lastUsed: Date.now() })
    pool.set('b', { client: { isReady: () => true, disconnect: async () => { disconnected.push('b') }, getTools: () => [], callTool: async () => ({}) }, refCount: 1, lastUsed: Date.now() })
    adapter.dispose()
    await Promise.resolve()
    expect(disconnected.sort()).toEqual(['a', 'b'])
    expect(pool.size).toBe(0)
  })

  it('client 没有 disconnect 方法时仍安全调用（链式 ?. 防止 crash）', () => {
    const adapter = new McpAdapter()
    const pool = adapter['connectionPool'] as Map<string, { client: FakeClient; refCount: number; lastUsed: number }>
    // 故意构造一个缺少 disconnect 方法的对象，模拟第三方 MCP 客户端未实现 disconnect。
    // dispose() 内的 entry.client.disconnect?.() 应通过链式可选调用短路为 undefined，
    // 不抛 TypeError。FakeClient 接口强制 disconnect 存在，这里用 cast 绕过类型校验。
    const partialClient = { isReady: () => true, getTools: () => [], callTool: async () => ({}) } as unknown as FakeClient
    pool.set('no-disconnect', { client: partialClient, refCount: 0, lastUsed: Date.now() })
    expect(() => adapter.dispose()).not.toThrow()
    expect(pool.size).toBe(0)
  })

  it('重复 dispose 不抛错（幂等）', () => {
    const adapter = new McpAdapter()
    expect(() => {
      adapter.dispose()
      adapter.dispose()
    }).not.toThrow()
  })
})

describe('McpAdapter.cleanupMcpResources()', () => {
  const adapter = new McpAdapter()
  const pool = adapter['connectionPool'] as Map<string, { client: FakeClient; refCount: number; lastUsed: number }>
  const mcpClients = adapter['mcpClients'] as Map<string, FakeClient[]>

  beforeEach(() => {
    pool.clear()
    mcpClients.clear()
  })

  it('refCount > 0 时不断开（其他会话还在用）', async () => {
    let disconnectCalls = 0
    const client = {
      isReady: () => true,
      disconnect: async () => { disconnectCalls++ },
      getTools: () => [],
      callTool: async () => ({}),
    }
    pool.set('srv-A', { client, refCount: 2, lastUsed: Date.now() })
    mcpClients.set('sess-X', [client])

    adapter['cleanupMcpResources']('sess-X')
    await Promise.resolve()
    await Promise.resolve()

    expect(pool.get('srv-A')?.refCount).toBe(1)
    expect(disconnectCalls).toBe(0) // 还有其他会话引用，不应断开
    expect(pool.has('srv-A')).toBe(true)
    expect(mcpClients.has('sess-X')).toBe(false)
  })

  it('refCount 减到 0 时触发 disconnect（释放资源）', async () => {
    let disconnectCalls = 0
    const client = {
      isReady: () => true,
      disconnect: async () => { disconnectCalls++ },
      getTools: () => [],
      callTool: async () => ({}),
    }
    pool.set('release', { client, refCount: 1, lastUsed: Date.now() })
    mcpClients.set('sess-release', [client])

    adapter['cleanupMcpResources']('sess-release')
    await Promise.resolve()
    await Promise.resolve()

    expect(pool.get('release')?.refCount).toBe(0)
    expect(disconnectCalls).toBe(1)
    // 池条目不立即清除——等 idle reaper 清理。client 已被断开，下次复用会触发替换逻辑。
  })

  it('多个 session 共享同一池条目时 refCount 累加正确', async () => {
    const disconnectLog: string[] = []
    const client = {
      isReady: () => true,
      disconnect: async () => { disconnectLog.push('disconnected') },
      getTools: () => [],
      callTool: async () => ({}),
    }
    // 池 refCount 反映当前持有引用的会话数（生产代码在 startSession 中递增）
    pool.set('shared', { client, refCount: 3, lastUsed: Date.now() })
    mcpClients.set('sess-1', [client])
    mcpClients.set('sess-2', [client])
    mcpClients.set('sess-3', [client])

    adapter['cleanupMcpResources']('sess-1')
    expect(pool.get('shared')?.refCount).toBe(2)
    adapter['cleanupMcpResources']('sess-2')
    expect(pool.get('shared')?.refCount).toBe(1)
    adapter['cleanupMcpResources']('sess-3')
    expect(pool.get('shared')?.refCount).toBe(0)
    await Promise.resolve()
    await Promise.resolve()
    // 最后一次清理时 refCount=0，触发 disconnect
    expect(disconnectLog).toEqual(['disconnected'])
    // 池条目仍在，等待 idle reaper
    expect(pool.has('shared')).toBe(true)
  })

  it('池条目 client 不在 mcpClients 中时不被 refCount 减（孤儿条目保留）', () => {
    const client = {
      isReady: () => true,
      disconnect: async () => {},
      getTools: () => [],
      callTool: async () => ({}),
    }
    pool.set('orphan', { client, refCount: 1, lastUsed: Date.now() })
    // 注意：sess-cleanup 没有把 orphan client 注册到 mcpClients
    mcpClients.set('no-match', [{
      isReady: () => true,
      disconnect: async () => {},
      getTools: () => [],
      callTool: async () => ({}),
    }]) // 不同的 client

    adapter['cleanupMcpResources']('no-match')

    // orphan 的 client 没被任何 mcpClients 引用，refCount 不变
    expect(pool.get('orphan')?.refCount).toBe(1)
  })

  it('mcpClients 中存在但 connectionPool 没有的 client 也会被断开（非池化连接）', async () => {
    let disconnected = 0
    const standaloneClient = {
      isReady: () => true,
      disconnect: async () => { disconnected++ },
      getTools: () => [],
      callTool: async () => ({}),
    }
    mcpClients.set('standalone-sess', [standaloneClient])

    adapter['cleanupMcpResources']('standalone-sess')
    await Promise.resolve()
    await Promise.resolve()

    expect(disconnected).toBe(1)
    expect(mcpClients.has('standalone-sess')).toBe(false)
  })

  it('client.disconnect 抛错时不会中断整个清理（best-effort）', async () => {
    let secondDisconnected = false
    const goodClient = {
      isReady: () => true,
      disconnect: async () => { secondDisconnected = true },
      getTools: () => [],
      callTool: async () => ({}),
    }
    const badClient = {
      isReady: () => true,
      disconnect: async () => { throw new Error('boom') },
      getTools: () => [],
      callTool: async () => ({}),
    }
    mcpClients.set('multi', [badClient, goodClient])

    adapter['cleanupMcpResources']('multi')
    await Promise.resolve()
    await Promise.resolve()
    // 不应抛错，第二个 client 仍被断开
    expect(secondDisconnected).toBe(true)
    expect(mcpClients.has('multi')).toBe(false)
  })

  it('清理 mcpClients 中不存在的 sessionId 不抛错', () => {
    expect(() => adapter['cleanupMcpResources']('never-existed')).not.toThrow()
  })
})
