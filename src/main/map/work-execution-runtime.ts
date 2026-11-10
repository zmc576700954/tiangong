/**
 * 主进程执行触发的装配与异步 tick 驱动。
 *
 * 只在 `BIZGRAPH_MAP_EXECUTION` 显式开启、且配置了 pinned adapter 时启动循环。
 * tick 不在 IPC handler 内联跑 turn：handler 只入队/取消，turn 由此处的单实例循环
 * 每 `intervalMs` 驱动一次（上一轮未结束不会重入）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { getKernelBackendPolicy } from '../agent/runtime/feature-flags'
import { createLogger } from '../shared/logger'
import { AgentManagerTurnRunner, type KernelOnlyTurnHost } from './agent-step-runner'
import { evaluateAcceptance } from './acceptance-executor'
import { createGateEngine, type GateEngineOptions } from './gate-engine'
import { isMapExecutionEnabled, mapExecutionAdapter } from './execution-flags'
import { setWorkExecutionService } from './work-execution-registry'
import {
  WorkExecutionService,
  type KernelCapabilityProbe,
  type WorkExecutionEvent,
} from './work-execution-service'
import type { AgentRuntimeTimeouts } from '@shared/types/agent-runtime'
import type { WorkspaceLeaseRegistry } from '../agent/runtime/locks/workspace-lease'

const logger = createLogger('MapExecutionRuntime')

/** D7 裁决（2026-11-07）：G4 生产阈值 env 可调；非法值回退默认并告警（不静默放宽/收紧）。 */
export function readG4Config(): Pick<GateEngineOptions, 'g4MaxFiles' | 'g4MaxLines'> {
  const readPositiveInt = (key: string, fallback: number): number => {
    const raw = process.env[key]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
      logger.warn(`[g4] ${key}=${raw} 非法，回退默认 ${fallback}`)
      return fallback
    }
    return value
  }
  return {
    g4MaxFiles: readPositiveInt('BIZGRAPH_MAP_EXECUTION_G4_MAX_FILES', 20),
    g4MaxLines: readPositiveInt('BIZGRAPH_MAP_EXECUTION_G4_MAX_LINES', 800),
  }
}

/** 行数缓存：mtime+size 命中即复用，避免每 tick 重读大文件。 */
const lineCache = new Map<string, { mtimeMs: number; size: number; lines: number }>()

function countLines(absPath: string, stat: fs.Stats): number {
  const cached = lineCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.lines
  const content = fs.readFileSync(absPath, 'utf8')
  const lines = content.length === 0 ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  lineCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, lines })
  return lines
}

/**
 * D7 裁决的预估行数来源：Σ scope 文件行数的确定性代理。
 * - 已存在文件按实际行数（mtime+size 缓存）；不存在的文件（将新建）计 0，
 *   新建规模由 G4 文件数上限约束。
 * - scope 指向目录、stat/读取失败 → 返回 null，引擎按 fail-closed
 *   `line_estimate_unavailable` 处理（不猜、不跳过）。
 * 真实改动行数属执行后 evidence 对比（超限是执行后审计），不归准入判定。
 */
function buildEstimateLines(): (files: string[], projectPath: string | null) => number | null {
  return (files, projectPath) => {
    if (!projectPath) return null
    let total = 0
    for (const file of files) {
      const abs = path.resolve(projectPath, file)
      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (!stat.isFile()) return null
      try {
        total += countLines(abs, stat)
      } catch {
        return null
      }
    }
    return total
  }
}

export { buildEstimateLines }

export interface StartWorkExecutionOptions {
  db: BetterSqlite3.Database
  host: KernelOnlyTurnHost
  /** adapter 是否已注册（driver 探测）；缺省视为存在，由 sendCommandKernelOnly 兜底拒绝。 */
  hasAdapter?: (adapterName: string) => boolean
  intervalMs?: number
  /** v36 / G3-7/G3-8：`agentRuntime.timeouts`（未配置回落实常量）。 */
  timeouts?: AgentRuntimeTimeouts
  /**
   * G3-2：跨进程项目写闸。生产必须传 `AgentManager.getWorkspaceLease()` 的
   * 同一个 registry（与 runtime.runNode 共用）；缺省 = 无闸。
   */
  lease?: WorkspaceLeaseRegistry
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
      ...(event.stepId ? { stepId: event.stepId } : {}),
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
    // 生产 gate：G1–G6 引擎（只读、fail-closed）；D1/D7 裁决后预估来源与
    // G4 阈值在此装配（§M5.7）。
    gateRecheck: createGateEngine(options.db, {
      ...readG4Config(),
      estimateLines: buildEstimateLines(),
    }),
    probeKernel: buildProbe(options.hasAdapter),
    // D2：completed 后跑确定性验收（command 退出码 / file_check 存在性），
    // 判定不出即 verify_fail，不默认通过（§14.8）。
    verifyAcceptance: ({ acceptanceJson, projectPath }) =>
      evaluateAcceptance({ acceptanceJson, projectPath }),
    onEvent: (event) => {
      void broadcastEvent(event)
    },
    timeouts: options.timeouts,
    lease: options.lease,
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
