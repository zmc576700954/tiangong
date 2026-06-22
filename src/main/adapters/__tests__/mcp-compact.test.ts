/**
 * MCP adapter — LLM-based context compaction (Phase 3 Task 33)
 *
 * Verifies:
 * - compactByLlm reads sessionOutputBuffers, summarises via injected LLM,
 *   stores the result on session.config.contextSummary, and clears the buffer.
 * - Empty buffer is handled gracefully.
 * - LLM failures surface as AdapterError so the orchestrator can fall back to
 *   summary-rewrite.
 * - Response parsers extract `usage` so reportUsage can be wired downstream.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpAdapter, parseAnthropicResponse, parseOpenAiResponse, parseGeminiResponse } from '../mcp-adapter'
import type { AgentSession } from '@shared/types'

function makeSession(id = 's1'): AgentSession {
  return {
    id,
    adapterName: 'mcp',
    config: {
      workingDirectory: '/tmp',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: '',
      acceptanceCriteria: [],
    },
    startTime: Date.now(),
  }
}

describe('McpAdapter LLM compaction', () => {
  let adapter: McpAdapter

  beforeEach(() => {
    adapter = new McpAdapter()
  })

  it('summarises buffer and stores in contextSummary', async () => {
    const session = makeSession('s1')
    // Bracket access bypasses private visibility — safe for test setup
    adapter['sessions'].set('s1', session)
    adapter['sessionOutputBuffers'].set('s1', ['some prior output', 'more content'])

    // Replace the LLM call with a stub returning a fixed summary
    adapter['summariseViaLlm'] = vi.fn().mockResolvedValue('Mocked summary content')

    const result = await adapter.compactContext('s1', 'llm')

    expect(result.strategy).toBe('llm')
    expect(result.trigger).toBe('manual')
    expect(result.summary).toBe('Mocked summary content')
    expect(result.tokensBefore).toBeGreaterThan(0)
    expect(result.tokensAfter).toBeGreaterThan(0)
    expect(result.startedAt).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    expect(session.config.contextSummary).toBe('Mocked summary content')
    expect(adapter['sessionOutputBuffers'].get('s1')).toEqual([])
  })

  it('passes the conversation text to summariseViaLlm', async () => {
    const session = makeSession('s2')
    adapter['sessions'].set('s2', session)
    adapter['sessionOutputBuffers'].set('s2', ['line one', 'line two', 'line three'])

    const stub = vi.fn().mockResolvedValue('summary')
    adapter['summariseViaLlm'] = stub

    await adapter.compactContext('s2', 'llm')

    expect(stub).toHaveBeenCalledTimes(1)
    const [text, sess] = stub.mock.calls[0] as [string, AgentSession]
    expect(text).toBe('line one\nline two\nline three')
    expect(sess.id).toBe('s2')
  })

  it('handles empty buffer gracefully (returns sentinel)', async () => {
    const session = makeSession('s3')
    adapter['sessions'].set('s3', session)
    adapter['sessionOutputBuffers'].set('s3', [])

    // Real summariseViaLlm handles empty text without calling the network
    const result = await adapter.compactContext('s3', 'llm')

    expect(result.strategy).toBe('llm')
    expect(result.summary).toMatch(/no prior context/i)
    expect(session.config.contextSummary).toMatch(/no prior context/i)
  })

  it('handles missing buffer (never written) gracefully', async () => {
    const session = makeSession('s4')
    adapter['sessions'].set('s4', session)
    // Note: no sessionOutputBuffers entry at all

    const result = await adapter.compactContext('s4', 'llm')

    expect(result.summary).toMatch(/no prior context/i)
  })

  it('throws AdapterError when LLM call fails', async () => {
    const session = makeSession('s5')
    adapter['sessions'].set('s5', session)
    adapter['sessionOutputBuffers'].set('s5', ['some content'])
    adapter['summariseViaLlm'] = vi.fn().mockRejectedValue(new Error('Network error'))

    await expect(adapter.compactContext('s5', 'llm')).rejects.toThrow(/LLM summarisation failed/)
    // Buffer should NOT be cleared on failure
    expect(adapter['sessionOutputBuffers'].get('s5')).toEqual(['some content'])
    // Summary should NOT be stored on failure
    expect(session.config.contextSummary).toBeUndefined()
  })

  it('throws when session is unknown', async () => {
    await expect(adapter.compactContext('ghost', 'llm')).rejects.toThrow(/not found/)
  })
})

describe('McpAdapter response parsers — usage extraction', () => {
  it('parseAnthropicResponse extracts input_tokens / output_tokens', () => {
    const result = parseAnthropicResponse({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1234, output_tokens: 56 },
    })
    expect(result.usage?.input_tokens).toBe(1234)
    expect(result.usage?.output_tokens).toBe(56)
  })

  it('parseAnthropicResponse returns undefined usage when not present', () => {
    const result = parseAnthropicResponse({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    })
    expect(result.usage).toBeUndefined()
  })

  it('parseOpenAiResponse extracts prompt_tokens / completion_tokens', () => {
    const result = parseOpenAiResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 789, completion_tokens: 42 },
    })
    expect(result.usage?.prompt_tokens).toBe(789)
    expect(result.usage?.completion_tokens).toBe(42)
  })

  it('parseGeminiResponse extracts promptTokenCount / candidatesTokenCount', () => {
    const result = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 17 },
    })
    expect(result.usage?.prompt_tokens).toBe(321)
    expect(result.usage?.completion_tokens).toBe(17)
  })
})
