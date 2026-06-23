import { useState, useEffect } from 'react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
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
        <h3 className="text-sm font-medium">Subagent Types</h3>
        <Button size="sm" variant="outline" onClick={() => { setEditing({ ...EMPTY_TYPE }); setIsNew(true) }}>
          + New Custom Type
        </Button>
      </div>

      <div className="space-y-2">
        {allTypes.map((t) => {
          const isBuiltIn = BUILT_IN_AGENT_TYPES.some((b) => b.name === t.name)
          return (
            <div key={t.name} className="border rounded p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{t.name}</span>
                <span className="text-muted-foreground">{t.displayName}</span>
                {isBuiltIn && <Badge variant="outline" className="text-[10px]">built-in</Badge>}
                {!isBuiltIn && (
                  <div className="flex-1 flex justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-6 text-[10px]"
                      onClick={() => { setEditing({ ...t }); setIsNew(false) }}>Edit</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] text-destructive"
                      onClick={() => handleDelete(t.name)}>Delete</Button>
                  </div>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {t.description} &bull; scope: {t.scopeStrategy} &bull; tools: {Array.isArray(t.allowedTools) ? t.allowedTools.join(', ') : '*'}
              </div>
            </div>
          )
        })}
      </div>

      {/* Edit form */}
      {editing && (
        <div className="border rounded p-4 space-y-3">
          <h4 className="text-sm font-medium">{isNew ? 'New' : 'Edit'} Custom Type</h4>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px]">Name (machine name)</label>
              <input
                className="w-full border rounded px-2 py-1 text-xs"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                disabled={!isNew}
              />
            </div>
            <div>
              <label className="text-[10px]">Display Name</label>
              <input
                className="w-full border rounded px-2 py-1 text-xs"
                value={editing.displayName}
                onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-[10px]">Description</label>
            <textarea
              className="w-full border rounded px-2 py-1 text-xs h-16"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px]">Scope Strategy</label>
              <select
                className="w-full border rounded px-2 py-1 text-xs"
                value={editing.scopeStrategy}
                onChange={(e) => setEditing({ ...editing, scopeStrategy: e.target.value as SubagentScopeStrategy })}
              >
                <option value="inherit">inherit</option>
                <option value="subset">subset</option>
                <option value="fresh">fresh</option>
              </select>
            </div>
            <div>
              <label className="text-[10px]">Allowed Tools (comma separated)</label>
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
            <Button size="sm" onClick={handleSave}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}