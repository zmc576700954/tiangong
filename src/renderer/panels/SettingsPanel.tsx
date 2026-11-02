import { useState, useEffect, useMemo, useRef } from 'react'
import { Bot, Server, RefreshCw, Download, Check, AlertCircle, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { SubagentTypesTab } from './SubagentTypesTab'
import { ContextWaterlineTab } from './ContextWaterlineTab'
import { useI18n } from '../i18n/useI18n'
import type { Locale } from '@shared/i18n/types'
import { AdapterHealthPanel } from './AdapterHealthPanel'
import { A2ASettingsTab } from './A2ASettingsTab'
import { DefaultsTab } from './DefaultsTab'
import type { AdapterDetection } from './DefaultsTab'
import type { BizGraphSettings, AgentTypeDefinition } from '@shared/types'
import { ALLOWED_API_PROVIDERS } from '@shared/adapter-defaults'
import { toastError, toastSuccess } from '../lib/toast'
import { errorText } from '../lib/error-text'

const ipc = typeof window !== 'undefined' && window.electronAPI
  ? window.electronAPI
  : null

/**
 * 已安装适配器的实时检测上界。
 *
 * CLI 探测是 `execFile(cmd, ['--version'])`，**没有超时**
 * （src/main/adapters/cline.ts:26、cursor.ts:25、qoder.ts:25 等）：一个在
 * `--version` 上等待交互输入的 CLI（首次运行的认证向导）、装坏了的 CLI、
 * 或者往满管道写的 CLI，都可能让探测永不 settle。而
 * `AdapterRegistry.checkAllInstalled()` 用 `Promise.allSettled` 包着
 * （src/main/agent/adapter-registry.ts:35-50）—— 只要有一个不 settle，
 * 整个 IPC 就不会返回。
 *
 * 5s 的依据：一次健康检测最多 11 个进程 spawn，即使安装缓存失效（要真探测），
 * 通常也在 0.2–1s 内跑完。5s 是健康最坏情况的数倍余量，慢机器/冷启动上不会
 * 误报「无法确认」；同时又足够短 —— 挂死的探测不会让下拉长时间停在「检测中」。
 *
 * 注意：这个上界只管**渲染层不再等**。主进程那边的 execFile 仍然没有超时，
 * 挂死的子进程会留在那儿（既有行为，marketplace 路径同样受影响）。
 */
const ADAPTER_DETECTION_TIMEOUT_MS = 5000

/**
 * 给探测加一个上界，并允许取消。
 *
 * - 超时：reject 一个带说明的 Error（渲染层据此转成「无法确认」）
 * - abort：clearTimeout + reject。组件卸载时调用 —— 否则会留下一个悬挂的
 *   定时器，还会在组件卸载后触发迟到的 setState 与日志。
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error(`${label}已取消`))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export function SettingsPanel() {
  const { locale, setLocale: setUiLocale, t } = useI18n()
  const [settings, setSettings] = useState<BizGraphSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<string | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [maskedKeys, setMaskedKeys] = useState<Record<string, string>>({})
  const [customTypes, setCustomTypes] = useState<AgentTypeDefinition[]>([])
  const [localeDraft, setLocaleDraft] = useState<Locale>(locale)
  // 受控页签：默认值页签需要知道当前是否激活，才能给它挂 hidden（forceMount 常驻）
  const [activeTab, setActiveTab] = useState('general')
  // 实时检测到的已安装适配器（见 loadDetectedAdapters）
  const [detectedAdapters, setDetectedAdapters] = useState<string[]>([])
  // 实时检测的状态：pending / ready / unavailable
  const [detection, setDetection] = useState<AdapterDetection>('pending')
  // 探测的取消句柄：组件卸载时 abort，不留悬挂定时器、不打到已卸载的组件
  const detectionAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // 首屏只等 settings:read —— 外部 CLI 探测可能永不 settle（见
    // ADAPTER_DETECTION_TIMEOUT_MS），绝不能让它把整个设置面板卡在 spinner 上。
    void loadSettings()
    void loadDetectedAdapters()
    return () => { detectionAbortRef.current?.abort() }
  }, [])

  // 主进程推送语言变更时同步下拉框
  useEffect(() => {
    setLocaleDraft(locale)
  }, [locale])

  /**
   * 实时检测已安装的适配器。
   *
   * `settings.cliTools[].installed` 只有用户手动点「刷新状态」后才会更新 ——
   * 启动时没人调用刷新，于是这个标记是陈旧的（默认全是 false）。
   * 「默认适配器」下拉必须用实时检测，否则新装的用户会看到一个永久禁用、
   * 还提示他去安装自己已经装了 CLI 的下拉。
   *
   * `agent:getAdapterMarketplace` 内部走 `agentManager.listAdapters()` →
   * `registry.checkAllInstalled()`（对每个注册适配器实时探测），
   * 并顺带套用 marketplace 既有的 `hidden` 过滤 —— 内部适配器
   * （mindmap-internal）不该出现在用户可选的列表里。
   *
   * 探测带一个上界：CLI 的 --version 探测可能永不 settle（见
   * ADAPTER_DETECTION_TIMEOUT_MS）。到界后按「无法确认」处理，面板照常用
   * cliTools 里的已知信息，绝不停在 spinner 上。
   *
   * 可重入：检测失败/超时后，用户可以在「默认值」页签内点「重新检测」再跑一次
   * （重试入口在页签内部，跳去「基础设置」会卸载整个 Tabs 子树、丢掉草稿）。
   */
  const loadDetectedAdapters = async () => {
    if (!ipc) {
      setDetection('unavailable')
      return
    }
    // 取消上一次还没结束的探测（重试时用）
    detectionAbortRef.current?.abort()
    const controller = new AbortController()
    detectionAbortRef.current = controller
    setDetection('pending')
    try {
      const items = await withTimeout(
        ipc['agent:getAdapterMarketplace'](),
        ADAPTER_DETECTION_TIMEOUT_MS,
        '已安装适配器检测',
        controller.signal,
      )
      if (controller.signal.aborted) return
      setDetectedAdapters(items.filter((item) => item.installed).map((item) => item.name))
      setDetection('ready')
    } catch (err) {
      // 已取消 = 组件卸载，或被一次新的探测取代：不记日志、不 setState
      if (controller.signal.aborted) return
      console.error('Failed to detect installed adapters:', err)
      setDetection('unavailable')
    }
  }

  const loadSettings = async () => {
    try {
      // 没有 electronAPI（用普通浏览器打开开发服务器）时也要走到 finally ——
      // 否则 loading 永远是 true，面板会永远转圈。
      if (!ipc) return
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
      // 面板内的反馈统一走全局 toast（src/renderer/lib/toast.tsx）——
      // 同一个面板里混两套反馈样式（本地横幅 + 全局 toast）会让用户以为
      // 是两种不同的提示。DefaultsTab 也是这么做的。
      if (result.success) {
        toastSuccess(result.message)
      } else {
        toastError(result.message)
      }
      if (result.success) await refreshCli()
    } finally {
      setInstalling(null)
    }
  }

  /**
   * 保存某个 provider 的 API Key。
   *
   * 空输入**不能**保存：输入框保存后就被清空（不把明文留在 state 里），
   * 用户什么都不改、只是又点了一次「保存」，就会把已存的密钥覆盖成空串。
   * 所以空输入直接报错返回 —— 真正的「删除」走 deleteApiKey 那条独立动作。
   */
  const saveApiKey = async (provider: string) => {
    if (!ipc) return
    const key = (apiKeys[provider] ?? '').trim()
    if (!key) {
      toastError(t('settings.apiKeys'), t('settings.apiKeys.emptyKey'))
      return
    }
    try {
      await ipc['settings:setApiKey'](provider, key)
    } catch (err) {
      toastError(t('settings.apiKeys'), t('settings.apiKeys.saveFailed', { error: errorText(err) }))
      return
    }
    // C-2-FIX: 保存后立即清除本地明文 state，减少敏感信息驻留时间
    setApiKeys((prev) => ({ ...prev, [provider]: '' }))
    // 该 provider 现在有 key 了 —— 占位符从「输入 API 密钥…」变成「当前：****」
    // （maskedKeys 只被当作「这个 provider 有没有 key」的标记用，不展示具体值）
    setMaskedKeys((prev) => ({ ...prev, [provider]: '****' }))
  }

  /**
   * 删除某个 provider 已存的 API Key。
   *
   * 空串 = 主进程从 apiKeys 里移除该条目（不是写入一个空 key）。
   * 二次确认是必须的：密钥删掉后只能重新输入，找不回来。
   */
  const deleteApiKey = async (provider: string) => {
    if (!ipc) return
    if (!window.confirm(t('settings.apiKeys.confirmDelete', { provider }))) return
    try {
      await ipc['settings:setApiKey'](provider, '')
    } catch (err) {
      toastError(t('settings.apiKeys'), t('settings.apiKeys.deleteFailed', { error: errorText(err) }))
      return
    }
    setApiKeys((prev) => ({ ...prev, [provider]: '' }))
    setMaskedKeys((prev) => {
      const next = { ...prev }
      delete next[provider]
      return next
    })
    toastSuccess(t('settings.apiKeys.deleted', { provider }))
  }

  /**
   * 该 provider 是否已经存了 key。
   *
   * 看的是「有没有这条记录」，不是「遮蔽后的值是否非空」——
   * 老版本可能存过空 key，那条记录存在但没有内容，仍然要给删除入口。
   * maskedKeys 的值只当「有没有 key」的标记用，不展示具体内容。
   */
  const hasStoredKey = (provider: string): boolean =>
    Object.prototype.hasOwnProperty.call(maskedKeys, provider)

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

  const handleLocaleChange = async (next: Locale) => {
    if (!ipc || !settings) return
    const previous = locale
    setLocaleDraft(next)
    setUiLocale(next)
    try {
      const updated: BizGraphSettings = { ...settings, locale: next }
      await ipc['settings:write'](updated)
      setSettings(updated)
      toastSuccess(t('settings.language.saved'))
    } catch (err) {
      console.error('Failed to persist locale:', err)
      setLocaleDraft(previous)
      setUiLocale(previous)
      toastError(t('settings.language.saveFailed'))
    }
  }

  /**
   * 已安装的适配器名 —— 「默认值」页签的默认适配器下拉只列这些。
   *
   * 两个来源取并集：实时检测的结果（准）+ cliTools 里 `installed === true` 的名字
   * （用户手动点过「刷新状态」后确认过的状态）。
   */
  const installedNames = useMemo(() => {
    const names = new Set(detectedAdapters)
    for (const tool of settings?.cliTools ?? []) {
      if (tool.installed) names.add(tool.name)
    }
    return [...names]
  }, [detectedAdapters, settings?.cliTools])

  /**
   * 「默认值」页签的保存回调。
   *
   * `settings:write` 在主进程做的是顶层浅合并，所以这里必须把**整个** settings
   * 连同补丁一起发过去 —— 只发补丁会把 cliTools / apiKeys 等字段整体丢掉。
   */
  const persistDefaults = async (patch: Partial<BizGraphSettings>): Promise<void> => {
    if (!ipc || !settings) {
      // 不能静默 resolve —— 调用方会据此弹「已保存」的成功提示，实际什么都没写。
      throw new Error('设置尚未加载完成，无法保存。请稍后重试。')
    }
    const next: BizGraphSettings = { ...settings, ...patch }
    await ipc['settings:write'](next)
    setSettings(next)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // 设置读不出来（没有 electronAPI，或读取失败）：降级渲染 + 说清楚为什么。
  // 加载状态必须有终态 —— 成功、失败或降级都行，但不能永远转圈。
  // 也不能渲染成「一个 CLI 都没装」的假象：那是「没读到」，不是「确实没有」。
  if (!settings) {
    return (
      <div className="p-3">
        <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{ipc ? t('settings.loadFailed') : t('settings.requiresElectron')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3 relative">

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="general">{t('settings.tab.general')}</TabsTrigger>
          <TabsTrigger value="subagents">{t('settings.tab.subagents')}</TabsTrigger>
          <TabsTrigger value="waterline">{t('settings.tab.waterline')}</TabsTrigger>
          <TabsTrigger value="health">{t('settings.tab.health')}</TabsTrigger>
          <TabsTrigger value="defaults">{t('settings.tab.defaults')}</TabsTrigger>
          <TabsTrigger value="a2a">{t('settings.tab.a2a')}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-5">
          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t('settings.language')}
            </h3>
            <select
              data-testid="language-select"
              value={localeDraft}
              onChange={(e) => { void handleLocaleChange(e.target.value as Locale) }}
              className="w-full px-2 py-1.5 text-xs border rounded bg-background"
            >
              <option value="zh-CN">{t('settings.language.zhCN')}</option>
              <option value="en-US">{t('settings.language.enUS')}</option>
            </select>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('settings.cliTools')}
              </h3>
              <button
                onClick={refreshCli}
                className="p-1 rounded hover:bg-muted text-muted-foreground" title={t('settings.refreshStatus')}
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
                        {tool.installed ? (tool.version || t('settings.installed')) : t('settings.notInstalled')}
                      </div>
                    </div>
                  </div>
                  {tool.installed ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-1">
                      <Check className="w-3 h-3" /> {t('settings.ready')}
                    </span>
                  ) : tool.npmPackage ? (
                    <button
                      data-testid={`cli-install-${tool.name}`}
                      onClick={() => installCli(tool.name)}
                      disabled={!!installing}
                      className="text-xs px-2.5 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 flex items-center gap-1 disabled:opacity-50"
                    >
                      <Download className="w-3 h-3" />
                      {installing === tool.name ? t('settings.installing') : t('settings.install')}
                    </button>
                  ) : (
                    // 没有 npm 安装方式（cursor 只能官网下载）——
                    // 给一个点了必然失败的「安装」按钮只会误导用户。
                    <span className="text-[10px] text-muted-foreground">
                      {t('settings.cliTools.manualInstall')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t('settings.apiKeys')}
            </h3>
            <div className="space-y-2">
              {ALLOWED_API_PROVIDERS.map((provider) => (
                <div key={provider} className="space-y-1">
                  <label className="text-xs text-muted-foreground capitalize">{provider}</label>
                  <div className="flex gap-1.5">
                    <input
                      type="password"
                      data-testid={`api-key-input-${provider}`}
                      value={apiKeys[provider] || ''}
                      onChange={(e) => setApiKeys((prev) => ({ ...prev, [provider]: e.target.value }))}
                      placeholder={hasStoredKey(provider) ? t('settings.currentKey') : t('settings.enterApiKey')}
                      className="flex-1 px-2 py-1.5 text-xs border rounded bg-background"
                    />
                    <button
                      data-testid={`api-key-save-${provider}`}
                      onClick={() => saveApiKey(provider)}
                      className="px-2.5 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                    >
                      {t('settings.save')}
                    </button>
                    {hasStoredKey(provider) && (
                      <button
                        data-testid={`api-key-delete-${provider}`}
                        onClick={() => deleteApiKey(provider)}
                        title={t('settings.apiKeys.delete')}
                        aria-label={t('settings.apiKeys.delete')}
                        className="px-2 py-1.5 text-xs border rounded hover:bg-muted text-muted-foreground flex items-center"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>
                {t('settings.apiKeysHint')}
              </span>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {t('settings.mcpServers')}
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
                    {server.enabled ? t('settings.enabled') : t('settings.disabled')}
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

        <TabsContent value="health">
          <AdapterHealthPanel />
        </TabsContent>

        {/* forceMount：常驻挂载，切走再切回来时未保存的草稿不丢。
            hidden 由我们控制 —— Radix 1.1 的 forceMount 只保证「不卸载」，
            不会自动隐藏未激活的面板（它把 hidden 写成 false），
            所以这里用 HTML hidden 属性把它藏起来。 */}
        <TabsContent value="defaults" forceMount hidden={activeTab !== 'defaults'}>
          {settings && (
            <DefaultsTab
              settings={settings}
              installedAdapters={installedNames}
              onSave={persistDefaults}
              detection={detection}
              onRetryDetection={() => { void loadDetectedAdapters() }}
            />
          )}
        </TabsContent>

        <TabsContent value="a2a">
          <A2ASettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
