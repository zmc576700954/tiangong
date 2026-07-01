import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractJson } from '../claude-runner'

describe('extractJson', () => {
  it('parses valid JSON directly', () => {
    expect(extractJson('{"key": "value"}')).toEqual({ key: 'value' })
  })

  it('parses JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3])
  })

  it('extracts JSON from code block', () => {
    const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.'
    expect(extractJson(input)).toEqual({ key: 'value' })
  })

  it('extracts JSON from code block without language tag', () => {
    const input = '```\n{"key": "value"}\n```'
    expect(extractJson(input)).toEqual({ key: 'value' })
  })

  it('extracts JSON from mixed text with single object', () => {
    const input = 'Here is the data: {"a": 1} some text'
    const result = extractJson(input) as Record<string, unknown>
    expect(result).toEqual({ a: 1 })
  })

  it('throws AgentError for non-JSON text', () => {
    expect(() => extractJson('This is not JSON at all')).toThrow('Failed to extract JSON')
  })

  it('handles nested JSON objects', () => {
    const input = '{"outer": {"inner": "value"}}'
    expect(extractJson(input)).toEqual({ outer: { inner: 'value' } })
  })

  it('handles JSON with whitespace', () => {
    const input = '  \n  {"key": "value"}  \n  '
    expect(extractJson(input)).toEqual({ key: 'value' })
  })

  it('handles JSON with comments in surrounding text', () => {
    const input = 'The answer is:\n{"result": 42}\nAs shown above.'
    expect(extractJson(input)).toEqual({ result: 42 })
  })
})
