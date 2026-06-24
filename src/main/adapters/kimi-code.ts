/**
 * Kimi Code 适配器（CLI 模式）
 *
 * Kimi Code 是 Moonshot AI 出品的终端编码代理。
 * npm: @moonshot-ai/kimi-code, CLI 命令: kimi
 * 非交互模式: kimi -p "prompt"
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { createLogger } from '../shared/logger'

const execFileAsync = promisify(execFile)

export class KimiCodeAdapter extends BaseAdapter {
  readonly name = 'kimi-code'
  readonly version = '1.0.0'

  protected logger = createLogger('KimiCodeAdapter')

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('kimi', ['--version'])
      return true
    } catch {
      this.logger.warn('kimi CLI not found')
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('kimi')
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

    const args = ['-p']

    const proc = spawn('kimi', args, {
      cwd: session.config.workingDirectory || undefined,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 通过 stdin 传入 prompt，避免超出 OS 命令行长度限制和参数注入风险
    if (proc.stdin && !proc.stdin.writableEnded) {
      proc.stdin.on('error', (err) => {
        this.logger.warn(`stdin write error for session ${session.id}: ${err.message}`)
      })
      proc.stdin.write(fullPrompt)
      proc.stdin.end()
    }

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id, { parseFileChanges: false })
  }
}
