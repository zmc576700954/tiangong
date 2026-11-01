import { useMemo, useState } from 'react'
// `Map` 图标改名 —— 直接 import `Map` 会遮蔽全局的 Map 构造器，
// 本文件里 `new Map(...)` 会变成 "Map is not a constructor"
import { Plus, X, GitBranch, Map as MapIcon } from 'lucide-react'
import { useGraphStore } from '../store/graphStore'
import { useFileTreeStore } from '../store/fileTreeStore'
import { cn, normalizeProjectPath, projectNameFromPath } from '../lib/utils'
import { localizeGraphName } from '@shared/i18n'
import type { TranslationKey } from '@shared/i18n'
import { useI18n } from '../i18n/useI18n'
import { FloatingPanel } from './ui/FloatingPanel'
import { toastError } from '../lib/toast'
import type { Graph } from '@shared/types'

/**
 * 新建图固定为「工作图（dev）」。
 *
 * 每个项目本来就有固定的两张图（online 蓝图 + dev 场景，项目导入时在一个事务里建好），
 * 让用户「选类型」等于允许造出一张重复的废图 —— 类型选择器整体移除（spec §四.B2）。
 */
const NEW_GRAPH_TYPE = 'dev' as const

interface GraphTabsProps {
  graphs: Graph[]
  currentGraphId: string | null
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

/** 默认名：新工作图 N（N = 已有 dev 图数 + 1；撞名则继续递增） */
function defaultGraphName(graphs: Graph[], t: Translate): string {
  const taken = new Set(graphs.map((g) => g.name))
  let n = graphs.filter((g) => g.type === 'dev').length + 1
  let name = t('graph.tab.defaultName', { n })
  while (taken.has(name)) {
    n += 1
    name = t('graph.tab.defaultName', { n })
  }
  return name
}

export function GraphTabs({ graphs, currentGraphId }: GraphTabsProps) {
  const { locale, t } = useI18n()
  const { setCurrentGraph, createGraph, deleteGraph } = useGraphStore()
  const projects = useFileTreeStore((s) => s.projects)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newGraphName, setNewGraphName] = useState('')
  const [deriveFromGraphId, setDeriveFromGraphId] = useState<string | null>(null)
  const [selectedProjectPath, setSelectedProjectPath] = useState('')

  const onlineGraphs = graphs.filter(g => g.type === 'online')
  const currentGraph = graphs.find(g => g.id === currentGraphId)
  /** 「当前项目」= 当前打开的图所属项目 */
  const currentProjectPath = currentGraph?.projectPath
  const deriveSource = deriveFromGraphId ? graphs.find(g => g.id === deriveFromGraphId) : undefined
  const isDeriving = !!deriveSource
  /**
   * 派生图**继承源图的 projectPath**（主进程 deriveGraph 就是这么写的）——
   * 所以选了派生源之后，项目由源图决定，不能再让用户选别的（否则「选了也没用」）。
   *
   * ⚠️ 这里存的是**原始路径**（侧边栏给什么就存什么），不是归一化后的：
   * 归一化不可能和主进程的 `path.resolve` 完全等价（POSIX 目录名里的反斜杠、
   * Windows UNC / 盘符根），拿归一化值去落库会让图**绑到错的目录**。
   * 归一化只用来做「同一个目录」的比较（见 projectOptions）。
   */
  const effectiveProjectPath = isDeriving ? deriveSource?.projectPath : selectedProjectPath

  const projectOptions = useMemo(() => {
    // 按归一化后的路径去重：同一个目录只出现一次（主进程存的路径是 resolve 过的，
    // 侧边栏是原始路径，文本可能不同）。
    // id = 归一化路径（只做比较用），path = **原始路径**（真正发出去的那条）。
    const byId = new Map<string, { id: string; path: string; name: string }>()
    for (const p of projects) {
      const id = normalizeProjectPath(p.path)
      if (!id || byId.has(id)) continue
      byId.set(id, { id, path: p.path, name: p.name })
    }
    // 当前图所属项目可能已从侧边栏移除，但绑定仍然有效 —— 保留为可选项
    if (effectiveProjectPath) {
      const id = normalizeProjectPath(effectiveProjectPath)
      if (id && !byId.has(id)) {
        byId.set(id, { id, path: effectiveProjectPath, name: projectNameFromPath(effectiveProjectPath) })
      }
    }
    return [...byId.values()]
  }, [projects, effectiveProjectPath])

  /** 当前生效的项目在选择器里的 id（= 归一化路径），用来让 select 选中正确项 */
  const effectiveProjectId = effectiveProjectPath ? normalizeProjectPath(effectiveProjectPath) : ''

  const openNewDialog = () => {
    setNewGraphName(defaultGraphName(graphs, t))
    setDeriveFromGraphId(null)
    // 单项目时自动带入当前项目；当前图没有项目时退到第一个项目（都存原始路径）
    setSelectedProjectPath(currentProjectPath ?? projects[0]?.path ?? '')
    setShowNewDialog(true)
  }

  const handleCreate = async () => {
    const name = newGraphName.trim()
    if (!name) {
      // 空名不再静默失败：给出提示，且对话框保持打开（改完名字就能重试）
      toastError(t('graph.tab.nameRequired'))
      return
    }
    try {
      // 源图可能在这个对话框开着的时候被删掉 —— 那种情况下别去派生（否则主进程报
      // "Source graph not found"），按当前选择建一张空白图。
      await createGraph(
        name,
        NEW_GRAPH_TYPE,
        deriveSource?.id,
        effectiveProjectPath || undefined,
      )
    } catch (err) {
      // 创建失败（IPC 校验拒绝、源图不存在、DB 报错……）必须说出来，
      // 否则又变成「点了没反应」的那类静默失败
      toastError(t('graph.tab.createFailed'), err instanceof Error ? err.message : String(err))
      return
    }
    setNewGraphName('')
    setDeriveFromGraphId(null)
    setShowNewDialog(false)
  }

  return (
    <div className="h-10 border-b flex items-center bg-muted/30 px-2 gap-1 shrink-0">
      {graphs.map((graph) => (
        <div
          key={graph.id}
          onClick={() => setCurrentGraph(graph.id)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors group',
            currentGraphId === graph.id
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground hover:bg-background/50',
          )}
        >
          {graph.type === 'online' ? (
            <MapIcon className="w-3.5 h-3.5" />
          ) : (
            <GitBranch className="w-3.5 h-3.5" />
          )}
          <span className="max-w-[120px] truncate">{localizeGraphName(graph.name, locale)}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              deleteGraph(graph.id)
            }}
            className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      {/* 新建图按钮 */}
      <button
        data-testid="new-graph-btn"
        onClick={openNewDialog}
        className="flex items-center gap-1 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {/* 新建图对话框 */}
      <FloatingPanel
        isOpen={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        title={t('graph.tab.new')}
        variant="centered"
        width="md"
        showCloseButton={false}
        className="top-12 -translate-y-0"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNewDialog(false)}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('graph.tab.cancel')}
            </button>
            <button
              data-testid="create-graph-btn"
              onClick={handleCreate}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              {t('graph.tab.create')}
            </button>
          </div>
        }
      >
        <div className="p-4">
          <input
            data-testid="graph-name-input"
            type="text"
            placeholder={t('graph.tab.namePlaceholder')}
            value={newGraphName}
            onChange={(e) => setNewGraphName(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm mb-3 bg-background"
            autoFocus
            // 默认名已预填 —— 聚焦时全选，直接打字就是改名而不是追加
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          {onlineGraphs.length > 0 && (
            <div className="mb-3">
              <label className="text-xs text-muted-foreground mb-1 block">{t('graph.tab.deriveFrom')}</label>
              <select
                data-testid="graph-derive-select"
                value={deriveFromGraphId ?? ''}
                onChange={(e) => setDeriveFromGraphId(e.target.value || null)}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background"
              >
                <option value="">{t('graph.tab.blank')}</option>
                {onlineGraphs.map(g => (
                  <option key={g.id} value={g.id}>{localizeGraphName(g.name, locale)}</option>
                ))}
              </select>
            </div>
          )}
          <div className="mb-3">
            <label className="text-xs text-muted-foreground mb-1 block">{t('graph.tab.project')}</label>
            {projectOptions.length > 1 || isDeriving ? (
              <select
                data-testid="graph-project-select"
                value={effectiveProjectId}
                disabled={isDeriving}
                onChange={(e) => {
                  // 存的是**原始路径**（不是归一化值）—— 真正落库的路径由主进程的
                  // path.resolve 还原，这里不替它做决定
                  const picked = projectOptions.find(o => o.id === e.target.value)
                  setSelectedProjectPath(picked?.path ?? '')
                }}
                className="w-full px-3 py-2 border rounded-md text-sm bg-background disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {!effectiveProjectId && <option value="">{t('graph.tab.noProject')}</option>}
                {projectOptions.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            ) : (
              <div className="w-full px-3 py-2 border rounded-md text-sm bg-muted/30 text-muted-foreground">
                {projectOptions[0]?.name ?? t('graph.tab.noProject')}
              </div>
            )}
            {isDeriving && (
              <p className="text-xs text-muted-foreground mt-1">
                {deriveSource?.projectPath
                  ? t('graph.tab.deriveProjectLocked')
                  : t('graph.tab.deriveNoProject')}
              </p>
            )}
          </div>
        </div>
      </FloatingPanel>
    </div>
  )
}
