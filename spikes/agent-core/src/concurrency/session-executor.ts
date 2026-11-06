import { RunLockRegistry } from './run-lock'

/**
 * 新文档 §7.1 的 SessionExecutor 最小实现。
 * 一次 submit = 一个 run/turn；只负责串行与重入，不做调度。
 */
export class SessionExecutor {
  readonly locks = new RunLockRegistry()

  submit<T>(runId: string, _turnId: string, job: () => Promise<T> | T): Promise<T> {
    return this.locks.runExclusive(runId, job)
  }
}
