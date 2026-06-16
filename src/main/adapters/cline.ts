/**
 * Cline 适配器（CLI 模式）
 *
 * Cline 是开源 AI 编码代理，支持交互式终端和 headless 模式。
 * npm: cline, CLI 命令: cline
 * 非交互模式: cline "prompt"  |  cline --json "prompt"
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'

const execFileAsync = promisify(execFile)

export class ClineAdapter extends BaseAdapter {
  readonly name = 'cline'
  readonly version = '1.0.0'

  protected logger = createLogger('ClineAdapter')

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('cline', ['--version'])
      return true
    } catch {
      this.logger.warn('cline CLI not found')
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('cline')
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

    const args: string[] = [fullPrompt]

    const proc = spawn('cline', args, {
      cwd: session.config.workingDirectory || undefined,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id, { parseFileChanges: false })
  }
}
