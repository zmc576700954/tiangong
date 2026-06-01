/**
 * Claude Code 适配器（单次执行模式）
 *
 * Claude Code CLI (`claude -p`) 是单次执行工具：启动、处理一个 prompt、输出结果、退出。
 * 因此本适配器采用"单次执行"模式：
 * - startSession() 只记录配置，不启动进程
 * - sendCommand() 启动新进程，传入完整 prompt（scope + command）
 * - 进程输出通过 EventEmitter 实时推送，退出后自动完成
 *
 * 安全设计：
 * - P0-FIX: 不通过命令行参数传递用户输入内容（防止参数注入）
 * - prompt 内容通过 stdin 管道传入，命令行仅保留固定参数
 */

import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { AdapterError } from '../errors'

const execFileAsync = promisify(execFile)

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'claude-code'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      await execFileAsync('claude', ['--version'])
      return true
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('claude')
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
    const scopePrompt = this.buildScopePrompt(session.config, session.resolvedContexts)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    // 构建 CLI 参数
    const args = ['-p', '--verbose', '--model', 'sonnet']
    if (session.config.resumeSessionId) {
      args.push('--resume', session.config.resumeSessionId)
    }

    // SECURITY-P0: 通过 stdin 传入 prompt，不经过命令行参数
    // 避免用户输入内容被 shell/CLI 解析为选项或特殊字符
    const proc = spawn('claude', args, {
      cwd: session.config.workingDirectory,
      env: this.buildSafeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 先启动输出监听，再写入 stdin
    const runPromise = this.runOneShot(proc)

    // 安全写入 prompt 到 stdin
    await this.safeWriteStdin(proc, fullPrompt + '\n')
    proc.stdin?.end()

    await runPromise
  }

  /**
   * 安全写入 stdin，等待 drain 事件避免背压
   */
  private safeWriteStdin(proc: ChildProcess, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!proc.stdin || proc.stdin.writableEnded) {
        reject(new AdapterError('Stdin is not writable', this.name))
        return
      }
      const writable = proc.stdin.write(data)
      if (writable) {
        resolve()
      } else {
        proc.stdin.once('drain', resolve)
        proc.stdin.once('error', reject)
      }
    })
  }
}
