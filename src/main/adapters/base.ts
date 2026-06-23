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
import { SessionNotFoundError, AdapterError, ErrorCode } from '../errors'
import { buildSafeEnv } from '../shared/env'
import { createLogger } from '../shared/logger'
import { parseFileChanges } from './file-change-parser'
import { buildScopePrompt } from './scope-prompt-builder'
import { estimateTokens } from '../shared/token-utils'
import type { CompactResult, CompactStrategy, CompactTrigger } from '@shared/types'
import type { SubagentManager } from '../agent/subagent-manager'

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
  protected logger = createLogger('BaseAdapter')
  /** Phase 4: SubagentManager注入，供子类（Claude Code/MCP）派发子代理使用 */
  protected subagentManager?: SubagentManager
  /** 输出到 session 的映射（WeakMap 自动 GC，不阻止 AgentOutput 回收） */
  private outputSessionMap = new WeakMap<AgentOutput, string>()
  /** 当前输出上下文栈（用于 doSendCommand 中自动关联 session） */
  private outputSessionStack: string[] = []
  /** 会话输出缓冲区：为不支持 resume 的适配器收集历史输出，用于生成上下文摘要 */
  protected sessionOutputBuffers = new Map<string, string[]>()
  /** 单会话输出条数上限，防止内存无限增长 */
  private static readonly MAX_OUTPUT_BUFFER_SIZE = 200
  /** 错误关键词列表（与 MemoryExtractor 保持一致） */
  private static readonly ERROR_KEYWORDS = [
    'error', '失败', 'exception', 'panic', 'fatal', 'crash',
    'timeout', 'refused', 'enoent', 'econnrefused', 'permission denied',
    'stack overflow', 'out of memory', 'segfault', 'abort',
    'undefined is not', 'cannot read', 'typeerror', 'referenceerror',
    'syntaxerror', 'rangeerror',
  ]
  /** 会话级进程守护定时器：超时自动 kill，防止子进程泄漏 */
  private sessionKillTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 默认会话超时时间（30 分钟） */
  private static readonly DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000
  /** 连接超时（10 秒） */
  static readonly CONNECTION_TIMEOUT_MS = 10_000
  /** 首字节超时（30 秒） */
  static readonly FIRST_BYTE_TIMEOUT_MS = 30_000
  /** 执行超时（5 分钟） */
  static readonly EXECUTION_TIMEOUT_MS = 5 * 60 * 1000
  /** SIGKILL 保底超时（SIGTERM 后等待时间） */
  private static readonly SIGKILL_GRACE_PERIOD_MS = 5000
  /** Phase 5: inline tool loop max rounds */
  protected static readonly MAX_TOOL_ROUNDS = 5
  /** Phase 5: inline tool loop total timeout */
  protected static readonly TOOL_AWARE_LOOP_TIMEOUT_MS = 5 * 60 * 1000

  constructor() {
    super()
    // MEM-01: 避免大量会话时触发 maxListeners 警告
    this.setMaxListeners(50)
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
    try {
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
    } catch (error) {
      if (error instanceof SessionNotFoundError || error instanceof AdapterError) throw error
      const adapterError = new AdapterError(
        `Unexpected error in ${this.name}.sendCommand: ${(error as Error).message}`,
        this.name,
      )
      this.emitOutput({
        type: 'error',
        data: adapterError.message,
        timestamp: Date.now(),
      })
      throw adapterError
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
    } catch (err) {
      // doTerminate 可能失败（进程已无法终止），记录但不阻塞后续清理
      this.logger.error(`doTerminate failed for session ${sessionId}:`, err)
    } finally {
      // 无论 doTerminate 是否成功，都执行清理
      try {
        // 生成会话上下文摘要（供不支持原生 resume 的适配器使用）
        this.buildAndStoreSummary(sessionId)
        this.sessionCleanups.get(sessionId)?.()
        this.sessionCleanups.delete(sessionId)
        this.disposeProtocolHandler(sessionId)
        // 先发出 complete 事件（此时 session 仍存在，消费者可查找）
        this.emitOutput({
          type: 'complete',
          data: 'Session terminated by user',
          timestamp: Date.now(),
        })
        // 清理进程守护定时器
        this.clearSessionKillTimer(sessionId)
        // outputSessionMap 使用 WeakMap，无需手动清理（GC 自动回收无引用的 AgentOutput）
        this.sessions.delete(sessionId)
        this.processes.delete(sessionId)
      } catch (cleanupErr) {
        this.logger.error(`Cleanup failed for session ${sessionId}:`, cleanupErr)
      } finally {
        // 清理输出缓冲区，防止内存泄漏
        this.sessionOutputBuffers.delete(sessionId)
      }
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
      this.startSessionKillTimer(session.id, proc)
    }
  }

  /**
   * 启动会话级进程守护定时器：超时自动 kill，防止子进程泄漏
   * @protected
   */
  protected startSessionKillTimer(sessionId: string, proc: ChildProcess, timeoutMs?: number): void {
    this.clearSessionKillTimer(sessionId)
    const timer = setTimeout(() => {
      if (!proc.killed) {
        this.logger.warn(`Session ${sessionId} exceeded timeout (${timeoutMs ?? BaseAdapter.DEFAULT_SESSION_TIMEOUT_MS}ms), force killing`)
        // 先尝试 SIGTERM，再保底 SIGKILL
        this.forceKillProcess(proc)
      }
    }, timeoutMs ?? BaseAdapter.DEFAULT_SESSION_TIMEOUT_MS)
    this.sessionKillTimers.set(sessionId, timer)
  }

  /**
   * 清理会话级进程守护定时器
   * @protected
   */
  protected clearSessionKillTimer(sessionId: string): void {
    const timer = this.sessionKillTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.sessionKillTimers.delete(sessionId)
    }
  }

  /**
   * 强制终止进程：SIGTERM → 等待 → SIGKILL 保底
   * @protected
   */
  protected forceKillProcess(proc: ChildProcess, gracePeriodMs = BaseAdapter.SIGKILL_GRACE_PERIOD_MS): void {
    if (proc.killed) return
    const timeout = setTimeout(() => {
      if (!proc.killed) {
        this.logger.warn(`Process ${proc.pid} did not exit after SIGTERM, force killing`)
        if (process.platform === 'win32') {
          proc.kill()
        } else {
          proc.kill('SIGKILL')
        }
      }
    }, gracePeriodMs)
    proc.once('exit', () => clearTimeout(timeout))
    if (process.platform === 'win32') {
      proc.kill()
    } else {
      proc.kill('SIGTERM')
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
   * 设置会话的智能代码上下文（外部调用，用于注入代码分析结果）
   */
  setCodeContext(sessionId: string, codeContext: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new SessionNotFoundError(sessionId)
    }
    session.codeContext = codeContext
  }

  /**
   * 设置会话的项目记忆上下文（外部调用，用于注入项目记忆）
   */
  setMemoryContext(sessionId: string, memoryContext: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new SessionNotFoundError(sessionId)
    }
    session.memoryContext = memoryContext
  }

  /**
   * Phase 4: 注入 SubagentManager，使适配器（Claude Code 通过 createSdkMcpServer、
   * MCP 通过 tools 数组）能够派发子代理任务。
   */
  setSubagentManager(mgr: SubagentManager): void {
    this.subagentManager = mgr
  }

  /**
   * 向所有监听器发送输出
   * 自动关联当前输出上下文栈顶的 sessionId（如果存在）
   * 同时收集 stdout/complete 到输出缓冲区，用于生成会话摘要
   * @protected
   */
  protected emitOutput(output: AgentOutput): void {
    const sessionId = this.outputSessionStack[this.outputSessionStack.length - 1]
    if (sessionId) {
      this.outputSessionMap.set(output, sessionId)
      // 收集 stdout/complete 到缓冲区，用于后续生成上下文摘要
      if (output.type === 'stdout' || output.type === 'complete') {
        let buffer = this.sessionOutputBuffers.get(sessionId)
        if (!buffer) {
          buffer = []
          this.sessionOutputBuffers.set(sessionId, buffer)
        }
        buffer.push(output.data)
        // 限制缓冲区大小，防止内存无限增长
        if (buffer.length > BaseAdapter.MAX_OUTPUT_BUFFER_SIZE) {
          buffer.splice(0, buffer.length - BaseAdapter.MAX_OUTPUT_BUFFER_SIZE)
        }
      }
    }
    this.emit('output', output)
  }

  /**
   * 解析输出关联的 sessionId（供 AgentManager 精准广播）
   */
  resolveOutputSession(output: AgentOutput): string | undefined {
    return this.outputSessionMap.get(output)
  }

  protected pushOutputSession(sessionId: string): void {
    this.outputSessionStack.push(sessionId)
  }

  protected popOutputSession(): void {
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

    // 协议解析错误时降级为原始 stdout；致命错误（如 buffer 溢出）时终止 session
    handler.onError((err, rawLine) => {
      if (err.message.startsWith('BUFFER_OVERFLOW')) {
        this.logger.error(`Protocol buffer overflow for session ${sessionId}, terminating`)
        this.terminateSession(sessionId).catch((e) => {
          this.logger.error(`Failed to terminate session ${sessionId} after buffer overflow:`, e)
        })
        return
      }
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
      // Process exited naturally — clear the kill timer to prevent it firing on a dead process
      this.clearSessionKillTimer(sessionId)

      // Exit code classification for recovery diagnostics
      // code 1       — general error; may be recoverable (adapter logic error, bad input)
      // code 126/127 — command not found / not executable; adapter not available on this system
      // code 137/143 — SIGKILL / SIGTERM; normal termination (user-initiated or timeout)
      if (code === 126 || code === 127) {
        this.logger.warn(`Adapter ${this.name} not available (exit code ${code}) — adapter may not be installed or executable`)
      } else if (code === 137 || code === 143) {
        this.logger.info(`Adapter ${this.name} terminated by signal (exit code ${code}) — normal termination`)
      } else if (code !== null && code !== 0 && code !== 1) {
        this.logger.warn(`Adapter ${this.name} exited with unusual code ${code} — recovery may be possible via SessionRecoveryManager`)
      }

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
   * 先发送 SIGTERM，5 秒后未退出则发送 SIGKILL 保底
   * @protected
   */
  protected async doTerminate(_session: AgentSession, proc?: ChildProcess): Promise<void> {
    // proc.killed is only true after an explicit kill() call.
    // proc.exitCode !== null means the process has already exited naturally.
    if (!proc || proc.killed || proc.exitCode !== null) return
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          this.logger.warn(`Process ${proc.pid} did not exit after signal, force killing`)
          proc.kill()
        }
      }, BaseAdapter.SIGKILL_GRACE_PERIOD_MS)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      if (process.platform === 'win32') {
        proc.kill()
      } else {
        proc.kill('SIGTERM')
      }
    })
  }

  /**
   * 构建命令提示词
   * @protected
   */
  protected buildCommandPrompt(command: AgentCommand): string {
    const typeContext: Record<string, { label: string; guidance: string }> = {
      implement: {
        label: '请实现以下功能',
        guidance: 'Focus on clean, maintainable code. Follow existing patterns in the codebase.',
      },
      fix_bug: {
        label: '请修复以下 Bug',
        guidance: 'Identify the root cause first. Make minimal changes to fix the issue. Add a regression test if possible.',
      },
      refactor: {
        label: '请重构以下代码',
        guidance: 'Preserve existing behavior. Improve code structure without changing functionality.',
      },
      add_test: {
        label: '请为以下功能添加测试',
        guidance: 'Cover edge cases and error paths. Follow existing test patterns in the project.',
      },
    }

    const ctx = typeContext[command.type] ?? { label: '请完成以下任务', guidance: '' }
    return `${ctx.label}：\n${command.description}\n\n${ctx.guidance}`
  }

  /**
   * 解析输出中的文件变更信息
   * 委托给 file-change-parser 模块处理
   * @protected
   */
  protected parseFileChanges(text: string): void {
    parseFileChanges(text, (output) => this.emitOutput(output))
  }

  /**
   * 清理环境变量，防止敏感信息泄露给子进程
   * 过滤掉以 BIZGRAPH_ 开头的变量，只保留必要的系统环境变量
   * 实际逻辑委托给 ../shared/env 中的 buildSafeEnv()
   */
  protected buildSafeEnv(): NodeJS.ProcessEnv {
    return buildSafeEnv(this.name)
  }

  /**
   * 生成范围约束提示词
   * 委托给 scope-prompt-builder 模块处理
   * @protected
   */
  /**
   * 便捷方法：从 session 中自动提取 codeContext 并构建 scope prompt
   */
  protected buildScopePromptForSession(
    session: AgentSession,
    resolvedContexts?: ResolvedContext[],
  ): string {
    const parts: string[] = []

    // 注入前序会话摘要（为不支持原生 resume 的适配器提供伪连续性）
    if (session.config.contextSummary) {
      parts.push(session.config.contextSummary)
      parts.push('') // 空行分隔
    }

    parts.push(buildScopePrompt(session.config, resolvedContexts ?? session.resolvedContexts, session.codeContext))

    // 注入项目记忆上下文（与代码上下文分离）
    if (session.memoryContext) {
      parts.push('')
      parts.push(session.memoryContext)
    }

    return parts.join('\n')
  }

  /**
   * Phase 5: Build the inline tool prompt describing dispatch_subagent.
   * CLI adapters without native tool support inject this into their prompt.
   */
  protected buildSubagentToolPrompt(): string {
    const schema = DISPATCH_SUBAGENT_TOOL_SCHEMA.input_schema
    const required = schema.required as unknown as string[]
    const properties = schema.properties as unknown as Record<
      string,
      { type: string; description: string; enum?: readonly string[]; items?: unknown }
    >

    const paramLines = Object.entries(properties).map(([name, def]) => {
      const isRequired = required.includes(name)
      const enumPart = def.enum ? ` (enum: ${def.enum.join(', ')})` : ''
      return `- ${name}${isRequired ? '' : ' (optional)'}: ${def.description}${enumPart}`
    })

    return [
      '## Available Tools',
      '',
      'You can call the following tool by emitting exactly one JSON object wrapped in `<tool_call>` and `</tool_call>` tags.',
      'After the tool executes, its result will be returned to you and you may continue thinking.',
      '',
      `Tool: ${DISPATCH_SUBAGENT_TOOL_NAME}`,
      `Description: ${DISPATCH_SUBAGENT_TOOL_SCHEMA.description}`,
      '',
      'Parameters:',
      ...paramLines,
      '',
      'Example call:',
      `<tool_call>{"tool": "${DISPATCH_SUBAGENT_TOOL_NAME}", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find all usages of Foo in src/.", "allowed_files": ["src/foo.ts"]}}</tool_call>`,
      '',
    ].join('\n')
  }

  /**
   * Phase 5: Parse inline tool_call tags from LLM stdout.
   */
  protected parseToolCalls(text: string): InlineToolCall[] {
    const calls: InlineToolCall[] = []
    const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const raw = match[1].trim()
      try {
        const parsed = JSON.parse(raw) as unknown
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).tool === 'string' &&
          typeof (parsed as Record<string, unknown>).args === 'object'
        ) {
          calls.push({
            tool: (parsed as Record<string, unknown>).tool as string,
            args: (parsed as Record<string, unknown>).args as Record<string, unknown>,
          })
        } else {
          this.logger.warn(`Invalid tool_call structure: ${raw}`)
        }
      } catch (err) {
        this.logger.warn(`Failed to parse tool_call JSON: ${raw}`, err)
      }
    }
    return calls
  }

  /**
   * Phase 5: Tool-aware execution loop for CLI adapters without native tool support.
   *
   * @param session - Active agent session
   * @param command - Original user command
   * @param spawnOnce - Function that runs the CLI once with the given full prompt and returns stdout
   */
  protected async runToolAwareLoop(
    session: AgentSession,
    command: AgentCommand,
    spawnOnce: (fullPrompt: string) => Promise<string>,
  ): Promise<void> {
    if (!this.subagentManager) {
      this.emitOutput({
        type: 'error',
        data: 'SubagentManager not injected; inline tool dispatch unavailable.',
        timestamp: Date.now(),
      })
      return
    }

    const history: ToolHistoryEntry[] = []
    const toolPrompt = this.buildSubagentToolPrompt()
    const basePrompt = `${this.buildScopePromptForSession(session)}\n${toolPrompt}\n${this.buildCommandPrompt(command)}`
    const startTime = Date.now()

    for (let round = 0; round < BaseAdapter.MAX_TOOL_ROUNDS; round++) {
      if (Date.now() - startTime > BaseAdapter.TOOL_AWARE_LOOP_TIMEOUT_MS) {
        this.emitOutput({
          type: 'error',
          data: `Inline tool loop timed out after ${BaseAdapter.TOOL_AWARE_LOOP_TIMEOUT_MS}ms`,
          timestamp: Date.now(),
        })
        return
      }

      const historyText = history.length > 0
        ? `\n## Tool Call History\n${history.map((h) => {
          if (h.role === 'assistant') return `Assistant: ${h.content}`
          return `Result of ${h.tool}:\n${h.result}`
        }).join('\n\n')}\n`
        : ''

      const fullPrompt = `${basePrompt}${historyText}\nPlease continue.`
      const stdout = await spawnOnce(fullPrompt)

      const calls = this.parseToolCalls(stdout)
      if (calls.length === 0) {
        this.emitOutput({ type: 'stdout', data: stdout, timestamp: Date.now() })
        this.emitOutput({ type: 'complete', data: 'OpenCode session completed', timestamp: Date.now() })
        return
      }

      this.emitOutput({ type: 'stdout', data: stdout, timestamp: Date.now() })
      history.push({ role: 'assistant', content: stdout })

      const results = await Promise.all(
        calls.map(async (call) => {
          if (call.tool !== DISPATCH_SUBAGENT_TOOL_NAME) {
            return { tool: call.tool, result: `Unknown tool: ${call.tool}` }
          }
          try {
            const args = call.args
            const result = await this.subagentManager!.invoke({
              parentSessionId: session.id,
              agentType: String(args.agent_type ?? ''),
              description: String(args.description ?? ''),
              prompt: String(args.prompt ?? ''),
              adapterName: args.adapter_name ? String(args.adapter_name) : undefined,
              nodeId: args.node_id ? String(args.node_id) : undefined,
              allowedFiles: Array.isArray(args.allowed_files) ? (args.allowed_files as string[]) : undefined,
            })
            return { tool: call.tool, result: result.resultText }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { tool: call.tool, result: `Subagent failed: ${msg}` }
          }
        }),
      )

      for (const r of results) {
        history.push({ role: 'tool', tool: r.tool, result: r.result })
      }
    }

    this.emitOutput({
      type: 'error',
      data: `Inline tool loop reached max rounds (${BaseAdapter.MAX_TOOL_ROUNDS})`,
      timestamp: Date.now(),
    })
  }

  protected buildScopePrompt(
    config: AgentSessionConfig,
    resolvedContexts?: ResolvedContext[],
    codeContext?: string,
  ): string {
    return buildScopePrompt(config, resolvedContexts, codeContext)
  }

  // ============================================
  // 会话摘要（为不支持原生 resume 的适配器提供伪连续性）
  // ============================================

  /**
   * 从输出缓冲区生成会话上下文摘要，并存储到 session.config
   * 提取关键信息：完成的任务、修改的文件、遇到的错误
   */
  protected buildAndStoreSummary(sessionId: string): void {
    const buffer = this.sessionOutputBuffers.get(sessionId)
    if (!buffer || buffer.length === 0) return

    const session = this.sessions.get(sessionId)
    if (!session) return

    // 提取文件变更信息
    const fileChanges: string[] = []
    const errors: string[] = []
    const completions: string[] = []

    for (const output of buffer) {
      // 文件变更提取（与 MemoryExtractor._extractFileChanges 相同模式）
      const fileMatches = output.match(/(?:modif(?:y|ied)|change(?:d)?|edit(?:ed)?|wrote?|creat(?:e|ed)|add(?:ed)?|delet(?:e|ed)|update(?:d)?)\s*[:：]\s*([^\s\n]{5,200}\.\w{2,10})/gi)
        ?? output.match(/(?:create|modify|delete|add|write|edit)[ed]?\s*[:：]?\s*(\S+\.\w+)/gi)
      if (fileMatches) {
        fileChanges.push(...fileMatches.map((m) => m.trim()).filter((m) => m.length > 3 && m.length < 200))
      }
      // 错误提取（与 MemoryExtractor._extractErrors 相同关键词列表）
      const outputLower = output.toLowerCase()
      if (BaseAdapter.ERROR_KEYWORDS.some(kw => outputLower.includes(kw))) {
        const lines = output.split('\n').filter((l) => l.length > 10 && l.length < 300)
        errors.push(...lines.slice(0, 3))
      }
      // 提取完成语句
      if (outputLower.includes('complete') || outputLower.includes('完成') || outputLower.includes('done') || outputLower.includes('success')) {
        completions.push(output.trim().substring(0, 200))
      }
    }

    const lines: string[] = ['## 前序会话摘要']

    if (completions.length > 0) {
      lines.push('已完成的任务：')
      for (const c of completions.slice(0, 3)) {
        lines.push(`- ${c}`)
      }
    }

    if (fileChanges.length > 0) {
      lines.push('\n已修改的文件：')
      const uniqueChanges = [...new Set(fileChanges)].slice(0, 10)
      for (const f of uniqueChanges) {
        lines.push(`- ${f}`)
      }
    }

    if (errors.length > 0) {
      lines.push('\n遇到的问题：')
      for (const e of [...new Set(errors)].slice(0, 3)) {
        lines.push(`- ${e}`)
      }
    }

    // 限制摘要长度，避免污染 context window
    let summary = lines.join('\n')
    if (summary.length > 2000) {
      summary = summary.substring(0, 2000) + '\n\n[摘要已截断]'
    }

    session.config.contextSummary = summary
    this.logger.debug(`Built context summary for session ${sessionId}: ${summary.length} chars`)
  }

  // ============================================
  // Context compaction (Phase 3)
  // ============================================

  /**
   * Public compaction entry — subclasses normally don't override this.
   * Dispatches to the three strategy helpers based on the strategy param.
   */
  async compactContext(
    sessionId: string,
    strategy: CompactStrategy,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    switch (strategy) {
      case 'native':  return this.compactByNative(sessionId, options)
      case 'llm':     return this.compactByLlm(sessionId, options)
      case 'summary': return this.compactBySummaryRewrite(sessionId, options)
    }
  }

  /**
   * Default summary rewrite — reads sessionOutputBuffers, calls buildAndStoreSummary
   * which writes session.config.contextSummary, then clears the buffer.
   */
  protected async compactBySummaryRewrite(
    sessionId: string,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AdapterError(
        `Session ${sessionId} not found`,
        this.name,
        ErrorCode.AGENT_SESSION_NOT_FOUND,
      )
    }
    const buffer = this.sessionOutputBuffers.get(sessionId) ?? []
    const before = estimateTokens(buffer.join('\n'))
    const startedAt = Date.now()

    this.buildAndStoreSummary(sessionId)

    const summary = session.config.contextSummary ?? ''
    const after = estimateTokens(summary)
    this.sessionOutputBuffers.set(sessionId, [])

    return {
      sessionId,
      strategy: 'summary',
      trigger: options?.reason ?? 'manual',
      tokensBefore: before,
      tokensAfter: after,
      summary,
      startedAt,
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * Native compact — subclasses override (e.g. Claude Code uses CLI native /compact).
   */
  protected async compactByNative(
    _sessionId: string,
    _options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    throw new AdapterError(
      'Native compaction is not supported by this adapter',
      this.name,
      ErrorCode.AGENT_COMPACT_FAILED,
    )
  }

  /**
   * LLM-based compact — subclasses override (e.g. MCP adapter calls a small model).
   */
  protected async compactByLlm(
    _sessionId: string,
    _options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    throw new AdapterError(
      'LLM-based compaction is not supported by this adapter',
      this.name,
      ErrorCode.AGENT_COMPACT_FAILED,
    )
  }

  /**
   * Subscribe to usage events emitted by reportUsage() (Phase 2 skeleton).
   */
  onUsage(handler: (data: { sessionId: string; inputTokens: number; maxTokens?: number }) => void): void {
    this.on('usage', handler)
  }

  offUsage(handler: (data: { sessionId: string; inputTokens: number; maxTokens?: number }) => void): void {
    this.off('usage', handler)
  }

  /**
   * Report authoritative token usage from the adapter/SDK.
   * Phase 2: skeleton; Phase 3: claude-code/codex/mcp-adapter call this
   * after receiving real usage from their SDK/API responses.
   */
  protected reportUsage(sessionId: string, inputTokens: number, maxTokens?: number): void {
    this.emit('usage', { sessionId, inputTokens, maxTokens })
  }
}

/**
 * Phase 4: shared schema for the dispatch_subagent tool exposed by adapters
 * supporting subagent dispatch (Claude Code via createSdkMcpServer, MCP via tools array).
 */
export const DISPATCH_SUBAGENT_TOOL_NAME = 'dispatch_subagent'

export const DISPATCH_SUBAGENT_TOOL_SCHEMA = {
  name: DISPATCH_SUBAGENT_TOOL_NAME,
  description: 'Spawn an ephemeral subagent for a focused task. Multiple calls may be issued in one turn to run in parallel. The subagent runs with a constrained tool set and file scope; its final output is returned to you as the tool result.',
  input_schema: {
    type: 'object' as const,
    properties: {
      agent_type: {
        type: 'string' as const,
        description: 'Which subagent type to spawn.',
        enum: ['explore', 'implement', 'review', 'fix', 'general'],
      },
      description: {
        type: 'string' as const,
        description: 'A 3-5 word label for the task.',
      },
      prompt: {
        type: 'string' as const,
        description: 'Full task instructions. The subagent only sees this text.',
      },
      adapter_name: {
        type: 'string' as const,
        description: 'Optional adapter override (defaults to the type default).',
      },
      node_id: {
        type: 'string' as const,
        description: 'Optional canvas node binding.',
      },
      allowed_files: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Optional file allow-list for subset/fresh scope strategies.',
      },
    },
    required: ['agent_type', 'description', 'prompt'],
  },
} as const

interface InlineToolCall {
  tool: string
  args: Record<string, unknown>
}

type ToolHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; result: string }
