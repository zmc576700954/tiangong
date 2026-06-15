import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { ChatBubble, RunningIndicator } from './ChatBubble'
import type { ChatMessage } from '@shared/types'

interface ChatMessageListProps {
  messages: ChatMessage[]
  isRunning: boolean
  adapterName?: string
  onRetry?: (messageId: string) => void
  currentOperation?: string
}

export function ChatMessageList({ messages, isRunning, adapterName, onRetry, currentOperation }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Compute a content signature so we also scroll on streaming content growth
  const lastContent = messages.length > 0 ? messages[messages.length - 1].content : ''
  const contentSig = `${messages.length}:${lastContent.length}:${isRunning ? 1 : 0}`

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [contentSig])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6 py-12">
        <div>
          <MessageSquare className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Start a conversation</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Type a message, use / for commands, or @ to add context
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 select-text" role="log" aria-live="polite">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} onRetry={onRetry} />
      ))}
      {isRunning && <RunningIndicator adapterName={adapterName} currentOperation={currentOperation} />}
      <div ref={bottomRef} />
    </div>
  )
}
