import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, AgentOutput } from '@shared/types'

// 构建 IPC API，将主进程的方法暴露给渲染进程
const ipcApi: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

// 需要暴露的 IPC 通道列表
const ipcChannels: (keyof IpcApi)[] = [
  // 图操作
  'graph:create',
  'graph:list',
  'graph:get',
  'graph:delete',

  // 节点操作
  'node:create',
  'node:update',
  'node:delete',

  // 边操作
  'edge:create',
  'edge:update',
  'edge:delete',

  // Bug 操作
  'bug:create',
  'bug:update',
  'bug:delete',
  'bug:listByNode',
  'bug:listByGraph',

  // Agent 操作
  'agent:checkInstalled',
  'agent:startSession',
  'agent:sendCommand',
  'agent:terminateSession',
  'agent:listAdapters',

  // 文件系统
  'fs:readDir',
  'fs:readFile',
  'fs:writeFile',

  // Git 操作
  'git:status',
  'git:diff',
  'git:commit',
]

// 为每个通道创建 invoke 包装器
for (const channel of ipcChannels) {
  ipcApi[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
}

// 暴露 API 到 window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  ...ipcApi,

  // Agent 输出事件监听（特殊处理，使用 on/once/off 模式）
  onAgentOutput: (callback: (sessionId: string, output: AgentOutput) => void) => {
    const handler = (_: unknown, sessionId: string, output: AgentOutput) => {
      callback(sessionId, output)
    }
    ipcRenderer.on('agent:onOutput', handler)
    return () => ipcRenderer.off('agent:onOutput', handler)
  },

  // 平台信息
  platform: process.platform,
})

// 类型声明（用于渲染进程的 TypeScript）
declare global {
  interface Window {
    electronAPI: typeof ipcApi & {
      onAgentOutput: (callback: (sessionId: string, output: AgentOutput) => void) => () => void
      platform: string
    }
  }
}

