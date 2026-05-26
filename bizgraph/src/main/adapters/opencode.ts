/**
 * OpenCode 适配器
 * 通过 stdin/stdout 与 OpenCode CLI 非交互式模式通信
 */

import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { exec } from 'node:child_process'
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

const execAsync = promisify(exec)

export class OpenCodeAdapter extends BaseAdapter {
  readonly name = 'opencode'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      // 10 秒超时，防止进程卡死导致 Promise 永久挂起
      await execAsync('opencode --version', { timeout: 10000 })
      return true
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // OpenCode CLI 参数（根据实际 CLI 文档调整）
    const args = []

    // 注入范围上下文
    const scopePrompt = this.buildScopePrompt(config)

    const proc = spawn('opencode', args, {
      cwd: config.workingDirectory,
      env: {
        ...process.env,
        BIZGRAPH_SESSION_ID: sessionId,
        BIZGRAPH_CONTEXT: JSON.stringify(config),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session: AgentSession = {
      id: sessionId,
      process: proc,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }

    this.registerSession(session)
    this.attachOutputHandlers(session)

    // 发送初始提示
    if (proc.stdin && !proc.stdin.writableEnded) {
      proc.stdin.write(scopePrompt + '\n')
    }

    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const proc = session.process
    if (!proc.stdin || proc.stdin.writableEnded) {
      throw new Error('OpenCode process stdin is not writable')
    }

    const prompt = this.buildCommandPrompt(command)
    proc.stdin.write(prompt + '\n')
  }

  protected async doTerminate(session: AgentSession): Promise<void> {
    const proc = session.process
    if (!proc.killed) {
      proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 5000)
        proc.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
  }

  private attachOutputHandlers(session: AgentSession): void {
    const { process: proc } = session

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      this.emitOutput({
        type: 'stdout',
        data: text,
        timestamp: Date.now(),
      })
    })

    proc.stderr?.on('data', (data: Buffer) => {
      this.emitOutput({
        type: 'stderr',
        data: data.toString('utf-8'),
        timestamp: Date.now(),
      })
    })

    proc.on('exit', (code) => {
      this.emitOutput({
        type: 'complete',
        data: `OpenCode exited with code ${code ?? 'unknown'}`,
        timestamp: Date.now(),
      })
    })

    proc.on('error', (err) => {
      this.emitOutput({
        type: 'error',
        data: err.message,
        timestamp: Date.now(),
      })
    })
  }

  private buildCommandPrompt(command: AgentCommand): string {
    const typeLabels: Record<string, string> = {
      implement: '请实现以下功能',
      fix_bug: '请修复以下 Bug',
      refactor: '请重构以下代码',
      add_test: '请为以下功能添加测试',
    }

    return `${typeLabels[command.type] ?? '请完成以下任务'}：\n${command.description}`
  }
}

