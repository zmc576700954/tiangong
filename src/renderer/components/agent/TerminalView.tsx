import { useRef, useEffect } from 'react'
import { Terminal } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AgentOutput } from '@shared/types'

interface TerminalViewProps {
  outputs: AgentOutput[]
}

const TYPE_STYLES: Record<string, string> = {
  stdout: '',
  stderr: 'text-red-400',
  file_change: 'text-green-400',
  error: 'text-red-400',
  complete: 'text-blue-400',
}

export function TerminalView({ outputs }: TerminalViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [outputs.length])

  if (outputs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6 py-12">
        <div>
          <Terminal className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No output yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Agent output will appear here
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
      {outputs.map((output, i) => (
        <div key={`${output.type}-${output.timestamp}-${i}`} className={cn('whitespace-pre-wrap break-all', TYPE_STYLES[output.type])}>
          <span className="text-muted-foreground/30 select-none mr-1.5">
            [{output.type}]
          </span>
          {output.data}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
