/**
 * Project IPC Handlers
 * 项目扫描、分析
 */

import { ProjectScanner } from '../project-scanner'
import type { GraphService } from '../services/graph-service'
import type { ChatService } from '../services/chat-service'
import { validateProjectPath } from './utils'
import type { TypedHandle } from './utils'
import type { ProjectSettingsRepository } from '../repositories/project-settings-repository'
import type { ProjectDefaults } from '@shared/types'

export function registerProjectHandlers(
  typedHandle: TypedHandle,
  graphService: GraphService,
  _chatService?: ChatService,
  projectSettingsRepo?: ProjectSettingsRepository,
): void {
  typedHandle('project:scan', async (_, projectPath) => {
    const validatedPath = validateProjectPath(projectPath)
    const scanner = new ProjectScanner()
    return scanner.scan(validatedPath)
  })

  typedHandle('graph:initFromProject', async (_, data) => {
    // 校验 projectPath
    const validatedPath = validateProjectPath(data.projectPath)
    return graphService.initFromProject({ ...data, projectPath: validatedPath })
  })

  // 项目级默认（适配器 / 模型 / 可改文件范围）。
  // 路径同样要过 validateProjectPath —— 与其余项目级 IPC 一致。
  typedHandle('project:getDefaults', async (_, projectPath) => {
    if (!projectSettingsRepo) return null
    const validatedPath = validateProjectPath(projectPath)
    return projectSettingsRepo.get(validatedPath) ?? null
  })

  typedHandle('project:setDefaults', async (_, projectPath, defaults: ProjectDefaults) => {
    if (!projectSettingsRepo) return
    const validatedPath = validateProjectPath(projectPath)
    projectSettingsRepo.set(validatedPath, defaults)
  })
}
