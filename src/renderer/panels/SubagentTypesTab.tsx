import { useState, useEffect } from 'react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { useI18n } from '../i18n/useI18n'
import type { AgentTypeDefinition, SubagentScopeStrategy, SubagentToolName } from '@shared/types'
import { BUILT_IN_AGENT_TYPES } from '@shared/types'

interface Props {
  customTypes: AgentTypeDefinition[]
  onSave: (types: AgentTypeDefinition[]) => void
}

const EMPTY_TYPE: AgentTypeDefinition = {
  name: '',
  displayName: '',
  description: '',
  allowedTools: ['Read', 'Glob', 'Grep'],
  scopeStrategy: 'subset',
}

export function SubagentTypesTab({ customTypes, onSave }: Props) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<AgentTypeDefinition | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [localCustom, setLocalCustom] = useState<AgentTypeDefinition[]>(customTypes)

  useEffect(() => {
    setLocalCustom(customTypes)
  }, [customTypes])

  const handleSave = () => {
    if (!editing) return
    const updated = isNew
      ? [...localCustom, editing]
      : localCustom.map((t) => t.name === editing.name ? editing : t)
    setLocalCustom(updated)
    onSave(updated)
    setEditing(null)
    setIsNew(false)
  }

  const handleDelete = (name: string) => {
    const updated = localCustom.filter((t) => t.name !== name)
    setLocalCustom(updated)
    onSave(updated)
  }

  const allTypes = [...BUILT_IN_AGENT_TYPES, ...localCustom]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('settings.subagents.title')}</h3>
        <Button size="sm" variant="outline" onClick={() => { setEditing({ ...EMPTY_TYPE }); setIsNew(true) }}>
          {t('settings.subagents.new')}
        </Button>
      </div>

      <div className="space-y-2">
        {allTypes.map((agentType) => {
          const isBuiltIn = BUILT_IN_AGENT_TYPES.some((b) => b.name === agentType.name)
          return (
            <div key={agentType.name} className="border rounded p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{agentType.name}</span>
                <span className="text-muted-foreground">{agentType.displayName}</span>
                {isBuiltIn && <Badge variant="outline" className="text-[10px]">{t('settings.subagents.builtIn')}</Badge>}
                {!isBuiltIn && (
                  <div className="flex-1 flex justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-6 text-[10px]"
                      onClick={() => { setEditing({ ...agentType }); setIsNew(false) }}>{t('settings.subagents.edit')}</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] text-destructive"
                      onClick={() => handleDelete(agentType.name)}>{t('settings.subagents.delete')}</Button>
                  </div>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {agentType.description} &bull; {t('settings.subagents.scope')}: {agentType.scopeStrategy} &bull; {t('settings.subagents.tools')}: {Array.isArray(agentType.allowedTools) ? agentType.allowedTools.join(', ') : '*'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Edit form */}
      {editing && (
        <div className="border rounded p-4 space-y-3">
          <h4 className="text-sm font-medium">
            {isNew ? t('settings.subagents.formTitle.new') : t('settings.subagents.formTitle.edit')}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px]">{t('settings.subagents.name')}</label>
              <input
                className="w-full border rounded px-2 py-1 text-xs"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                disabled={!isNew}
              />
            </div>
            <div>
              <label className="text-[10px]">{t('settings.subagents.displayName')}</label>
              <input
                className="w-full border rounded px-2 py-1 text-xs"
                value={editing.displayName}
                onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-[10px]">{t('settings.subagents.description')}</label>
            <textarea
              className="w-full border rounded px-2 py-1 text-xs h-16"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px]">{t('settings.subagents.scopeStrategy')}</label>
              <select
                className="w-full border rounded px-2 py-1 text-xs"
                value={editing.scopeStrategy}
                onChange={(e) => setEditing({ ...editing, scopeStrategy: e.target.value as SubagentScopeStrategy })}
              >
                <option value="inherit">{t('settings.subagents.scope.inherit')}</option>
                <option value="subset">{t('settings.subagents.scope.subset')}</option>
                <option value="fresh">{t('settings.subagents.scope.fresh')}</option>
              </select>
            </div>
            <div>
              <label className="text-[10px]">{t('settings.subagents.allowedTools')}</label>
              <input
                className="w-full border rounded px-2 py-1 text-xs"
                value={Array.isArray(editing.allowedTools) ? editing.allowedTools.join(', ') : '*'}
                onChange={(e) => {
                  const val = e.target.value.trim()
                  setEditing({ ...editing, allowedTools: val === '*' ? '*' : val.split(',').map((s) => s.trim()).filter(Boolean) as SubagentToolName[] })
                }}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave}>{t('settings.subagents.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('settings.subagents.cancel')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}