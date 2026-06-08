/**
 * OpenCode 适配器（单次执行模式）
 *
 * OpenCode CLI 是单次执行工具：启动、处理 prompt、输出结果、退出。
 * 每次 sendCommand() 启动新进程，传入完整 prompt。
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
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
    const sessionId = generateId('opencode')
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
    const constraintSuffix = this.buildConstraintSuffix(session.config)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n${constraintSuffix}\n\n${commandPrompt}`

    const args: string[] = [
      '-p',
      fullPrompt,
      '-q',
    ]

    const proc = spawn('opencode', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.processes.set(session.id, proc)
    await this.runOneShot(proc, session.id, { parseFileChanges: false })
  }

  /**
   * 构建强制约束后缀
   * 在白名单模式下追加明确的禁止指令，增强 prompt 约束力
   */
  private buildConstraintSuffix(config: AgentSessionConfig): string {
    if (config.allowedFiles.length === 0) return ''

    return [
      '## ⚠️ 强制约束',
      `- 只能修改白名单中的文件：${config.allowedFiles.join(', ')}`,
      '- 禁止使用 Bash 命令修改白名单外的文件（如 mv、cp、sed、echo 重定向等）',
      '- 如果需要修改白名单外的文件，先向用户说明原因并请求授权',
      '',
    ].join('\n')
  }
}
