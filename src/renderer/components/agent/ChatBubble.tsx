import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import ts from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import js from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import React, { useState, useCallback } from 'react'
import { formatTime } from '../../lib/utils'

// Register only the languages we need
SyntaxHighlighter.registerLanguage('typescript', ts)
SyntaxHighlighter.registerLanguage('javascript', js)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('yaml', yaml)
import { User, Bot, Loader2, AlertTriangle, Copy, RefreshCw, Check, Ban, Clock, Send, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ToolCallRenderer } from './ToolCallRenderer'
import type { ChatMessage, ContextRef, ToolCallBlock } from '@shared/types'

/** Auto-fold long plain-text output (>20 lines) with expand/collapse */
function CollapsibleOutput({ content, maxLines = 20 }: { content: string; maxLines?: number }) {
  const lines = content.split('\n')
  const shouldFold = lines.length > maxLines
  const [expanded, setExpanded] = useState(false)

  if (!shouldFold) {
    return <pre className="text-xs whitespace-pre-wrap font-mono break-all">{content}</pre>
  }

  const displayed = expanded ? lines : lines.slice(0, 3)

  return (
    <div className="relative">
      <pre className="text-xs whitespace-pre-wrap font-mono break-all">{displayed.join('\n')}</pre>
      {!expanded && <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-background to-transparent" />}
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-muted-foreground hover:text-foreground mt-1"
      >
        {expanded ? 'Show less' : `Show all ${lines.length} lines`}
      </button>
    </div>
  )
}

/** Wrapper for <pre> elements from ReactMarkdown — uses CollapsibleOutput for plain text */
function PreBlock({ children }: React.HTMLAttributes<HTMLPreElement>) {
  // Extract text content and detect if this is a code block with a language tag
  const child = React.Children.toArray(children)[0]
  let isCodeBlock = false
  let textContent = ''

  if (React.isValidElement(child) && child.props) {
    const childProps = child.props as { className?: string; children?: React.ReactNode }
    isCodeBlock = !!/language-(\w+)/.exec(childProps.className || '')
    textContent = String(childProps.children ?? '').replace(/\n$/, '')
  }

  // Code blocks with language tags are handled by CodeBlock (SyntaxHighlighter)
  if (isCodeBlock) {
    return <>{children}</>
  }

  // Plain text output — use CollapsibleOutput for long content
  return <CollapsibleOutput content={textContent} />
}

/** Module-level component to avoid re-creation on every render (prevents code block remounting) */
function CodeBlock({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { className?: string }) {
  const match = /language-(\w+)/.exec(className || '')
  const codeStr = String(children).replace(/\n$/, '')
  const isBlock = codeStr.includes('\n') || !!match
  const language = match?.[1] ?? 'text'
  const [copied, setCopied] = useState(false)
  const lines = codeStr.split('\n')
  const showLineNumbers = lines.length > 5

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(codeStr)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
      .catch((err) => { console.warn('[ChatBubble] Failed to copy code to clipboard:', err) })
  }, [codeStr])

  if (isBlock) {
    return (
      <div className="relative group my-2 rounded-md overflow-hidden border border-border">
        <div className="flex items-center justify-between px-3 py-1 bg-muted/50 border-b border-border">
          <span className="text-[9px] text-muted-foreground font-mono">{language}</span>
          <button
            onClick={handleCopy}
            className="text-[9px] text-muted-foreground hover:text-foreground"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="flex">
          {showLineNumbers && (
            <div className="select-none text-right pr-2 pl-2 text-[9px] text-muted-foreground/50 leading-[18px] bg-muted/30 border-r border-border py-2">
              {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
            </div>
          )}
          <SyntaxHighlighter
            language={language}
            PreTag="div"
            style={oneDark}
            customStyle={{ margin: 0, padding: '8px 12px', fontSize: '11px', background: 'transparent', flex: 1 }}
          >
            {codeStr}
          </SyntaxHighlighter>
        </div>
      </div>
    )
  }
  return (
    <code className="bg-muted/50 px-1 py-0.5 rounded text-[11px]" {...props}>
      {children}
    </code>
  )
}

const STATUS_ICONS: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
  queued: { icon: <Clock size={10} />, label: 'Queued', className: 'text-gray-400' },
  sending: { icon: <Send size={10} />, label: 'Sending', className: 'text-blue-400' },
  streaming: { icon: <Loader2 size={10} className="animate-spin" />, label: 'Streaming', className: 'text-blue-500' },
  success: { icon: <Check size={10} />, label: 'Sent', className: 'text-green-500' },
  error: { icon: <AlertTriangle size={10} />, label: 'Failed', className: 'text-red-500' },
  permanently_failed: { icon: <XCircle size={10} />, label: 'Permanently failed', className: 'text-red-600' },
}

function ProgressBlock({ data }: { data: unknown }) {
  const { stage, label, current, total } = data as {
    stage?: string
    label?: string
    current?: number
    total?: number
  }
  const percent = total && total > 0 ? Math.round(((current ?? 0) / total) * 100) : 0
  return (
    <div className="my-2 space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span className="font-medium capitalize">{stage ?? 'running'}</span>
        {label && <span className="text-muted-foreground/70 truncate">{label}</span>}
      </div>
      {total !== undefined && total > 0 && (
        <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ data }: { data: unknown }) {
  const { data: text } = data as { data?: string }
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  return (
    <div className="my-2 border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-muted/50 hover:bg-muted transition-colors text-left text-xs text-muted-foreground"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>Thinking...</span>
      </button>
      {expanded && (
        <div className="p-2.5 text-[11px] text-muted-foreground bg-background font-mono whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

function StructuredToolCallBlock({ data }: { data: unknown }) {
  const block = data as ToolCallBlock
  return <ToolCallRenderer block={block} />
}

function ContextInjectionBlock({ data }: { data: unknown }) {
  const { contextRefs, tokenEstimate } = data as {
    contextRefs?: ContextRef[]
    tokenEstimate?: number
  }
  const [expanded, setExpanded] = useState(false)
  if (!contextRefs?.length) return null
  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 text-[10px] hover:bg-blue-500/20 transition-colors"
      >
        <span>已注入上下文</span>
        {tokenEstimate !== undefined && (
          <span className="text-blue-400/70">~{tokenEstimate} tokens</span>
        )}
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {contextRefs.map((ref, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="px-1 py-0.5 rounded bg-muted uppercase">{ref.type}</span>
              <span className="truncate">{ref.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TextBlock({ data }: { data: unknown }) {
  const { level, message, raw } = data as {
    level?: string
    message?: string
    raw?: string
  }
  const [showRaw, setShowRaw] = useState(false)
  if (!message) return null
  return (
    <div
      className={cn(
        'my-2 p-2 rounded text-[11px]',
        level === 'error'
          ? 'bg-red-500/10 text-red-400'
          : level === 'warning'
            ? 'bg-amber-500/10 text-amber-400'
            : 'bg-muted text-muted-foreground',
      )}
    >
      <p>{message}</p>
      {raw && (
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="text-[10px] underline mt-1 text-muted-foreground hover:text-foreground"
        >
          {showRaw ? 'Hide details' : 'Show details'}
        </button>
      )}
      {showRaw && raw && (
        <pre className="mt-1 text-[10px] whitespace-pre-wrap">{raw}</pre>
      )}
    </div>
  )
}

function MessageContextRefs({ refs, tokenEstimate }: { refs: ContextRef[]; tokenEstimate?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (!refs.length) return null
  return (
    <div className="mt-2 pt-2 border-t border-border/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>Context</span>
        <span className="text-muted-foreground/60">({refs.length})</span>
        {tokenEstimate !== undefined && <span className="text-muted-foreground/60">~{tokenEstimate} tokens</span>}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {refs.map((ref, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="px-1 py-0.5 rounded bg-muted uppercase">{ref.type}</span>
              <span className="truncate">{ref.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
    await navigator.clipboard.writeText(message.content)
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
          'w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-semibold',
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
          {message.status && STATUS_ICONS[message.status] && (
            <span className={`inline-flex items-center gap-0.5 text-[10px] ml-1 ${STATUS_ICONS[message.status].className}`} title={STATUS_ICONS[message.status].label}>
              {STATUS_ICONS[message.status].icon}
            </span>
          )}
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
                  components={{ code: CodeBlock, pre: PreBlock }}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
            )
          ) : null}

          {/* Structured content blocks */}
          {message.structuredContent?.map((block, i) => {
            switch (block.type) {
              case 'progress':
                return <ProgressBlock key={i} data={block.data} />
              case 'thinking':
                return <ThinkingBlock key={i} data={block.data} />
              case 'tool_call':
                return <StructuredToolCallBlock key={i} data={block.data} />
              case 'context_injection':
                return <ContextInjectionBlock key={i} data={block.data} />
              case 'text':
                return <TextBlock key={i} data={block.data} />
              default:
                return null
            }
          })}

          {/* Tool calls */}
          {message.toolCalls?.map((block, i) => (
            <ToolCallRenderer
              key={i}
              block={block}
            />
          ))}

          {/* Context refs */}
          {message.contextRefs && message.contextRefs.length > 0 && (
            <MessageContextRefs refs={message.contextRefs} tokenEstimate={message.tokenEstimate} />
          )}
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
