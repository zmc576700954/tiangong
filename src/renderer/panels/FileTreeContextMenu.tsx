import { useRef, useEffect, useState } from 'react'
import {
  Terminal,
  Sparkles,
  Box,
  GitBranch,
  Code2,
  Bug,
  Plus,
  Copy,
  Scissors,
  Clipboard,
  Trash2,
  Loader2,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useFileTreeStore } from '../store/fileTreeStore'
import { useGraphStore } from '../store/graphStore'
import { useAppStore } from '../store/appStore'
import { useAgentStore } from '../store/agentStore'
import { useI18n } from '../i18n/useI18n'
import { nodeTypeLabel } from '@shared/i18n'
import type { Locale } from '@shared/i18n'
import type { NodeType } from '@shared/types'
import type { TreeNode } from '../store/fileTreeStore'

/** 节点类型选项——标签走共享的 nodeTypeLabel 查表 */
function typeOptions(locale: Locale): { type: NodeType; label: string; color: string }[] {
  return [
    { type: 'module', label: nodeTypeLabel('module', locale), color: '#3b82f6' },
    { type: 'process', label: nodeTypeLabel('process', locale), color: '#8b5cf6' },
    { type: 'feature', label: nodeTypeLabel('feature', locale), color: '#22c55e' },
    { type: 'bug', label: nodeTypeLabel('bug', locale), color: '#ef4444' },
  ]
}

export function FileTreeContextMenu() {
  const contextMenuPath = useFileTreeStore((s) => s.contextMenuPath)
  const contextMenuPos = useFileTreeStore((s) => s.contextMenuPos)
  const setContextMenu = useFileTreeStore((s) => s.setContextMenu)
  const setClipboard = useFileTreeStore((s) => s.setClipboard)
  const clipboard = useFileTreeStore((s) => s.clipboard)
  const paste = useFileTreeStore((s) => s.paste)
  const deletePaths = useFileTreeStore((s) => s.deletePaths)
  const projects = useFileTreeStore((s) => s.projects)

  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)
  const setAgentWorkingDirectory = useAppStore((s) => s.setAgentWorkingDirectory)
  const setPendingContextRef = useAppStore((s) => s.setPendingContextRef)

  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [showTypePicker, setShowTypePicker] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { t, locale } = useI18n()

  // 点击外部关闭
  useEffect(() => {
    if (!contextMenuPath) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
        setShowTypePicker(false)
        setConfirmDelete(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [contextMenuPath, setContextMenu])

  // Esc 关闭
  useEffect(() => {
    if (!contextMenuPath) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setShowTypePicker(false)
        setConfirmDelete(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [contextMenuPath, setContextMenu])

  if (!contextMenuPath || !contextMenuPos) return null

  const nodeName = contextMenuPath.split(/[\\/]/).pop() || contextMenuPath
  const isDirectory = (() => {
    for (const proj of projects) {
      const node = findNodeByPath(proj.root, contextMenuPath)
      if (node) return node.isDirectory
    }
    return false
  })()

  const handleCopy = () => {
    setClipboard('copy', [contextMenuPath])
    setContextMenu(null)
  }

  const handleCut = () => {
    setClipboard('cut', [contextMenuPath])
    setContextMenu(null)
  }

  const handlePaste = async () => {
    const destDir = isDirectory ? contextMenuPath : contextMenuPath.replace(/[\\/][^\\/]+$/, '')
    await paste(destDir)
    setContextMenu(null)
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await deletePaths([contextMenuPath])
    setContextMenu(null)
    setConfirmDelete(false)
  }

  const handleAgentInput = () => {
    setAgentWorkingDirectory(contextMenuPath)
    setPendingContextRef({
      type: 'file',
      id: contextMenuPath,
      label: nodeName,
    })
    setActiveRightPanel('agent')
    setContextMenu(null)
  }

  const handleGenerateNode = async (nodeType: NodeType) => {
    const graphs = useGraphStore.getState().graphs
    const onlineGraph = graphs.find((g) => g.type === 'online')
    if (!onlineGraph) {
      useFileTreeStore.getState().clearToast()
      useFileTreeStore.setState({
        toast: { message: t('projects.context.needOnlineGraph'), type: 'error' },
      })
      setContextMenu(null)
      return
    }

    setLoadingAction(`generate-${nodeType}`)

    try {
      const scopeNote = `[Scope: ${contextMenuPath}]`
      const position = calculateNewNodePosition()

      await useGraphStore.getState().createNode({
        type: nodeType,
        status: 'draft',
        title: nodeName,
        description: scopeNote,
        graphId: onlineGraph.id,
        graphType: 'online',
        position,
      })

      useFileTreeStore.setState({
        toast: {
          message: t('projects.context.nodeCreated', {
            type: nodeTypeLabel(nodeType, locale),
            name: nodeName,
          }),
          type: 'success',
        },
      })
    } catch (err) {
      useFileTreeStore.setState({
        toast: { message: t('projects.context.createNodeFailed', { error: String(err) }), type: 'error' },
      })
    } finally {
      setLoadingAction(null)
      setContextMenu(null)
    }
  }

  const handleDeduceMindMap = async () => {
    const graphs = useGraphStore.getState().graphs
    const onlineGraph = graphs.find((g) => g.type === 'online')
    if (!onlineGraph) {
      useFileTreeStore.setState({
        toast: { message: t('projects.context.needOnlineGraph'), type: 'error' },
      })
      setContextMenu(null)
      return
    }

    setLoadingAction('deduce')

    try {
      const adapters = useAgentStore.getState().adapters.filter((a) => a.installed)
      if (adapters.length === 0) {
        throw new Error(t('projects.context.noAgentInstalled'))
      }

      const config = {
        workingDirectory: '',
        allowedFiles: [contextMenuPath],
        forbiddenFiles: [],
        invariantRules: [],
        upstreamContext: '',
        downstreamContext: '',
        nodeTitle: t('projects.context.deduceNodeTitle', { name: nodeName }),
        acceptanceCriteria: [],
      }

      const result = await window.electronAPI['agent:startSession'](null, config)

      const prompt = `分析 ${contextMenuPath} 的代码结构，生成业务模块/流程/功能点的节点层级。返回 JSON 格式：{"modules":[{"title":"模块名","description":"描述","processes":[{"title":"流程名","description":"描述","features":["功能点名"]}]}]}`

      await window.electronAPI['agent:sendCommand'](result.sessionId, {
        type: 'implement',
        description: prompt,
        targetNodeId: '',
      })

      useFileTreeStore.setState({
        toast: { message: t('projects.context.deduceStarted'), type: 'success' },
      })

      setAgentWorkingDirectory(contextMenuPath)
      setActiveRightPanel('agent')
    } catch (err) {
      useFileTreeStore.setState({
        toast: { message: t('projects.context.deduceFailed', { error: String(err) }), type: 'error' },
      })
    } finally {
      setLoadingAction(null)
      setContextMenu(null)
    }
  }

  const handleAddIndependentNode = () => {
    setShowTypePicker(true)
  }

  const handleTypeSelected = async (nodeType: NodeType) => {
    const graphs = useGraphStore.getState().graphs
    const onlineGraph = graphs.find((g) => g.type === 'online')
    if (!onlineGraph) {
      useFileTreeStore.setState({
        toast: { message: t('projects.context.needOnlineGraph'), type: 'error' },
      })
      setShowTypePicker(false)
      setContextMenu(null)
      return
    }

    const position = calculateNewNodePosition()
    await useGraphStore.getState().createNode({
      type: nodeType,
      status: 'draft',
      title: nodeName,
      description: `[Scope: ${contextMenuPath}]`,
      graphId: onlineGraph.id,
      graphType: 'online',
      position,
    })

    setShowTypePicker(false)
    setContextMenu(null)
  }

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(contextMenuPos.x, window.innerWidth - 240),
    top: Math.min(contextMenuPos.y, window.innerHeight - 400),
    zIndex: 100,
  }

  return (
    <div
      ref={menuRef}
      className="bg-background border rounded-lg shadow-lg py-1 w-56"
      style={menuStyle}
    >
      {/* 标题栏 */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b mb-1 flex items-center gap-1">
        <span className="truncate font-medium">{nodeName}</span>
      </div>

      {/* 分组 1：Agent 操作 */}
      <MenuGroup title={t('projects.context.agentGroup')}>
        <MenuItem
          icon={Terminal}
          label={t('projects.context.agentInput')}
          onClick={handleAgentInput}
        />
        <MenuItem
          icon={loadingAction === 'deduce' ? Loader2 : Sparkles}
          label={t('projects.context.deduceMindMap')}
          onClick={handleDeduceMindMap}
          loading={loadingAction === 'deduce'}
        />
      </MenuGroup>

      {/* 分组 2：生成节点 */}
      <MenuGroup title={t('projects.context.generateGroup')}>
        {[
          { type: 'module' as NodeType, label: t('projects.context.generateModule'), icon: Box },
          { type: 'process' as NodeType, label: t('projects.context.generateProcess'), icon: GitBranch },
          { type: 'feature' as NodeType, label: t('projects.context.generateFeature'), icon: Code2 },
          { type: 'bug' as NodeType, label: t('projects.context.generateBug'), icon: Bug },
        ].map(({ type, label, icon }) => (
          <MenuItem
            key={type}
            icon={loadingAction === `generate-${type}` ? Loader2 : icon}
            label={label}
            onClick={() => handleGenerateNode(type)}
            loading={loadingAction === `generate-${type}`}
          />
        ))}
        <MenuItem
          icon={Plus}
          label={t('projects.context.addStandaloneNode')}
          onClick={handleAddIndependentNode}
        />
      </MenuGroup>

      {/* 节点类型选择浮层 */}
      {showTypePicker && (
        <div className="px-2 py-1.5 border-t border-b">
          <div className="text-[10px] text-muted-foreground mb-1 px-1">
            {t('projects.context.selectNodeType')}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {typeOptions(locale).map(({ type, label, color }) => (
              <button
                key={type}
                onClick={() => handleTypeSelected(type)}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-muted transition-colors"
              >
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 分组 3：文件操作 */}
      <MenuGroup title={t('projects.context.fileOpsGroup')}>
        <MenuItem icon={Copy} label={t('projects.context.copy')} onClick={handleCopy} />
        <MenuItem icon={Scissors} label={t('projects.context.cut')} onClick={handleCut} />
        <MenuItem
          icon={Clipboard}
          label={t('projects.context.paste')}
          onClick={handlePaste}
          disabled={!clipboard}
        />
        <MenuItem
          icon={confirmDelete ? X : Trash2}
          label={confirmDelete ? t('projects.context.confirmDelete') : t('projects.context.delete')}
          onClick={handleDelete}
          danger
        />
      </MenuGroup>
    </div>
  )
}

// ---- 子组件 ----

function MenuGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="px-3 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wider">
        {title}
      </div>
      <div className="px-1 pb-1">{children}</div>
    </>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
  loading,
}: {
  icon: typeof Terminal
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  loading?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'w-full text-left px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-2',
        disabled
          ? 'text-muted-foreground/50 cursor-not-allowed'
          : danger
            ? 'text-destructive hover:bg-destructive/10'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className={cn('w-3 h-3', loading && 'animate-spin')} />
      {label}
    </button>
  )
}

// ---- 辅助函数 ----

function findNodeByPath(root: TreeNode | null, targetPath: string): TreeNode | null {
  if (!root) return null
  if (root.path === targetPath) return root
  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, targetPath)
      if (found) return found
    }
  }
  return null
}

function calculateNewNodePosition() {
  const nodes = useGraphStore.getState().nodes
  if (nodes.length === 0) return { x: 250, y: 150 }
  const maxX = Math.max(...nodes.map((n) => n.position.x))
  return { x: maxX + 300, y: 150 }
}
