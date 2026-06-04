/**
 * NDJSON (Newline Delimited JSON) 通信协议层
 *
 * 为 Agent CLI 适配器提供结构化的 stdin/stdout 通信封装。
 * 解决原生 `proc.stdin.write(prompt + '\n')` 的不可靠问题：
 * - 消息边界模糊（换行符可能与内容冲突）
 * - 无类型信息，输出解析依赖正则
 * - 无法区分元数据、进度、结果
 *
 * 设计原则：
 * 1. 向后兼容：协议层是可选的，适配器可 fallback 到原始文本模式
 * 2. 渐进增强：CLI 支持 JSON 则启用，不支持则保持原样
 * 3. 容错：解析错误不崩溃，降级为原始文本输出
 */

import type { ChildProcess } from 'node:child_process'
import type { AgentOutput } from '@shared/types'

// ============================================
// 协议消息类型
// ============================================

/** 输入消息（主进程 -> CLI） */
export interface ProtocolInputMessage {
  /** 协议版本 */
  version: '1.0'
  /** 消息类型 */
  type: 'command' | 'ping'
  /** 关联的命令 ID */
  id: string
  /** 时间戳 */
  timestamp: number
  /** 载荷 */
  payload: ProtocolCommandPayload | ProtocolPingPayload
}

/** command 类型载荷 */
export interface ProtocolCommandPayload {
  action: 'implement' | 'fix_bug' | 'refactor' | 'add_test'
  description: string
  /** 范围上下文（可选，首次发送时携带） */
  scope?: Record<string, unknown>
}

/** ping 类型载荷 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProtocolPingPayload {
  // 空载荷
}

/** 输出消息（CLI -> 主进程） */
export interface ProtocolOutputMessage {
  /** 协议版本 */
  version: '1.0'
  /** 消息类型 */
  type: 'progress' | 'result' | 'file_change' | 'error' | 'tool_call' | 'pong'
  /** 关联输入消息的 ID */
  id?: string
  /** 时间戳 */
  timestamp: number
  /** 载荷 */
  payload: unknown
}

/** progress 载荷 */
export interface ProtocolProgressPayload {
  /** 进度描述 */
  message: string
  /** 可选进度百分比 0-100 */
  percent?: number
}

/** result 载荷 */
export interface ProtocolResultPayload {
  /** 最终输出文本 */
  content: string
  /** 是否成功完成 */
  success: boolean
  /** 使用的 token 数（如果 CLI 提供） */
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** file_change 载荷 */
export interface ProtocolFileChangePayload {
  /** 文件路径 */
  path: string
  /** 变更类型 */
  changeType: 'add' | 'modify' | 'delete'
  /** 变更描述 */
  description?: string
}

/** error 载荷 */
export interface ProtocolErrorPayload {
  /** 错误码 */
  code: string
  /** 错误信息 */
  message: string
  /** 是否可恢复 */
  recoverable?: boolean
}

/** tool_call 载荷 */
export interface ProtocolToolCallPayload {
  /** 工具名称 */
  tool: string
  /** 工具参数 */
  params: Record<string, unknown>
  /** 工具输出 */
  output?: string
}

// ============================================
// 协议处理器
// ============================================

export type ProtocolMessageHandler = (message: ProtocolOutputMessage) => void
export type ProtocolErrorHandler = (err: Error, rawLine: string) => void

/**
 * NDJSON 协议处理器
 *
 * 封装基于换行分隔 JSON 的进程间通信：
 * - 发送：将对象序列化为 JSON + '\n'
 * - 接收：按行缓冲，逐行解析 JSON
 */
export class JsonProtocolHandler {
  private proc: ChildProcess
  private buffer = ''
  private messageHandlers: ProtocolMessageHandler[] = []
  private errorHandlers: ProtocolErrorHandler[] = []
  private isEnabled = false
  private stdoutListener?: (data: Buffer) => void

  constructor(proc: ChildProcess) {
    this.proc = proc
  }

  /**
   * 检测对端是否支持协议
   *
   * 发送一个 ping 消息，如果在 3 秒内收到 pong 响应，
   * 则认为对端支持 NDJSON 协议。
   */
  async handshake(timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.offMessage(onPong)
        this.offError(onError)
        this.isEnabled = false
        resolve(false)
      }, timeoutMs)

      const onPong = (msg: ProtocolOutputMessage) => {
        if (msg.type === 'pong') {
          clearTimeout(timer)
          this.offMessage(onPong)
          this.offError(onError)
          this.isEnabled = true
          resolve(true)
        }
      }

      const onError = (_err: Error, _raw: string) => {
        // 解析错误说明对端可能不支持 JSON，等待超时
      }

      this.onMessage(onPong)
      this.onError(onError)
      this.attachStdoutListener()

      // 发送 ping
      this.sendRaw({
        version: '1.0',
        type: 'ping',
        id: `ping-${Date.now()}`,
        timestamp: Date.now(),
        payload: {},
      })
    })
  }

  /**
   * 直接启用协议（跳过 handshake，用于已知支持协议的 CLI）
   */
  enable(): void {
    this.isEnabled = true
    this.attachStdoutListener()
  }

  /**
   * 发送结构化消息
   */
  send(message: Omit<ProtocolInputMessage, 'version'>): boolean {
    if (!this.proc.stdin || this.proc.stdin.writableEnded) {
      return false
    }
    const fullMessage: ProtocolInputMessage = {
      version: '1.0',
      ...message,
    }
    return this.sendRaw(fullMessage)
  }

  /**
   * 注册消息处理器
   */
  onMessage(handler: ProtocolMessageHandler): void {
    this.messageHandlers.push(handler)
  }

  /**
   * 移除消息处理器
   */
  offMessage(handler: ProtocolMessageHandler): void {
    const idx = this.messageHandlers.indexOf(handler)
    if (idx !== -1) {
      this.messageHandlers.splice(idx, 1)
    }
  }

  /**
   * 注册错误处理器
   */
  onError(handler: ProtocolErrorHandler): void {
    this.errorHandlers.push(handler)
  }

  /**
   * 移除错误处理器
   */
  offError(handler: ProtocolErrorHandler): void {
    const idx = this.errorHandlers.indexOf(handler)
    if (idx !== -1) {
      this.errorHandlers.splice(idx, 1)
    }
  }

  /**
   * 协议是否已启用
   */
  get enabled(): boolean {
    return this.isEnabled
  }

  /**
   * 清理监听器
   */
  dispose(): void {
    if (this.stdoutListener && this.proc.stdout) {
      this.proc.stdout.off('data', this.stdoutListener)
    }
    this.stdoutListener = undefined
    this.messageHandlers = []
    this.errorHandlers = []
    this.buffer = ''
    this.isEnabled = false
  }

  // ============================================
  // 私有方法
  // ============================================

  private sendRaw(message: ProtocolInputMessage): boolean {
    if (!this.proc.stdin || this.proc.stdin.writableEnded) {
      return false
    }
    try {
      const line = JSON.stringify(message) + '\n'
      this.proc.stdin.write(line)
      return true
    } catch {
      return false
    }
  }

  private attachStdoutListener(): void {
    if (this.stdoutListener || !this.proc.stdout) {
      return
    }

    this.stdoutListener = (data: Buffer) => {
      this.buffer += data.toString('utf-8')
      // 防止单行超大输出导致 OOM（10MB 上限）
      if (this.buffer.length > 10 * 1024 * 1024) {
        console.error('[JsonProtocol] Buffer exceeded 10MB limit, resetting')
        this.buffer = ''
        // 通知 errorHandlers，让上层适配器能感知并终止 session
        for (const handler of this.errorHandlers) {
          try {
            handler(new Error('BUFFER_OVERFLOW: stdout buffer exceeded 10MB limit'), '')
          } catch (err) {
            console.error('[JsonProtocol] buffer overflow handler error:', err)
          }
        }
        return
      }
      this.flushBuffer()
    }

    this.proc.stdout.on('data', this.stdoutListener)
  }

  private flushBuffer(): void {
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (line.length === 0) continue

      // 尝试解析 JSON
      const parsed = this.tryParseLine(line)
      if (parsed) {
        for (const handler of this.messageHandlers) {
          try {
            handler(parsed)
          } catch (err) {
            // 处理器异常不应中断协议
            console.error('[JsonProtocol] handler error:', err)
          }
        }
      } else {
        // 不是合法 JSON 行，通知错误处理器
        for (const handler of this.errorHandlers) {
          try {
            handler(new Error('Invalid JSON line'), line)
          } catch (err) {
            console.error('[JsonProtocol] error handler error:', err)
          }
        }
      }
    }
  }

  private tryParseLine(line: string): ProtocolOutputMessage | null {
    // 快速排除：不以 { 开头的不可能是我们的 JSON 消息
    if (!line.startsWith('{')) {
      return null
    }
    try {
      const parsed = JSON.parse(line) as unknown
      // 协议校验：必须有 version 和 type 字段
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'version' in parsed &&
        'type' in parsed &&
        (parsed as Record<string, unknown>).version === '1.0'
      ) {
        return parsed as ProtocolOutputMessage
      }
      return null
    } catch {
      return null
    }
  }
}

// ============================================
// 协议输出转换器
// ============================================

/**
 * 将协议消息转换为 AgentOutput
 */
export function protocolMessageToAgentOutput(msg: ProtocolOutputMessage): AgentOutput | null {
  switch (msg.type) {
    case 'progress': {
      const p = msg.payload as ProtocolProgressPayload
      return {
        type: 'stdout',
        data: p.percent !== undefined ? `[${p.percent}%] ${p.message}` : p.message,
        timestamp: msg.timestamp,
      }
    }
    case 'result': {
      const r = msg.payload as ProtocolResultPayload
      return {
        type: r.success ? 'complete' : 'error',
        data: r.content,
        timestamp: msg.timestamp,
      }
    }
    case 'file_change': {
      const f = msg.payload as ProtocolFileChangePayload
      return {
        type: 'file_change',
        data: `${f.changeType}: ${f.path}`,
        timestamp: msg.timestamp,
        filePath: f.path,
        changeType: f.changeType,
      }
    }
    case 'error': {
      const e = msg.payload as ProtocolErrorPayload
      return {
        type: 'error',
        data: `[${e.code}] ${e.message}`,
        timestamp: msg.timestamp,
      }
    }
    case 'tool_call': {
      const t = msg.payload as ProtocolToolCallPayload
      return {
        type: 'stdout',
        data: `Tool: ${t.tool}\nParams: ${JSON.stringify(t.params, null, 2)}`,
        timestamp: msg.timestamp,
      }
    }
    case 'pong':
      // 内部握手消息，不对外暴露
      return null
    default:
      return null
  }
}

// ============================================
// 带长度前缀的备选协议（Length-Prefixed JSON）
// ============================================

/**
 * 当 NDJSON 因换行符冲突而不可用时，可使用长度前缀协议：
 * `<length>:<json>\n`
 *
 * 例如：`42:{"type":"command","action":"implement"}\n`
 *
 * 当前版本保留为扩展点，暂不实现。
 */
export class LengthPrefixedProtocolHandler {
  // 扩展点：如需实现，参考 JsonProtocolHandler 的结构
}
