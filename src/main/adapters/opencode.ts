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
import { createLogger } from '../shared/logger'

const execFileAsync = promisify(execFile)

export class OpenCodeAdapter extends BaseAdapter {
  readonly name = 'opencode'
  readonly version = '1.0.0'

  protected logger = createLogger('OpenCodeAdapter')

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('opencode', ['--version'])
      return true
    } catch {
      this.logger.warn('opencode CLI not found')
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
    const constraintSuffix = this.buildConstraintSuffix(session.config)

    await this.runToolAwareLoop(session, command, async (fullPrompt) => {
      const args: string[] = ['-q']

      const proc = spawn('opencode', args, {
        cwd: session.config.workingDirectory,
        env: this.buildSafeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      if (proc.stdin) {
        proc.stdin.on('error', (err) => {
          this.logger.warn(`stdin write error for session ${session.id}: ${err.message}`)
        })
      }

      const finalPrompt = constraintSuffix ? `${fullPrompt}\n${constraintSuffix}` : fullPrompt
      proc.stdin?.write(finalPrompt, (err) => {
        if (err) {
          this.logger.warn(`stdin write failed for session ${session.id}: ${err.message}`)
        }
      })
      proc.stdin?.end()

      this.processes.set(session.id, proc)

      return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        proc.stdout?.on('data', (chunk) => chunks.push(chunk))
        proc.stderr?.on('data', (chunk) => {
          this.emitOutput({ type: 'stderr', data: chunk.toString('utf-8'), timestamp: Date.now() })
        })
        proc.on('error', reject)
        proc.on('exit', (code) => {
          if (code !== null && code !== 0) {
            this.logger.warn(`opencode exited with code ${code}`)
          }
          resolve(Buffer.concat(chunks).toString('utf-8'))
        })
      })
    })
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
