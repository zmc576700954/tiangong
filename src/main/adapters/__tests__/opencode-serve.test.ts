/**
 * `opencode serve` 客户端（G7-3 的「问了再放行」通道）。
 *
 * CI 上没有 opencode 二进制，所以这里全部用注入的假进程 + 假传输验证协议胶水：
 * 监听地址解析、权限决策（allow/deny/无钩子/钩子抛错）、事件方言翻译、
 * 回合请求体。真实链路另由 v3.31 的实机记录背书（见蓝图 I.2 G7-3 行）。
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  OpencodeServeClient,
  bridgePermission,
  buildServePermissionRules,
  parseModel,
  permissionToToolCall,
  toStreamEvent,
  type ServeEvent,
  type ServePermissionAsked,
  type ServeTransport,
} from '../opencode-serve'

/** 只实现 `start()` 用得到的那点进程语义。 */
class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} })
  stderr = new Readable({ read() {} })
  pid = 4321
  exitCode: number | null = null
  killed = false
  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }
}

function fakeSpawn(banner = 'opencode server listening on http://127.0.0.1:41234\n') {
  const child = new FakeChild()
  const spawnImpl = vi.fn(() => {
    // 下一拍再吐 banner，模拟真实进程的启动时序（同步吐会掩盖「等」的逻辑）
    setTimeout(() => child.stdout.push(banner), 0)
    // 假进程只实现 start() 用到的那几项，转成 ChildProcess 只为过类型
    return child as unknown as ChildProcess
  })
  return { child, spawnImpl }
}

function fakeTransport() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const handlers: Array<(event: ServeEvent) => void> = []
  const responses: Record<string, unknown> = {}
  const transport: ServeTransport = {
    async request(method, path, body) {
      // 记录时去掉 `?directory=`：断言关心的是打到哪个接口
      calls.push({ method, path: path.split('?')[0], body })
      return responses[path.split('?')[0]] ?? null
    },
    subscribe(handler) {
      handlers.push(handler)
    },
  }
  return {
    transport,
    calls,
    responses,
    emit: (event: ServeEvent) => handlers.forEach((handler) => handler(event)),
  }
}

const ASKED: ServePermissionAsked = {
  id: 'per_1',
  sessionID: 'ses_1',
  permission: 'bash',
  patterns: ['echo hi'],
  metadata: { command: 'echo hi' },
  tool: { callID: 'call_1', messageID: 'msg_1' },
}

describe('parseModel', () => {
  it('拆成 providerID / modelID', () => {
    expect(parseModel('opencode/deepseek-v4.1-flash-free')).toEqual({
      providerID: 'opencode',
      modelID: 'deepseek-v4.1-flash-free',
    })
  })

  it('裸模型名返回 undefined —— serve 只认 provider 前缀', () => {
    expect(parseModel('deepseek-v4.1-flash-free')).toBeUndefined()
    expect(parseModel('/x')).toBeUndefined()
    expect(parseModel('opencode/')).toBeUndefined()
    expect(parseModel(undefined)).toBeUndefined()
  })
})

describe('buildServePermissionRules', () => {
  const rules = buildServePermissionRules()

  it('执行与写类一律 ask（宿主必须看到它们）', () => {
    for (const permission of ['bash', 'edit', 'write', 'patch']) {
      expect(rules.find((rule) => rule.permission === permission)?.action).toBe('ask')
    }
  })

  it('读类放行：读文件弹审批会把审批页变成噪音', () => {
    expect(rules.find((rule) => rule.permission === 'read')?.action).toBe('allow')
  })

  it('catch-all ask 兜底在最前：MCP 工具名不在白名单里时也要进网关', () => {
    // v3.35 实测反例：只列内置工具名时，`marker_write_marker` 直接执行、零审批。
    // 顺序也有意义（后面的覆盖前面的），所以兜底必须排在最前面。
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'ask' })
  })

  it('读类白名单排在兜底之后，仍然不弹审批', () => {
    const readIndex = rules.findIndex((rule) => rule.permission === 'read')
    expect(readIndex).toBeGreaterThan(0)
    expect(rules[readIndex].action).toBe('allow')
  })
})

describe('permissionToToolCall', () => {
  it('metadata 原样传入，bash 策略才能读到 command', () => {
    expect(permissionToToolCall(ASKED)).toEqual({
      toolName: 'bash',
      input: { command: 'echo hi' },
    })
  })

  it('metadata 为空时退化成 patterns，避免策略把「没有命令」当结论', () => {
    const asked = { ...ASKED, metadata: {} }
    expect(permissionToToolCall(asked).input).toEqual({ patterns: ['echo hi'] })
  })
})

describe('toStreamEvent', () => {
  it('工具 part 原样透传成 tool_use（两个方言形状一致）', () => {
    const part = { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'ok' } }
    expect(toStreamEvent({ type: 'message.part.updated', properties: { part } })).toEqual({
      type: 'tool_use',
      part,
    })
  })

  it('流式中间态（没有 time.end）不发 text —— 否则一句话会被拆成十几条', () => {
    const part = { type: 'text', text: '正在' }
    expect(toStreamEvent({ type: 'message.part.updated', properties: { part } })).toBeNull()
    const done = { type: 'text', text: '写完了', time: { start: 1, end: 2 } }
    expect(toStreamEvent({ type: 'message.part.updated', properties: { part: done } })).toMatchObject({
      type: 'text',
    })
  })

  it('会话错误翻译成 error', () => {
    const error = { name: 'UnknownError', data: { message: 'boom' } }
    expect(toStreamEvent({ type: 'session.error', properties: { error } })).toEqual({ type: 'error', error })
  })

  it('无关事件忽略', () => {
    expect(toStreamEvent({ type: 'server.heartbeat' })).toBeNull()
  })
})

describe('bridgePermission', () => {
  const signal = new AbortController().signal

  it('用户放行 → once', async () => {
    const decide = vi.fn().mockResolvedValue({ behavior: 'allow' as const })
    await expect(bridgePermission(ASKED, decide, signal)).resolves.toEqual({ reply: 'once' })
    // 钩子拿到的必须是可执行的入参，不是「permission 类别」本身
    expect(decide).toHaveBeenCalledWith('bash', { command: 'echo hi' }, { signal, toolUseID: 'call_1' })
  })

  it('用户拒绝 → reject + 原话', async () => {
    const decide = vi.fn().mockResolvedValue({ behavior: 'deny' as const, message: '这条命令会删库' })
    await expect(bridgePermission(ASKED, decide, signal)).resolves.toEqual({
      reply: 'reject',
      message: '这条命令会删库',
    })
  })

  it('没有钩子 → 拒绝（不替用户放行）', async () => {
    const result = await bridgePermission(ASKED, undefined, signal)
    expect(result.reply).toBe('reject')
    expect(result.message).toContain('没有安装审批网关')
  })

  it('钩子抛错 → 拒绝，且原因不被吞', async () => {
    const decide = vi.fn().mockRejectedValue(new Error('gateway down'))
    const result = await bridgePermission(ASKED, decide, signal)
    expect(result.reply).toBe('reject')
    expect(result.message).toContain('gateway down')
  })
})

describe('OpencodeServeClient', () => {
  it('从 stdout 解析监听地址，会话/消息/权限三处请求体都对', async () => {
    const { spawnImpl, child } = fakeSpawn()
    const fake = fakeTransport()
    fake.responses['/session'] = { id: 'ses_new' }

    const client = await OpencodeServeClient.start({
      plan: { command: 'opencode', args: ['serve'], cwd: '/tmp', env: {} },
      spawnImpl,
      createTransport: () => fake.transport,
      pickPort: async () => 41234,
    })
    expect(client.baseUrl).toBe('http://127.0.0.1:41234')
    expect(client.pid).toBe(4321)

    await client.createSession({ directory: '/tmp/proj', model: 'opencode/x-free' })
    await client.prompt('ses_new', '读一下 note.txt', 'opencode/x-free')
    await client.replyPermission('per_1', 'reject', '不许跑')

    const byPath = Object.fromEntries(fake.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]))
    // ⚠️ 两个接口的 model 形状不同：建会话 {id, providerID}、发消息 {providerID, modelID}。
    // 发错只回一个 `{"_tag":"BadRequest"}`，不知道错在哪个字段。
    expect(byPath['/session']).toMatchObject({
      permission: expect.any(Array),
      model: { id: 'x-free', providerID: 'opencode' },
    })
    expect(byPath['/session/ses_new/message']).toMatchObject({
      parts: [{ type: 'text', text: '读一下 note.txt' }],
    })
    expect(byPath['/permission/per_1/reply']).toEqual({ reply: 'reject', message: '不许跑' })

    await client.dispose()
    expect(child.killed).toBe(true)
  })

  it('服务起不来时报错，而不是静静降级', async () => {
    const child = new FakeChild()
    const spawnImpl = () => {
      setTimeout(() => child.emit('exit', 3), 0)
      return child as unknown as ChildProcess
    }

    await expect(
      OpencodeServeClient.start({
        plan: { command: 'opencode', args: ['serve'], cwd: '/tmp', env: {} },
        spawnImpl,
        createTransport: () => fakeTransport().transport,
        pickPort: async () => 41234,
      }),
    ).rejects.toThrow(/启动即退出/)
  })

  it('订阅收到的事件原样交给调用方（由适配器做翻译）', async () => {
    const { spawnImpl } = fakeSpawn()
    const fake = fakeTransport()
    const client = await OpencodeServeClient.start({
      plan: { command: 'opencode', args: ['serve'], cwd: '/tmp', env: {} },
      spawnImpl,
      createTransport: () => fake.transport,
      pickPort: async () => 41234,
    })
    const seen: string[] = []
    const off = client.subscribe((event) => seen.push(event.type))
    fake.emit({ type: 'permission.asked', properties: { id: 'per_1' } })
    fake.emit({ type: 'session.idle', properties: {} })
    off()
    expect(seen).toEqual(['permission.asked', 'session.idle'])
    await client.dispose()
  })
})
