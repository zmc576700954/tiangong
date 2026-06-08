/**
 * Preload script
 * 通过 contextBridge 精确暴露必要的 IPC API 给渲染进程
 *
 * 安全设计（TG-008）：
 * - 仅暴露渲染进程实际需要的 IPC 通道
 * - 文件操作通过 IPC 通道暴露给渲染进程，路径验证和频率限制在 main 进程中完成
 * - 敏感操作（如 Agent 执行范围外的文件修改）由 ScopeGuard 在 main 进程层拦截
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, AgentOutput } from '@shared/types'

// 渲染进程实际使用的 IPC 通道（最小暴露原则）
const exposedChannels: (keyof IpcApi)[] = [
  // Graph operations
  'graph:create',
  'graph:list',
  'graph:get',
  'graph:delete',
  'graph:derive',

  // Node operations
  'node:create',
  'node:createBatch',
  'node:update',
  'node:delete',
  'node:batchUpdatePositions',

  // Edge operations
  'edge:create',
  'edge:update',
  'edge:delete',

  // Bug operations
  'bug:create',
  'bug:update',
  'bug:delete',
  'bug:listByNode',

  'snapshot:create',
  'snapshot:list',
  'snapshot:load',
  'snapshot:delete',

  // Agent operations
  'agent:listAdapters',
  'agent:startSession',
  'agent:sendCommand',
  'agent:resolveAndSendCommand',
  'agent:terminateSession',
  'agent:verify',

  'agent:getLogsByNode',
  'agent:getLogsByGraph',

  // Chat 会话记录
  'thread:list',
  'thread:load',
  'thread:create',
  'thread:update',
  'thread:delete',
  'thread:search',
  'message:list',
  'message:save',
  'message:saveBatch',

  // 文件系统 — 只读 + 文件操作
  'fs:readDir',
  'fs:readDirDetail',
  'fs:readFile',
  'fs:createFile',
  'fs:createDir',
  'fs:delete',
  'fs:rename',
  'fs:move',
  'fs:copy',
  'fs:exists',
  'fs:stat',
  'fs:registerProjectPaths',
  'fs:searchFiles',

  // Dialog
  'dialog:openDirectory',

  // Project scanning
  'graph:initFromProject',

  // MindMap Agent
  'mindmap:generate',
  'mindmap:generateModule',
  'mindmap:enrichNode',
  'mindmap:refine',
  'mindmap:buildDevPrompt',

  // Settings
  'settings:read',
  'settings:refreshCli',
  'settings:installCli',
  'settings:setApiKey',

  // ScopeGuard
  'scopeGuard:rollbackFile',
  'scopeGuard:commitSession',
  'scopeGuard:rollbackSession',

  // Code Intelligence
  'codeIntel:indexProject',
  'codeIntel:querySymbols',
  'codeIntel:getRelatedFiles',
  'codeIntel:generatePlan',
]

// Build IPC API object
const ipcApi: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

for (const channel of exposedChannels) {
  ipcApi[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
}

// Expose API to window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  ...ipcApi,

  // Agent output event listener
  onAgentOutput: (callback: (sessionId: string, output: AgentOutput) => void) => {
    const handler = (_: unknown, sessionId: string, output: AgentOutput) => {
      callback(sessionId, output)
    }
    ipcRenderer.on('agent:onOutput', handler)
    return () => ipcRenderer.off('agent:onOutput', handler)
  },

  // Agent status change event listener
  onAgentStatusChange: (callback: (sessionId: string, nodeId: string, status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, nodeId: string, status: string) =>
      callback(sessionId, nodeId, status)
    ipcRenderer.on('agent:onStatusChange', handler)
    return () => { ipcRenderer.removeListener('agent:onStatusChange', handler) }
  },

  // Session started event (for sessionId persistence)
  onSessionStarted: (callback: (threadId: string, sessionId: string) => void) => {
    const handler = (_: unknown, threadId: string, sessionId: string) => {
      callback(threadId, sessionId)
    }
    ipcRenderer.on('agent:onSessionStarted', handler)
    return () => ipcRenderer.off('agent:onSessionStarted', handler)
  },

  // Platform info
  platform: process.platform,
})

type ExposedApi = Pick<IpcApi, typeof exposedChannels[number]>

// Type declarations for renderer TypeScript
declare global {
  interface Window {
    electronAPI: ExposedApi & {
      onAgentOutput: (callback: (sessionId: string, output: AgentOutput) => void) => () => void
      onAgentStatusChange: (callback: (sessionId: string, nodeId: string, status: string) => void) => () => void
      onSessionStarted: (callback: (threadId: string, sessionId: string) => void) => () => void
      platform: string
    }
  }
}
