/**
 * IPC 通信处理器入口
 * 组装并注册所有领域 IPC handlers
 */

import { BrowserWindow, app, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { getClient } from './database'
import { ClaudeCodeAdapter } from './adapters/claude-code'
import { CodexAdapter } from './adapters/codex'
import { OpenCodeAdapter } from './adapters/opencode'
import { McpAdapter } from './adapters/mcp-adapter'
import { CursorAdapter } from './adapters/cursor'
import { MindMapAdapter } from './adapters/mindmap-adapter'
import { GitAgent } from './git-agent'
import { AdapterRegistry } from './agent/adapter-registry'
import { SessionRouter } from './agent/session-router'
import { OutputBroadcaster } from './agent/output-broadcaster'
import { AgentManager } from './agent/agent-manager'
import { GraphService } from './services/graph-service'
import { IpcError, ErrorCode } from './errors'

import { createTypedHandle, isBlockedSystemPath } from './ipc/utils'
import { registerGraphHandlers } from './ipc/graph'
import { registerAgentHandlers } from './ipc/agent'
import { registerFsHandlers } from './ipc/fs'
import { registerGitHandlers } from './ipc/git'
import { registerProjectHandlers } from './ipc/project'
import { registerSettingsHandlers } from './ipc/settings'
import { registerDialogHandlers } from './ipc/dialog'
import { registerMindmapHandlers } from './ipc/mindmap'
import { registerChatHandlers } from './ipc/chat'
import { registerScopeGuardHandlers } from './ipc/scope-guard'
import { getIpcContext } from './ipc/context'
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
registry.register(new MindMapAdapter())

const router = new SessionRouter(registry)
const broadcaster = new OutputBroadcaster()
const agentManager = new AgentManager(registry, router, broadcaster)
const gitAgent = new GitAgent()

export { agentManager }

// COUP-01: 解耦 broadcastOutput 与 BrowserWindow 的直接耦合
broadcaster.onBroadcast((adapterName, output) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onOutput', adapterName, output)
  }
})

agentManager.setStatusChangeCallback((sessionId, nodeId, status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onStatusChange', sessionId, nodeId, status)
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

  // ---------- 会话级允许路径（按窗口隔离） ----------
  /** 最大允许的会话路径数量，防止内存无限增长 */
  const MAX_SESSION_ALLOWED_PATHS = 50
  const sessionPathsByWindow = new Map<number, Set<string>>()

  /**
   * 添加路径到指定窗口的会话允许列表，带大小限制（LRU 策略）。
   */
  function addSessionAllowedPath(webContentsId: number, validatedPath: string): void {
    let paths = sessionPathsByWindow.get(webContentsId)
    if (!paths) {
      paths = new Set()
      sessionPathsByWindow.set(webContentsId, paths)
    }
    if (paths.has(validatedPath)) {
      paths.delete(validatedPath)
    }
    paths.add(validatedPath)

    while (paths.size > MAX_SESSION_ALLOWED_PATHS) {
      const first = paths.values().next().value
      if (first !== undefined) {
        paths.delete(first)
      }
    }
  }

  /** 获取指定窗口的所有允许路径 */
  function getSessionAllowedPaths(webContentsId: number): Set<string> {
    return sessionPathsByWindow.get(webContentsId) ?? new Set()
  }

  // 窗口关闭时自动清理对应路径集
  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => {
      sessionPathsByWindow.delete(win.webContents.id)
    })
  })

  // ---------- 路径安全校验 ----------
  const validateFsPath: ValidateFsPath = async (targetPath, operation) => {
    const { senderId } = getIpcContext()
    // 解析符号链接获取真实路径，文件不存在时回退到 path.resolve
    let resolved: string
    try {
      resolved = await fs.realpath(targetPath)
    } catch {
      resolved = path.resolve(targetPath)
    }
    const normalized = path.normalize(resolved)

    // 1. 拒绝系统关键目录
    if (isBlockedSystemPath(normalized)) {
      throw new IpcError(`Access denied: cannot ${operation} system directory`, ErrorCode.IPC_ACCESS_DENIED)
    }

    // 2. 构建允许的路径根目录
    const sep = path.sep
    const allowedRoots: string[] = []
    allowedRoots.push(path.resolve(app.getPath('userData')))
    allowedRoots.push(path.resolve(app.getPath('temp')))

    if (operation === 'read') {
      allowedRoots.push(path.resolve(app.getPath('desktop')))
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

    // 会话级允许路径（按窗口隔离）
    for (const p of getSessionAllowedPaths(senderId)) {
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
  registerAgentHandlers(agentManager, typedHandle)
  registerFsHandlers(validateFsPath, typedHandle)
  registerGitHandlers(gitAgent, typedHandle)
  registerProjectHandlers(typedHandle, graphService)
  registerSettingsHandlers(typedHandle)
  registerDialogHandlers(typedHandle)
  registerMindmapHandlers(typedHandle, agentManager)
  registerChatHandlers(chatService, typedHandle)
  registerScopeGuardHandlers(agentManager.scopeGuardInstance, agentManager, typedHandle)

  // 渲染进程 localStorage 保存的项目路径 → 加入会话级允许列表
  typedHandle('fs:registerProjectPaths', async (event, paths: unknown) => {
    if (!Array.isArray(paths)) return
    const { senderId } = getIpcContext()
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) continue
      try {
        const validatedPath = await validateFsPath(p.trim(), 'read')
        addSessionAllowedPath(senderId, validatedPath)
        console.info(`[IPC] fs:registerProjectPaths: allowed path=${validatedPath} sender=${senderId}`)
      } catch (err) {
        console.warn(`[IPC] fs:registerProjectPaths: rejected path=${p.trim()} sender=${senderId} reason=${err instanceof Error ? err.message : err}`)
      }
    }
  })
}
