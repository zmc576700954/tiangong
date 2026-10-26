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
 *   - 文案走共享 i18n 层（zh 为真值来源），反馈走全局 Toast，不自建局部 toast
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
import { toastError, toastSuccess } from '../lib/toast'
import { useI18n } from '../i18n/useI18n'
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
    'settings:write': (s: { a2aServer?: A2AServerConfig }) => Promise<void>
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

/**
 * 新建 A2A Server 配置时的初始值。
 *
 * settings 里默认**没有** a2aServer（区分「没配过」和「配了但取默认值」），
 * 所以面板必须自己给一份初始值 —— 否则这里只会显示「未配置」，用户永远
 * 建不出配置，A2A Server 也就永远启不起来。
 */
function createDefaultServerConfig(): A2AServerConfig {
  return {
    enabled: false,
    port: 8089,
    bindAddress: '127.0.0.1',
    apiKey: '',
    agentCard: { ...DEFAULT_AGENT_CARD },
  }
}

export function A2ASettingsTab({ electronAPI: apiProp }: Props) {
  const api = getApi(apiProp)
  const { t } = useI18n()
  const [serverCfg, setServerCfg] = useState<A2AServerConfig | null>(null)
  /** settings 里是否已经存过 a2aServer 配置（false = 还没配过，表单只是初始值）。 */
  const [serverConfigured, setServerConfigured] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [status, setStatus] = useState<A2AServerStatus>({
    running: false, activeTasks: 0, completedTasks: 0, failedTasks: 0,
  })
  const [remoteAgents, setRemoteAgents] = useState<A2ARemoteAgent[]>([])
  const [testing, setTesting] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
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
      // 没配过 → 用初始值填表，用户保存后配置才真正落盘。
      setServerConfigured(!!s.a2aServer)
      setServerCfg(s.a2aServer ?? createDefaultServerConfig())
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

  const saveServerCfg = async (): Promise<void> => {
    if (!api) return
    const current = serverCfg ?? createDefaultServerConfig()
    const next: A2AServerConfig = {
      ...current,
      apiKey: apiKeyInput || current.apiKey,
    }
    const test = await api['a2a:testServerConfig'](next)
    if (!test.valid) {
      toastError(t('settings.a2a.toast.invalidConfig', { errors: test.errors.join('; ') }))
      return
    }
    try {
      await api['settings:write']({ a2aServer: next })
      setServerCfg(next)
      setServerConfigured(true)
      setApiKeyInput('')
      toastSuccess(t('settings.a2a.toast.configSaved'))
      void refreshStatus()
    } catch (err) {
      toastError(t('settings.a2a.toast.saveFailed', { error: (err as Error).message }))
    }
  }

  const startServer = async (): Promise<void> => {
    if (!api) return
    try {
      const r = await api['a2a:startServer']()
      if (r.success) toastSuccess(t('settings.a2a.toast.started', { port: r.port ?? '?' }))
      else toastError(t('settings.a2a.toast.startFailed', { error: r.error ?? 'unknown' }))
    } catch (err) {
      toastError(t('settings.a2a.toast.startFailed', { error: (err as Error).message }))
    }
    void refreshStatus()
  }

  const stopServer = async (): Promise<void> => {
    if (!api) return
    await api['a2a:stopServer']()
    toastSuccess(t('settings.a2a.toast.stopped'))
    void refreshStatus()
  }

  const testAgent = async (name: string): Promise<void> => {
    if (!api) return
    setTesting(name)
    try {
      const r = await api['a2a:testConnection'](name)
      if (r.ok) {
        toastSuccess(t('settings.a2a.toast.reachable', {
          name,
          latency: r.latencyMs,
          card: r.card?.name ?? 'n/a',
        }))
      } else {
        toastError(t('settings.a2a.toast.unreachable', { name, error: r.error ?? 'unknown' }))
      }
    } finally {
      setTesting(null)
    }
  }

  const deleteAgent = async (name: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(t('settings.a2a.confirmDelete', { name }))) return
    const r = await api['a2a:deleteRemoteAgent'](name)
    if (r.success) {
      toastSuccess(t('settings.a2a.toast.deleted', { name }))
      void refreshAgents()
    } else {
      toastError(t('settings.a2a.toast.deleteFailed'))
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
      toastError(t('settings.a2a.toast.requiredFields'))
      return
    }
    const payload: A2ARemoteAgent = {
      ...pendingAgent,
      apiKey: agentApiKeyInput.trim() || undefined,
    }
    const r = await api['a2a:saveRemoteAgent'](payload)
    if (r.success) {
      toastSuccess(t('settings.a2a.toast.added', { name: payload.name }))
      setShowAddForm(false)
      setPendingAgent(null)
      void refreshAgents()
    } else {
      toastError(t('settings.a2a.toast.saveFailed', { error: r.error ?? 'unknown' }))
    }
  }

  const statusLabel = status.running
    ? (status.tls
        ? t('settings.a2a.status.runningTls', { address: status.bindAddress ?? '?', port: status.port ?? '?' })
        : t('settings.a2a.status.running', { address: status.bindAddress ?? '?', port: status.port ?? '?' }))
    : t('settings.a2a.status.stopped')

  // 未配置时也展示表单（用初始值填充）—— 否则用户无法创建 A2A Server 配置。
  const effectiveCfg = serverCfg ?? createDefaultServerConfig()

  return (
    <div className="space-y-5 relative">
      {/* A2A Server */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('settings.a2a.server')}
          </h3>
          <span className={cn(
            'text-xs px-2 py-0.5 rounded-full flex items-center gap-1',
            status.running ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground',
          )}>
            {status.running ? <Check className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
            {statusLabel}
          </span>
        </div>

        {!serverConfigured && (
          <div className="text-xs text-muted-foreground italic p-3 rounded border bg-muted/20 mb-2">
            {t('settings.a2a.server.notConfigured')}
          </div>
        )}

        <div className="space-y-2 p-3 rounded border bg-muted/20">
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">{t('settings.a2a.field.enabled')}</label>
              <input
                type="checkbox"
                checked={effectiveCfg.enabled}
                onChange={(e) => setServerCfg({ ...effectiveCfg, enabled: e.target.checked })}
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">{t('settings.a2a.field.port')}</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={effectiveCfg.port}
                onChange={(e) => setServerCfg({ ...effectiveCfg, port: Number(e.target.value) })}
                className="flex-1 px-2 py-1 border rounded bg-background"
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">{t('settings.a2a.field.bind')}</label>
              <select
                value={effectiveCfg.bindAddress}
                onChange={(e) => setServerCfg({ ...effectiveCfg, bindAddress: e.target.value as '127.0.0.1' | '0.0.0.0' })}
                className="flex-1 px-2 py-1 border rounded bg-background"
              >
                <option value="127.0.0.1">{t('settings.a2a.bind.loopback')}</option>
                <option value="0.0.0.0">{t('settings.a2a.bind.all')}</option>
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">{t('settings.a2a.field.apiKey')}</label>
              <input
                type="password"
                value={apiKeyInput}
                placeholder={effectiveCfg.apiKey ? t('settings.a2a.apiKey.current') : t('settings.a2a.apiKey.placeholder')}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="flex-1 px-2 py-1 border rounded bg-background"
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <label className="w-20 text-muted-foreground">{t('settings.a2a.field.cardName')}</label>
              <input
                type="text"
                value={effectiveCfg.agentCard.name}
                onChange={(e) => setServerCfg({ ...effectiveCfg, agentCard: { ...effectiveCfg.agentCard, name: e.target.value } })}
                className="flex-1 px-2 py-1 border rounded bg-background"
              />
            </div>

            <div className="flex items-center gap-2 mt-2">
              <Button size="sm" onClick={saveServerCfg}>
                <Save className="w-3 h-3 mr-1" />
                {t('settings.a2a.action.save')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={status.running ? stopServer : startServer}
                disabled={!effectiveCfg.enabled && !status.running}
              >
                {status.running ? <PowerOff className="w-3 h-3 mr-1" /> : <Power className="w-3 h-3 mr-1" />}
                {status.running ? t('settings.a2a.action.stop') : t('settings.a2a.action.start')}
              </Button>
              <Button size="sm" variant="ghost" onClick={refreshStatus}>
                <RefreshCw className="w-3 h-3 mr-1" />
                {t('settings.a2a.action.status')}
              </Button>
            </div>

            <div className="text-[10px] text-muted-foreground pt-2 border-t mt-2">
              {t('settings.a2a.tasks', {
                active: status.activeTasks,
                completed: status.completedTasks,
                failed: status.failedTasks,
              })}
            </div>
          </div>
      </section>

      {/* Remote Agents */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('settings.a2a.remoteAgents')}
          </h3>
          <Button size="sm" variant="outline" onClick={openAddForm}>
            <Plus className="w-3 h-3 mr-1" />
            {t('settings.a2a.action.add')}
          </Button>
        </div>

        {remoteAgents.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded border bg-muted/20">
            {t('settings.a2a.remoteAgents.empty')}
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
                        <><Wifi className="w-2.5 h-2.5 mr-0.5" />{t('settings.a2a.badge.enabled')}</>
                      ) : (
                        <><WifiOff className="w-2.5 h-2.5 mr-0.5" />{t('settings.a2a.badge.disabled')}</>
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
                    {testing === a.name
                      ? <RefreshCw className="w-3 h-3 animate-spin" />
                      : t('settings.a2a.action.test')}
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
              <h3 className="text-sm font-medium">{t('settings.a2a.addModal.title')}</h3>
              <button onClick={() => setShowAddForm(false)} className="text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-muted-foreground">{t('settings.a2a.addModal.name')}</label>
                <input
                  type="text"
                  value={pendingAgent.name}
                  onChange={(e) => setPendingAgent({ ...pendingAgent, name: e.target.value })}
                  placeholder="my-remote-agent"
                  className="w-full px-2 py-1.5 text-xs rounded border bg-background"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('settings.a2a.addModal.endpoint')}</label>
                <input
                  type="text"
                  value={pendingAgent.endpoint}
                  onChange={(e) => setPendingAgent({ ...pendingAgent, endpoint: e.target.value })}
                  placeholder="http://host:8089"
                  className="w-full px-2 py-1.5 text-xs rounded border bg-background"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t('settings.a2a.addModal.apiKey')}</label>
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
                  {t('settings.a2a.addModal.verifyTls')}
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={pendingAgent.devAllowLocalhost ?? false}
                    onChange={(e) => setPendingAgent({ ...pendingAgent, devAllowLocalhost: e.target.checked })}
                  />
                  {t('settings.a2a.addModal.allowLoopback')}
                </label>
              </div>
              <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
                <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>
                  {t('settings.a2a.addModal.loopbackWarning')}
                </span>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>
                {t('settings.a2a.action.cancel')}
              </Button>
              <Button size="sm" onClick={submitAddForm}>{t('settings.a2a.action.save')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
