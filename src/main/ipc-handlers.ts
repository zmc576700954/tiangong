/**
 * IPC 通信处理器入口
 * 组装并注册所有领域 IPC handlers
 */

import { BrowserWindow, app, ipcMain } from 'electron'
import path from 'node:path'
import { getClient } from './database'
import { ClaudeCodeAdapter } from './adapters/claude-code'
import { CodexAdapter } from './adapters/codex'
import { OpenCodeAdapter } from './adapters/opencode'
import { McpAdapter } from './adapters/mcp-adapter'
import { CursorAdapter } from './adapters/cursor'
import { GitAgent } from './git-agent'
import { AdapterRegistry } from './agent/adapter-registry'
import { SessionRouter } from './agent/session-router'
import { OutputBroadcaster } from './agent/output-broadcaster'
import { AgentManager } from './agent/agent-manager'
import { AgentService } from './services/agent-service'
import { GraphService } from './services/graph-service'
import { IpcError, ErrorCode } from './errors'

import { createTypedHandle } from './ipc/utils'
import { registerGraphHandlers } from './ipc/graph'
import { registerAgentHandlers } from './ipc/agent'
import { registerFsHandlers } from './ipc/fs'
import { registerGitHandlers } from './ipc/git'
import { registerProjectHandlers } from './ipc/project'
import { registerSettingsHandlers } from './ipc/settings'
import { registerDialogHandlers } from './ipc/dialog'
import { registerMindmapHandlers } from './ipc/mindmap'
import { registerChatHandlers } from './ipc/chat'
import { ChatService } from './services/chat-service'
import type { ValidateFsPath } from './ipc/fs'

// ============================================
// 全局实例组装（依赖注入）
// ============================================

const registry = new AdapterRegistry()
registry.register(new ClaudeCodeAdapter())
registry.register(new CodexAdapter())
registry.register(new OpenCodeAdapter())
registry.register(new McpAdapter())
registry.register(new CursorAdapter())

const router = new SessionRouter(registry)
const broadcaster = new OutputBroadcaster()
const agentManager = new AgentManager(registry, router, broadcaster)
const agentService = new AgentService(agentManager)
const gitAgent = new GitAgent()

export { agentManager }

// COUP-01: 解耦 broadcastOutput 与 BrowserWindow 的直接耦合
broadcaster.onBroadcast((adapterName, output) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onOutput', adapterName, output)
  }
})

// ============================================
// IPC 处理器注册
// ============================================

export function registerIpcHandlers(): void {
  const db = getClient()
  const graphService = new GraphService(db, agentManager)
  const chatService = new ChatService(db)
  const typedHandle = createTypedHandle(ipcMain)

  // ---------- 会话级允许路径（渲染进程 localStorage 中保存的项目路径） ----------
  const sessionAllowedPaths = new Set<string>()

  // ---------- 路径安全校验 ----------
  const validateFsPath: ValidateFsPath = async (targetPath, operation) => {
    const resolved = path.resolve(targetPath)
    const normalized = path.normalize(resolved)

    // 1. 拒绝系统关键目录
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
        throw new IpcError(`Access denied: cannot ${operation} system directory`, ErrorCode.IPC_ACCESS_DENIED)
      }
    }

    // 2. 构建允许的路径根目录
    const allowedRoots: string[] = []
    allowedRoots.push(path.resolve(app.getPath('userData')))
    allowedRoots.push(path.resolve(app.getPath('temp')))

    if (operation === 'read') {
      allowedRoots.push(path.resolve(app.getPath('desktop')))
      allowedRoots.push(path.resolve(app.getPath('home')))
    }

    try {
      const projectPaths = await graphService.getProjectPaths()
      for (const projectPath of projectPaths) {
        allowedRoots.push(path.resolve(projectPath))
      }
    } catch (err) {
      // 数据库可能未就绪，记录日志但不阻塞路径校验
      console.warn('[IPC] Failed to load project paths for path validation:', err)
    }

    // 会话级允许路径（渲染进程 localStorage 保存的项目路径）
    for (const p of sessionAllowedPaths) {
      allowedRoots.push(path.resolve(p))
    }

    // 3. 检查是否在允许路径下
    for (const root of allowedRoots) {
      const normalizedRoot = path.resolve(root)
      const isAllowed = process.platform === 'win32'
        ? normalized.toLowerCase().startsWith(normalizedRoot.toLowerCase() + sep) ||
          normalized.toLowerCase() === normalizedRoot.toLowerCase()
        : normalized.startsWith(normalizedRoot + sep) || normalized === normalizedRoot
      if (isAllowed) {
        return normalized
      }
    }

    throw new IpcError(`Access denied: path outside allowed directories for ${operation}`, ErrorCode.IPC_ACCESS_DENIED)
  }

  // ---------- 注册各领域 handlers ----------
  registerGraphHandlers(db, typedHandle, graphService)
  registerAgentHandlers(agentService, typedHandle)
  registerFsHandlers(validateFsPath, typedHandle)
  registerGitHandlers(gitAgent, typedHandle)
  registerProjectHandlers(typedHandle, graphService)
  registerSettingsHandlers(typedHandle)
  registerDialogHandlers(typedHandle)
  registerMindmapHandlers(typedHandle, agentManager)
  registerChatHandlers(chatService, typedHandle)

  // 渲染进程 localStorage 保存的项目路径 → 加入会话级允许列表
  typedHandle('fs:registerProjectPaths', async (_, paths: unknown) => {
    if (!Array.isArray(paths)) return
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) continue
      try {
        const validatedPath = await validateFsPath(p.trim(), 'read')
        sessionAllowedPaths.add(validatedPath)
      } catch {
        // 跳过无效路径
      }
    }
  })
}
