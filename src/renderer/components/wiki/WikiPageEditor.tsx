/**
 * Wiki 页面编辑器
 * 解析规则统一在后端（wiki:parseContent），前端只负责渲染：
 * - Markdown 页签：原始编辑，失焦保存（同时落 markdown 与 wikiMeta.frontmatter）
 * - 预览页签：wikilink 内联渲染，已解析可跳转，悬空可一键创建
 * - Backlinks 页签：反向链接列表
 * - Meta 页签：后端解析的 frontmatter 只读展示
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, PenLine, Eye, Settings2, Link2, FileText, Plus, CornerDownLeft } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from '@/components/ui/dialog'
import { useGraphStore } from '@/store/graphStore'
import { useI18n } from '../../i18n/useI18n'
import { wikiPageTitle } from '@shared/i18n'
import { splitWikiLinks, formatMetaValue, type WikiLinkResolution, type WikiRenderSegment } from '@/lib/wiki-render'
import { cn } from '@/lib/utils'

interface WikiPageEditorProps {
  nodeId: string
  graphId: string
  wikiContent: string | undefined
  wikiMeta: Record<string, unknown> | undefined
  onUpdate: (data: { wikiContent?: string; wikiMeta?: Record<string, unknown> }) => void
  onNavigate?: (nodeId: string) => void
}

const PARSE_DEBOUNCE_MS = 500

export function WikiPageEditor({
  nodeId,
  graphId,
  wikiContent,
  wikiMeta,
  onUpdate,
  onNavigate,
}: WikiPageEditorProps) {
  const [activeTab, setActiveTab] = useState('content')
  const [draft, setDraft] = useState(wikiContent ?? '')
  const [links, setLinks] = useState<WikiLinkResolution[]>([])
  const [backlinks, setBacklinks] = useState<{ id: string; title: string }[]>([])
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const { locale, t } = useI18n()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 用户有未保存编辑时为 true：外部内容更新不得覆盖草稿
  const dirtyRef = useRef(false)
  const createNode = useGraphStore((s) => s.createNode)

  // 外部内容变化（如 Agent 更新）时同步草稿；用户有未保存编辑时不覆盖
  useEffect(() => {
    if (!dirtyRef.current) setDraft(wikiContent ?? '')
  }, [wikiContent])

  // 切换编辑的节点时强制复位 dirty 并加载新节点内容
  //（nodeId 变化时 wikiContent 通常也随之变化，但不能依赖该巧合，须显式复位）
  useEffect(() => {
    dirtyRef.current = false
    setDraft(wikiContent ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在切换节点时复位草稿
  }, [nodeId])

  // 防抖解析（仅更新链接解析状态，不落库）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      window.electronAPI['wiki:parseContent'](graphId, draft)
        .then((r) => setLinks(r.links))
        .catch(() => setLinks([]))
    }, PARSE_DEBOUNCE_MS)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [draft, graphId])

  // Backlinks 页签激活时拉取
  useEffect(() => {
    if (activeTab !== 'backlinks') return
    window.electronAPI['wiki:getBacklinks'](nodeId)
      .then(setBacklinks)
      .catch(() => setBacklinks([]))
  }, [activeTab, nodeId])

  const handleBlur = useCallback(() => {
    if (draft === (wikiContent ?? '')) { dirtyRef.current = false; return }
    const sentDraft = draft
    window.electronAPI['wiki:parseContent'](graphId, sentDraft)
      .then((parsed) => {
        dirtyRef.current = false
        onUpdate({
          wikiContent: sentDraft,
          wikiMeta: { ...(wikiMeta ?? {}), frontmatter: parsed.frontmatter },
        })
      })
      .catch(() => {
        // frontmatter YAML 错误时仍保存内容，wikiMeta 保持不变
        dirtyRef.current = false
        onUpdate({ wikiContent: sentDraft })
      })
  }, [draft, wikiContent, wikiMeta, graphId, onUpdate])

  const handleCreatePage = useCallback(async () => {
    if (!createTarget) return
    const state = useGraphStore.getState()
    const graphType = state.graphs.find((g) => g.id === graphId)?.type
      ?? state.nodes.find((n) => n.id === nodeId)?.graphType
    if (!graphType) {
      // 无法确定图类型时不创建（避免静默错建到 online 图）
      console.warn(`[WikiPageEditor] 无法确定 graphId=${graphId} 的图类型，取消创建页面「${createTarget}」`)
      return
    }
    const node = await createNode({
      type: 'wiki-page',
      status: 'draft',
      title: createTarget,
      graphId,
      graphType,
      position: { x: 0, y: 0 },
      acceptanceCriteria: [],
      wikiContent: `# ${createTarget}\n\n`,
    })
    setCreateTarget(null)
    onNavigate?.(node.id)
  }, [createTarget, createNode, graphId, nodeId, onNavigate])

  const frontmatter = (wikiMeta?.frontmatter ?? {}) as Record<string, unknown>
  const segments = splitWikiLinks(draft, links)
  const hasLinks = segments.some((s) => s.kind === 'link')

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
        <BookOpen className="w-3.5 h-3.5" />
        <span>{t('wiki.editor.title')}</span>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4 h-8">
          <TabsTrigger value="content" className="text-xs gap-1">
            <PenLine className="w-3 h-3" />
            {t('wiki.editor.tab.markdown')}
          </TabsTrigger>
          <TabsTrigger value="preview" className="text-xs gap-1">
            <Eye className="w-3 h-3" />
            {t('wiki.editor.tab.preview')}
          </TabsTrigger>
          <TabsTrigger value="backlinks" className="text-xs gap-1">
            <CornerDownLeft className="w-3 h-3" />
            {t('wiki.editor.tab.backlinks')}
          </TabsTrigger>
          <TabsTrigger value="meta" className="text-xs gap-1">
            <Settings2 className="w-3 h-3" />
            {t('wiki.editor.tab.meta')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => { dirtyRef.current = true; setDraft(e.target.value) }}
            onBlur={handleBlur}
            placeholder={t('wiki.editor.placeholder')}
            className="w-full px-2 py-1.5 text-sm border rounded-md bg-background font-mono resize-y min-h-[180px]"
            spellCheck={false}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            {t('wiki.editor.hint')}
          </p>
        </TabsContent>

        <TabsContent value="preview" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[180px] max-h-[360px] overflow-y-auto">
            {!draft ? (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <FileText className="w-3 h-3" />
                {t('wiki.editor.emptyPreview')}
              </div>
            ) : (
              <>
                {/* 结构化预览：GFM 渲染，[[link]] 以代码样式占位展示 */}
                <div className="prose prose-sm dark:prose-invert max-w-none [&_code]:text-xs">
                  <ReactMarkdownSkipLinks content={draft} />
                </div>
                {/* 链接区：wikilink 内联交互（跳转 / 创建） */}
                {hasLinks && (
                  <div className="mt-3 pt-2 border-t space-y-1" data-testid="wiki-links">
                    <p className="text-[10px] text-muted-foreground">{t('wiki.editor.pageLinks')}</p>
                    <WikiLinkList segments={segments} onNavigate={onNavigate} onCreate={setCreateTarget} />
                  </div>
                )}
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="backlinks" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[120px]">
            {backlinks.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('wiki.editor.emptyBacklinks')}</p>
            ) : (
              <ul className="space-y-1">
                {backlinks.map((b) => (
                  <li key={b.id}>
                    <button
                      onClick={() => onNavigate?.(b.id)}
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <Link2 className="w-3 h-3" />
                      {wikiPageTitle(b.title, locale)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="meta" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[120px]">
            {Object.keys(frontmatter).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('wiki.editor.emptyMeta')}
              </p>
            ) : (
              <dl className="space-y-1">
                {Object.entries(frontmatter).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-xs">
                    <dt className="font-medium text-muted-foreground shrink-0 w-24 truncate">{key}</dt>
                    <dd className="flex-1 break-all">{formatMetaValue(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* 悬空链接 → 创建页面确认 */}
      <Dialog open={createTarget !== null} onOpenChange={(open) => { if (!open) setCreateTarget(null) }}>
        <DialogContent className="max-w-sm" closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle className="text-sm">{t('wiki.editor.createTitle', { title: createTarget ?? '' })}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t('wiki.editor.createHint')}
          </p>
          <DialogFooter>
            <DialogClose className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted">{t('common.cancel')}</DialogClose>
            <button
              onClick={handleCreatePage}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              <Plus className="w-3 h-3" />
              {t('wiki.editor.create')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * GFM 渲染：[[link]] 以行内代码样式占位（wikilink 的交互在下方链接区）。
 * 预处理把 [[...]] 包为 `[[...]]`，避免被 markdown 语法解析切碎。
 */
function ReactMarkdownSkipLinks({ content }: { content: string }) {
  const prepared = content.replace(/\[\[([^\]]+)\]\]/g, '`[[$1]]`')
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{prepared}</ReactMarkdown>
}

function WikiLinkList({
  segments,
  onNavigate,
  onCreate,
}: {
  segments: WikiRenderSegment[]
  onNavigate?: (nodeId: string) => void
  onCreate: (targetTitle: string) => void
}) {
  const seen = new Set<string>()
  const { locale, t } = useI18n()
  return (
    <ul className="flex flex-wrap gap-1.5">
      {segments.filter((s) => s.kind === 'link').map((seg) => {
        if (seg.kind !== 'link') return null
        const key = seg.targetTitle.toLowerCase()
        if (seen.has(key)) return null
        seen.add(key)
        const targetLabel = wikiPageTitle(seg.targetTitle, locale)
        if (seg.resolved && seg.nodeId) {
          return (
            <li key={key}>
              <button
                onClick={() => onNavigate?.(seg.nodeId!)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20"
                title={t('wiki.editor.jumpTo', { title: targetLabel })}
              >
                <Link2 className="w-3 h-3" />
                {seg.displayText ?? targetLabel}
              </button>
            </li>
          )
        }
        return (
          <li key={key}>
            <button
              onClick={() => onCreate(seg.targetTitle)}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-dashed border-muted-foreground/50 text-muted-foreground hover:text-foreground"
              title={t('wiki.editor.createMissing', { title: targetLabel })}
            >
              <Plus className="w-3 h-3" />
              {seg.displayText ?? targetLabel}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function WikiPageBadge({ nodeId, className }: { nodeId: string; className?: string }) {
  const { locale } = useI18n()
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
      {wikiPageTitle(node.title, locale)}
    </button>
  )
}
