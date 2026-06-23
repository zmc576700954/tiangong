import { useState, useEffect } from 'react'
import { Button } from '../components/ui/button'

interface WaterlineConfig {
  autoCompactEnabled: boolean
  autoCompactThreshold: number
  minCompactInterval: number
}

interface Props {
  onSave: (config: WaterlineConfig) => void
}

export function ContextWaterlineTab({ onSave }: Props) {
  const [config, setConfig] = useState<WaterlineConfig>({
    autoCompactEnabled: true,
    autoCompactThreshold: 0.75,
    minCompactInterval: 60_000,
  })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    window.electronAPI['settings:getContextWaterlineConfig']().then((c) => {
      setConfig(c)
    }).catch(() => { /* use defaults */ })
  }, [])

  const handleSave = () => {
    if (!window.electronAPI) return
    window.electronAPI['settings:setContextWaterlineConfig'](config).then(() => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
    onSave(config)
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Context Waterline</h3>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.autoCompactEnabled}
            onChange={(e) => setConfig({ ...config, autoCompactEnabled: e.target.checked })}
          />
          Auto-compact when context exceeds threshold
        </label>

        <div>
          <label className="text-[10px] block">
            Threshold: {Math.round(config.autoCompactThreshold * 100)}%
          </label>
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.05"
            value={config.autoCompactThreshold}
            onChange={(e) => setConfig({ ...config, autoCompactThreshold: parseFloat(e.target.value) })}
            className="w-full"
          />
        </div>

        <div>
          <label className="text-[10px] block">
            Min interval between compactions
          </label>
          <input
            type="number"
            className="border rounded px-2 py-1 text-xs w-32"
            value={Math.round(config.minCompactInterval / 1000)}
            onChange={(e) => setConfig({ ...config, minCompactInterval: parseInt(e.target.value) * 1000 })}
            min={10}
            max={3600}
          />
          <span className="text-[10px] text-muted-foreground ml-2">seconds</span>
        </div>

        <Button size="sm" onClick={handleSave}>
          {saved ? '✓ Saved' : 'Save'}
        </Button>
      </div>
    </div>
  )
}