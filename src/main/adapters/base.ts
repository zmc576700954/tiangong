/**
 * Agent 适配器基类
 * 核心扩展点 —— 贡献者继承此类即可接入新的 Agent CLI
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type {
  AgentAdapter,
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
  ResolvedContext,
} from '@shared/types'
import { JsonProtocolHandler, protocolMessageToAgentOutput } from './json-protocol'
import type { ProtocolInputMessage } from './json-protocol'
import { SessionNotFoundError } from '../errors'
import { buildSafeEnv } from '../shared/env'

/**
 * Agent 适配器抽象基类
 *
 * 贡献者只需实现以下方法即可接入新的 Agent CLI：
 * - checkInstalled(): 检测用户系统是否已安装该 Agent
 * - startSession(): 启动 Agent 会话，注入范围上下文
 * - doSendCommand(): 向 Agent 进程发送指令
 *
 * 输出监听、进程终止、命令提示词构建等通用逻辑由基类自动处理
 */
export abstract class BaseAdapter extends EventEmitter implements AgentAdapter {
  abstract readonly name: string
  abstract readonly version: string

  protected sessions = new Map<string, AgentSession>()
  protected processes = new Map<string, ChildProcess>()
  protected sessionCleanups = new Map<string, () => void>()
  protected protocolHandlers = new Map<string, JsonProtocolHandler>()
  /** 输出到 session 的映射（用于 AgentManager 精准广播） */
  private outputSessionMap = new WeakMap<AgentOutput, string>()
  /** 当前输出上下文栈（用于 doSendCommand 中自动关联 session） */
  private outputSessionStack: string[] = []

  constructor() {
    super()
    // MEM-01: 避免大量会话时触发 maxListeners 警告
    this.setMaxListeners(0)
  }

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
   * @param proc - 子进程对象（从内部 Map 获取，避免序列化问题）
   */
  protected abstract doSendCommand(session: AgentSession, command: AgentCommand, proc?: ChildProcess): Promise<void>

  /**
   * 发送指令到指定会话
   */
  async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new SessionNotFoundError(sessionId)
    }
    const proc = this.processes.get(sessionId)
    this.pushOutputSession(sessionId)
    try {
      await this.doSendCommand(session, command, proc)
    } finally {
      this.popOutputSession()
    }
  }

  /**
   * 注册输出监听处理器
   */
  onOutput(handler: (output: AgentOutput) => void): void {
    this.on('output', handler)
  }

  /**
   * 移除输出监听处理器
   */
  offOutput(handler: (output: AgentOutput) => void): void {
    this.off('output', handler)
  }

  /**
   * 终止指定会话
   */
  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    this.pushOutputSession(sessionId)
    try {
      // SDK 适配器钩子：在基类清理前关闭 SDK query 对象
      this.doCloseQuery(sessionId)
      const proc = this.processes.get(sessionId)
      await this.doTerminate(session, proc)
      // TG-009: 清理事件监听器，防止内存泄漏
      this.sessionCleanups.get(sessionId)?.()
      this.sessionCleanups.delete(sessionId)
      // 清理协议处理器
      this.disposeProtocolHandler(sessionId)
      this.sessions.delete(sessionId)
      this.processes.delete(sessionId)
      this.emitOutput({
        type: 'complete',
        data: 'Session terminated by user',
        timestamp: Date.now(),
      })
    } finally {
      this.popOutputSession()
    }
  }

  /**
   * SDK 适配器钩子：关闭 SDK query 对象
   * 子类重写此方法以清理 SDK 资源（如 query.close()）
   * @protected
   */
  protected doCloseQuery(_sessionId: string): void {
    // 默认空实现，SDK 适配器重写
  }

  /**
   * 保存会话到内部映射
   * @protected
   */
  protected registerSession(session: AgentSession, proc?: ChildProcess): void {
    this.sessions.set(session.id, session)
    if (proc) {
      this.processes.set(session.id, proc)
    }
  }

  /**
   * 设置会话的已解析上下文（外部调用，用于在 sendCommand 前注入上下文）
   */
  setResolvedContexts(sessionId: string, resolvedContexts: import('@shared/types').ResolvedContext[]): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new SessionNotFoundError(sessionId)
    }
    session.resolvedContexts = resolvedContexts
  }

  /**
   * 向所有监听器发送输出
   * 自动关联当前输出上下文栈顶的 sessionId（如果存在）
   * @protected
   */
  protected emitOutput(output: AgentOutput): void {
    const sessionId = this.outputSessionStack[this.outputSessionStack.length - 1]
    if (sessionId) {
      this.outputSessionMap.set(output, sessionId)
    }
    this.emit('output', output)
  }

  /**
   * 解析输出关联的 sessionId（供 AgentManager 精准广播）
   */
  resolveOutputSession(output: AgentOutput): string | undefined {
    return this.outputSessionMap.get(output)
  }

  private pushOutputSession(sessionId: string): void {
    this.outputSessionStack.push(sessionId)
  }

  private popOutputSession(): void {
    this.outputSessionStack.pop()
  }

  // ============================================
  // 协议层方法（NDJSON 结构化通信）
  // ============================================

  /**
   * 为会话初始化协议处理器（可选）
   * 子类可在 startSession 中调用此方法来启用 NDJSON 协议
   * @protected
   */
  protected initProtocolHandler(
    session: AgentSession,
    proc: ChildProcess,
    options?: { autoEnable?: boolean },
  ): JsonProtocolHandler {
    const handler = new JsonProtocolHandler(proc)
    this.protocolHandlers.set(session.id, handler)

    // 缓存 sessionId，消除协议回调对上下文栈的依赖
    const sessionId = session.id

    if (options?.autoEnable) {
      handler.enable()
    }

    // 将协议消息转换为 AgentOutput 并广播
    handler.onMessage((msg) => {
      const output = protocolMessageToAgentOutput(msg)
      if (output) {
        this.emitOutputForSession(sessionId, output)
      }
    })

    // 协议解析错误时降级为原始 stdout
    handler.onError((_err, rawLine) => {
      this.emitOutputForSession(sessionId, {
        type: 'stdout',
        data: rawLine,
        timestamp: Date.now(),
      })
    })

    return handler
  }

  /**
   * 通过协议发送命令（如果协议已启用）
   * @protected
   * @returns 是否成功通过协议发送
   */
  protected sendProtocolCommand(
    sessionId: string,
    command: AgentCommand,
  ): boolean {
    const handler = this.protocolHandlers.get(sessionId)
    if (!handler || !handler.enabled) {
      return false
    }

    const message: Omit<ProtocolInputMessage, 'version'> = {
      type: 'command',
      id: `${sessionId}-${Date.now()}`,
      timestamp: Date.now(),
      payload: {
        action: command.type,
        description: command.description,
      },
    }

    return handler.send(message)
  }

  /**
   * 清理协议处理器
   * @protected
   */
  protected disposeProtocolHandler(sessionId: string): void {
    const handler = this.protocolHandlers.get(sessionId)
    if (handler) {
      handler.dispose()
      this.protocolHandlers.delete(sessionId)
    }
  }

  // ============================================
  // 通用工具方法（子类可直接复用）
  // ============================================

  /**
   * 为指定 session 发送输出（直接关联 sessionId，不依赖上下文栈）
   * @protected
   */
  private emitOutputForSession(sessionId: string, output: AgentOutput): void {
    this.outputSessionMap.set(output, sessionId)
    this.emit('output', output)
  }

  /**
   * 创建标准输出处理器（供 attachOutputHandlers 和 runOneShot 复用）
   * @protected
   */
  protected createOutputHandlers(sessionId: string, options?: { parseFileChanges?: boolean }): {
    onStdout: (data: Buffer) => void
    onStderr: (data: Buffer) => void
    onExit: (code: number | null) => void
    onError: (err: Error) => void
  } {
    const onStdout = (data: Buffer) => {
      const text = data.toString('utf-8')
      this.emitOutputForSession(sessionId, {
        type: 'stdout',
        data: text,
        timestamp: Date.now(),
      })
      if (options?.parseFileChanges !== false) {
        this.parseFileChanges(text)
      }
    }

    const onStderr = (data: Buffer) => {
      this.emitOutputForSession(sessionId, {
        type: 'stderr',
        data: data.toString('utf-8'),
        timestamp: Date.now(),
      })
    }

    const onExit = (code: number | null) => {
      if (code !== null && code !== 0) {
        this.emitOutputForSession(sessionId, {
          type: 'error',
          data: `${this.name} exited with code ${code}`,
          timestamp: Date.now(),
          errorCode: 'AGENT_CRASH',
        })
      } else {
        this.emitOutputForSession(sessionId, {
          type: 'complete',
          data: `${this.name} exited with code ${code ?? 'unknown'}`,
          timestamp: Date.now(),
        })
      }
      // 通知外部监听者 session 已结束（用于 AgentManager 清理沙箱等资源）
      this.emit('sessionEnded', sessionId, code === null ? 'error' : code === 0 ? 'success' : 'crash')
    }

    const onError = (err: Error) => {
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: err.message,
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
      // 通知外部监听者 session 因错误结束
      this.emit('sessionEnded', sessionId, 'error')
    }

    return { onStdout, onStderr, onExit, onError }
  }

  /**
   * 附加标准输出处理器，解析 stdout/stderr/exit/error
   * 子类在 startSession 中调用此方法注册输出监听
   * @protected
   * @returns detach 函数，用于清理事件监听器（防止内存泄漏）
   */
  protected attachOutputHandlers(session: AgentSession, options?: { parseFileChanges?: boolean }): () => void {
    const proc = this.processes.get(session.id)
    if (!proc) return () => {}

    const { onStdout, onStderr, onExit, onError } = this.createOutputHandlers(session.id, options)

    proc.stdout?.on('data', onStdout)
    proc.stderr?.on('data', onStderr)
    proc.on('exit', onExit)
    proc.on('error', onError)

    const detach = () => {
      proc.stdout?.off('data', onStdout)
      proc.stderr?.off('data', onStderr)
      proc.off('exit', onExit)
      proc.off('error', onError)
    }
    this.sessionCleanups.set(session.id, detach)
    return detach
  }

  /**
   * 单次执行模式：启动进程、收集输出、等待退出
   * 适用于 claude -p / codex 等单次执行 CLI
   * @protected
   */
  protected async runOneShot(
    proc: ChildProcess,
    sessionId: string,
    options?: { parseFileChanges?: boolean },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { onStdout, onStderr, onExit: baseOnExit, onError: baseOnError } = this.createOutputHandlers(sessionId, options)

      const onExit = (code: number | null) => {
        baseOnExit(code)
        cleanup()
        resolve()
      }

      const onError = (err: Error) => {
        baseOnError(err)
        cleanup()
        reject(err)
      }

      const cleanup = () => {
        proc.stdout?.off('data', onStdout)
        proc.stderr?.off('data', onStderr)
        proc.off('exit', onExit)
        proc.off('error', onError)
      }

      proc.stdout?.on('data', onStdout)
      proc.stderr?.on('data', onStderr)
      proc.once('exit', onExit)
      proc.once('error', onError)
    })
  }

  /**
   * 终止 Agent 进程的默认实现
   * 先发送 SIGTERM，5 秒后未退出则发送 SIGKILL
   * @protected
   */
  protected async doTerminate(_session: AgentSession, proc?: ChildProcess): Promise<void> {
    if (!proc || proc.killed) return
    return new Promise<void>((resolve) => {
      // P0-11: 先注册 exit 监听器，再调用 kill，避免竞态条件
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL')
        }
      }, 5000)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  }

  /**
   * 构建命令提示词
   * @protected
   */
  protected buildCommandPrompt(command: AgentCommand): string {
    const typeLabels: Record<string, string> = {
      implement: '请实现以下功能',
      fix_bug: '请修复以下 Bug',
      refactor: '请重构以下代码',
      add_test: '请为以下功能添加测试',
    }

    return `${typeLabels[command.type] ?? '请完成以下任务'}：\n${command.description}`
  }

  /**
   * 解析输出中的文件变更信息
   * 例如："I'll edit src/services/RefundService.ts"
   *
   * 带上下文校验，减少误报：
   * - 排除 Markdown 代码块内的内容
   * - 排除示例/讨论语气（e.g., for example, such as）
   * - 排除列表项和引用块
   * - 要求文件路径包含目录分隔符（排除单文件名如 "test"）
   * @protected
   */
  // 快速预检查：输出中是否包含文件扩展名，避免超大输出浪费正则计算
  private static readonly FILE_EXT_QUICK_CHECK = /\.(ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml)\b/
  private static readonly MAX_PARSE_LENGTH = 50_000

  protected parseFileChanges(text: string): void {
    if (text.length > BaseAdapter.MAX_PARSE_LENGTH) return
    if (!BaseAdapter.FILE_EXT_QUICK_CHECK.test(text)) return

    const EXAMPLE_MARKERS = /\b(e\.g\.|for example|such as|like this|similar to)\b/gi
    const FILE_PATTERN = /(?:edit|modify|update|create|add|delete|remove)\s+(?:file\s+)?[`'"]?([\w/\\.-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml))[`'"]?/gi

    const lines = text.split('\n')
    let inCodeBlock = false

    for (const line of lines) {
      FILE_PATTERN.lastIndex = 0
      const trimmed = line.trim()

      // 跳过 Markdown 代码块边界和内部行
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock
        continue
      }
      if (inCodeBlock) continue

      // 跳过列表项、引用块、表格行
      if (/^[-*+>]\s/.test(trimmed)) continue
      if (/^\|/.test(trimmed)) continue

      // 跳过示例/讨论语气
      if (EXAMPLE_MARKERS.test(trimmed)) continue

      // 逐行匹配，避免跨行误匹配
      let match: RegExpExecArray | null
      while ((match = FILE_PATTERN.exec(trimmed)) !== null) {
        const filePath = match[1]
        // 要求路径包含目录分隔符，排除孤立文件名
        if (!filePath.includes('/') && !filePath.includes('\\')) continue

        const changeType = this.inferChangeType(match[0])
        this.emitOutput({
          type: 'file_change',
          data: `${changeType}: ${filePath}`,
          timestamp: Date.now(),
          filePath,
          changeType,
        })
      }
      // 重置正则 lastIndex，避免跨行状态污染
      FILE_PATTERN.lastIndex = 0
    }
  }

  /**
   * 根据动作文本推断变更类型
   * @protected
   */
  protected inferChangeType(actionText: string): 'add' | 'modify' | 'delete' {
    const lower = actionText.toLowerCase()
    if (lower.includes('create') || lower.includes('add')) return 'add'
    if (lower.includes('delete') || lower.includes('remove')) return 'delete'
    return 'modify'
  }

  /**
   * 清理环境变量，防止敏感信息泄露给子进程
   * 过滤掉以 BIZGRAPH_ 开头的变量，只保留必要的系统环境变量
   * 实际逻辑委托给 ../shared/env 中的 buildSafeEnv()
   */
  protected buildSafeEnv(): NodeJS.ProcessEnv {
    return buildSafeEnv()
  }

  /**
   * 生成范围约束提示词
   * 将 AgentSessionConfig 转换为自然语言约束说明
   * @protected
   */
  protected buildScopePrompt(config: AgentSessionConfig, resolvedContexts?: ResolvedContext[]): string {
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

    // 注入已解析的上下文
    if (resolvedContexts && resolvedContexts.length > 0) {
      lines.push('## 附加上下文')
      for (const ctx of resolvedContexts) {
        lines.push(`### ${ctx.label} (${ctx.type})`)
        lines.push(ctx.content)
        lines.push('')
      }
    }

    return lines.join('\n')
  }
}
