/**
 * 适配器安装引导组件
 *
 * 当没有适配器安装时，替代 "Welcome to Agent" 空状态。
 * 像VSCode插件市场一样，列出可用适配器及其安装方式。
 */

import { useState } from 'react'
import { Bot, Check, ExternalLink, Copy, CheckCheck, Settings, RefreshCw, ChevronDown, ChevronRight, Terminal, Zap, Key } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AdapterMarketplaceItem, InstallMethod } from '@shared/types'

interface AdapterSetupGuideProps {
  items: AdapterMarketplaceItem[]
  onOpenSettings: () => void
  onRefresh: () => void
  onInstallCli: (name: string) => Promise<{ success: boolean; message: string }>
}

function getTypeIcon(type: AdapterMarketplaceItem['type']) {
  switch (type) {
    case 'sdk': return <Zap className="w-4 h-4 text-amber-400" />
    case 'cli': return <Terminal className="w-4 h-4 text-blue-400" />
    case 'api': return <Key className="w-4 h-4 text-green-400" />
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-muted transition-colors shrink-0"
      title="Copy"
    >
      {copied ? <CheckCheck className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
    </button>
  )
}

function InstallMethodItem({ method }: { method: InstallMethod }) {
  if (method.type === 'api-key') {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <Key className="w-3 h-3" />
        <span>{method.label}</span>
      </div>
    )
  }
  if (method.type === 'manual') {
    return (
      <a
        href={method.command}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-2 py-1.5 text-xs text-blue-500 hover:text-blue-400 transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        <span>{method.label}</span>
      </a>
    )
  }
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground min-w-[40px] text-center">
        {method.label}
      </span>
      <code className="text-[11px] font-mono text-foreground/80 truncate flex-1">{method.command}</code>
      <CopyButton text={method.command} />
    </div>
  )
}

function AdapterCard({ item, onInstallCli }: { item: AdapterMarketplaceItem; onInstallCli: (name: string) => Promise<{ success: boolean; message: string }> }) {
  const [expanded, setExpanded] = useState(item.installed ? false : item.recommendedInstallIndex >= 0)
  const [installing, setInstalling] = useState(false)

  const recommendedMethod = item.installMethods[item.recommendedInstallIndex]
  const canNpmInstall = item.installMethods.some((m) => m.type === 'npm')

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await onInstallCli(item.name)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className={cn(
      'border rounded-lg overflow-hidden transition-colors',
      item.installed ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-background',
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left"
      >
        {getTypeIcon(item.type)}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{item.displayName}</span>
            {item.installed ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">
                <Check className="w-2.5 h-2.5" /> Ready
              </span>
            ) : (
              <span className="text-[10px] text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                Not Installed
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{item.description}</p>
        </div>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>

      {expanded && !item.installed && (
        <div className="border-t border-border px-2 py-2 space-y-1">
          {item.installMethods.length > 0 ? (
            <>
              {recommendedMethod && (
                <div className="mb-1.5">
                  <p className="text-[10px] text-muted-foreground px-2 mb-1">Recommended</p>
                  <InstallMethodItem method={recommendedMethod} />
                </div>
              )}
              {item.installMethods.filter((_, i) => i !== item.recommendedInstallIndex).length > 0 && (
                <div>
                  <p className="text-[10px] text-muted-foreground px-2 mb-1">Other methods</p>
                  {item.installMethods
                    .filter((_, i) => i !== item.recommendedInstallIndex)
                    .map((method, i) => (
                      <InstallMethodItem key={i} method={method} />
                    ))}
                </div>
              )}
              {canNpmInstall && (
                <div className="px-2 pt-1.5 border-t border-border/50">
                  <button
                    onClick={handleInstall}
                    disabled={installing}
                    className="text-[11px] px-2.5 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {installing ? 'Installing...' : 'Install via npm'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground px-2">No installation methods available</p>
          )}
          {item.homepage && (
            <a
              href={item.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-blue-500 hover:text-blue-400 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              View documentation
            </a>
          )}
        </div>
      )}

      {expanded && item.installed && (
        <div className="border-t border-border px-3 py-2">
          <p className="text-[11px] text-green-500">This adapter is ready to use.</p>
        </div>
      )}
    </div>
  )
}

export function AdapterSetupGuide({ items, onOpenSettings, onRefresh, onInstallCli }: AdapterSetupGuideProps) {
  const installedCount = items.filter((i) => i.installed).length
  const anyInstalled = installedCount > 0

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <Bot className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
          <h2 className="text-lg font-semibold mb-1">
            {anyInstalled ? 'Agent Tools' : 'Choose Your Agent Tools'}
          </h2>
          <p className="text-xs text-muted-foreground">
            {anyInstalled
              ? `${installedCount} of ${items.length} adapters installed`
              : 'Install at least one agent tool to start coding with AI'
            }
          </p>
        </div>

        <div className="space-y-2 mb-4">
          {items.map((item) => (
            <AdapterCard key={item.name} item={item} onInstallCli={onInstallCli} />
          ))}
        </div>

        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            <Settings className="w-3 h-3" />
            Settings
          </button>
        </div>
      </div>
    </div>
  )
}
