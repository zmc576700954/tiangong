/**
 * A2A Settings Tab
 *
 * Phase D9 C6. 位于 SettingsPanel 内，提供 A2A Server lifecycle + Remote Agents 管理。
 *
 * 设计要点：
 *   - 顶部「A2A Server」卡片：启用 / 端口 / 绑定地址 / API Key / TLS / 启动状态 / 重启
 *   - 下方「Remote Agents」表格：name / endpoint / 状态徽标 / 测试连接 / 删除
 *   - 「新增 Agent」表单：name / endpoint / apiKey / tlsVerify / devAllowLocalhost
 *   - apiKey 在内存中以 password input 形式存在；保存时通过 maskApiKey 模式保护
 *
 * 严格遵守 CLAUDE.md：不编辑 settings.json 文件路径之外的任何路径；
 * 不替换或修改 Agent CLI 内部行为；只在调用边界之上组装 scope / memory 上下文。
 */

import { useState, useEffect } from 'react'
import {
  Plus, Trash2, RefreshCw, Save, X, Wifi, WifiOff,
  Power, PowerOff, Check, AlertCircle,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import type {
  A2ARemoteAgent, A2AServerConfig, A2AAgentCard, A2AServerStatus,
} from '@shared/types/a2a'

interface Props {
  /** 注入 electronAPI；测试可传 mock。 */
  electronAPI?: {
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
    onA2AServerStatusChange?: (cb: (status: A2AServerStatus) => void) => () => void
  }
}

function getApi(propsApi?: Props['electronAPI']) {
  return propsApi ?? (window.electronAPI as unknown as Props['electronAPI'])
}

const DEFAULT_AGENT_CARD: A2AAgentCard = {
  a2aVersion: '0.3.0',
  name: 'bizgraph-agent',
  description: 'BizGraph default agent card',
  url: 'http://127.0.0.1:8089',
  capabilities: ['streaming'],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
}
void DEFAULT_AGENT_CARD // reserved for future "Reset card" button

export function A2ASettingsTab({ electronAPI: apiProp }: Props) {
  const api = getApi(apiProp)
  const [serverCfg, setServerCfg] = useState<A2AServerConfig | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [status, setStatus] = useState<A2AServerStatus>({
    running: false, activeTasks: 0, completedTasks: 0, failedTasks: 0,
  })
  const [remoteAgents, setRemoteAgents] = useState<A2ARemoteAgent[]>([])
  const [testing, setTesting] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [pendingAgent, setPendingAgent] = useState<A2ARemoteAgent | null>(null)
  const [agentApiKeyInput, setAgentApiKeyInput] = useState('')

  const refreshStatus = async (): Promise<void> => {
    if (!api) return
    try { setStatus(await api['a2a:getServerStatus']()) } catch { /* keep previous */ }
  }

  const refreshAgents = async (): Promise<void> => {
    if (!api) return
    try { setRemoteAgents(await api['a2a:listRemoteAgents']()) } catch { /* keep previous */ }
  }

  const refreshServerCfg = async (): Promise<void> => {
    if (!api) return
    try {
      const s = await api['settings:read']()
      setServerCfg(s.a2aServer ?? null)
    } catch { /* keep previous */ }
  }

  useEffect(() => {
    void refreshStatus()
    void refreshAgents()
    void refreshServerCfg()
    if (api?.onA2AServerStatusChange) {
      const off = api.onA2AServerStatusChange((s) => setStatus(s))
      return () => { off() }
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showToast = (message: string, type: 'success' | 'error' = 'success'): void => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  const saveServerCfg = async (): Promise<void> => {
    if (!api || !serverCfg) return
    const next: A2AServerConfig = {
      ...serverCfg,
      apiKey: apiKeyInput || serverCfg.apiKey,
    }
    const test = await api['a2a:testServerConfig'](next)
    if (!test.valid) {
      showToast(`配置无效：${test.errors.join('; ')}`, 'error')
      return
    }
    try {
      await api['settings:write']({ a2aServer: next })
      setServerCfg(next)
      setApiKeyInput('')
      showToast('A2A Server 配置已保存。状态变更会自动应用。')
      void refreshStatus()
    } catch (err) {
      showToast(`保存失败：${(err as Error).message}`, 'error')
    }
  }

  const startServer = async (): Promise<void> => {
    if (!api) return
    const r = await api['a2a:startServer']()
    if (r.success) showToast(`A2A server 已启动（端口 ${r.port}）`)
    else showToast(`启动失败：${r.error ?? 'unknown'}`, 'error')
    void refreshStatus()
  }

  const stopServer = async (): Promise<void> => {
    if (!api) return
    await api['a2a:stopServer']()
    showToast('A2A server 已停止')
    void refreshStatus()
  }

  const testAgent = async (name: string): Promise<void> => {
    if (!api) return
    setTesting(name)
    try {
      const r = await api['a2a:testConnection'](name)
      if (r.ok) showToast(`${name} 可达 (${r.latencyMs} ms，card=${r.card?.name ?? 'n/a'})`)
      else showToast(`${name} 不可达：${r.error}`, 'error')
    } finally {
      setTesting(null)
    }
  }

  const deleteAgent = async (name: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(`确定删除远程 agent "${name}"？`)) return
    const r = await api['a2a:deleteRemoteAgent'](name)
    if (r.success) {
      showToast(`已删除 ${name}`)
      void refreshAgents()
    } else {
      showToast(`删除失败`, 'error')
    }
  }

  const openAddForm = (): void => {
    setPendingAgent({
      name: '',
      endpoint: 'http://127.0.0.1:8089',
      tlsVerify: true,
      enabled: true,
      timeoutMs: 30000,
      devAllowLocalhost: false,
    })
    setAgentApiKeyInput('')
    setShowAddForm(true)
  }

  const submitAddForm = async (): Promise<void> => {
    if (!api || !pendingAgent) return
    if (!pendingAgent.name.trim() || !pendingAgent.endpoint.trim()) {
      showToast('name 和 endpoint 必填', 'error')
      return
    }
    const payload: A2ARemoteAgent = {
      ...pendingAgent,
      apiKey: agentApiKeyInput.trim() || undefined,
    }
    const r = await api['a2a:saveRemoteAgent'](payload)
    if (r.success) {
      showToast(`已添加远程 agent "${payload.name}"`)
      setShowAddForm(false)
      setPendingAgent(null)
      void refreshAgents()
    } else {
      showToast(`保存失败：${r.error ?? 'unknown'}`, 'error')
    }
  }

  return (
    <div className="space-y-5 relative">
      {toast && (
        <div className={cn(
          'absolute top-0 left-0 right-0 z-50 px-3 py-2 rounded-md text-xs shadow-lg border',
          toast.type === 'success'
            ? 'bg-green-50 text-green-700 border-green-200'
            : 'bg-red-50 text-red-700 border-red-200',
        )}>
          {toast.message}
        </div>
      )}

      {/* A2A Server */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            A2A Server
          </h3>
          <span className={cn(
            'text-xs px-2 py-0.5 rounded-full flex items-center gap-1',
            status.running ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground',
          )}>
            {status.running ? <Check className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
            {status.running
              ? `running @ ${status.bindAddress ?? '?'}:${status.port ?? '?'} ${status.tls ? '(TLS)' : ''}`
              : 'stopped'}
          </span>
        </div>

        {serverCfg === null ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded border bg-muted/20">
            尚未配置 A2A Server。
          </div>
        ) : (
          <div className="space-y-2 p-3 rounded border bg-muted/20">
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">Enabled</label>
              <input
                type="checkbox"
                checked={serverCfg.enabled}
                onChange={(e) => setServerCfg({ ...serverCfg, enabled: e.target.checked })}
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={serverCfg.port}
                onChange={(e) => setServerCfg({ ...serverCfg, port: Number(e.target.value) })}
                className="flex-1 px-2 py-1 border rounded bg-background"
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">Bind</label>
              <select
                value={serverCfg.bindAddress}
                onChange={(e) => setServerCfg({ ...serverCfg, bindAddress: e.target.value as '127.0.0.1' | '0.0.0.0' })}
                className="flex-1 px-2 py-1 border rounded bg-background"
              >
                <option value="127.0.0.1">127.0.0.1 (loopback)</option>
                <option value="0.0.0.0">0.0.0.0 (所有网卡)</option>
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">API Key</label>
              <input
                type="password"
                value={apiKeyInput}
                placeholder={serverCfg.apiKey ? '当前: ****' : '最少 16 位'}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="flex-1 px-2 py-1 border rounded bg-background"
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">Card Name</label>
              <input
                type="text"
                value={serverCfg.agentCard.name}
                onChange={(e) => setServerCfg({ ...serverCfg, agentCard: { ...serverCfg.agentCard, name: e.target.value } })}
                className="flex-1 px-2 py-1 border rounded bg-background"
              />
            </div>

            <div className="flex items-center gap-2 mt-2">
              <Button size="sm" onClick={saveServerCfg}>
                <Save className="w-3 h-3 mr-1" />
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={status.running ? stopServer : startServer}
                disabled={!serverCfg.enabled && !status.running}
              >
                {status.running ? <PowerOff className="w-3 h-3 mr-1" /> : <Power className="w-3 h-3 mr-1" />}
                {status.running ? 'Stop' : 'Start'}
              </Button>
              <Button size="sm" variant="ghost" onClick={refreshStatus}>
                <RefreshCw className="w-3 h-3 mr-1" />
                Status
              </Button>
            </div>

            <div className="text-[10px] text-muted-foreground pt-2 border-t mt-2">
              Tasks: active={status.activeTasks}, completed={status.completedTasks}, failed={status.failedTasks}
            </div>
          </div>
        )}
      </section>

      {/* Remote Agents */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Remote Agents
          </h3>
          <Button size="sm" variant="outline" onClick={openAddForm}>
            <Plus className="w-3 h-3 mr-1" />
            Add
          </Button>
        </div>

        {remoteAgents.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded border bg-muted/20">
            尚未配置远程 A2A agent。点击 Add 注册一个。
          </div>
        ) : (
          <div className="space-y-1.5">
            {remoteAgents.map((a) => (
              <div
                key={a.name}
                className="flex items-center justify-between px-2.5 py-2 rounded-md border bg-muted/30 text-xs"
                data-testid={`a2a-agent-${a.name}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    <Badge variant={a.enabled !== false ? 'default' : 'secondary'}>
                      {a.enabled !== false ? (
                        <><Wifi className="w-2.5 h-2.5 mr-0.5" />enabled</>
                      ) : (
                        <><WifiOff className="w-2.5 h-2.5 mr-0.5" />disabled</>
                      )}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">{a.endpoint}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => testAgent(a.name)}
                    disabled={testing === a.name}
                  >
                    {testing === a.name ? <RefreshCw className="w-3 h-3 animate-spin" /> : 'Test'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteAgent(a.name)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Add-agent modal */}
      {showAddForm && pendingAgent && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg shadow-xl p-4 w-96 max-w-[90vw] space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Add Remote Agent</h3>
              <button onClick={() => setShowAddForm(false)} className="text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-muted-foreground">Name (kebab-case)</label>
                <input
                  type="text"
                  value={pendingAgent.name}
                  onChange={(e) => setPendingAgent({ ...pendingAgent, name: e.target.value })}
                  placeholder="my-remote-agent"
                  className="w-full px-2 py-1.5 text-xs rounded border bg-background"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Endpoint</label>
                <input
                  type="text"
                  value={pendingAgent.endpoint}
                  onChange={(e) => setPendingAgent({ ...pendingAgent, endpoint: e.target.value })}
                  placeholder="http://host:8089"
                  className="w-full px-2 py-1.5 text-xs rounded border bg-background"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">API Key (optional)</label>
                <input
                  type="password"
                  value={agentApiKeyInput}
                  onChange={(e) => setAgentApiKeyInput(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs rounded border bg-background"
                />
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={pendingAgent.tlsVerify !== false}
                    onChange={(e) => setPendingAgent({ ...pendingAgent, tlsVerify: e.target.checked })}
                  />
                  Verify TLS
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={pendingAgent.devAllowLocalhost ?? false}
                    onChange={(e) => setPendingAgent({ ...pendingAgent, devAllowLocalhost: e.target.checked })}
                  />
                  Allow loopback (dev)
                </label>
              </div>
              <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
                <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>
                  远端 endpoint 不能是内网/loopback，除非勾选 Allow loopback（仅 dev 用）。
                </span>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>Cancel</Button>
              <Button size="sm" onClick={submitAddForm}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}