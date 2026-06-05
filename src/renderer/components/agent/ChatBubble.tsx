import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useState } from 'react'
import { User, Bot, Loader2, AlertTriangle, Copy, RefreshCw, Check, Ban } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ToolCallRenderer } from './ToolCallRenderer'
import type { ChatMessage } from '@shared/types'

interface ChatBubbleProps {
  message: ChatMessage
  onRetry?: (messageId: string) => void
}

export function ChatBubble({ message, onRetry }: ChatBubbleProps) {
  const isUser = message.role === 'user'
  const isError = message.status === 'error'
  const isAborted = message.status === 'aborted'
  const [copied, setCopied] = useState(false)
  const [showRawError, setShowRawError] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
    } catch {
      // Fallback for Electron where clipboard API may require focus
      const textarea = document.createElement('textarea')
      textarea.value = message.content
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleRetry = () => {
    onRetry?.(message.id)
  }

  return (
    <div className="group flex gap-2 items-start">
      <div
        className={cn(
          'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-semibold',
          isUser
            ? 'bg-blue-500/20 text-blue-400'
            : isError
              ? 'bg-red-500/20 text-red-400'
              : 'bg-purple-500/20 text-purple-400',
        )}
      >
        {isUser ? <User className="w-3 h-3" /> : isError ? <AlertTriangle className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
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
            'rounded-lg px-3 py-2 text-sm leading-relaxed select-text',
            isUser
              ? 'bg-blue-500/10 border border-blue-500/20'
              : isError
                ? 'bg-red-500/10 border border-red-500/40'
                : 'bg-muted/50 border border-border',
          )}
        >
          {/* Error state */}
          {isError && message.error && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 text-red-400 text-xs font-medium mb-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{message.error.message}</span>
              </div>
              {message.error.raw && (
                <div>
                  <button
                    onClick={() => setShowRawError(!showRawError)}
                    className="text-[10px] text-muted-foreground hover:text-foreground underline"
                  >
                    {showRawError ? '隐藏原始错误' : '查看原始错误'}
                  </button>
                  {showRawError && (
                    <pre className="mt-1 p-2 text-[10px] bg-red-950/30 rounded overflow-x-auto text-red-300 select-text">
                      {message.error.raw}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Message content */}
          {message.content ? (
            isUser ? (
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none break-words
                prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1
                prose-ul:my-1 prose-ol:my-1 prose-li:my-0
                prose-pre:my-2 prose-pre:p-0 prose-code:before:content-none prose-code:after:content-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || '')
                      const codeStr = String(children).replace(/\n$/, '')
                      const isBlock = codeStr.includes('\n') || !!match
                      if (isBlock) {
                        return (
                          <div className="relative group">
                            <SyntaxHighlighter
                              style={oneDark}
                              language={match?.[1] ?? 'text'}
                              PreTag="div"
                              customStyle={{ margin: 0, borderRadius: '0.375rem', fontSize: '11px' }}
                            >
                              {codeStr}
                            </SyntaxHighlighter>
                            <button
                              onClick={() => navigator.clipboard?.writeText(codeStr)}
                              className="absolute top-1 right-1 px-1.5 py-0.5 text-[9px] bg-muted/80 rounded
                                opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground"
                            >
                              Copy
                            </button>
                          </div>
                        )
                      }
                      return (
                        <code className="bg-muted/50 px-1 py-0.5 rounded text-[11px]" {...props}>
                          {children}
                        </code>
                      )
                    },
                  }}
                />
              </div>
            )
          ) : null}

          {/* Tool calls */}
          {message.toolCalls?.map((block, i) => (
            <ToolCallRenderer
              key={i}
              block={block}
              onAccept={() => {
                // Stub: Phase 3 will wire this to DiffReviewPanel
                console.log('[ToolCall] Accept:', block.filePath)
              }}
              onReject={() => {
                // Stub: Phase 3 will wire this to ScopeGuard rollback
                console.log('[ToolCall] Reject:', block.filePath)
              }}
            />
          ))}
        </div>

        {/* Aborted label */}
        {isAborted && (
          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground/70">
            <Ban className="w-3 h-3" />
            <span>已终止</span>
          </div>
        )}

        {/* Action bar — visible for agent messages with content */}
        {!isUser && (message.content || isError) && (
          <div className="flex items-center gap-1 mt-1">
            <button
              onClick={handleCopy}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Copy"
            >
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {(isError || isAborted) && onRetry && (
              <button
                onClick={handleRetry}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Retry"
              >
                <RefreshCw className="w-3 h-3" />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function RunningIndicator({
  adapterName,
  currentOperation,
}: {
  adapterName?: string
  currentOperation?: string
}) {
  return (
    <div className="flex gap-2 items-center py-1">
      <div className="w-5 h-5 rounded-full bg-purple-500/20 flex items-center justify-center">
        <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
      </div>
      <span className="text-xs text-amber-400">
        {currentOperation
          ? `${adapterName ?? 'Agent'} ${currentOperation}`
          : `${adapterName ?? 'Agent'} is working...`}
      </span>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
