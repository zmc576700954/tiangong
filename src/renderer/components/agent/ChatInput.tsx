import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '../../lib/utils'
import { SlashCommandMenu } from './SlashCommandMenu'
import type { SlashCommand } from './promptTemplates'
import { MentionSearchPopup } from './MentionSearchPopup'
import type { ContextRef } from '@shared/types'

interface ChatInputProps {
  onSend: (content: string, contextRefs: ContextRef[]) => void
  onStop?: () => void
  onMentionAdd?: (ref: ContextRef) => void
  disabled?: boolean
  isRunning?: boolean
  attachedContexts: ContextRef[]
}

export function ChatInput({ onSend, onStop, onMentionAdd, disabled, isRunning, attachedContexts }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [mentionFilter, setMentionFilter] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setValue(val)

    const slashMatch = val.match(/\/(\w*)$/)
    if (slashMatch) {
      setShowSlash(true)
      setSlashFilter('/' + slashMatch[1])
      setShowMention(false)
      return
    }
    setShowSlash(false)

    const mentionMatch = val.match(/@(\w*)$/)
    if (mentionMatch) {
      setShowMention(true)
      setMentionFilter(mentionMatch[1])
      return
    }
    setShowMention(false)
  }

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setValue((v) => v.replace(/\/\w*$/, ''))
    setShowSlash(false)
    onSend(cmd.name, attachedContexts)
  }, [onSend, attachedContexts])

  const handleMentionSelect = useCallback((ref: ContextRef) => {
    setValue((v) => v.replace(/@\w*$/, ''))
    setShowMention(false)
    if (onMentionAdd) onMentionAdd(ref)
  }, [onMentionAdd])

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed, attachedContexts)
    setValue('')
    setShowSlash(false)
    setShowMention(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash || showMention) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    }
  }, [value])

  return (
    <div className="border-t border-border p-2.5 relative flex-shrink-0">
      {showSlash && (
        <SlashCommandMenu
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlash(false)}
        />
      )}
      {showMention && (
        <MentionSearchPopup
          filter={mentionFilter}
          onSelect={handleMentionSelect}
          onClose={() => setShowMention(false)}
          excludeIds={attachedContexts.filter((c) => c.type === 'node').map((c) => c.id)}
        />
      )}
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message, / for commands, @ to add context..."
          disabled={disabled && !isRunning}
          rows={1}
          className={cn(
            'flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg resize-none',
            'placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        />
        {isRunning ? (
          <button
            onClick={onStop}
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors bg-red-600 text-white hover:bg-red-700"
            title="Stop"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
              value.trim() && !disabled
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="text-[9px] text-muted-foreground/50">Shift+Enter for newline</span>
      </div>
    </div>
  )
}
