/**
 * Qwen Code 适配器（CLI 模式）
 *
 * Qwen Code 是阿里云出品的开源 AI 终端编码代理。
 * npm: @qwen-code/qwen-code, CLI 命令: qwen
 * 非交互模式: qwen -p "prompt"
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'

const execFileAsync = promisify(execFile)

export class QwenCodeAdapter extends BaseAdapter {
  readonly name = 'qwen-code'
  readonly version = '1.0.0'

  protected logger = createLogger('QwenCodeAdapter')

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('qwen', ['--version'])
      return true
    } catch {
      this.logger.warn('qwen CLI not found')
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('qwen')
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

    const args = ['-p', fullPrompt]

    const proc = spawn('qwen', args, {
      cwd: session.config.workingDirectory || undefined,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id, { parseFileChanges: false })
  }
}
