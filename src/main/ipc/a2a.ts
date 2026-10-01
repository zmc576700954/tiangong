/**
 * A2A IPC Handlers
 *
 * Phase D9 C6. 暴露给渲染进程的 A2A 操作（server lifecycle + 远端 agent CRUD）：
 *   - a2a:getServerStatus        → A2AServerStatus
 *   - a2a:startServer            → { success, port, error? }
 *   - a2a:stopServer             → { success }
 *   - a2a:testConnection(name)   → { ok, card?, error?, latencyMs }
 *   - a2a:listRemoteAgents       → A2ARemoteAgent[]（apiKey 已遮蔽）
 *   - a2a:saveRemoteAgent        → { success, error? }
 *   - a2a:deleteRemoteAgent(name)→ { success }
 *   - a2a:testServerConfig(cfg)  → { valid, errors }
 *
 * 与 Recipe IPC（src/main/ipc/recipe.ts）同模式：使用 createTypedHandle 包装，
 * 由 utils 统一做 IpcError 透传与频率限制。
 *
 * 设计：
 *   - 渲染进程永远拿到 masked 值（apiKey 字段 maskApiKey 后下发）
 *   - 写入若遇到 masked 值 → 复用 settings.json 中的已存明文
 *   - 启用/停用 server 由 settings 写入触发（writeSettings → onChange → wiring 热重载）；
 *     a2a:startServer / a2a:stopServer 只是把用户操作转化为 settings 改动
 *     然后广播 a2a:serverStatusChange 给所有渲染进程窗口。
 */

import { BrowserWindow } from 'electron'
import type { TypedHandle } from './utils'
import { ensureString } from './utils'
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import type { A2AController } from '../a2a/wiring'
import { getA2AServerStatus } from '../a2a/server'
import type { A2ABindAddress, A2ARemoteAgent, A2AServerConfig, A2AServerStatus } from '@shared/types/a2a'
import { A2A_MIN_API_KEY_LENGTH } from '@shared/types/a2a'
import { assertSafeEndpointSync } from '../a2a/endpoint-guard'
import type { BizGraphSettings } from '@shared/types'

const logger = createLogger('A2A-IPC')

/** 与 settings IPC 同步的 apiKey 遮蔽正则（最小 4 个连续星号）。 */
const MASKED_KEY_PATTERN = /^\S{0,4}\*{4,}\S{0,4}$/

/**
 * 把读路径返回的 apiKey 字段遮蔽。同步与 renderer 不一致会泄密，
 * 所以与 `src/main/ipc/settings.ts:18` 共享同一 pattern。
 */
function maskAgent(agent: A2ARemoteAgent): A2ARemoteAgent {
  if (!agent.apiKey) return agent
  if (MASKED_KEY_PATTERN.test(agent.apiKey)) return agent
  const k = agent.apiKey
  if (k.length <= 8) return { ...agent, apiKey: '****' }
  return { ...agent, apiKey: k.slice(0, 4) + '****' + k.slice(-4) }
}

function maskSmsStatus(status: ReturnType<typeof getA2AServerStatus>): A2AServerStatus {
  // apiKey 不在 status 中，无需遮蔽；保留为 identity 便于将来加字段。
  // 把 getA2AServerStatus 返回的 `bindAddress: string` 收窄为 `A2ABindAddress`：
  // config 校验要求 bindAddress 必为 '127.0.0.1' | '0.0.0.0'，运行时不会溢出。
  return { ...status, bindAddress: status.bindAddress as A2ABindAddress | undefined }
}

/**
 * 给所有未销毁窗口广播 a2a:serverStatusChange。
 * 由 settings.onChange / startServer / stopServer 调用。
 *
 * 接收 getA2AServerStatus 的宽类型（bindAddress: string）并收窄为
 * A2ABindAddress — config 校验保证运行时不会溢出。
 */
export function broadcastA2AStatusChange(status: ReturnType<typeof getA2AServerStatus>): A2AServerStatus {
  const payload = maskSmsStatus(status)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('a2a:serverStatusChange', payload)
    }
  }
  return payload
}

export interface A2AHandlerDeps {
  controller: A2AController
  /**
   * 提供 settings 读写与热重载；这里通过参数注入以避免 ipc/a2a 直接耦合 settings 模块
   * （settings.ts 模块图反向引用 ipc/a2a 时会构成循环依赖）。
   */
  settingsApi: {
    read(): Promise<BizGraphSettings>
    write(s: BizGraphSettings): Promise<void>
  }
}

/**
 * 注册 8 个 A2A IPC handlers。
 *
 * `controller` 由 `ipc-handlers.ts` 在 `wireA2ASubsystem` 返回值中捕获。
 * `settingsApi` 由调用方构造（包成 Promise<...>）。
 */
export function registerA2AHandlers(deps: A2AHandlerDeps, typedHandle: TypedHandle): void {
  const { controller, settingsApi } = deps

  /** 重新拉一次 server status 并广播（wiring 热重载完成后由 invoke 链路调用）。 */
  async function emitStatusChange(): Promise<void> {
    const status = getA2AServerStatus(controller.getServer(), controller.getTaskStore())
    broadcastA2AStatusChange(status)
  }

  typedHandle('a2a:getServerStatus', async () => {
    return maskSmsStatus(getA2AServerStatus(controller.getServer(), controller.getTaskStore()))
  })

  typedHandle('a2a:startServer', async () => {
    const settings = await settingsApi.read()
    if (!settings.a2aServer) {
      throw new IpcError('A2A server config is missing; configure it under Settings → A2A', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const next = { ...settings, a2aServer: { ...settings.a2aServer, enabled: true } }
    await settingsApi.write(next)
    // 等待 hot-reload 触发（同步事件，但 watcher 调用 applySettings 是 async fire-and-forget）。
    // 给 200ms 缓冲：让 startServer() 内部真正完成 bind。
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await emitStatusChange()
    const status = getA2AServerStatus(controller.getServer(), controller.getTaskStore())
    return { success: status.running, port: status.port, error: status.running ? undefined : 'server did not start within timeout' }
  })

  typedHandle('a2a:stopServer', async () => {
    const settings = await settingsApi.read()
    if (!settings.a2aServer) return { success: true }
    const next = { ...settings, a2aServer: { ...settings.a2aServer, enabled: false } }
    await settingsApi.write(next)
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    await emitStatusChange()
    return { success: true }
  })

  typedHandle('a2a:testConnection', async (_event, nameUnknown: unknown) => {
    const name = ensureString('name', nameUnknown)
    return controller.testConnection(name)
  })

  typedHandle('a2a:listRemoteAgents', async () => {
    const settings = await settingsApi.read()
    const list = settings.a2a?.remoteAgents ?? []
    return list.map(maskAgent)
  })

  typedHandle('a2a:saveRemoteAgent', async (_event, agentUnknown: unknown) => {
    if (typeof agentUnknown !== 'object' || agentUnknown === null) {
      throw new IpcError('a2a:saveRemoteAgent requires an agent object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const agent = agentUnknown as A2ARemoteAgent
    if (typeof agent.name !== 'string' || agent.name.length === 0) {
      throw new IpcError('agent.name is required', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (typeof agent.endpoint !== 'string' || agent.endpoint.length === 0) {
      throw new IpcError('agent.endpoint is required', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    // SSRF 同步校验（DNS 解析推迟到 call 时；这里只校验 IP literal）
    try {
      assertSafeEndpointSync(agent.endpoint)
    } catch (err) {
      throw new IpcError(`Invalid endpoint: ${(err as Error).message}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }

    const settings = await settingsApi.read()
    const existing = settings.a2a?.remoteAgents ?? []
    const idx = existing.findIndex((a) => a.name === agent.name)
    // apiKey 若为 masked → 复用旧值（与 settings IPC apiKey 写入同模式）。
    let apiKey: string | undefined = agent.apiKey
    if (apiKey !== undefined && MASKED_KEY_PATTERN.test(apiKey)) {
      const old = idx >= 0 ? existing[idx]?.apiKey : undefined
      apiKey = old
    }
    const sanitized: A2ARemoteAgent = { ...agent, apiKey }
    const next = {
      ...settings,
      a2a: {
        remoteAgents: [
          ...existing.slice(0, idx),
          sanitized,
          ...existing.slice(idx + 1),
        ],
      },
    }
    try {
      await settingsApi.write(next)
    } catch (err) {
      logger.warn('a2a:saveRemoteAgent write failed:', err)
      return { success: false, error: (err as Error).message }
    }
    return { success: true }
  })

  typedHandle('a2a:deleteRemoteAgent', async (_event, nameUnknown: unknown) => {
    const name = ensureString('name', nameUnknown)
    const settings = await settingsApi.read()
    const existing = settings.a2a?.remoteAgents ?? []
    const next = {
      ...settings,
      a2a: { remoteAgents: existing.filter((a) => a.name !== name) },
    }
    try {
      await settingsApi.write(next)
    } catch (err) {
      logger.warn('a2a:deleteRemoteAgent write failed:', err)
      return { success: false }
    }
    return { success: true }
  })

  typedHandle('a2a:testServerConfig', async (_event, cfgUnknown: unknown) => {
    const errors: string[] = []
    if (typeof cfgUnknown !== 'object' || cfgUnknown === null) {
      errors.push('config must be an object')
      return { valid: false, errors }
    }
    const cfg = cfgUnknown as Partial<A2AServerConfig>
    if (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535) {
      errors.push('port must be a number in [1, 65535]')
    }
    if (cfg.bindAddress !== '127.0.0.1' && cfg.bindAddress !== '0.0.0.0') {
      errors.push('bindAddress must be 127.0.0.1 or 0.0.0.0')
    }
    if (typeof cfg.apiKey !== 'string' || cfg.apiKey.length < A2A_MIN_API_KEY_LENGTH) {
      errors.push(`apiKey must be a string of at least ${A2A_MIN_API_KEY_LENGTH} characters`)
    }
    if (cfg.agentCard !== undefined) {
      if (typeof cfg.agentCard !== 'object' || cfg.agentCard === null) {
        errors.push('agentCard must be an object')
      } else if (typeof cfg.agentCard.name !== 'string' || cfg.agentCard.name.length === 0) {
        errors.push('agentCard.name is required')
      }
    }
    return { valid: errors.length === 0, errors }
  })
}