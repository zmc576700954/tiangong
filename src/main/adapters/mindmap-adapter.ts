/**
 * MindMap Adapter
 *
 * 专门为 MindMapAgent 设计的内部适配器。
 * 将思维导图生成操作纳入统一的 Agent 生命周期管理，
 * 复用 BaseAdapter 的安全机制（buildSafeEnv、输出广播、协议支持）。
 *
 * 与 ClaudeCodeAdapter 的区别：
 * - 不使用 SDK，直接 spawn claude CLI（与 runClaude 一致）
 * - 单次执行模式（one-shot），不支持多轮对话
 * - 输出作为完整文本块返回，而非流式 message
 */

import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import type { ChildProcess } from 'node:child_process'
import { createLogger } from '../shared/logger'
import { runClaude } from '../mindmap-agent/claude-runner'

export class MindMapAdapter extends BaseAdapter {
  readonly name = 'mindmap-internal'
  readonly version = '1.0.0'

  protected logger = createLogger('MindMapAdapter')

  /** 运行中的 MindMap 会话 AbortController，用于 doTerminate 取消 */
  private activeControllers = new Map<string, AbortController>()

  async checkInstalled(): Promise<boolean> {
    try {
      const { spawnSync } = await import('node:child_process')
      const result = spawnSync('claude', ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      })
      return result.status === 0
    } catch {
      this.logger.warn('claude CLI not found')
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('mindmap')
    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const scopePrompt = this.buildScopePromptForSession(session)
    const fullPrompt = scopePrompt
      ? `${scopePrompt}\n\n---\n\n${command.description}`
      : command.description

    let sessionEnded = false
    try {
      // 使用 BaseAdapter 的输出处理器模式，解析文件变更
      this.emitOutput({
        type: 'stdout',
        data: `[MindMap] 开始生成，工作目录: ${session.config.workingDirectory}`,
        timestamp: Date.now(),
      })

      const controller = new AbortController()
      this.activeControllers.set(session.id, controller)

      const result = await runClaude(fullPrompt, {
        cwd: session.config.workingDirectory,
        timeoutMs: 300_000,
        outputFormat: 'text',
      })

      this.activeControllers.delete(session.id)

      if (result.timedOut) {
        this.emitOutput({
          type: 'error',
          data: 'MindMap 生成超时（5分钟）',
          timestamp: Date.now(),
          errorCode: 'TIMEOUT',
        })
        this.emit('sessionEnded', session.id, 'error')
        sessionEnded = true
        return
      }

      if (result.exitCode !== 0) {
        const errorMsg = result.stderr || `Claude 进程退出码: ${result.exitCode}`
        this.emitOutput({
          type: 'error',
          data: `MindMap 生成失败: ${errorMsg}`,
          timestamp: Date.now(),
          errorCode: 'AGENT_CRASH',
        })
        this.emit('sessionEnded', session.id, 'crash')
        sessionEnded = true
        return
      }

      // 输出 stdout 内容（即 AI 生成的 JSON/文本）
      if (result.stdout) {
        this.emitOutput({
          type: 'stdout',
          data: result.stdout,
          timestamp: Date.now(),
        })
      }

      this.emitOutput({
        type: 'complete',
        data: 'MindMap 生成完成',
        timestamp: Date.now(),
      })
      this.emit('sessionEnded', session.id, 'success')
      sessionEnded = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutput({
        type: 'error',
        data: `MindMap 适配器错误: ${msg}`,
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
      this.emit('sessionEnded', session.id, 'error')
      sessionEnded = true
    } finally {
      if (!sessionEnded) {
        this.emitOutput({
          type: 'error',
          data: 'MindMap 适配器异常退出（未预期的代码路径）',
          timestamp: Date.now(),
          errorCode: 'AGENT_CRASH',
        })
        this.emit('sessionEnded', session.id, 'error')
      }
    }
  }

  protected override async doTerminate(_session: AgentSession, _proc?: ChildProcess): Promise<void> {
    const controller = this.activeControllers.get(_session.id)
    if (controller) {
      controller.abort()
      this.activeControllers.delete(_session.id)
    }
    await super.doTerminate(_session, _proc)
  }
}
