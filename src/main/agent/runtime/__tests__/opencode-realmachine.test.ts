/**
 * OpenCode 真机夹具回归（v3.31）。
 *
 * 和 `opencode-stream.test.ts` 的分工：
 * - 那份是「按实机形状手写」的夹具，负责把归一化规则（stepId 归并、风险档、
 *   file.change、token 计法）钉住；
 * - 这份是**逐字未改**的 CLI 原始输出，负责证明解析器认得出真实字段，
 *   包括我们手写时想不到的部分（`metadata.display`、`time`、`chatcmpl-tool-`
 *   形式的 callID、`data.message` / `data.ref` 的错误体）。
 *
 * 采集条件（2026-11-12，opencode 1.19.5，macOS）：
 *   `opencode run --format json --auto --model opencode/deepseek-v4.1-flash-free
 *    "read note.txt and reply with its exact content"`
 *   —— 免费档、`~/.local/share/opencode/auth.json` 里 0 条凭据、cost 0。
 * 这一点很关键：国内用户没有官方订阅时，这是唯一开箱能跑的组合。
 */

import { describe, expect, it } from 'vitest'
import { errorTextOf, OpenCodeStreamNormalizer, type OpenCodeEvent } from '../normalize/opencode'

const META = { runId: 'run-rm', turnId: 'turn-rm', sessionId: 'sess-rm', baseTimestamp: 2_000 }

/** 原样输出：读文件 → 回话，两个 step。 */
const RAW_READ_TURN = String.raw`{"type":"step_start","timestamp":1794496899954,"sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","part":{"id":"prt_1d059ab6c001PHs1lqSUsOQP2y","messageID":"msg_1d0598b84001HaSX3FVQAmrDji","sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","type":"step-start"}}
{"type":"tool_use","timestamp":1794496900892,"sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","part":{"type":"tool","tool":"read","callID":"chatcmpl-tool-ae7533b4924b1d44","state":{"status":"completed","input":{"filePath":"/private/tmp/oc-probe/note.txt"},"output":"<path>/private/tmp/oc-probe/note.txt</path>\n<type>file</type>\n<content>\n1: hello from fixture\n\n(End of file - total 1 lines)\n</content>","metadata":{"preview":"hello from fixture","truncated":false,"loaded":[],"display":{"type":"file","path":"/private/tmp/oc-probe/note.txt","text":"hello from fixture","lineStart":1,"lineEnd":1,"totalLines":1,"truncated":false}},"title":"private/tmp/oc-probe/note.txt","time":{"start":1794496900884,"end":1794496900891}},"id":"prt_1d059ab6f001HIYzmzAOsqtBLN","sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","messageID":"msg_1d0598b84001HaSX3FVQAmrDji"}}
{"type":"step_finish","timestamp":1794496901736,"sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","part":{"id":"prt_1d059b263001a3JBOOnV5pgocZ","reason":"tool-calls","messageID":"msg_1d0598b84001HaSX3FVQAmrDji","sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","type":"step-finish","tokens":{"total":7887,"input":6046,"output":49,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}
{"type":"step_start","timestamp":1794496908039,"sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","part":{"id":"prt_1d059cb05001qy1SwPAwbwN5Up","messageID":"msg_1d059b2670018agQ2k1Fl7DWua","sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","type":"step-start"}}
{"type":"text","timestamp":1794496908712,"sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","part":{"id":"prt_1d059cda20019lre4jRUNQD3QF","messageID":"msg_1d059b2670018agQ2k1Fl7DWua","sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","type":"text","text":"hello from fixture","time":{"start":1794496908706,"end":1794496908707}}}
{"type":"step_finish","timestamp":1794496908712,"sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","part":{"id":"prt_1d059cda3001P304XpwyFcPn8a","reason":"stop","messageID":"msg_1d059b2670018agQ2k1Fl7DWua","sessionID":"ses_e2fa6751fffePucmuTBbkNOBqf","type":"step-finish","tokens":{"total":7946,"input":133,"output":5,"reasoning":0,"cache":{"write":0,"read":7808}},"cost":0}}`

/**
 * 原样输出：模型 id 写错时 CLI **只给这一行**，退出码 1。
 *
 * `--model opencode/no-such-model-xyz` 的实机响应；它把真原因
 * （`ProviderModelNotFoundError: Model not found: …`）压进了 server 日志，
 * 只在 DEBUG 下可见。所以宿主能拿到的全部线索就是这句 + `ref`。
 */
const RAW_ERROR_TURN = String.raw`{"type":"error","timestamp":1794496862854,"sessionID":"ses_e2fa6e60bffeS7nvJ2a5V22uDb","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_c0851bc9"}}}`

function parseJsonl(raw: string): OpenCodeEvent[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenCodeEvent)
}

function normalize(raw: string, exitCode: number) {
  const normalizer = new OpenCodeStreamNormalizer(META)
  for (const event of parseJsonl(raw)) normalizer.feed(event)
  return normalizer.finish(exitCode)
}

describe('OpenCode 真机输出（1.19.5 免费档，零凭据）', () => {
  it('read 工具被还原成 requested + result，callID 与输出原样保留', () => {
    const events = normalize(RAW_READ_TURN, 0)

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'turn.started',
      'tool.requested',
      'tool.result',
      'message.completed',
      'usage.updated',
      'run.completed',
    ])

    const requested = events.find((event) => event.type === 'tool.requested')
    const result = events.find((event) => event.type === 'tool.result')
    expect(requested?.payload).toMatchObject({
      toolCallId: 'chatcmpl-tool-ae7533b4924b1d44',
      toolName: 'read',
      // 读类工具不该被抬成写风险，否则每次读文件都会弹审批
      risk: 'low',
    })
    expect(result?.stepId).toBe(requested?.stepId)
    expect(result?.payload).toMatchObject({ ok: true })
    expect(String(result?.payload.output)).toContain('hello from fixture')
    // 读不是写：不该凭空产出一条 file.change
    expect(events.some((event) => event.type === 'file.change')).toBe(false)
  })

  it('token 取真实值：input 只认首个非零步，output 累加两步', () => {
    const events = normalize(RAW_READ_TURN, 0)
    const usage = events.find((event) => event.type === 'usage.updated')?.payload
    expect(usage).toMatchObject({ inputTokens: 6046, outputTokens: 54 })
  })

  it('回合用模型最后一句话收尾，不是 stdout 原文', () => {
    const events = normalize(RAW_READ_TURN, 0)
    expect(events.at(-1)?.payload).toMatchObject({ status: 'completed', summary: 'hello from fixture' })
  })

  it('错误体走 data.message + ref，不吞成「exit code 1」', () => {
    const events = normalize(RAW_ERROR_TURN, 1)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'turn.started',
      'error',
      'usage.updated',
      'run.failed',
    ])

    const failed = events.at(-1)?.payload
    // 之前这里只有 `opencode exited with code 1`，用户拿不到任何线索
    expect(String(failed?.summary)).toContain('Unexpected server error')
    expect(String(failed?.summary)).toContain('ref=err_c0851bc9')
    expect(failed).toMatchObject({ status: 'failed' })
    expect((failed?.failure as { message?: string }).message).toContain('ref=err_c0851bc9')
  })

  it('退出码非零但没有 error 事件时，仍判失败（被杀掉的进程不算完成）', () => {
    const events = normalize(RAW_READ_TURN, 1)
    expect(events.at(-1)?.type).toBe('run.failed')
    expect(String(events.at(-1)?.payload.summary)).toContain('code 1')
  })

  it('errorTextOf 兼容三种错误体形状', () => {
    expect(errorTextOf('boom')).toBe('boom')
    expect(errorTextOf({ message: 'boom' })).toBe('boom')
    expect(errorTextOf({ name: 'UnknownError', data: { message: 'boom', ref: 'err_1' } })).toBe('boom (ref=err_1)')
    // 没有可读 message 时退回序列化，至少不丢原因
    expect(errorTextOf({ name: 'Weird' })).toContain('Weird')
    expect(errorTextOf(undefined)).toBeUndefined()
  })
})
