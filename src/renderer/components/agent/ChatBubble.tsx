import { User, Bot, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ToolCallRenderer } from './ToolCallRenderer'
import type { ChatMessage } from '@shared/types'

export function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className="flex gap-2 items-start">
      <div
        className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-semibold',
          isUser
            ? 'bg-blue-500/20 text-blue-400'
            : 'bg-purple-500/20 text-purple-400',
        )}
      >
        {isUser ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-muted-foreground mb-1">
          {isUser ? 'You' : message.adapterName ?? 'Agent'}
          <span className="text-muted-foreground/50 ml-1">
            {formatTime(message.timestamp)}
          </span>
        </div>
        <div
          className={cn(
            'rounded-lg px-3 py-2 text-sm leading-relaxed',
            isUser
              ? 'bg-blue-500/10 border border-blue-500/20'
              : 'bg-muted/50 border border-border',
          )}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          {message.toolCalls?.map((block, i) => (
            <ToolCallRenderer key={i} block={block} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function RunningIndicator({ adapterName }: { adapterName?: string }) {
  return (
    <div className="flex gap-2 items-center py-1">
      <div className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center">
        <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
      </div>
      <span className="text-xs text-amber-400">{adapterName ?? 'Agent'} is working...</span>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
