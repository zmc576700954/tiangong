/**
 * OpenCode 适配器（单次执行模式）
 *
 * OpenCode CLI 是单次执行工具：启动、处理 prompt、输出结果、退出。
 * 每次 sendCommand() 启动新进程，传入完整 prompt。
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

const execFileAsync = promisify(execFile)

export class OpenCodeAdapter extends BaseAdapter {
  readonly name = 'opencode'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('opencode', ['--version'])
      return true
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = `opencode-${randomUUID().replace(/-/g, '')}`
    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const scopePrompt = this.buildScopePrompt(session.config)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    const args: string[] = [
      '--',
      fullPrompt.replace(/^-/gm, '\\-'),
    ]

    const proc = spawn('opencode', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await this.runOneShot(proc, { parseFileChanges: false })
  }
}
