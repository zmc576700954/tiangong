/**
 * Claude Code 适配器
 * 通过 stdin/stdout 与 Claude Code CLI 非交互式模式通信
 */

import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { exec } from 'node:child_process'
import { BaseAdapter } from './base'
import type { AgentSession, AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'

const execAsync = promisify(exec)

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'claude-code'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    try {
      await execAsync('claude --version')
      return true
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // 构建 Claude Code 启动参数
    // -p: 非交互式模式（prompt mode）
    // --dangerously-skip-permissions: 跳过权限确认（仅限受控环境）
    // --allowedTools: 限制可用工具
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--allowedTools', 'Bash,Edit,Read,Write',
      '--verbose',
    ]

    // 注入范围上下文作为初始提示
    const scopePrompt = this.buildScopePrompt(config)
    const initialPrompt = `${scopePrompt}\n\n请根据以上约束开始工作。当前任务将在接下来的消息中指定。`

    args.push(initialPrompt)

    const proc = spawn('claude', args, {
      cwd: config.workingDirectory,
      env: {
        ...process.env,
        BIZGRAPH_SESSION_ID: sessionId,
        BIZGRAPH_ALLOWED_FILES: JSON.stringify(config.allowedFiles),
        BIZGRAPH_FORBIDDEN_FILES: JSON.stringify(config.forbiddenFiles),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const session: AgentSession = {
      id: sessionId,
      process: proc,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }

    this.registerSession(session)
    this.attachOutputHandlers(session)

    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const proc = session.process
    if (!proc.stdin || proc.stdin.writableEnded) {
      throw new Error('Claude Code process stdin is not writable')
    }

    const prompt = this.buildCommandPrompt(command)
    proc.stdin.write(prompt + '\n')
  }

  protected async doTerminate(session: AgentSession): Promise<void> {
    const proc = session.process
    if (!proc.killed) {
      proc.kill('SIGTERM')
      // 给 5 秒优雅退出时间
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 5000)
        proc.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
  }

  /**
   * 附加输出处理器，解析 stdout/stderr
   */
  private attachOutputHandlers(session: AgentSession): void {
    const { process: proc } = session

    // stdout
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      this.emitOutput({
        type: 'stdout',
        data: text,
        timestamp: Date.now(),
      })
      this.parseFileChanges(text)
    })

    // stderr
    proc.stderr?.on('data', (data: Buffer) => {
      this.emitOutput({
        type: 'stderr',
        data: data.toString('utf-8'),
        timestamp: Date.now(),
      })
    })

    // 进程退出
    proc.on('exit', (code) => {
      this.emitOutput({
        type: 'complete',
        data: `Claude Code exited with code ${code ?? 'unknown'}`,
        timestamp: Date.now(),
      })
    })

    // 进程错误
    proc.on('error', (err) => {
      this.emitOutput({
        type: 'error',
        data: err.message,
        timestamp: Date.now(),
      })
    })
  }

  /**
   * 解析输出中的文件变更信息
   * Claude Code verbose 模式下会输出类似：
   * "I'll edit src/services/RefundService.ts"
   */
  private parseFileChanges(text: string): void {
    // 简单的启发式匹配 —— 未来可以改进为正则
    const patterns = [
      /(?:edit|modify|update|create|add|delete|remove)\s+(?:file\s+)?[`'"]?([\w\/\-.]+\.(?:ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml))[`'"]?/gi,
    ]

    for (const pattern of patterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const filePath = match[1]
        const changeType = this.inferChangeType(match[0])
        this.emitOutput({
          type: 'file_change',
          data: `${changeType}: ${filePath}`,
          timestamp: Date.now(),
          filePath,
          changeType,
        })
      }
    }
  }

  private inferChangeType(actionText: string): 'add' | 'modify' | 'delete' {
    const lower = actionText.toLowerCase()
    if (lower.includes('create') || lower.includes('add')) return 'add'
    if (lower.includes('delete') || lower.includes('remove')) return 'delete'
    return 'modify'
  }

  /**
   * 构建命令提示词
   */
  private buildCommandPrompt(command: AgentCommand): string {
    const typeLabels: Record<string, string> = {
      implement: '请实现以下功能',
      fix_bug: '请修复以下 Bug',
      refactor: '请重构以下代码',
      add_test: '请为以下功能添加测试',
    }

    return `${typeLabels[command.type] ?? '请完成以下任务'}：\n${command.description}`
  }
}
