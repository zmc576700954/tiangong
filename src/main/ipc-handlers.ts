/**
 * IPC 通信处理器入口
 * 组装并注册所有领域 IPC handlers
 */

import { BrowserWindow, app, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { getClient } from './database'
import { ADAPTER_REGISTRY } from './adapters/registry'
import { GitAgent } from './git-agent'
import { AdapterRegistry } from './agent/adapter-registry'
import { SessionRouter } from './agent/session-router'
import { OutputBroadcaster } from './agent/output-broadcaster'
import { AgentManager } from './agent/agent-manager'
import { GraphService } from './services/graph-service'
import { AgentLogRepository } from './repositories/agent-log-repository'
import { SnapshotRepository } from './repositories/snapshot-repository'
import { createLogger } from './shared/logger'
import { IpcError, ErrorCode } from './errors'

const logger = createLogger('IPC')

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
import { registerCodeIntelHandlers, initCodeIntelligence, getSymbolIndex } from './ipc/code-intelligence'
import { registerMemoryHandlers } from './ipc/memory'
import { registerModeHandlers } from './ipc/mode'
import { getIpcContext } from './ipc/context'
import { ChatService } from './services/chat-service'
import type { ValidateFsPath } from './ipc/fs'

// ============================================
// 依赖工厂：集中组装全局实例（便于测试时替换 Mock）
// ============================================

function createCoreDependencies() {
  const registry = new AdapterRegistry()
  // 从适配器描述符注册表自动注册所有适配器
  for (const desc of ADAPTER_REGISTRY) {
    registry.register(new desc.adapterClass())
  }

  const router = new SessionRouter(registry)
  const broadcaster = new OutputBroadcaster()
  const agentManager = new AgentManager(registry, router, broadcaster)
  const gitAgent = new GitAgent()

  return { registry, router, broadcaster, agentManager, gitAgent }
}

const { broadcaster, agentManager, gitAgent } = createCoreDependencies()

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

// Agent 日志持久化回调（延迟注册，需要 db client）
let agentLogRepo: AgentLogRepository | null = null

function setupAgentLogPersistence(): void {
  if (agentLogRepo) return
  const db = getClient()
  agentLogRepo = new AgentLogRepository(db)

  agentManager.setOnSessionComplete((sessionId, adapterName, nodeId, result, duration) => {
    agentLogRepo!.create({
      sessionId,
      adapterName,
      nodeId,
      graphId: '',
      command: { type: 'implement', description: '', targetNodeId: nodeId },
      outputs: [],
      result,
      duration,
    }).catch((err) => {
      const logger = createLogger('AgentLog')
      logger.warn('Failed to write agent log:', err)
    })
  })
}

// ============================================
// IPC 处理器注册
// ============================================

export async function registerIpcHandlers(): Promise<void> {
  const db = getClient()
  const graphService = new GraphService(db, agentManager)
  const chatService = new ChatService(db)
  setupAgentLogPersistence()
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
  /** realpath 缓存：减少高频文件操作时的系统调用开销（TTL 10秒，最大 500 条） */
  const realpathCache = new Map<string, { resolved: string; timestamp: number }>()
  const REALPATH_CACHE_TTL = 10_000
  const REALPATH_CACHE_MAX = 500

  async function cachedRealpath(targetPath: string): Promise<string> {
    const cached = realpathCache.get(targetPath)
    if (cached && Date.now() - cached.timestamp < REALPATH_CACHE_TTL) {
      return cached.resolved
    }
    let resolved: string
    try {
      resolved = await fs.realpath(targetPath)
    } catch {
      // 文件不存在时，解析父目录的真实路径再拼接文件名，
      // 防止攻击者通过符号链接父目录绕过路径校验
      const parentDir = path.dirname(targetPath)
      const fileName = path.basename(targetPath)
      try {
        const resolvedParent = await fs.realpath(parentDir)
        resolved = path.join(resolvedParent, fileName)
      } catch {
        // 父目录也不存在（全新路径），回退到 path.resolve
        resolved = path.resolve(targetPath)
      }
    }
    // LRU 淘汰：超过大小时删除最早条目
    if (realpathCache.size >= REALPATH_CACHE_MAX) {
      const oldest = realpathCache.keys().next().value
      if (oldest !== undefined) realpathCache.delete(oldest)
    }
    realpathCache.set(targetPath, { resolved, timestamp: Date.now() })
    return resolved
  }

  const validateFsPath: ValidateFsPath = async (targetPath, operation) => {
    const { senderId } = getIpcContext()
    // 解析符号链接获取真实路径（带缓存），文件不存在时回退到 path.resolve
    const resolved = await cachedRealpath(targetPath)
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

    try {
      const projectPaths = await graphService.getProjectPaths()
      for (const projectPath of projectPaths) {
        allowedRoots.push(path.resolve(projectPath))
      }
    } catch (err) {
      // 数据库可能未就绪，记录日志但不阻塞路径校验
      logger.warn('Failed to load project paths for path validation:', err)
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
  const snapshotRepo = new SnapshotRepository(db)
  registerGraphHandlers(db, typedHandle, graphService, snapshotRepo)
  registerAgentHandlers(agentManager, typedHandle, agentLogRepo ?? undefined)
  registerFsHandlers(validateFsPath, typedHandle)
  registerGitHandlers(gitAgent, typedHandle)
  registerProjectHandlers(typedHandle, graphService)
  registerSettingsHandlers(typedHandle)
  registerDialogHandlers(typedHandle)
  registerMindmapHandlers(typedHandle, agentManager)
  registerChatHandlers(chatService, typedHandle)
  registerScopeGuardHandlers(agentManager.scopeGuardInstance, agentManager, typedHandle)
  registerCodeIntelHandlers(ipcMain)
  registerMemoryHandlers(typedHandle)
  registerModeHandlers(typedHandle)

  // 初始化代码智能（符号索引 + 注入到 AgentManager 和 GraphService）
  try {
    await initCodeIntelligence()
    const symbolIndex = getSymbolIndex()
    if (symbolIndex) {
      agentManager.setSymbolIndex(symbolIndex)
      graphService.setSymbolIndex(symbolIndex)
      logger.info('AgentManager and GraphService connected to SymbolIndex')
    }
  } catch (err) {
    logger.warn('Failed to initialize code intelligence:', err)
  }

  // 注入适配器偏好加载器（延迟加载 settings，避免循环依赖）
  agentManager.setAdapterPreferencesLoader(async () => {
    const { getAdapterPreferences } = await import('./settings')
    return getAdapterPreferences()
  })

  // 渲染进程 localStorage 保存的项目路径 → 加入会话级允许列表
  typedHandle('fs:registerProjectPaths', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return
    const { senderId } = getIpcContext()
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) continue
      try {
        const validatedPath = await validateFsPath(p.trim(), 'read')
        addSessionAllowedPath(senderId, validatedPath)
        logger.info(`fs:registerProjectPaths: allowed path=${validatedPath} sender=${senderId}`)
      } catch (err) {
        logger.warn(`fs:registerProjectPaths: rejected path=${p.trim()} sender=${senderId} reason=${err instanceof Error ? err.message : err}`)
      }
    }
  })
}
