import { describe, it, expect } from 'vitest'
import { extractJson } from '../mindmap-agent/claude-runner'

describe('extractJson', () => {
  // ==================== 纯 JSON ====================
  describe('纯 JSON 输入', () => {
    it('直接解析 JSON 对象', () => {
      const result = extractJson('{"name": "test", "value": 42}')
      expect(result).toEqual({ name: 'test', value: 42 })
    })

    it('直接解析 JSON 数组', () => {
      const result = extractJson('[1, 2, 3]')
      expect(result).toEqual([1, 2, 3])
    })

    it('直接解析嵌套 JSON', () => {
      const input = '{"modules": [{"name": "A", "features": ["f1"]}]}'
      const result = extractJson(input)
      expect(result).toEqual({ modules: [{ name: 'A', features: ['f1'] }] })
    })
  })

  // ==================== Code Block ====================
  describe('Markdown Code Block', () => {
    it('解析 ```json ... ``` 代码块', () => {
      const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.'
      const result = extractJson(input)
      expect(result).toEqual({ key: 'value' })
    })

    it('解析 ``` ... ``` 代码块（无 json 标记）', () => {
      const input = '```\n[1, 2, 3]\n```'
      const result = extractJson(input)
      expect(result).toEqual([1, 2, 3])
    })

    it('代码块中有前后空格', () => {
      const input = '```json\n  {"a": 1}  \n```'
      const result = extractJson(input)
      expect(result).toEqual({ a: 1 })
    })
  })

  // ==================== 嵌入文本中的 JSON ====================
  describe('嵌入文本中的 JSON', () => {
    it('从文本中提取 JSON 对象', () => {
      const input = 'Some preamble text {"result": true} and some trailing text'
      const result = extractJson(input)
      expect(result).toEqual({ result: true })
    })

    it('从文本中提取 JSON 数组', () => {
      const input = 'Result: [{"a": 1}, {"b": 2}] end'
      const result = extractJson(input)
      expect(result).toEqual([{ a: 1 }, { b: 2 }])
    })

    it('多行 JSON 嵌入文本', () => {
      const input = `Here is the output:
{
  "name": "module1",
  "description": "test module"
}
End of output.`
      const result = extractJson(input)
      expect(result).toEqual({ name: 'module1', description: 'test module' })
    })
  })

  // ==================== 错误情况 ====================
  describe('错误处理', () => {
    it('纯文本无 JSON → 抛出异常', () => {
      expect(() => extractJson('Hello world, no JSON here')).toThrow()
    })

    it('空字符串 → 抛出异常', () => {
      expect(() => extractJson('')).toThrow()
    })

    it('无效 JSON 语法 → 抛出异常', () => {
      expect(() => extractJson('{invalid json}')).toThrow()
    })

    it('只有左括号 → 抛出异常', () => {
      expect(() => extractJson('text { more text')).toThrow()
    })

    it('错误消息包含描述', () => {
      try {
        extractJson('no json')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect((err as Error).message).toContain('Failed to extract JSON')
      }
    })
  })
})
