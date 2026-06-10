/**
 * Mode IPC Handlers
 * Agent 工作模式的查询和切换 IPC 通道
 */

import { getModeManager } from '../agent/mode-manager'
import type { TypedHandle } from './utils'
import type { AgentMode, AgentModeConfig } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('ModeIPC')

export function registerModeHandlers(typedHandle: TypedHandle): void {
  /**
   * 获取当前项目的 Agent 工作模式
   */
  typedHandle('mode:getCurrent', async (_event, projectId: string) => {
    const manager = getModeManager()
    const mode = manager.getMode(projectId)
    logger.debug(`mode:getCurrent for ${projectId} → ${mode}`)
    return mode as AgentMode
  })

  /**
   * 设置当前项目的 Agent 工作模式
   */
  typedHandle('mode:setCurrent', async (_event, projectId: string, mode: string) => {
    const manager = getModeManager()
    const validModes: AgentMode[] = ['general', 'security', 'performance', 'refactor']
    if (!validModes.includes(mode as AgentMode)) {
      logger.warn(`Invalid mode requested: ${mode}, falling back to general`)
      manager.setMode(projectId, 'general')
      return
    }
    manager.setMode(projectId, mode as AgentMode)
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
