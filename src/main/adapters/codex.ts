/**
 * Codex CLI 适配器（单次执行模式）
 *
 * Codex CLI 是单次执行工具：启动、处理 prompt、输出结果、退出。
 * 每次 sendCommand() 启动新进程，传入完整 prompt。
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

const execFileAsync = promisify(execFile)

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('codex', ['--version'])
      return true
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('codex')
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

    const args = [
      '-a', 'auto-edit',
      '--approval-mode', 'auto-edit',
      '-m', 'gpt-4o',
      '--',
      fullPrompt.replace(/^-/gm, '\\-'),
    ]

    const proc = spawn('codex', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await this.runOneShot(proc)
  }
}
