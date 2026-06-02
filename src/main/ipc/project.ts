/**
 * Project IPC Handlers
 * 项目扫描、分析
 */

import type { Client } from '@libsql/client'
import { ProjectScanner } from '../project-scanner'
import { GraphService } from '../services/graph-service'
import { validateProjectPath } from './utils'
import type { AgentManager } from '../agent/agent-manager'
import type { TypedHandle } from './utils'

export function registerProjectHandlers(db: Client, typedHandle: TypedHandle, agentManager?: AgentManager): void {
  const graphService = new GraphService(db, agentManager)

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
}
