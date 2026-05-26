/**
 * Project IPC Handlers
 * 项目扫描、分析
 */

import type { Client } from '@libsql/client'
import { ProjectScanner } from '../project-scanner'
import { GraphService } from '../services/graph-service'
import type { TypedHandle } from './utils'

export function registerProjectHandlers(db: Client, typedHandle: TypedHandle): void {
  const graphService = new GraphService(db)

  typedHandle('project:scan', async (_, projectPath) => {
    const scanner = new ProjectScanner()
    return scanner.scan(projectPath)
  })

  typedHandle('graph:initFromProject', async (_, data) => {
    return graphService.initFromProject(data)
  })
}
