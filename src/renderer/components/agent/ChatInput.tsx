import { useState, useRef, useCallback, useEffect } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '../../lib/utils'
import { SlashCommandMenu } from './SlashCommandMenu'
import type { SlashCommand } from './promptTemplates'
import { generatePromptTemplate } from './promptTemplates'
import { MentionSearchPopup } from './MentionSearchPopup'
import type { GraphNode } from '@shared/types'
import type { ContextRef } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'

interface ChatInputProps {
  onSend: (content: string, contextRefs: ContextRef[]) => void
  onStop?: () => void
  onMentionAdd?: (ref: ContextRef) => void
  disabled?: boolean
  isRunning?: boolean
  attachedContexts: ContextRef[]
  projectPath?: string
  selectedNode?: GraphNode
  /** Fixed container height set by the resize handle. Undefined = auto-size. */
  containerHeight?: number
  initialPrompt?: string | null
  onPromptConsumed?: () => void
}

export function ChatInput({ onSend, onStop, onMentionAdd, disabled, isRunning, attachedContexts, projectPath, selectedNode, containerHeight, initialPrompt, onPromptConsumed }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [mentionFilter, setMentionFilter] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Consume initialPrompt (e.g., from mindmap dev prompt generation)
  useEffect(() => {
    if (initialPrompt) {
      setValue(initialPrompt)
      onPromptConsumed?.()
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [initialPrompt, onPromptConsumed])

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
    const allNodes = useGraphStore.getState().nodes
    const allEdges = useGraphStore.getState().edges
    const template = generatePromptTemplate(cmd.name, selectedNode, allNodes, allEdges)
    if (template) {
      // Show generated template in input for user to review/edit before sending
      setValue(template)
    } else {
      // No node selected — insert command hint as starting point
      setValue(`${cmd.name} `)
    }
    setShowSlash(false)
    // Focus the textarea so the user can immediately edit
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [selectedNode])

  const handleMentionSelect = useCallback((ref: ContextRef) => {
    // Insert @label text into input for file references
    if (ref.type === 'file') {
      setValue((v) => v.replace(/@\w*$/, `@${ref.label} `))
    } else {
      setValue((v) => v.replace(/@\w*$/, ''))
    }
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
      // When containerHeight is set, the textarea fills via CSS flex; cap at scrollHeight
      if (!containerHeight) {
        el.style.height = Math.min(el.scrollHeight, 120) + 'px'
      } else {
        el.style.height = '100%'
      }
    }
  }, [value, containerHeight])

  return (
    <div
      className="border-t border-border relative shrink-0 flex flex-col"
      style={containerHeight ? { height: containerHeight, padding: '8px 10px' } : { padding: '10px' }}
    >
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
          projectPath={projectPath}
        />
      )}
      <div className={cn('flex gap-2 items-end', containerHeight ? 'flex-1 min-h-0' : '')}>
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
            containerHeight ? 'h-full overflow-y-auto' : '',
          )}
        />
        {isRunning ? (
          <button
            onClick={onStop}
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors bg-red-600 text-white hover:bg-red-700 self-end"
            title="Stop"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors self-end',
              value.trim() && !disabled
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-muted text-muted-foreground cursor-not-allowed',
            )}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex justify-between mt-1.5 shrink-0">
        <span className="text-[9px] text-muted-foreground/50">Shift+Enter for newline</span>
      </div>
    </div>
  )
}
