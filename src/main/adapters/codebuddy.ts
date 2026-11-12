/**
 * CodeBuddy 适配器（CLI 模式）
 *
 * CodeBuddy 是腾讯出品的 AI 编码助手。
 * npm: @tencent-ai/codebuddy-code, CLI 命令: codebuddy / cbc
 */

import { spawn } from 'node:child_process'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'
import { probeCliInstalled } from './cli-probe'

export class CodeBuddyAdapter extends BaseAdapter {
  readonly name = 'codebuddy'
  readonly version = '1.0.0'

  protected logger = createLogger('CodeBuddyAdapter')

  async checkInstalled(): Promise<boolean> {
    if (await probeCliInstalled('codebuddy', ['--version'])) return true
    // 备用命令
    if (await probeCliInstalled('cbc', ['--version'])) return true
    this.logger.warn('codebuddy/cbc CLI not found')
    return false
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
    const fullPrompt = this.buildFullPrompt(session, command)

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
