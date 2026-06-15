/**
 * Cursor CLI 适配器
 *
 * 使用 `cursor agent -p` 非交互模式。
 * 支持 --resume 实现多轮对话续接。
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'

const execFileAsync = promisify(execFile)

export class CursorAdapter extends BaseAdapter {
  readonly name = 'cursor'
  readonly version = '1.0.0'

  protected logger = createLogger('CursorAdapter')

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('cursor', ['agent', '--version'])
      return true
    } catch {
      this.logger.warn('cursor CLI not found')
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('cursor')
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
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    const args = ['agent']

    if (session.config.resumeSessionId) {
      args.push('--resume', session.config.resumeSessionId)
    }

    const proc = spawn('cursor', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 通过 stdin 传入 prompt，避免超出 OS 命令行长度限制
    proc.stdin.write(fullPrompt)
    proc.stdin.end()

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id)
  }
}
