import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useSubagentStore } from '../../store/subagentStore'
import { SubagentInvocationCard } from './SubagentInvocationCard'
import { useI18n } from '../../i18n/useI18n'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSessionId: string | null
}

export function SubagentInvocationsPanel({ open, onOpenChange, parentSessionId }: Props) {
  const { t } = useI18n()
  const invocations = useSubagentStore(useShallow((s) => s.invocations))
  const loadInvocations = useSubagentStore((s) => s.loadInvocations)

  useEffect(() => {
    if (open && parentSessionId) {
      loadInvocations(parentSessionId)
    }
  }, [open, parentSessionId, loadInvocations])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px]" closeLabel={t('common.close')} data-testid="subagent-panel">
        <SheetHeader>
          <SheetTitle>{t('agent.subagent.invocations')}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-2 overflow-y-auto max-h-[calc(100vh-120px)]" data-testid="subagent-list">
          {invocations.length === 0 && (
            <div className="text-sm text-muted-foreground" data-testid="subagent-empty">{t('agent.subagent.empty')}</div>
          )}
          {invocations.map((inv) => (
            <SubagentInvocationCard
              key={inv.id}
              invocationId={inv.id}
              agentType={inv.agentType}
              description={inv.description}
            />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
