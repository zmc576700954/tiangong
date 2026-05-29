import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { ChatBubble, RunningIndicator } from './ChatBubble'
import type { ChatMessage } from '@shared/types'

interface ChatMessageListProps {
  messages: ChatMessage[]
  isRunning: boolean
  adapterName?: string
}

export function ChatMessageList({ messages, isRunning, adapterName }: ChatMessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isRunning])

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
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
      {messages.map((msg) => (
        <ChatBubble key={msg.id} message={msg} />
      ))}
      {isRunning && <RunningIndicator adapterName={adapterName} />}
      <div ref={bottomRef} />
    </div>
  )
}
