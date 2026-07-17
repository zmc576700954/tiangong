/**
 * Wiki 页面编辑器
 * 支持 Markdown 内容编辑、YAML frontmatter 元数据编辑、wikilink 解析与跳转。
 */
import { useState, useCallback, useMemo } from 'react'
import { BookOpen, PenLine, Eye, Settings2, Link2, FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useGraphStore } from '@/store/graphStore'
import { cn } from '@/lib/utils'

interface WikiPageEditorProps {
  wikiContent: string | undefined
  wikiMeta: Record<string, unknown> | undefined
  onUpdate: (data: { wikiContent?: string; wikiMeta?: Record<string, unknown> }) => void
  onNavigate?: (nodeId: string) => void
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

function parseFrontmatter(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return ''
  const lines = Object.entries(meta).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}:\n${value.map((v) => `  - ${String(v)}`).join('\n')}`
    }
    if (typeof value === 'object' && value !== null) {
      return `${key}: ${JSON.stringify(value)}`
    }
    return `${key}: ${String(value)}`
  })
  return `---\n${lines.join('\n')}\n---`
}

function parseYamlInput(input: string): Record<string, unknown> | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const result: Record<string, unknown> = {}
  const lines = trimmed.replace(/^---\n?/, '').replace(/\n?---$/, '').split('\n')
  let currentKey: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('- ')) {
      const item = line.slice(2)
      if (currentKey) {
        const arr = result[currentKey]
        if (Array.isArray(arr)) {
          arr.push(item)
        } else {
          result[currentKey] = [item]
        }
      }
      continue
    }
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let value: unknown = line.slice(colonIdx + 1).trim()
    if (value === '') {
      currentKey = key
      result[key] = []
      continue
    }
    currentKey = null
    if ((value as string).startsWith('[') && (value as string).endsWith(']')) {
      try {
        value = JSON.parse(value as string)
      } catch {
        // keep as string
      }
    } else if ((value as string).toLowerCase() === 'true') {
      value = true
    } else if ((value as string).toLowerCase() === 'false') {
      value = false
    } else if (!Number.isNaN(Number(value)) && (value as string) !== '') {
      value = Number(value)
    }
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function WikilinkRenderer({ content, nodes, onNavigate }: {
  content: string
  nodes: { id: string; title: string; type: string }[]
  onNavigate?: (nodeId: string) => void
}) {
  const parts = useMemo(() => {
    const result: { type: 'text' | 'link'; value: string; nodeId?: string }[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null
    WIKILINK_RE.lastIndex = 0
    while ((match = WIKILINK_RE.exec(content)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: content.slice(lastIndex, match.index) })
      }
      const title = match[1].trim()
      const target = nodes.find((n) => n.title === title)
      result.push({ type: 'link', value: title, nodeId: target?.id })
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < content.length) {
      result.push({ type: 'text', value: content.slice(lastIndex) })
    }
    return result
  }, [content, nodes])

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return <span key={i}>{part.value}</span>
        }
        if (part.nodeId) {
          return (
            <button
              key={i}
              onClick={() => onNavigate?.(part.nodeId!)}
              className="inline-flex items-center gap-0.5 text-primary hover:underline"
              title="跳转到页面"
            >
              <Link2 className="w-3 h-3" />
              {part.value}
            </button>
          )
        }
        return (
          <span key={i} className="inline-flex items-center gap-0.5 text-muted-foreground" title="未找到目标页面">
            <Link2 className="w-3 h-3" />
            {part.value}
          </span>
        )
      })}
    </>
  )
}

export function WikiPageEditor({
  wikiContent,
  wikiMeta,
  onUpdate,
  onNavigate,
}: WikiPageEditorProps) {
  const [activeTab, setActiveTab] = useState('content')
  const [metaInput, setMetaInput] = useState(() => parseFrontmatter(wikiMeta))
  const nodes = useGraphStore((s) => s.nodes)

  const handleContentChange = useCallback((value: string) => {
    onUpdate({ wikiContent: value })
  }, [onUpdate])

  const handleMetaBlur = useCallback(() => {
    const parsed = parseYamlInput(metaInput)
    onUpdate({ wikiMeta: parsed })
  }, [metaInput, onUpdate])

  const plainText = useMemo(() => {
    return (wikiContent ?? '').replace(WIKILINK_RE, (_, title: string) => title)
  }, [wikiContent])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
        <BookOpen className="w-3.5 h-3.5" />
        <span>Wiki 页面</span>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3 h-8">
          <TabsTrigger value="content" className="text-xs gap-1">
            <PenLine className="w-3 h-3" />
            Markdown
          </TabsTrigger>
          <TabsTrigger value="preview" className="text-xs gap-1">
            <Eye className="w-3 h-3" />
            预览
          </TabsTrigger>
          <TabsTrigger value="meta" className="text-xs gap-1">
            <Settings2 className="w-3 h-3" />
            Frontmatter
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="mt-2">
          <textarea
            value={wikiContent ?? ''}
            onChange={(e) => handleContentChange(e.target.value)}
            placeholder="输入 Markdown 内容... 使用 [[页面标题]] 创建 wikilink"
            className="w-full px-2 py-1.5 text-sm border rounded-md bg-background font-mono resize-y min-h-[180px]"
            spellCheck={false}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            支持 [[页面标题]] 语法链接到同图其他 Wiki 页面
          </p>
        </TabsContent>

        <TabsContent value="preview" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[180px] max-h-[360px] overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
            {wikiContent ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {plainText}
              </ReactMarkdown>
            ) : (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <FileText className="w-3 h-3" />
                暂无内容，请在 Markdown 页签中编辑
              </div>
            )}
          </div>
          {wikiContent && (
            <div className="mt-2 text-[10px] text-muted-foreground">
              <WikilinkRenderer
                content={wikiContent}
                nodes={nodes.map((n) => ({ id: n.id, title: n.title, type: n.type }))}
                onNavigate={onNavigate}
              />
            </div>
          )}
        </TabsContent>

        <TabsContent value="meta" className="mt-2">
          <textarea
            value={metaInput}
            onChange={(e) => setMetaInput(e.target.value)}
            onBlur={handleMetaBlur}
            placeholder="---\nauthor: ai\ntags:\n  - docs\n---"
            className="w-full px-2 py-1.5 text-sm border rounded-md bg-background font-mono resize-y min-h-[120px]"
            spellCheck={false}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            YAML frontmatter，失焦后自动保存。支持简单键值与列表。
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function WikiPageBadge({ nodeId, className }: { nodeId: string; className?: string }) {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  if (!node) return null
  return (
    <button
      onClick={() => useGraphStore.getState().selectNode(nodeId)}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors',
        className,
      )}
    >
      <BookOpen className="w-3 h-3" />
      {node.title}
    </button>
  )
}
