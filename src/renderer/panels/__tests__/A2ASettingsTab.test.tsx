// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { A2ASettingsTab } from '../A2ASettingsTab'
import type {
  A2ARemoteAgent, A2AServerConfig, A2AServerStatus, A2AAgentCard,
} from '@shared/types/a2a'

/**
 * A2ASettingsTab 渲染层测试（最小覆盖）：
 *   - 空态文案渲染
 *   - 列表展示 mock 远端 agent（带 status 徽标 + 测试按钮）
 *   - Test Connection 按钮触发 a2a:testConnection IPC，loading → success 反馈
 *   - 错误反馈：testConnection 返回 error 时 toast 显示
 *
 * 本仓库未配置 @testing-library/jest-dom，自行实现最小断言。
 */

function makeStatus(overrides: Partial<A2AServerStatus> = {}): A2AServerStatus {
  return {
    running: false,
    activeTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    ...overrides,
  }
}

function makeServerCfg(overrides: Partial<A2AServerConfig> = {}): A2AServerConfig {
  return {
    enabled: false,
    port: 8089,
    bindAddress: '127.0.0.1',
    apiKey: '',
    agentCard: {
      a2aVersion: '0.3.0',
      name: 'bizgraph-agent',
      description: '',
      url: 'http://127.0.0.1:8089',
      capabilities: ['streaming'],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    },
    ...overrides,
  }
}

function makeApi(overrides: Partial<{
  'a2a:getServerStatus': () => Promise<A2AServerStatus>
  'a2a:startServer': () => Promise<{ success: boolean; port?: number; error?: string }>
  'a2a:stopServer': () => Promise<{ success: boolean }>
  'a2a:testConnection': (name: string) => Promise<{ ok: boolean; card?: A2AAgentCard; error?: string; latencyMs: number }>
  'a2a:listRemoteAgents': () => Promise<A2ARemoteAgent[]>
  'a2a:saveRemoteAgent': (agent: A2ARemoteAgent) => Promise<{ success: boolean; error?: string }>
  'a2a:deleteRemoteAgent': (name: string) => Promise<{ success: boolean }>
  'a2a:testServerConfig': (cfg: A2AServerConfig) => Promise<{ valid: boolean; errors: string[] }>
  'settings:read': () => Promise<{ a2aServer?: A2AServerConfig; a2a?: { remoteAgents: A2ARemoteAgent[] } }>
  'settings:write': (s: unknown) => Promise<void>
}> = {}) {
  return {
    'a2a:getServerStatus': vi.fn(async () => makeStatus()),
    'a2a:startServer': vi.fn(async () => ({ success: true, port: 8089 })),
    'a2a:stopServer': vi.fn(async () => ({ success: true })),
    'a2a:testConnection': vi.fn(async () => ({ ok: true, latencyMs: 42 })),
    'a2a:listRemoteAgents': vi.fn(async () => []),
    'a2a:saveRemoteAgent': vi.fn(async () => ({ success: true })),
    'a2a:deleteRemoteAgent': vi.fn(async () => ({ success: true })),
    'a2a:testServerConfig': vi.fn(async () => ({ valid: true, errors: [] })),
    'settings:read': vi.fn(async () => ({ a2aServer: makeServerCfg(), a2a: { remoteAgents: [] } })),
    'settings:write': vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Parameters<typeof A2ASettingsTab>[0]['electronAPI']
}

describe('A2ASettingsTab', () => {
  it('shows empty-state hints when no remote agents and server not configured', async () => {
    const api = makeApi({
      'settings:read': vi.fn(async () => ({})),
    })
    render(<A2ASettingsTab electronAPI={api} />)
    await waitFor(() => {
      expect(api!['settings:read']).toHaveBeenCalled()
    })
    expect(screen.getByText(/尚未配置远程 A2A agent/)).toBeTruthy()
    expect(screen.getByText(/尚未配置 A2A Server/)).toBeTruthy()
  })

  it('renders remote agents with status badges and Test button', async () => {
    const api = makeApi({
      'a2a:listRemoteAgents': vi.fn(async () => [
        { name: 'peer-alpha', endpoint: 'http://10.0.0.5:8089', enabled: true } as A2ARemoteAgent,
        { name: 'peer-beta', endpoint: 'https://example.com', enabled: false } as A2ARemoteAgent,
      ]),
    })
    render(<A2ASettingsTab electronAPI={api} />)
    await waitFor(() => {
      expect(screen.getByText('peer-alpha')).toBeTruthy()
    })
    expect(screen.getByText('peer-beta')).toBeTruthy()
    // Two Test buttons (one per agent)
    const testButtons = screen.getAllByText('Test')
    expect(testButtons.length).toBe(2)
  })

  it('Test Connection button calls a2a:testConnection and shows latency toast on ok', async () => {
    const api = makeApi({
      'a2a:listRemoteAgents': vi.fn(async () => [
        { name: 'peer-alpha', endpoint: 'http://10.0.0.5:8089', enabled: true } as A2ARemoteAgent,
      ]),
      'a2a:testConnection': vi.fn(async () => ({ ok: true, latencyMs: 17 })),
    })
    render(<A2ASettingsTab electronAPI={api} />)
    await waitFor(() => {
      expect(screen.getByText('peer-alpha')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Test'))
    await waitFor(() => {
      expect(api!['a2a:testConnection']).toHaveBeenCalledWith('peer-alpha')
    })
    // toast surfaces the latency in success state
    await waitFor(() => {
      expect(screen.getByText(/peer-alpha.*17/)).toBeTruthy()
    })
  })

  it('shows error toast when testConnection returns ok=false', async () => {
    const api = makeApi({
      'a2a:listRemoteAgents': vi.fn(async () => [
        { name: 'peer-broken', endpoint: 'http://10.0.0.99:9999', enabled: true } as A2ARemoteAgent,
      ]),
      'a2a:testConnection': vi.fn(async () => ({ ok: false, error: 'ECONNREFUSED', latencyMs: 5 })),
    })
    render(<A2ASettingsTab electronAPI={api} />)
    await waitFor(() => {
      expect(screen.getByText('peer-broken')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Test'))
    await waitFor(() => {
      expect(screen.getByText(/peer-broken.*ECONNREFUSED/)).toBeTruthy()
    })
  })
})