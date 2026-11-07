/**
 * 生产进程内的执行触发服务单例。
 *
 * 单独拆出来是为了让 `ipc/map.ts` 只依赖一个无 Electron 依赖的取用口，
 * 由 `main/index.ts` 在 DB + AgentManager 就绪后初始化。
 */

import type { WorkExecutionService } from './work-execution-service'

let current: WorkExecutionService | null = null

export function setWorkExecutionService(service: WorkExecutionService | null): void {
  current = service
}

export function getWorkExecutionService(): WorkExecutionService | null {
  return current
}
