/**
 * Project IPC Handlers
 * 项目扫描、分析
 */

import { ProjectScanner } from '../project-scanner'
import type { GraphService } from '../services/graph-service'
import type { ChatService } from '../services/chat-service'
import { validateProjectPath } from './utils'
import type { TypedHandle } from './utils'
import { IpcError } from '../errors'
import { ErrorCode } from '../errors'
import type { ProjectSettingsRepository } from '../repositories/project-settings-repository'
import type { ProjectDefaults } from '@shared/types'
import { isPathWithinResolved } from '../shared/path-utils'
import path from 'node:path'

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

  /**
   * 项目路径必须是**已登记的项目根**。
   *
   * `validateProjectPath` 只拦系统目录与 root/home，不检查这个路径是不是
   * BizGraph 打开过的项目 —— 与 fs 家族的边界模型不一致（fs 家族用
   * `isUnderProject` 卡这一层）。这里补上同样的一道。
   */
  const requireRegisteredProject = async (projectPath: string): Promise<string> => {
    const validated = validateProjectPath(projectPath)
    const projectRoots = await graphService.getProjectPaths()
    const normalized = path.resolve(validated)
    const isUnderProject = projectRoots.some((root) =>
      isPathWithinResolved(path.resolve(root), normalized),
    )
    if (!isUnderProject) {
      throw new IpcError(
        'Access denied: path is not a registered project directory',
        ErrorCode.IPC_ACCESS_DENIED,
      )
    }
    return validated
  }

  // 项目级默认（适配器 / 模型 / 可改文件范围）。
  typedHandle('project:getDefaults', async (_, projectPath) => {
    if (!projectSettingsRepo) return null
    const validatedPath = await requireRegisteredProject(projectPath)
    return projectSettingsRepo.get(validatedPath) ?? null
  })

  typedHandle('project:setDefaults', async (_, projectPath, defaults: ProjectDefaults) => {
    if (!projectSettingsRepo) return
    const validatedPath = await requireRegisteredProject(projectPath)
    projectSettingsRepo.set(validatedPath, defaults)
  })
}
