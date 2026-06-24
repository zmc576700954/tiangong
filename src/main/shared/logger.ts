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

class Logger {
  constructor(private module: string) {}

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel]
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) console.info(`[${new Date().toISOString()}] [${this.module}]`, ...args)
  }

  info(...args: unknown[]): void {
    if (this.shouldLog('info')) console.info(`[${new Date().toISOString()}] [${this.module}]`, ...args)
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) console.warn(`[${new Date().toISOString()}] [${this.module}]`, ...args)
  }

  error(...args: unknown[]): void {
    if (this.shouldLog('error')) console.error(`[${new Date().toISOString()}] [${this.module}]`, ...args)
  }
}

export function createLogger(module: string): Logger {
  return new Logger(module)
}