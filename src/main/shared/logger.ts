import { redactTextForLog, redactUnknown } from './redaction'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const DEFAULT_LEVEL: LogLevel =
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production' ? 'warn' : 'debug'

let currentLevel: LogLevel = DEFAULT_LEVEL

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

/**
 * 日志入参脱敏（P1 隐私）：日志会进终端/落盘，命令原文里的 token/密码不能跟着走。
 * 错误保持 name + message（堆栈由崩溃转储负责，不在这里强制处理，见文档）。
 */
function redactLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactTextForLog(arg)
  if (typeof arg === 'object' && arg !== null) return redactUnknown(arg)
  return arg
}

class Logger {
  constructor(private module: string) {}

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel]
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.info(`[${new Date().toISOString()}] [${this.module}]`, ...args.map(redactLogArg))
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.info(`[${new Date().toISOString()}] [${this.module}]`, ...args.map(redactLogArg))
    }
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[${new Date().toISOString()}] [${this.module}]`, ...args.map(redactLogArg))
    }
  }

  error(...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(`[${new Date().toISOString()}] [${this.module}]`, ...args.map(redactLogArg))
    }
  }
}

export function createLogger(module: string): Logger {
  return new Logger(module)
}