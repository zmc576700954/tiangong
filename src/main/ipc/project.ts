/**
 * Project IPC Handlers
 * 项目扫描、分析
 */

import path from 'node:path'
import type { Client } from '@libsql/client'
import { ProjectScanner } from '../project-scanner'
import { GraphService } from '../services/graph-service'
import { IpcError, ErrorCode } from '../errors'
import type { AgentManager } from '../agent/agent-manager'
import type { TypedHandle } from './utils'

/** 校验项目路径安全性：拒绝路径遍历和系统关键目录 */
function validateProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath)
  const normalized = path.normalize(resolved)

  // 拒绝系统关键目录
  const blockedPrefixes = process.platform === 'win32'
    ? [
        path.resolve(process.env.SystemRoot || 'C:\\Windows'),
        path.resolve('C:\\Program Files'),
        path.resolve('C:\\Program Files (x86)'),
      ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
        '/opt', '/sys', '/proc', '/dev',
      ]

  const sep = path.sep
  for (const blocked of blockedPrefixes) {
    const normalizedBlocked = path.normalize(blocked)
    const isBlocked = process.platform === 'win32'
      ? normalized.toLowerCase().startsWith(normalizedBlocked.toLowerCase() + sep) ||
        normalized.toLowerCase() === normalizedBlocked.toLowerCase()
      : normalized.startsWith(normalizedBlocked + sep) || normalized === normalizedBlocked
    if (isBlocked) {
      throw new IpcError(`Access denied: cannot scan system directory`, ErrorCode.IPC_ACCESS_DENIED)
    }
  }

  // 确保路径不是 root 或 home 目录本身（只允许子目录）
  if (process.platform !== 'win32') {
    if (normalized === '/' || normalized === '/root' || normalized === process.env.HOME) {
      throw new IpcError('Access denied: cannot scan root or home directory, please select a project subdirectory', ErrorCode.IPC_ACCESS_DENIED)
    }
  }

  return normalized
}

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
