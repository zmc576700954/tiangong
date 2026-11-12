/**
 * Qoder 适配器（CLI 模式）
 *
 * Qoder 是基于 Gemini 的 AI 编码助手。
 * npm: @qoder-ai/qodercli, CLI 命令: qodercli
 */

import { spawn } from 'node:child_process'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'
import { probeCliInstalled } from './cli-probe'

export class QoderAdapter extends BaseAdapter {
  readonly name = 'qoder'
  readonly version = '1.0.0'

  protected logger = createLogger('QoderAdapter')

  async checkInstalled(): Promise<boolean> {
    if (await probeCliInstalled('qodercli', ['--version'])) return true
    this.logger.warn('qodercli CLI not found')
    return false
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('qoder')
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

    const proc = spawn('qodercli', args, {
      cwd: session.config.workingDirectory || undefined,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id, { parseFileChanges: false })
  }
}
