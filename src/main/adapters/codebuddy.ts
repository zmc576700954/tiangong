/**
 * CodeBuddy 适配器（CLI 模式）
 *
 * CodeBuddy 是腾讯出品的 AI 编码助手。
 * npm: @tencent-ai/codebuddy-code, CLI 命令: codebuddy / cbc
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'

const execFileAsync = promisify(execFile)

export class CodeBuddyAdapter extends BaseAdapter {
  readonly name = 'codebuddy'
  readonly version = '1.0.0'

  protected logger = createLogger('CodeBuddyAdapter')

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('codebuddy', ['--version'])
      return true
    } catch {
      // Try alternate command 'cbc'
      try {
        await execFileAsync('cbc', ['--version'])
        return true
      } catch {
        this.logger.warn('codebuddy/cbc CLI not found')
        return false
      }
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('cbuddy')
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

    const proc = spawn('codebuddy', args, {
      cwd: session.config.workingDirectory || undefined,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id, { parseFileChanges: false })
  }
}
