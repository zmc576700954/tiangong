import { useEffect, useState, useCallback } from 'react'
import { Code2, Shield, GitBranch, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface SlashCommand {
  name: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/implement', label: 'Implement', description: 'Implement a feature from node requirements', icon: Code2 },
  { name: '/fix', label: 'Fix Bug', description: 'Fix a bug with context from node', icon: Shield },
  { name: '/refactor', label: 'Refactor', description: 'Refactor with constraints from node', icon: GitBranch },
  { name: '/test', label: 'Add Tests', description: 'Add tests based on acceptance criteria', icon: Check },
]

interface SlashCommandMenuProps {
  filter: string
  onSelect: (command: SlashCommand) => void
  onClose: () => void
}

export function SlashCommandMenu({ filter, onSelect, onClose }: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filtered = SLASH_COMMANDS.filter((cmd) =>
    cmd.name.toLowerCase().includes(filter.toLowerCase()),
  )

  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[selectedIndex]) onSelect(filtered[selectedIndex])
      } else if (e.key === 'Escape') {
        onClose()
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (filtered.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-50">
      <div className="px-2.5 py-1.5 text-[9px] text-muted-foreground uppercase tracking-wider bg-muted/30">
        Commands
      </div>
      {filtered.map((cmd, i) => {
        const Icon = cmd.icon
        return (
          <button
            key={cmd.name}
            onClick={() => onSelect(cmd)}
            className={cn(
              'w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors',
              i === selectedIndex ? 'bg-muted' : 'hover:bg-muted/50',
            )}
          >
            <Icon className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-xs font-mono font-semibold text-blue-400 w-20">
              {cmd.name}
            </span>
            <span className="text-[11px] text-muted-foreground">{cmd.description}</span>
          </button>
        )
      })}
    </div>
  )
}
