/**
 * Preload script
 * 通过 contextBridge 精确暴露必要的 IPC API 给渲染进程
 *
 * 安全设计（TG-008）：
 * - 仅暴露渲染进程实际需要的 IPC 通道
 * - fs:writeFile 等危险操作不暴露，由主进程内部代理执行
 * - 路径验证、频率限制在 main 进程中完成
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

  // Node operations
  'node:create',
  'node:update',
  'node:delete',

  // Edge operations
  'edge:create',
  'edge:update',
  'edge:delete',

  // Bug operations
  'bug:create',
  'bug:update',
  'bug:delete',
  'bug:listByNode',

  // Agent operations
  'agent:listAdapters',
  'agent:startSession',
  'agent:sendCommand',
  'agent:terminateSession',

  // 文件系统 — 只读 + 文件操作
  'fs:readDir',
  'fs:readDirDetail',
  'fs:createFile',
  'fs:createDir',
  'fs:delete',
  'fs:rename',
  'fs:move',
  'fs:copy',
  'fs:exists',
  'fs:stat',
  'fs:registerProjectPaths',

  // Dialog
  'dialog:openDirectory',

  // Project scanning
  'graph:initFromProject',

  // Settings
  'settings:read',
  'settings:refreshCli',
  'settings:installCli',
  'settings:setApiKey',
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

  // Platform info
  platform: process.platform,
})

type ExposedApi = Pick<IpcApi, typeof exposedChannels[number]>

// Type declarations for renderer TypeScript
declare global {
  interface Window {
    electronAPI: ExposedApi & {
      onAgentOutput: (callback: (sessionId: string, output: AgentOutput) => void) => () => void
      platform: string
    }
  }
}
