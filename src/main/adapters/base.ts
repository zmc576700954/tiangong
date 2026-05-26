/**
 * Agent 适配器基类
 * 核心扩展点 —— 贡献者继承此类即可接入新的 Agent CLI
 */

import { EventEmitter } from 'node:events'
import type {
  AgentAdapter,
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
} from '@shared/types'

/**
 * Agent 适配器抽象基类
 *
 * 贡献者只需实现以下方法即可接入新的 Agent CLI：
 * - checkInstalled(): 检测用户系统是否已安装该 Agent
 * - startSession(): 启动 Agent 会话，注入范围上下文
 * - doSendCommand(): 向 Agent 进程发送指令
 * - doTerminate(): 终止 Agent 会话
 *
 * 输出监听通过 EventEmitter 自动处理
 */
export abstract class BaseAdapter extends EventEmitter implements AgentAdapter {
  abstract readonly name: string
  abstract readonly version: string

  protected sessions = new Map<string, AgentSession>()

  /**
   * 检测用户系统是否已安装该 Agent
   */
  abstract checkInstalled(): Promise<boolean>

  /**
   * 启动 Agent 会话
   * @param config - 范围上下文配置
   * @returns Agent 会话对象
   */
  abstract startSession(config: AgentSessionConfig): Promise<AgentSession>

  /**
   * 内部方法：向 Agent 进程发送指令
   * @param session - Agent 会话
   * @param command - 指令对象
   */
  protected abstract doSendCommand(session: AgentSession, command: AgentCommand): Promise<void>

  /**
   * 内部方法：终止 Agent 进程
   * @param session - Agent 会话
   */
  protected abstract doTerminate(session: AgentSession): Promise<void>

  /**
   * 发送指令到指定会话
   */
  async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    await this.doSendCommand(session, command)
  }

  /**
   * 注册输出监听处理器
   */
  onOutput(handler: (output: AgentOutput) => void): void {
    this.on('output', handler)
  }

  /**
   * 终止指定会话
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    await this.doTerminate(session)
    this.sessions.delete(sessionId)
    this.emit('output', {
      type: 'complete',
      data: 'Session terminated by user',
      timestamp: Date.now(),
    })
  }

  /**
   * 保存会话到内部映射
   * @protected
   */
  protected registerSession(session: AgentSession): void {
    this.sessions.set(session.id, session)
  }

  /**
   * 向所有监听器发送输出
   * @protected
   */
  protected emitOutput(output: AgentOutput): void {
    this.emit('output', output)
  }

  /**
   * 生成范围约束提示词
   * 将 AgentSessionConfig 转换为自然语言约束说明
   * @protected
   */
  protected buildScopePrompt(config: AgentSessionConfig): string {
    const lines: string[] = []

    lines.push(`# 业务节点：${config.nodeTitle}`)
    lines.push('')

    if (config.acceptanceCriteria.length > 0) {
      lines.push('## 验收标准')
      for (const criteria of config.acceptanceCriteria) {
        lines.push(`- ${criteria}`)
      }
      lines.push('')
    }

    if (config.allowedFiles.length > 0) {
      lines.push('## 允许修改的文件（白名单）')
      for (const file of config.allowedFiles) {
        lines.push(`- ${file}`)
      }
      lines.push('')
    }

    if (config.forbiddenFiles.length > 0) {
      lines.push('## 禁止修改的文件（黑名单）')
      for (const file of config.forbiddenFiles) {
        lines.push(`- ${file}`)
      }
      lines.push('')
    }

    if (config.invariantRules.length > 0) {
      lines.push('## 业务不变量')
      for (const rule of config.invariantRules) {
        lines.push(`- ${rule}`)
      }
      lines.push('')
    }

    if (config.upstreamContext) {
      lines.push('## 上游契约')
      lines.push(config.upstreamContext)
      lines.push('')
    }

    if (config.downstreamContext) {
      lines.push('## 下游契约')
      lines.push(config.downstreamContext)
      lines.push('')
    }

    if (config.bugContext && config.bugContext.length > 0) {
      lines.push('## 待修复 Bug')
      for (const bug of config.bugContext) {
        lines.push(`### ${bug.title} [${bug.severity}]`)
        lines.push(bug.description)
        lines.push('')
      }
    }

    return lines.join('\n')
  }
}
