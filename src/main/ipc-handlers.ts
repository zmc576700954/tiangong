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
import { NodeRepository } from './repositories/node-repository'
import { SnapshotRepository } from './repositories/snapshot-repository'
import { createLogger } from './shared/logger'
import { isPathWithinResolved } from './shared/path-utils'
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
import { registerContextHandlers } from './ipc/context-waterline'
import { registerScopeGuardHandlers } from './ipc/scope-guard'
import { registerCodeIntelHandlers, initCodeIntelligence, getSymbolIndex } from './ipc/code-intelligence'
import { registerMemoryHandlers } from './ipc/memory'
import { registerModeHandlers } from './ipc/mode'
import { registerSubagentHandlers } from './ipc/subagent'
import { getIpcContext } from './ipc/context'
import { ChatService } from './services/chat-service'
import { ChatRepository } from './repositories/chat-repository'
import { ContextWaterline } from './memory/context-waterline'
import { CompactHistoryRepository } from './repositories/compact-history-repository'
import { SubagentManager } from './agent/subagent-manager'
import { SubagentInvocationRepository } from './repositories/subagent-invocation-repository'
import { BaseAdapter } from './adapters/base'
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

const { registry, broadcaster, agentManager, gitAgent } = createCoreDependencies()

// ContextWaterline: Phase 2 实例化，通过 setWaterline 注入到 AgentManager。
// Phase 3: autoCompactEnabled 设为 true，完善 resolveAndSendCommand 的 threadId 映射逻辑。
const contextWaterline = new ContextWaterline()
agentManager.setWaterline(contextWaterline)

export { agentManager, contextWaterline }

// COUP-01: 解耦 broadcastOutput 与 BrowserWindow 的直接耦合
broadcaster.onBroadcast((payload) => {
  const sessionId = payload.sessionId ?? ''
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onOutput', sessionId, payload.output)
  }
})

agentManager.setStatusChangeCallback((sessionId, nodeId, status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onStatusChange', sessionId, nodeId, status)
  }
})

agentManager.setSessionStartedCallback((threadId, sessionId) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:onSessionStarted', threadId, sessionId)
  }
})

agentManager.setNodeStatusChangeCallback((nodeId, oldStatus, newStatus) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('event:NODE_STATUS_CHANGE', nodeId, oldStatus, newStatus)
  }
})

// Agent 日志持久化回调（延迟注册，需要 db client）
let agentLogRepo: AgentLogRepository | null = null
let logNodeRepo: NodeRepository | null = null

function setupAgentLogPersistence(): void {
  if (agentLogRepo) return
  const db = getClient()
  agentLogRepo = new AgentLogRepository(db)
  logNodeRepo = new NodeRepository(db)

  agentManager.setOnSessionComplete(async (sessionId, adapterName, nodeId, result, duration) => {
    let graphId = ''
    if (nodeId && logNodeRepo) {
      try {
        const node = await logNodeRepo.findById(nodeId)
        if (node) graphId = node.graphId
      } catch { /* ignore lookup failure */ }
    }
    agentLogRepo!.create({
      sessionId,
      adapterName,
      nodeId,
      graphId,
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
  const chatRepo = new ChatRepository(db)

  // Apply persisted waterline config to runtime ContextWaterline instance
  try {
    const { readSettings } = await import('./settings')
    const persisted = await readSettings()
    if (persisted.contextWaterline) {
      if (persisted.contextWaterline.autoCompactEnabled !== undefined) {
        contextWaterline.autoCompactEnabled = persisted.contextWaterline.autoCompactEnabled
      }
      if (persisted.contextWaterline.autoCompactThreshold !== undefined) {
        contextWaterline.autoCompactThreshold = persisted.contextWaterline.autoCompactThreshold
      }
      if (persisted.contextWaterline.minCompactInterval !== undefined) {
        contextWaterline.minCompactInterval = persisted.contextWaterline.minCompactInterval
      }
    }
  } catch (err) {
    logger.warn('Failed to apply persisted contextWaterline config:', err)
  }

  // Wire waterline's dbWriteback so token changes persist to chat_threads
  contextWaterline.setDbWriteback(async (threadId, tokensUsed) => {
    await chatRepo.resetContextTokens(threadId, tokensUsed)
  })

  const graphService = new GraphService(db, agentManager)
  const chatService = new ChatService(chatRepo, contextWaterline)
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
    const cacheKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
    const cached = realpathCache.get(cacheKey)
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
    realpathCache.set(cacheKey, { resolved, timestamp: Date.now() })
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

    // 3. 检查是否在允许路径下（normalized 已被 cachedRealpath 解析过，避免重复 realpath）
    for (const root of allowedRoots) {
      if (isPathWithinResolved(path.resolve(root), normalized)) {
        return normalized
      }
    }

    throw new IpcError(`Access denied: path outside allowed directories for ${operation}`, ErrorCode.IPC_ACCESS_DENIED)
  }

  // ---------- 注册各领域 handlers ----------
  const snapshotRepo = new SnapshotRepository(db)
  registerGraphHandlers(db, typedHandle, graphService, snapshotRepo)
  registerAgentHandlers(agentManager, typedHandle, agentLogRepo ?? undefined, new NodeRepository(db))
  registerFsHandlers(validateFsPath, typedHandle)
  registerGitHandlers(gitAgent, typedHandle)
  registerProjectHandlers(typedHandle, graphService)
  registerSettingsHandlers(typedHandle, contextWaterline)
  registerDialogHandlers(typedHandle)
  registerMindmapHandlers(typedHandle, agentManager)
  registerChatHandlers(chatService, typedHandle)
  const compactHistoryRepo = new CompactHistoryRepository(db)
  // Phase 3 Task 3: wire repos into AgentManager so compactContext can persist
  agentManager.setCompactHistoryRepo(compactHistoryRepo)
  agentManager.setChatRepo(chatRepo)

  // Phase 4 Task 3: SubagentManager — adapters get wired via setSubagentManager in their own tasks.
  const subagentInvocationRepo = new SubagentInvocationRepository(db)
  const subagentManager = new SubagentManager(agentManager, subagentInvocationRepo)
  agentManager.setSubagentManager(subagentManager)
  // Phase 5 Task 8: register user-defined subagent types from settings.json
  try {
    const { readSettings } = await import('./settings')
    const settings = await readSettings()
    if (settings.customAgentTypes) {
      for (const def of settings.customAgentTypes) {
        subagentManager.registerType(def)
      }
    }
  } catch (err) {
    logger.warn('Failed to load customAgentTypes from settings:', err)
  }
  // Phase 4 Task 4: pass SubagentManager to every BaseAdapter-derived adapter
  for (const adapter of registry.list()) {
    if (adapter instanceof BaseAdapter) {
      adapter.setSubagentManager(subagentManager)
    }
  }
  const getMainWindow = (): BrowserWindow | null => {
    const windows = BrowserWindow.getAllWindows()
    return windows.length > 0 ? windows[0] : null
  }
  registerContextHandlers(contextWaterline, agentManager, typedHandle, compactHistoryRepo, getMainWindow)
  registerScopeGuardHandlers(agentManager.scopeGuardInstance, agentManager, typedHandle)
  registerCodeIntelHandlers(typedHandle)
  registerMemoryHandlers(typedHandle)
  registerModeHandlers(typedHandle)
  // Phase 4 Task 7: subagent:* channels + progress push events
  registerSubagentHandlers(subagentManager, subagentInvocationRepo, typedHandle, getMainWindow)

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
  // 安全：只允许注册已存在于项目路径数据库中的路径，防止渲染进程扩展自身文件访问权限
  typedHandle('fs:registerProjectPaths', async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return
    const { senderId } = getIpcContext()
    // 获取所有已注册的项目路径作为允许根目录
    let projectRoots: string[] = []
    try {
      const projectPaths = await graphService.getProjectPaths()
      projectRoots = projectPaths.map((p: string) => path.resolve(p))
    } catch {
      logger.warn('fs:registerProjectPaths: failed to load project paths, rejecting all')
    }
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) continue
      try {
        const resolved = await cachedRealpath(p.trim())
        const normalized = path.normalize(resolved)
        if (isBlockedSystemPath(normalized)) {
          throw new IpcError('Access denied: cannot access system directory', ErrorCode.IPC_ACCESS_DENIED)
        }
        // 验证路径在某个已知项目根目录下，防止注册任意路径
        // normalized 已被 cachedRealpath 解析过，避免重复 realpath。
        let isUnderProject = false
        for (const root of projectRoots) {
          if (isPathWithinResolved(root, normalized)) {
            isUnderProject = true
            break
          }
        }
        if (!isUnderProject) {
          throw new IpcError('Access denied: path is not under any registered project directory', ErrorCode.IPC_ACCESS_DENIED)
        }
        addSessionAllowedPath(senderId, normalized)
        logger.info(`fs:registerProjectPaths: allowed path=${normalized} sender=${senderId}`)
      } catch (err) {
        logger.warn(`fs:registerProjectPaths: rejected path=${p.trim()} sender=${senderId} reason=${err instanceof Error ? err.message : err}`)
      }
    }
  })
}
