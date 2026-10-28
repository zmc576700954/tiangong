import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { nodeTypeLabel } from '@shared/i18n'
import type { GraphNode, NodeType } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'
import { useI18n } from '../../i18n/useI18n'

/**
 * 封装节点相关的业务操作：添加子节点、AI 生成、AI 补充详情、生成开发 Prompt。
 */
export function useNodeOperations(graphId: string, projectPath?: string) {
  const { locale, t } = useI18n()
  const graphNodes = useGraphStore((state) => state.nodes)
  const createNode = useGraphStore((state) => state.createNode)
  const updateNode = useGraphStore((state) => state.updateNode)
  const createEdge = useGraphStore((state) => state.createEdge)

  const { screenToFlowPosition } = useReactFlow()

  const handleAddChild = useCallback(async (parentId: string, childType: NodeType) => {
    const parent = graphNodes.find((n) => n.id === parentId)
    const offsetX = parent ? 280 : 100
    const offsetY = parent ? 60 : 60
    const position = parent
      ? { x: parent.position.x + offsetX, y: parent.position.y + offsetY }
      : screenToFlowPosition({ x: 400, y: 300 })

    // 新节点标题按当前语言生成——类型名走共享层的标签表
    const newTitle = t('canvas.node.newTitle', { type: nodeTypeLabel(childType, locale) })

    // onAddChild 的签名是 (parentId, childType) => void —— 调用方（NodeContextMenu）
    // 既不 await 也不 catch，这里抛出去会变成 unhandled rejection。
    // 所以两个 await（createNode / createEdge）都要兜住：失败只记日志，不往上抛。
    let created: GraphNode
    try {
      created = await createNode({
        type: childType,
        status: 'draft',
        title: newTitle,
        graphId,
        graphType: childType === 'feature' || childType === 'bug' ? 'dev' : 'online',
        parentId,
        position,
        acceptanceCriteria: [],
        wikiContent: childType === 'wiki-page' ? `# ${newTitle}\n\n` : undefined,
      })
    } catch (err) {
      // 建节点失败就没有 created.id 可用 —— 直接返回，
      // 绝不能拿 undefined 的 id 去建边（会造出一条指向不存在节点的边）
      console.error('[useNodeOperations] createNode failed:', err)
      return
    }

    // parent_id 是父子关系的唯一事实来源，但存储层镜像（hierarchical 边）也要同步补上 ——
    // 缺了它，迁移/克隆/画布派生都拿不到这一对的层级边。
    try {
      await createEdge({
        source: parentId,
        target: created.id,
        graphId,
        edgeType: 'hierarchical',
      })
    } catch (err) {
      console.error('[useNodeOperations] createHierarchyEdge failed:', err)
    }
  }, [graphNodes, createNode, createEdge, graphId, screenToFlowPosition, locale, t])

  const handleGenerateChildren = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    try {
      const result = await window.electronAPI['mindmap:generateModule'](
        projectPath, nodeId, node.title, node.type,
      )
      if (result && result.children.length > 0) {
        const parent = graphNodes.find((n) => n.id === nodeId)
        const baseX = parent ? parent.position.x + 280 : 100
        const baseY = parent ? parent.position.y : 0

        for (let i = 0; i < result.children.length; i++) {
          const child = result.children[i]
          const created = await createNode({
            type: result.childType,
            status: 'draft',
            title: child.title,
            description: child.description,
            graphId,
            graphType: result.childType === 'feature' ? 'dev' : 'online',
            parentId: nodeId,
            position: { x: baseX, y: baseY + i * 80 },
            acceptanceCriteria: [],
          })

          // 每个 AI 生成的子节点都要补建层级边（parent_id 的存储层镜像）
          await createEdge({
            source: nodeId,
            target: created.id,
            graphId,
            edgeType: 'hierarchical',
          })
        }
      }
    } catch (err) {
      console.error('[useNodeOperations] generateChildren failed:', err)
    }
  }, [graphNodes, projectPath, createNode, createEdge, graphId])

  const handleEnrichNode = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    try {
      const result = await window.electronAPI['mindmap:enrichNode'](
        projectPath, nodeId, node.type, node.title, undefined, node.contextRefs,
      )
      if (result) {
        await updateNode(nodeId, {
          description: result.description,
          acceptanceCriteria: result.acceptanceCriteria,
          rules: result.businessRules,
          metadata: result.metadata,
        })
      }
    } catch (err) {
      console.error('[useNodeOperations] enrichNode failed:', err instanceof Error ? err.message : err)
    }
  }, [graphNodes, projectPath, updateNode])

  const handleStartDev = useCallback(async (nodeId: string) => {
    const node = graphNodes.find((n) => n.id === nodeId)
    if (!node || !projectPath) return

    // Immediately switch to Agent panel so user sees feedback
    useAppStore.getState().setActiveRightPanel('agent')

    try {
      // placeholder 节点自动切换到 developing 状态
      if (node.status === 'placeholder') {
        await updateNode(nodeId, { status: 'developing' })
      }

      const prompt = await window.electronAPI['mindmap:buildDevPrompt'](
        nodeId, node.title, node.type, 'feature', graphId ?? '', node.contextRefs,
      )
      if (prompt) {
        useAppStore.getState().setPendingPrompt(prompt)
      }
    } catch (err) {
      console.error('[useNodeOperations] startDev failed:', err)
    }
  }, [graphNodes, projectPath, graphId, updateNode])

  return {
    handleAddChild,
    handleGenerateChildren,
    handleEnrichNode,
    handleStartDev,
  }
}
