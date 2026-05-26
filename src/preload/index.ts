import { contextBridge, ipcRenderer } from 'electron'
import type { IpcApi, AgentOutput } from '@shared/types'

// Build IPC API object
const ipcApi: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

// List of IPC channels to expose
const ipcChannels: (keyof IpcApi)[] = [
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
  'agent:checkInstalled',
  'agent:startSession',
  'agent:sendCommand',
  'agent:terminateSession',
  'agent:listAdapters',

  // File system
  'fs:readDir',
  'fs:readFile',
  'fs:writeFile',

  // Git operations
  'git:status',
  'git:diff',
  'git:commit',

  // Dialog operations
  'dialog:openDirectory',

  // Project scanning
  'project:scan',

  // Initialize graph from project
  'graph:initFromProject',

  // Settings
  'settings:read',
  'settings:write',
  'settings:refreshCli',
  'settings:installCli',
  'settings:setApiKey',
]

// Create invoke wrapper for each channel
for (const channel of ipcChannels) {
  ipcApi[channel] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
}

// Expose API to window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  ...ipcApi,

  // Agent output event listener (uses on/once/off pattern)
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

// Type declarations for renderer TypeScript
declare global {
  interface Window {
    electronAPI: typeof ipcApi & {
      onAgentOutput: (callback: (sessionId: string, output: AgentOutput) => void) => () => void
      platform: string
    }
  }
}
