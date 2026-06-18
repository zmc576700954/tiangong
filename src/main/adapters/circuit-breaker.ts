import { createLogger } from '../shared/logger'

const logger = createLogger('circuit-breaker')

export interface CircuitBreakerConfig {
  failureThreshold?: number
  openDurationMs?: number
}

interface CircuitState {
  state: 'closed' | 'open' | 'half-open'
  failures: number
  lastFailureTime: number
}

export class AdapterCircuitBreaker {
  private _states = new Map<string, CircuitState>()
  private _failureThreshold: number
  private _openDurationMs: number

  constructor(config: CircuitBreakerConfig = {}) {
    this._failureThreshold = config.failureThreshold ?? 3
    this._openDurationMs = config.openDurationMs ?? 30_000
  }

  isCircuitOpen(key: string): boolean {
    const entry = this._getOrCreate(key)
    if (entry.state === 'open') {
      if (Date.now() - entry.lastFailureTime > this._openDurationMs) {
        entry.state = 'half-open'
        logger.info(`Circuit breaker for ${key} transitioned to half-open`)
        return false
      }
      return true
    }
    return false
  }

  getState(key: string): 'closed' | 'open' | 'half-open' {
    const entry = this._getOrCreate(key)
    if (entry.state === 'open' && Date.now() - entry.lastFailureTime > this._openDurationMs) {
      entry.state = 'half-open'
    }
    return entry.state
  }

  recordSuccess(key: string): void {
    const entry = this._getOrCreate(key)
    if (entry.state === 'half-open') {
      entry.state = 'closed'
      entry.failures = 0
      entry.lastFailureTime = 0
      logger.info(`Circuit breaker for ${key} closed after successful half-open request`)
    } else if (entry.state === 'closed') {
      entry.failures = 0
      entry.lastFailureTime = 0
    }
  }

  recordFailure(key: string): void {
    const entry = this._getOrCreate(key)
    entry.failures++
    entry.lastFailureTime = Date.now()

    if (entry.state === 'half-open') {
      entry.state = 'open'
      logger.warn(`Circuit breaker for ${key} re-opened after failure in half-open`)
    } else if (entry.failures >= this._failureThreshold) {
      entry.state = 'open'
      logger.warn(`Circuit breaker for ${key} opened after ${entry.failures} failures`)
    }
  }

  reset(key: string): void {
    this._states.delete(key)
  }

  private _getOrCreate(key: string): CircuitState {
    let entry = this._states.get(key)
    if (!entry) {
      entry = { state: 'closed', failures: 0, lastFailureTime: 0 }
      this._states.set(key, entry)
    }
    return entry
  }
}
