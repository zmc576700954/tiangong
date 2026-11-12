/**
 * 默认值设置页签
 *
 * `settings.adapterPreferences` / `settings.defaultModels` / `settings.compactModel`
 * 这三组设置的数据模型、IPC、preload 全都通了，却从来没有界面 —— 用户改不了，
 * 实际生效的永远是硬编码的 `claude-code`。本页签把它们真正暴露出来。
 *
 * 设计要点：
 *   - 四个区块各自保存（保存粒度按区块），失败走全局 Toast，不自建局部 toast
 *   - 模型档位用自由文本输入框：代码库里没有任何模型名清单，做枚举下拉等于臆造
 *   - 回退顺序用上移/下移按钮重排：仓库里没有现成的拖拽排序组件，不引新依赖
 *
 * 严格遵守 CLAUDE.md：不碰 Agent CLI 内部行为，只在设置边界上组装偏好。
 */

import { useMemo, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Plus, RefreshCw, Save, X } from 'lucide-react'
import { Button } from '../components/ui/button'
import { toastError, toastSuccess } from '../lib/toast'
import { errorText } from '../lib/error-text'
import { useI18n } from '../i18n/useI18n'
import { DEFAULT_ADAPTER_PREFERENCES } from '@shared/adapter-defaults'
import type { BizGraphSettings } from '@shared/types'
import type { TranslationKey } from '@shared/i18n'

export interface DefaultsTabProps {
  /** 主进程读回来的完整设置（已解密 / 已遮蔽 API Key）。 */
  settings: BizGraphSettings
  /** 已安装的 CLI 适配器名 —— 由调用方传入，组件自己不查 IPC。 */
  installedAdapters: string[]
  /** 保存补丁。失败时应 reject，组件会转成 error toast。 */
  onSave: (patch: Partial<BizGraphSettings>) => Promise<void>
  /**
   * 实时安装检测的状态。
   *
   * - `'pending'`：还在探测 —— 不能断言「一个都没装」
   * - `'ready'`：探测完成（结果可能为空）
   * - `'unavailable'`：探测失败或超时 —— 只能提示「无法确认」
   *
   * 省略时按 `'ready'` 处理（调用方没有做检测的场景）。
   */
  detection?: AdapterDetection
  /**
   * 重新做一次实时安装检测。
   *
   * 入口必须留在**这个页签内部**：让用户跳去「基础设置」点「刷新状态」会
   * `setLoading(true)` → 卸载整个 Tabs 子树 → 这里未保存的输入全丢，
   * 而且「刷新状态」根本不重跑安装检测，状态标签不会变。
   */
  onRetryDetection?: () => void
}

/**
 * 已安装适配器的实时检测状态。
 *
 * 「一个都没装」是**检测完成且结果为空**的事实陈述；检测还在跑、或者探测挂了，
 * 都不能这么说 —— 那是「我还没测完」，不是「确实没有」。
 */
export type AdapterDetection = 'pending' | 'ready' | 'unavailable'

/**
 * `defaultModels` 的档位。键名与 `BizGraphSettings['defaultModels']` 一一对应。
 *
 * 加档位时**必须**同时改这里、`models` 初值与保存时的对象字面量：保存是整体替换
 * （`settings:write` 是浅合并），漏一个键就等于把那一档清空。opencode 这一档
 * 正是这么被漏过一次 —— 界面上没有它，用户点一次保存就把配好的模型抹掉了。
 */
type ModelTier = 'claudeCode' | 'codex' | 'mcp' | 'opencode'

interface ModelTierSpec {
  tier: ModelTier
  labelKey: TranslationKey
  hintKey: TranslationKey
  placeholderKey: TranslationKey
}

const MODEL_TIERS: ModelTierSpec[] = [
  {
    tier: 'claudeCode',
    labelKey: 'settings.defaults.model.claudeCode',
    hintKey: 'settings.defaults.model.claudeCode.hint',
    placeholderKey: 'settings.defaults.model.claudeCode.placeholder',
  },
  {
    tier: 'codex',
    labelKey: 'settings.defaults.model.codex',
    hintKey: 'settings.defaults.model.codex.hint',
    placeholderKey: 'settings.defaults.model.codex.placeholder',
  },
  {
    tier: 'opencode',
    labelKey: 'settings.defaults.model.opencode',
    hintKey: 'settings.defaults.model.opencode.hint',
    placeholderKey: 'settings.defaults.model.opencode.placeholder',
  },
  {
    tier: 'mcp',
    labelKey: 'settings.defaults.model.mcp',
    hintKey: 'settings.defaults.model.mcp.hint',
    placeholderKey: 'settings.defaults.model.mcp.placeholder',
  },
]

export function DefaultsTab({
  settings,
  installedAdapters,
  onSave,
  detection = 'ready',
  onRetryDetection,
}: DefaultsTabProps) {
  const { t } = useI18n()

  const prefs = settings.adapterPreferences ?? DEFAULT_ADAPTER_PREFERENCES
  const [defaultAdapter, setDefaultAdapter] = useState(prefs.defaultAdapter)
  const [fallbackOrder, setFallbackOrder] = useState<string[]>(() => [...prefs.fallbackOrder])
  const [models, setModels] = useState<Record<ModelTier, string>>(() => ({
    claudeCode: settings.defaultModels?.claudeCode ?? '',
    codex: settings.defaultModels?.codex ?? '',
    mcp: settings.defaultModels?.mcp ?? '',
    opencode: settings.defaultModels?.opencode ?? '',
  }))
  const [compactModel, setCompactModel] = useState(settings.compactModel ?? '')
  const [pendingAdd, setPendingAdd] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

  // 注意：**没有**「settings 变了就重置本地草稿」的同步 effect。
  // 每个区块各带一个保存按钮，重置会静默吃掉用户没保存的输入
  // （保存 A 抹掉 B 的草稿、切页签回来发现白填了）。
  // 组件被 forceMount 常驻，草稿由 useState 初值持有，跨页签切换不丢。
  // 设置本身也没有从主进程推回渲染进程的通道，不存在「外部改了要同步」的场景。

  /** 还没进回退链的候选：已安装的适配器减去链里已有的。 */
  const addCandidates = useMemo(
    () => installedAdapters.filter((name) => !fallbackOrder.includes(name)),
    [installedAdapters, fallbackOrder],
  )

  /** 当前默认适配器是否已安装 —— 没装时不能把它从下拉里悄悄丢掉。 */
  const defaultInstalled = installedAdapters.includes(defaultAdapter)

  const runSave = async (section: string, patch: Partial<BizGraphSettings>): Promise<void> => {
    setSaving(section)
    try {
      await onSave(patch)
      toastSuccess(t('settings.defaults.saved'))
    } catch (err) {
      toastError(t('settings.defaults.saveFailed', { error: errorText(err) }))
    } finally {
      setSaving(null)
    }
  }

  const handleDefaultAdapterChange = (next: string): void => {
    if (!next) return
    setDefaultAdapter(next)
    // 默认适配器不该同时留在回退链里：它失败后按链回退，先试自己等于白试一次。
    setFallbackOrder((prev) => prev.filter((name) => name !== next))
  }

  const move = (index: number, delta: number): void => {
    setFallbackOrder((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const removeFromFallback = (name: string): void => {
    setFallbackOrder((prev) => prev.filter((item) => item !== name))
  }

  const addToFallback = (): void => {
    if (!pendingAdd) return
    setFallbackOrder((prev) => (prev.includes(pendingAdd) ? prev : [...prev, pendingAdd]))
    setPendingAdd('')
  }

  return (
    <div className="space-y-5">
      {/* ---- 默认适配器 ---- */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.defaults.defaultAdapter')}
        </h3>
        <div className="space-y-1.5">
          <select
            data-testid="defaults-default-adapter"
            aria-label={t('settings.defaults.defaultAdapter')}
            value={defaultInstalled ? defaultAdapter : ''}
            onChange={(e) => handleDefaultAdapterChange(e.target.value)}
            disabled={installedAdapters.length === 0}
            className="w-full px-2 py-1.5 text-xs border rounded bg-background disabled:opacity-50"
          >
            {/* 还在探测：先占位，别说「一个都没装」 */}
            {detection === 'pending' && (
              <option value="">{t('settings.defaults.defaultAdapter.detecting')}</option>
            )}
            {/* 存量的默认适配器没装时仍然列出来 —— 静默丢掉等于把用户的设置改了。 */}
            {detection !== 'pending' && !defaultInstalled && (
              <option value="">{defaultAdapter}</option>
            )}
            {installedAdapters.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {detection === 'pending' && (
            <p className="text-[10px] text-muted-foreground">
              {t('settings.defaults.defaultAdapter.detecting')}
            </p>
          )}
          {detection === 'unavailable' && (
            <div className="space-y-1.5">
              <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
                <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                <span>{t('settings.defaults.defaultAdapter.detectFailed')}</span>
              </div>
              {onRetryDetection && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="defaults-detection-retry"
                  onClick={onRetryDetection}
                >
                  <RefreshCw className="w-3 h-3 mr-1" />
                  {t('settings.defaults.defaultAdapter.retry')}
                </Button>
              )}
            </div>
          )}
          {detection === 'ready' && installedAdapters.length === 0 && (
            <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{t('settings.defaults.defaultAdapter.none')}</span>
            </div>
          )}
          {detection === 'ready' && !defaultInstalled && installedAdapters.length > 0 && (
            <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{t('settings.defaults.defaultAdapter.uninstalled', { name: defaultAdapter })}</span>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">{t('settings.defaults.defaultAdapter.hint')}</p>
        </div>
        <div className="mt-2">
          <Button
            size="sm"
            data-testid="defaults-adapter-save"
            disabled={saving !== null}
            onClick={() => void runSave('adapter', {
              adapterPreferences: { defaultAdapter, fallbackOrder },
            })}
          >
            <Save className="w-3 h-3 mr-1" />
            {t('settings.defaults.action.save')}
          </Button>
        </div>
      </section>

      {/* ---- 回退顺序 ---- */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.defaults.fallbackOrder')}
        </h3>
        <p className="text-[10px] text-muted-foreground mb-2">{t('settings.defaults.fallbackOrder.hint')}</p>
        {fallbackOrder.length === 0 ? (
          <div className="text-xs text-muted-foreground italic p-3 rounded border bg-muted/20">
            {t('settings.defaults.fallbackOrder.empty')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {fallbackOrder.map((name, index) => (
              <div
                key={name}
                className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-muted/30 border"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[10px] text-muted-foreground w-4 shrink-0">{index + 1}</span>
                  <span className="text-sm truncate">{name}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`defaults-fallback-up-${name}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    title={t('settings.defaults.fallbackOrder.moveUp')}
                    aria-label={t('settings.defaults.fallbackOrder.moveUp')}
                  >
                    <ArrowUp className="w-3 h-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`defaults-fallback-down-${name}`}
                    disabled={index === fallbackOrder.length - 1}
                    onClick={() => move(index, 1)}
                    title={t('settings.defaults.fallbackOrder.moveDown')}
                    aria-label={t('settings.defaults.fallbackOrder.moveDown')}
                  >
                    <ArrowDown className="w-3 h-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`defaults-fallback-remove-${name}`}
                    onClick={() => removeFromFallback(name)}
                    title={t('settings.defaults.fallbackOrder.remove')}
                    aria-label={t('settings.defaults.fallbackOrder.remove')}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {addCandidates.length > 0 && (
          <div className="flex gap-1.5 mt-2">
            <select
              data-testid="defaults-fallback-add"
              aria-label={t('settings.defaults.fallbackOrder.add')}
              value={pendingAdd}
              onChange={(e) => setPendingAdd(e.target.value)}
              className="flex-1 px-2 py-1.5 text-xs border rounded bg-background"
            >
              <option value="">{t('settings.defaults.fallbackOrder.addPlaceholder')}</option>
              {addCandidates.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              data-testid="defaults-fallback-add-button"
              disabled={!pendingAdd}
              onClick={addToFallback}
            >
              <Plus className="w-3 h-3 mr-1" />
              {t('settings.defaults.fallbackOrder.add')}
            </Button>
          </div>
        )}
        <div className="mt-2">
          <Button
            size="sm"
            data-testid="defaults-fallback-save"
            disabled={saving !== null}
            onClick={() => void runSave('fallback', {
              adapterPreferences: { defaultAdapter, fallbackOrder },
            })}
          >
            <Save className="w-3 h-3 mr-1" />
            {t('settings.defaults.action.save')}
          </Button>
        </div>
      </section>

      {/* ---- 按适配器分开的默认模型 ---- */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.defaults.defaultModels')}
        </h3>
        <div className="space-y-2.5">
          {MODEL_TIERS.map(({ tier, labelKey, hintKey, placeholderKey }) => (
            <div key={tier} className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor={`defaults-model-${tier}`}>
                {t(labelKey)}
              </label>
              <input
                type="text"
                id={`defaults-model-${tier}`}
                data-testid={`defaults-model-${tier}`}
                value={models[tier]}
                placeholder={t(placeholderKey)}
                onChange={(e) => setModels((prev) => ({ ...prev, [tier]: e.target.value }))}
                className="w-full px-2 py-1.5 text-xs border rounded bg-background"
              />
              <p className="text-[10px] text-muted-foreground">{t(hintKey)}</p>
              {tier === 'mcp' && (
                <div className="flex items-start gap-1.5 text-[10px] text-amber-600 bg-amber-50 p-2 rounded">
                  <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{t('settings.defaults.model.mcp.gateway')}</span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2">
          <Button
            size="sm"
            data-testid="defaults-models-save"
            disabled={saving !== null}
            onClick={() => void runSave('models', {
              // 四个档位必须**一起**发：settings:write 是浅合并，
              // defaultModels 会被整体替换，少发一个键等于把那一档清空。
              defaultModels: {
                claudeCode: models.claudeCode,
                codex: models.codex,
                mcp: models.mcp,
                opencode: models.opencode,
              },
            })}
          >
            <Save className="w-3 h-3 mr-1" />
            {t('settings.defaults.action.save')}
          </Button>
        </div>
      </section>

      {/* ---- 压缩模型 ---- */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          {t('settings.defaults.compactModel')}
        </h3>
        <div className="space-y-1">
          <input
            type="text"
            data-testid="defaults-compact-model"
            value={compactModel}
            placeholder={t('settings.defaults.compactModel.placeholder')}
            onChange={(e) => setCompactModel(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded bg-background"
          />
          <p className="text-[10px] text-muted-foreground">{t('settings.defaults.compactModel.hint')}</p>
        </div>
        <div className="mt-2">
          <Button
            size="sm"
            data-testid="defaults-compact-save"
            disabled={saving !== null}
            onClick={() => void runSave('compact', { compactModel })}
          >
            <Save className="w-3 h-3 mr-1" />
            {t('settings.defaults.action.save')}
          </Button>
        </div>
      </section>
    </div>
  )
}
