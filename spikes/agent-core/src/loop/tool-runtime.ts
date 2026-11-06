import type { ToolResultPayload } from '../types'

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown> | unknown

interface ToolCallText {
  tool: string
  input: Record<string, unknown>
}

/**
 * host-owned 循环的内联工具协议：<tool_call>{"tool":"read_file","input":{...}}</tool_call>
 * 必须做白名单 + schema 校验（新文档风险 #5：模型文本可伪造，不能直接执行任意工具）。
 */
export class ToolRuntime {
  constructor(private readonly tools: Record<string, ToolHandler>) {}

  parse(text: string): ToolCallText | undefined {
    const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
    if (!match) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1])
    } catch {
      throw new Error('TOOL_CALL_INVALID_JSON')
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { tool?: unknown }).tool !== 'string' ||
      typeof (parsed as { input?: unknown }).input !== 'object' ||
      (parsed as { input?: unknown }).input === null
    ) {
      throw new Error('TOOL_CALL_INVALID_SCHEMA')
    }
    const call = parsed as ToolCallText
    if (!(call.tool in this.tools)) throw new Error(`TOOL_NOT_ALLOWED: ${call.tool}`)
    return call
  }

  async execute(call: ToolCallText): Promise<ToolResultPayload> {
    const handler = this.tools[call.tool]
    if (!handler) {
      return { toolCallId: '', ok: false, error: `TOOL_NOT_ALLOWED: ${call.tool}` }
    }
    try {
      const output = await handler(call.input)
      return { toolCallId: '', ok: true, output }
    } catch (err) {
      return { toolCallId: '', ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
