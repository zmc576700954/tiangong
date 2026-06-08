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

const execFileAsync = promisify(execFile)

export class CursorAdapter extends BaseAdapter {
  readonly name = 'cursor'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('cursor', ['agent', '--version'])
      return true
    } catch {
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
    const scopePrompt = this.buildScopePrompt(session.config, session.resolvedContexts)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    const args = ['agent', '-p', fullPrompt]

    if (session.config.resumeSessionId) {
      args.push('--resume', session.config.resumeSessionId)
    }

    const proc = spawn('cursor', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id)
  }
}
