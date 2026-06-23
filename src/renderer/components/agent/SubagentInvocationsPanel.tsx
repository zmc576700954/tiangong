import { useEffect } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useSubagentStore } from '../../store/subagentStore'
import { SubagentInvocationCard } from './SubagentInvocationCard'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentSessionId: string | null
}

export function SubagentInvocationsPanel({ open, onOpenChange, parentSessionId }: Props) {
  const invocations = useSubagentStore((s) => s.invocations)
  const loadInvocations = useSubagentStore((s) => s.loadInvocations)

  useEffect(() => {
    if (open && parentSessionId) {
      loadInvocations(parentSessionId)
    }
  }, [open, parentSessionId, loadInvocations])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>Subagent Invocations</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-2 overflow-y-auto max-h-[calc(100vh-120px)]">
          {invocations.length === 0 && (
            <div className="text-sm text-muted-foreground">No subagent invocations yet.</div>
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
