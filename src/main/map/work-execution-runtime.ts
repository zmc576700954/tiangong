/**
 * 主进程执行触发的装配与异步 tick 驱动。
 *
 * 只在 `BIZGRAPH_MAP_EXECUTION` 显式开启、且配置了 pinned adapter 时启动循环。
 * tick 不在 IPC handler 内联跑 turn：handler 只入队/取消，turn 由此处的单实例循环
 * 每 `intervalMs` 驱动一次（上一轮未结束不会重入）。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { getKernelBackendPolicy } from '../agent/runtime/feature-flags'
import { createLogger } from '../shared/logger'
import { AgentManagerTurnRunner, type KernelOnlyTurnHost } from './agent-step-runner'
import { isMapExecutionEnabled, mapExecutionAdapter } from './execution-flags'
import { setWorkExecutionService } from './work-execution-registry'
import {
  WorkExecutionService,
  type KernelCapabilityProbe,
  type WorkExecutionEvent,
} from './work-execution-service'

const logger = createLogger('MapExecutionRuntime')

export interface StartWorkExecutionOptions {
  db: BetterSqlite3.Database
  host: KernelOnlyTurnHost
  /** adapter 是否已注册（driver 探测）；缺省视为存在，由 sendCommandKernelOnly 兜底拒绝。 */
  hasAdapter?: (adapterName: string) => boolean
  intervalMs?: number
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = true

/**
 * 生产能力探测：kernel 策略 + runtime 装配 + adapter 是否存在。
 * - `runtime: true`：ipc-handlers 启动期必定 setRuntime；若真缺失，kernel-only 发送会抛错
 *   （fail-closed），不会回退 legacy。
 * - `degraded`（UNSAFE 强制无审批后端）一律视为不可编排：执行触发不接受免审降级。
 */
function buildProbe(hasAdapter?: (name: string) => boolean) {
  return (adapterName: string): KernelCapabilityProbe => {
    const policy = getKernelBackendPolicy(adapterName)
    return {
      kernel: policy.kernel && !policy.degraded,
      runtime: true,
      driver: hasAdapter ? hasAdapter(adapterName) : true,
      reason: policy.reason,
    }
  }
}

async function broadcastEvent(event: WorkExecutionEvent): Promise<void> {
  try {
    const { BrowserWindow } = await import('electron')
    const payload = {
      lineageId: event.lineageId,
      revision: event.revision,
      status: event.status,
      ...(event.reason ? { reason: event.reason } : {}),
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('event:work-item-changed', payload)
    }
  } catch (error) {
    logger.warn(`[event] 广播失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 装配服务并（在开关+adapter 都就绪时）启动 tick 循环。 */
export function startWorkExecutionRuntime(options: StartWorkExecutionOptions): void {
  const service = new WorkExecutionService(options.db, new AgentManagerTurnRunner(options.host), {
    probeKernel: buildProbe(options.hasAdapter),
    onEvent: (event) => {
      void broadcastEvent(event)
    },
  })
  setWorkExecutionService(service)

  if (!isMapExecutionEnabled()) {
    logger.info('执行触发未开启（默认关闭）：tick 不启动，写通道将拒绝调用')
    return
  }
  const adapterName = mapExecutionAdapter()
  if (!adapterName) {
    logger.warn('执行触发已开启但未配置 pinned adapter：tick 不启动（无路由结论不猜执行器）')
    return
  }

  stopped = false
  const intervalMs = options.intervalMs ?? 1000
  const loop = async (): Promise<void> => {
    if (stopped) return
    try {
      await service.tick({ adapterName })
    } catch (error) {
      logger.error(`tick 异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs)
  }
  timer = setTimeout(() => void loop(), intervalMs)
  logger.info(`执行触发已启动：adapter=${adapterName} interval=${intervalMs}ms`)
}

export function stopWorkExecutionRuntime(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
  setWorkExecutionService(null)
}
