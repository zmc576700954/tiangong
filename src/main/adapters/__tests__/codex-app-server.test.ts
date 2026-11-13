/**
 * `codex app-server` 客户端（G7-2 的「问了再放行」通道）。
 *
 * CI 上没有 codex 二进制，所以这里全部用注入的假进程验证协议胶水：
 * 握手顺序、审批回执（含 `availableDecisions` 收窄）、事件方言翻译、
 * token 差分、配置加载失败的原文透出。真实链路由实机记录背书
 * （见蓝图 v3.33 的 G7-2 行）。
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexAppServerClient,
  approvalToToolCall,
  buildApprovalReply,
  mapItem,
  toCodexStreamEvent,
  type CodexApprovalRequest,
  type SpawnLike,
} from '../codex-app-server'

/** 只实现客户端用到的那点进程语义。stdin 收集客户端写出的帧。 */
class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stderr = new Readable({ read() {} })
  stdin = new PassThrough()
  pid = 5321
  exitCode: number | null = null
  written: Array<Record<string, unknown>> = []

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line.trim()) this.written.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
  }

  kill(): boolean {
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }

  /** 往 stdout 推一帧。 */
  push(frame: unknown): void {
    this.stdout.push(JSON.stringify(frame) + '\n')
  }
}

function fakeSpawn(): { child: FakeChild; spawnImpl: SpawnLike } {
  const child = new FakeChild()
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess) as unknown as SpawnLike
  return { child, spawnImpl }
}

/** 起一个已完成握手的客户端；`start` 期间自动回应 initialize。 */
async function startClient(options?: { onApproval?: (request: CodexApprovalRequest) => void }) {
  const { child, spawnImpl } = fakeSpawn()
  const approvals: CodexApprovalRequest[] = []
  const ready = CodexAppServerClient.start({
    plan: { command: 'codex', args: ['app-server'], cwd: '/tmp/wd', env: {} },
    spawnImpl,
    requestTimeoutMs: 2_000,
    onApproval: (request) => {
      approvals.push(request)
      options?.onApproval?.(request)
    },
  })
  // initialize 的响应
  await Promise.resolve()
  const init = child.written[0]
  child.push({ id: init.id, result: { userAgent: 'bizgraph/0.162.0', platformOs: 'macos' } })
  const client = await ready
  return { client, child, approvals }
}

/** 让客户端把 `thread/start` 发出来并回一个 thread。 */
async function startThreadRound(child: FakeChild, client: CodexAppServerClient) {
  const pending = client.startThread({ cwd: '/tmp/wd' })
  await Promise.resolve()
  const frame = child.written.at(-1) as { id: number }
  child.push({
    id: frame.id,
    result: {
      thread: { id: 'th_1' },
      model: 'gpt-5.1-codex',
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite' },
    },
  })
  return pending
}

describe('mapItem：v2 → SDK 方言', () => {
  it('commandExecution 的 aggregatedOutput 换成 output', () => {
    expect(
      mapItem({ id: 'c1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\n', status: 'completed' }),
    ).toEqual({ id: 'c1', type: 'command_execution', command: 'ls', output: 'a\n', status: 'completed' })
  })

  it('agentMessage 换成 agent_message', () => {
    expect(mapItem({ id: 'm1', type: 'agentMessage', text: 'hi' })).toEqual({
      id: 'm1',
      type: 'agent_message',
      text: 'hi',
    })
  })

  it('fileChange / mcpToolCall 的字段原样带过（归一化器按 status 判失败）', () => {
    expect(mapItem({ id: 'f1', type: 'fileChange', changes: [{ path: '/a.ts', kind: 'modify' }], status: 'failed' }))
      .toMatchObject({ type: 'file_change', changes: [{ path: '/a.ts', kind: 'modify' }], status: 'failed' })
    expect(
      mapItem({ id: 't1', type: 'mcpToolCall', server: 'sentry', tool: 'search', status: 'failed', error: { message: 'no' } }),
    ).toMatchObject({ type: 'mcp_tool_call', server: 'sentry', tool: 'search', status: 'failed' })
  })

  it('未知 item 只留类型，不猜字段', () => {
    expect(mapItem({ id: 'x', type: 'reasoning', content: ['…'] })).toEqual({ id: 'x', type: 'reasoning' })
  })
})

describe('toCodexStreamEvent：通知 → 归一化器事件', () => {
  it('thread/started 带 thread_id', () => {
    expect(toCodexStreamEvent({ method: 'thread/started', params: { thread: { id: 'th_1' } } })).toEqual({
      type: 'thread.started',
      thread_id: 'th_1',
    })
  })

  it('turn/completed 只有 status=completed 才算完成，并带 usage', () => {
    expect(
      toCodexStreamEvent(
        { method: 'turn/completed', params: { turn: { status: 'completed' } } },
        { input_tokens: 10, output_tokens: 2 },
      ),
    ).toEqual({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })
  })

  it('turn/completed 的 failed/interrupted 翻成 turn.failed，绝不冒充完成', () => {
    expect(
      toCodexStreamEvent({
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { message: 'model overloaded' } } },
      }),
    ).toEqual({ type: 'turn.failed', error: { message: 'model overloaded' } })

    expect(
      toCodexStreamEvent({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }),
    ).toEqual({ type: 'turn.failed', error: { message: 'codex turn interrupted' } })
  })

  it('inProgress 不是终态，返回 null', () => {
    expect(toCodexStreamEvent({ method: 'turn/completed', params: { turn: { status: 'inProgress' } } })).toBeNull()
  })

  it('不认识的通知返回 null（C5 容错）', () => {
    expect(toCodexStreamEvent({ method: 'remoteControl/status/changed', params: {} })).toBeNull()
  })
})

describe('approvalToToolCall / buildApprovalReply', () => {
  const commandRequest: CodexApprovalRequest = {
    requestId: 0,
    method: 'item/commandExecution/requestApproval',
    command: '/bin/zsh -lc \'echo hi\'',
    cwd: '/tmp/wd',
    reason: 'sandbox rejected',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'hi'] } }, 'cancel'],
    raw: {},
  }

  it('命令审批必须映射成 bash —— 否则 bash 策略层整层失效', () => {
    // 名字叫 command_execution 的话审批卡照样弹，但只读白名单、危险命令判定、
    // exec 面 literal 收敛全都挂在 bashPolicyForTool（只认 'bash'）上。
    expect(approvalToToolCall(commandRequest)).toEqual({
      toolName: 'bash',
      input: { command: '/bin/zsh -lc \'echo hi\'', cwd: '/tmp/wd', reason: 'sandbox rejected' },
    })
  })

  it('放行回 accept', () => {
    expect(buildApprovalReply('allow', commandRequest)).toEqual({ decision: 'accept' })
  })

  it('命令审批没有 decline 选项时，拒绝只能回 cancel（实机 availableDecisions 就是这三种）', () => {
    expect(buildApprovalReply('deny', commandRequest)).toEqual({ decision: 'cancel' })
  })

  it('文件变更审批有 decline 时优先 decline（模型还能继续干别的）', () => {
    const fileRequest: CodexApprovalRequest = {
      requestId: 1,
      method: 'item/fileChange/requestApproval',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      raw: {},
    }
    expect(buildApprovalReply('deny', fileRequest)).toEqual({ decision: 'decline' })
  })

  it('权限审批的回执是「给多少权限」，不是 decision', () => {
    const permissions: CodexApprovalRequest = {
      requestId: 2,
      method: 'item/permissions/requestApproval',
      raw: {},
    }
    expect(buildApprovalReply('allow', permissions)).toEqual({ permissions: {}, scope: 'turn' })
    expect(buildApprovalReply('deny', permissions)).toMatchObject({ scope: 'turn' })
  })
})

describe('CodexAppServerClient', () => {
  it('initialize 必须首发，thread/start 带上 on-request 与 workspace-write', async () => {
    const { client, child } = await startClient()
    expect(child.written[0]).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'bizgraph' } } })

    const thread = await startThreadRound(child, client)
    expect(child.written.at(-1)).toMatchObject({
      method: 'thread/start',
      params: { cwd: '/tmp/wd', approvalPolicy: 'on-request', sandbox: 'workspace-write', ephemeral: true },
    })
    expect(thread.threadId).toBe('th_1')
    await client.dispose()
  })

  it('turn/start 的 input 是 [{type:text,text}]', async () => {
    const { client, child } = await startClient()
    await startThreadRound(child, client)

    const pending = client.startTurn({ threadId: 'th_1', text: '跑个 echo' })
    await Promise.resolve()
    const frame = child.written.at(-1) as { id: number; params: Record<string, unknown> }
    expect(frame.params).toMatchObject({ threadId: 'th_1', input: [{ type: 'text', text: '跑个 echo' }] })
    child.push({ id: frame.id, result: { turn: { id: 'tu_1' } } })
    expect(await pending).toEqual({ turnId: 'tu_1' })
    await client.dispose()
  })

  it('服务端请求 id=0 的审批能被接住，回执原样带回同一个 id', async () => {
    const { client, child, approvals } = await startClient({
      onApproval: (request) => client.replyApproval(request.requestId, buildApprovalReply('allow', request)),
    })

    child.push({
      jsonrpc: '2.0',
      id: 0,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'th_1',
        turnId: 'tu_1',
        itemId: 'call_1',
        command: '/bin/zsh -lc \'echo hi\'',
        cwd: '/tmp/wd',
        reason: 'sandbox rejected',
        availableDecisions: ['accept', 'cancel'],
      },
    })
    await Promise.resolve()

    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ requestId: 0, command: '/bin/zsh -lc \'echo hi\'', reason: 'sandbox rejected' })
    expect(child.written.at(-1)).toEqual({ jsonrpc: '2.0', id: 0, result: { decision: 'accept' } })
    await client.dispose()
  })

  it('未处理的反向请求回 -32601，不让模型以为「问了没人答」', async () => {
    const { client, child } = await startClient()
    child.push({ jsonrpc: '2.0', id: 7, method: 'item/tool/requestUserInput', params: {} })
    await Promise.resolve()
    expect(child.written.at(-1)).toMatchObject({ id: 7, error: { code: -32601 } })
    await client.dispose()
  })

  it('事件流只吐翻译后的事件，tokenUsage 记账但不外发', async () => {
    const { client, child } = await startClient()
    const events: unknown[] = []
    client.onEvent((event) => events.push(event))

    child.push({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 100, outputTokens: 5 } } } })
    child.push({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: '好了' } } })
    await Promise.resolve()

    expect(events).toEqual([{ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '好了' } }])
    await client.dispose()
  })

  it('turn.completed 的 usage 是差分（total 是线程累计，不是单回合）', async () => {
    const { client, child } = await startClient()
    const events: Array<{ type: string; usage?: { input_tokens?: number; output_tokens?: number } }> = []
    client.onEvent((event) => events.push(event))

    // 线程前面的累计（比如上一轮留下的）
    child.push({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 900, outputTokens: 40 } } } })
    child.push({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    await Promise.resolve()

    expect(events[0]).toEqual({ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 40 } })
    await client.dispose()
  })

  it('配置加载失败（-32600）要原样抬出服务端说明，不能只剩「没响应」', async () => {
    const { child, spawnImpl } = fakeSpawn()
    const ready = CodexAppServerClient.start({
      plan: { command: 'codex', args: ['app-server'], cwd: '/tmp/wd', env: {} },
      spawnImpl,
      requestTimeoutMs: 2_000,
      onApproval: () => {},
    })
    await Promise.resolve()
    const init = child.written[0]
    child.push({ id: init.id, result: { userAgent: 'bizgraph/0.135.0' } })
    const client = await ready

    const pending = client.startThread({ cwd: '/tmp/wd' })
    await Promise.resolve()
    const frame = child.written.at(-1) as { id: number }
    child.push({
      id: frame.id,
      error: {
        code: -32600,
        message:
          'failed to load configuration: /Users/u/.codex/config.toml:3:26: unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`',
      },
    })

    await expect(pending).rejects.toThrow(/unknown variant `max`/)
    await client.dispose()
  })

  it('dispose 会 SIGTERM 子进程（宿主按 pid 回收）', async () => {
    const { client, child } = await startClient()
    const spy = vi.spyOn(child, 'kill')
    await client.dispose()
    expect(spy).toHaveBeenCalledWith('SIGTERM')
  })
})
