import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendPromptViaAgent } from '../agent/send-and-wait'
import type { AgentOutput, AgentSessionConfig } from '@shared/types'
import type { AgentManager } from '../agent/agent-manager'

function createMockAgentManager(): AgentManager & { __emitOutput: (output: AgentOutput) => void } {
  const listeners: Array<(output: AgentOutput) => void> = []
  return {
    startSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-123' }),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    addOutputListener: vi.fn().mockImplementation((handler: (output: AgentOutput) => void) => {
      listeners.push(handler)
    }),
    removeOutputListener: vi.fn().mockImplementation((handler: (output: AgentOutput) => void) => {
      const idx = listeners.indexOf(handler)
      if (idx >= 0) listeners.splice(idx, 1)
    }),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    // Helper: emit output to all listeners
    __emitOutput(output: AgentOutput) {
      for (const listener of [...listeners]) {
        listener(output)
      }
    },
  } as unknown as AgentManager & { __emitOutput: (output: AgentOutput) => void }
}

describe('sendPromptViaAgent', () => {
  let manager: ReturnType<typeof createMockAgentManager>

  beforeEach(() => {
    manager = createMockAgentManager()
  })

  it('正常完成 → 返回收集的输出', async () => {
    // sendCommand 触发后模拟输出
    (manager.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // 异步触发输出
      setTimeout(() => {
        manager.__emitOutput({ type: 'stdout', data: 'hello', timestamp: 1 })
        manager.__emitOutput({ type: 'stdout', data: ' world', timestamp: 2 })
        manager.__emitOutput({ type: 'complete', data: '', timestamp: 3 })
      }, 10)
      return Promise.resolve()
    })

    const result = await sendPromptViaAgent(manager, '/project', 'test prompt', { timeoutMs: 5000 })
    expect(result).toBe('hello\n world')
    expect(manager.startSession).toHaveBeenCalledWith('claude-code', expect.objectContaining({
      workingDirectory: '/project',
      nodeTitle: '思维导图生成',
    }))
    expect(manager.removeOutputListener).toHaveBeenCalled()
  })

  it('file_change 类型也被收集', async () => {
    (manager.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
      setTimeout(() => {
        manager.__emitOutput({ type: 'file_change', data: 'file content', timestamp: 1 })
        manager.__emitOutput({ type: 'complete', data: '', timestamp: 2 })
      }, 10)
      return Promise.resolve()
    })

    const result = await sendPromptViaAgent(manager, '/p', 'prompt', { timeoutMs: 5000 })
    expect(result).toBe('file content')
  })

  it('error 输出 → reject', async () => {
    (manager.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
      setTimeout(() => {
        manager.__emitOutput({ type: 'error', data: 'something broke', timestamp: 1 })
      }, 10)
      return Promise.resolve()
    })

    await expect(sendPromptViaAgent(manager, '/p', 'prompt', { timeoutMs: 5000 }))
      .rejects.toThrow('something broke')
  })

  it('sendCommand 失败 → reject', async () => {
    (manager.sendCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('send failed'))

    await expect(sendPromptViaAgent(manager, '/p', 'prompt', { timeoutMs: 5000 }))
      .rejects.toThrow('send failed')
  })

  it('超时但有部分输出 → resolve 已有输出', async () => {
    (manager.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
      setTimeout(() => {
        manager.__emitOutput({ type: 'stdout', data: 'partial output', timestamp: 1 })
      }, 10)
      // 不发送 complete，触发超时
      return Promise.resolve()
    })

    const result = await sendPromptViaAgent(manager, '/p', 'prompt', { timeoutMs: 200 })
    expect(result).toBe('partial output')
    expect(manager.terminateSession).toHaveBeenCalled()
  })

  it('timeout with no output should reject', async () => {
    await expect(
      sendPromptViaAgent(manager, '/p', 'prompt', { timeoutMs: 100 }),
    ).rejects.toThrow('timeout')
    expect(manager.terminateSession).toHaveBeenCalled()
  })

  it('自定义 adapterName 和 nodeTitle', async () => {
    (manager.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
      setTimeout(() => {
        manager.__emitOutput({ type: 'complete', data: '', timestamp: 1 })
      }, 10)
      return Promise.resolve()
    })

    await sendPromptViaAgent(manager, '/p', 'prompt', {
      adapterName: 'codex',
      nodeTitle: '用户模块',
      timeoutMs: 5000,
    })

    expect(manager.startSession).toHaveBeenCalledWith('codex', expect.objectContaining({
      nodeTitle: '用户模块',
    }))
  })
})
