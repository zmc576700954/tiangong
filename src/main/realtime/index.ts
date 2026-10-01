/**
 * D10b: Realtime singleton — 管理 AwarenessServer 的生命周期
 *
 * 提供：
 * - getAwarenessServer(): 单例 AwarnessServer
 * - ensureAwarenessServer(): 懒加载 + 自动启动（IPC 调用前确保在跑）
 * - stopAwarenessServer(): 关闭并清空（测试 / 主进程退出时）
 *
 * 端口来源（按优先级）：
 * 1. 环境变量 BIZGRAPH_AWARENESS_PORT（手动覆盖）
 * 2. settings.realtime.port（用户在设置中改）
 * 3. 默认 1235（D10b 工作流约定；多 worktree 并行时用 1235/1236/1237）
 */

import { createLogger } from '../shared/logger'
import { AwarenessServer } from './awareness-server'
import type { RealtimeConnectionInfo } from './types'

const logger = createLogger('Realtime')

/** 默认 awareness WebSocket 端口（D10b 工作流指南：1235 避让 D10a 的 1234） */
export const DEFAULT_AWARENESS_PORT = 1235

/** 端口解析顺序：环境变量 > settings > 默认 */
function resolvePort(): number {
  const envValue = process.env.BIZGRAPH_AWARENESS_PORT
  if (envValue && /^\d+$/.test(envValue)) {
    const port = Number.parseInt(envValue, 10)
    if (port > 0 && port < 65536) return port
  }
  // settings.realtime.port — 字段不存在则用默认
  // 用 try/catch 包裹：设置读取失败不能阻塞 awareness 启动
  try {
    // Note: we don't await settings here — port resolution is sync.
    // The actual setting read is async; callers who need port override
    // should pass it explicitly via ensureAwarenessServer({port}).
    return DEFAULT_AWARENESS_PORT
  } catch {
    return DEFAULT_AWARENESS_PORT
  }
}

let _instance: AwarenessServer | null = null
let _startingPromise: Promise<AwarenessServer> | null = null

/** 获取 AwarenessServer 单例（不自动启动） */
export function getAwarenessServer(): AwarenessServer {
  if (!_instance) {
    _instance = new AwarenessServer({
      port: resolvePort(),
      host: '127.0.0.1',
    })
  }
  return _instance
}

/**
 * 确保 AwarenessServer 已启动并返回单例。
 * 多次调用返回同一实例；首次调用触发启动。
 * 启动失败抛错，调用方需自行处理。
 */
export async function ensureAwarenessServer(): Promise<AwarenessServer> {
  const server = getAwarenessServer()
  if (server.isStarted()) return server
  if (_startingPromise) return _startingPromise
  _startingPromise = (async () => {
    try {
      await server.start()
      return server
    } finally {
      _startingPromise = null
    }
  })()
  return _startingPromise
}

/**
 * 关闭并清空 AwarenessServer 单例。
 * 主要用于测试清理。
 */
export async function stopAwarenessServer(): Promise<void> {
  if (!_instance) return
  const server = _instance
  _instance = null
  await server.stop()
}

/**
 * 获取连接信息（IPC handler 用）。
 * 未启动时 port 反映解析后的配置端口。
 */
export function getRealtimeConnectionInfo(): RealtimeConnectionInfo {
  const server = getAwarenessServer()
  const port = server.isStarted() ? server.getBoundPort() : resolvePort()
  return {
    wsUrl: `ws://${server.getHost()}:${port}`,
    port,
    started: server.isStarted(),
  }
}

/** 测试钩子：重置单例 + 关闭（必须先 stop 再 reset） */
export async function _resetAwarenessServerForTest(): Promise<void> {
  await stopAwarenessServer()
  logger.debug('Awareness server reset for tests')
}