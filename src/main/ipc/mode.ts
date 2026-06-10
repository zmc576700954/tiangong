/**
 * Mode IPC Handlers
 * Agent 工作模式的查询和切换 IPC 通道
 */

import { getModeManager } from '../agent/mode-manager'
import type { TypedHandle } from './utils'
import type { AgentMode, AgentModeConfig } from '@shared/types'
import { createLogger } from '../shared/logger'
import { IpcError, ErrorCode } from '../errors'

const logger = createLogger('ModeIPC')

const MAX_ID_LEN = 200
const VALID_MODES: ReadonlyArray<AgentMode> = ['general', 'security', 'performance', 'refactor']

function ensureProjectId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcError('projectId must be a non-empty string', ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (value.length > MAX_ID_LEN) {
    throw new IpcError(`projectId exceeds max length (${MAX_ID_LEN})`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  return value
}

export function registerModeHandlers(typedHandle: TypedHandle): void {
  /**
   * 获取当前项目的 Agent 工作模式
   */
  typedHandle('mode:getCurrent', async (_event, projectId: string) => {
    const safeProjectId = ensureProjectId(projectId)
    const manager = getModeManager()
    const mode = manager.getMode(safeProjectId)
    logger.debug(`mode:getCurrent for ${safeProjectId} → ${mode}`)
    return mode as AgentMode
  })

  /**
   * 设置当前项目的 Agent 工作模式
   *
   * 严格校验：未知 mode 直接拒绝，绝不静默降级到 general——
   * 静默降级允许只能发任意字符串的攻击面把项目强制设到最宽松模式，
   * 进而影响 MemoryExtractor / agent-manager 的安全边界。
   */
  typedHandle('mode:setCurrent', async (_event, projectId: string, mode: string) => {
    const safeProjectId = ensureProjectId(projectId)
    if (typeof mode !== 'string') {
      throw new IpcError('mode must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (!VALID_MODES.includes(mode as AgentMode)) {
      throw new IpcError(
        `Invalid mode: ${mode}. Valid modes: ${VALID_MODES.join(', ')}`,
        ErrorCode.IPC_INVALID_ARGUMENT,
      )
    }
    const manager = getModeManager()
    manager.setMode(safeProjectId, mode as AgentMode)
    logger.info(`mode:setCurrent for ${safeProjectId} → ${mode}`)
  })

  /**
   * 获取所有可用模式的配置列表
   */
  typedHandle('mode:getAvailable', async () => {
    const manager = getModeManager()
    const modes = manager.getAvailableModes()
    return modes as AgentModeConfig[]
  })
}
