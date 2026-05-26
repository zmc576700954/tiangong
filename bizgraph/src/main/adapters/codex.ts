/**
 * Codex CLI 适配器 (OpenAI)
 * 通过 stdin/stdout 与 Codex CLI 非交互式模式通信
 */

import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { exec } from 'node:child_process'
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'

const execAsync = promisify(exec)

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      // 10 秒超时，防止进程卡死导致 Promise 永久挂起
      await execAsync('codex --version', { timeout: 10000 })
      return true
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // Codex CLI 参数
    // -a auto-edit: 自动编辑模式
    // --approval-mode auto-edit: 自动批准编辑
    // -m: 指定模型
    const args = [
      '-a', 'auto-edit',
      '--approval-mode', 'auto-edit',
      '-m', 'gpt-4o',
    ]

    // 注入范围上下文
    const scopePrompt = this.buildScopePrompt(config)
    const initialPrompt = `${scopePrompt}\n\n请根据以上约束开始工作。`

    args.push(initialPrompt)

    const proc = spawn('codex', args, {
      cwd: config.workingDirectory,
      env: {
        ...process.env,
        BIZGRAPH_SESSION_ID: sessionId,
        BIZGRAPH_ALLOWED_FILES: JSON.stringify(config.allowedFiles),
        BIZGRAPH_FORBIDDEN_FILES: JSON.stringify(config.forbiddenFiles),
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

    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const proc = session.process
    if (!proc.stdin || proc.stdin.writableEnded) {
      throw new Error('Codex process stdin is not writable')
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
      this.parseFileChanges(text)
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
        data: `Codex exited with code ${code ?? 'unknown'}`,
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

  private parseFileChanges(text: string): void {
    const patterns = [
      /(?:edit|modify|update|create|add|delete|remove)\s+(?:file\s+)?[`'"]?([\w\/\-.]+\.(?:ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml))[`'"]?/gi,
    ]

    for (const pattern of patterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const filePath = match[1]
        const changeType = this.inferChangeType(match[0])
        this.emitOutput({
          type: 'file_change',
          data: `${changeType}: ${filePath}`,
          timestamp: Date.now(),
          filePath,
          changeType,
        })
      }
    }
  }

  private inferChangeType(actionText: string): 'add' | 'modify' | 'delete' {
    const lower = actionText.toLowerCase()
    if (lower.includes('create') || lower.includes('add')) return 'add'
    if (lower.includes('delete') || lower.includes('remove')) return 'delete'
    return 'modify'
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

