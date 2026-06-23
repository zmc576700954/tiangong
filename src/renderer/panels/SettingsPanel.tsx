import { useState, useEffect } from 'react'
import { Bot, Server, RefreshCw, Download, Check, AlertCircle } from 'lucide-react'
import { cn } from '../lib/utils'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { SubagentTypesTab } from './SubagentTypesTab'
import { ContextWaterlineTab } from './ContextWaterlineTab'
import type { BizGraphSettings, AgentTypeDefinition } from '@shared/types'

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

export function SettingsPanel() {
  const [settings, setSettings] = useState<BizGraphSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<string | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [maskedKeys, setMaskedKeys] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [customTypes, setCustomTypes] = useState<AgentTypeDefinition[]>([])

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    if (!ipc) return
    try {
      const data = await ipc['settings:read']()
      setSettings(data)
      const keys: Record<string, string> = {}
      const masked: Record<string, string> = {}
      for (const k of data.apiKeys) {
        keys[k.provider] = ''
        masked[k.provider] = k.key || ''
      }
      setApiKeys(keys)
      setMaskedKeys(masked)
      if (data.customAgentTypes) setCustomTypes(data.customAgentTypes)
    } catch (err) {
      console.error('Failed to load settings:', err)
    } finally {
      setLoading(false)
    }
  }

  const refreshCli = async () => {
    if (!ipc) return
    setLoading(true)
    try {
      const updated = await ipc['settings:refreshCli']()
      setSettings((prev) => prev ? { ...prev, cliTools: updated } : null)
    } finally {
      setLoading(false)
    }
  }

  const installCli = async (name: string) => {
    if (!ipc) return
    setInstalling(name)
    try {
      const result = await ipc['settings:installCli'](name)
      setToast({ message: result.message, type: result.success ? 'success' : 'error' })
      setTimeout(() => setToast(null), 4000)
      if (result.success) await refreshCli()
    } finally {
      setInstalling(null)
    }
  }

  const saveApiKey = async (provider: string) => {
    if (!ipc) return
    const key = apiKeys[provider]
    await ipc['settings:setApiKey'](provider, key)
    // C-2-FIX: 保存后立即清除本地明文 state，减少敏感信息驻留时间
    setApiKeys((prev) => ({ ...prev, [provider]: '' }))
  }

  const persistCustomTypes = async (types: AgentTypeDefinition[]) => {
    if (!ipc || !settings) return
    setCustomTypes(types)
    const next: BizGraphSettings = { ...settings, customAgentTypes: types }
    try {
      await ipc['settings:write'](next)
      setSettings(next)
    } catch (err) {
      console.error('Failed to persist custom agent types:', err)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3 relative">
      {/* Toast 通知 */}
      {toast && (
        <div className={`absolute top-3 left-3 right-3 z-50 px-3 py-2 rounded-md text-xs shadow-lg border ${
          toast.type === 'success'
            ? 'bg-green-50 text-green-700 border-green-200'
            : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          {toast.message}
        </div>
      )}

      <Tabs defaultValue="general">
        <TabsList className="mb-4">
          <TabsTrigger value="general">基础设置</TabsTrigger>
          <TabsTrigger value="subagents">子代理类型</TabsTrigger>
          <TabsTrigger value="waterline">上下文水位</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-5">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                CLI Tools
              </h3>
              <button
                onClick={refreshCli}
                className="p-1 rounded hover:bg-muted text-muted-foreground" title="Refresh status"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {settings?.cliTools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center justify-between px-2.5 py-2 rounded-md bg-muted/30 border"
                >
                  <div className="flex items-center gap-2">
                    <Bot className="w-3.5 h-3.5 text-muted-foreground" />
                    <div>
                      <div className="text-sm font-medium">{tool.name}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {tool.installed ? (tool.version || 'installed') : 'not installed'}
                      </div>
                    </div>
                  </div>
                  {tool.installed ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-1">
                      <Check className="w-3 h-3" /> Ready
                    </span>
                  ) : (
                    <button
                      onClick={() => installCli(tool.name)}
                      disabled={!!installing}
                      className="text-xs px-2.5 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1 disabled:opacity-50"
                    >
                      <Download className="w-3 h-3" />
                      {installing === tool.name ? 'Installing...' : 'Install'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              API Keys (MCP Fallback)
            </h3>
            <div className="space-y-2">
              {['anthropic', 'openai', 'deepseek'].map((provider) => (
                <div key={provider} className="space-y-1">
                  <label className="text-xs text-muted-foreground capitalize">{provider}</label>
                  <div className="flex gap-1.5">
                    <input
                      type="password"
                      value={apiKeys[provider] || ''}
                      onChange={(e) => setApiKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
                      placeholder={maskedKeys[provider] ? 'Current: ****' : 'Enter API key...'}
                      className="flex-1 px-2 py-1.5 text-xs border rounded bg-background"
                    />
                    <button
                      onClick={() => saveApiKey(provider)}
                      className="px-2.5 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>
                API keys are stored locally in settings.json. They are used as fallback when CLI tools are unavailable.
              </span>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              MCP Servers
            </h3>
            <div className="space-y-1.5">
              {settings?.mcpServers.map((server) => (
                <div
                  key={server.name}
                  className={cn(
                    'flex items-center justify-between px-2.5 py-2 rounded-md border text-sm',
                    server.enabled ? 'bg-muted/30' : 'bg-muted/10 opacity-60'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Server className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>{server.name}</span>
                  </div>
                  <span className={cn(
                    'text-xs px-1.5 py-0.5 rounded-full',
                    server.enabled ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
                  )}>
                    {server.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="subagents">
          <SubagentTypesTab
            customTypes={customTypes}
            onSave={persistCustomTypes}
          />
        </TabsContent>

        <TabsContent value="waterline">
          <ContextWaterlineTab onSave={() => { /* persisted via IPC inside the tab */ }} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
