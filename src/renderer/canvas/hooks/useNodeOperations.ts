import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import { NODE_TYPE_LABELS } from '@shared/constants'
import type { NodeType } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'
import { useAppStore } from '../../store/appStore'

/**
 * 封装节点相关的业务操作：添加子节点、AI 生成、AI 补充详情、生成开发 Prompt。
 */
export function useNodeOperations(graphId: string, projectPath?: string) {
  const graphNodes = useGraphStore((state) => state.nodes)
  const createNode = useGraphStore((state) => state.createNode)
  const updateNode = useGraphStore((state) => state.updateNode)

  const { screenToFlowPosition } = useReactFlow()

  const handleAddChild = useCallback(async (parentId: string, childType: NodeType) => {
    const parent = graphNodes.find((n) => n.id === parentId)
    const offsetX = parent ? 280 : 100
    const offsetY = parent ? 60 : 60
    const position = parent
      ? { x: parent.position.x + offsetX, y: parent.position.y + offsetY }
      : screenToFlowPosition({ x: 400, y: 300 })

    await createNode({
      type: childType,
      status: 'draft',
      title: `新建${NODE_TYPE_LABELS[childType]}`,
      graphId,
      graphType: childType === 'feature' || childType === 'bug' ? 'dev' : 'online',
      parentId,
      position,
      acceptanceCriteria: [],
    })
  }, [graphNodes, createNode, graphId, screenToFlowPosition])

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
          await createNode({
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
        }
      }
    } catch (err) {
      console.error('[useNodeOperations] generateChildren failed:', err)
    }
  }, [graphNodes, projectPath, createNode, graphId])

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
        useAppStore.getState().setActiveRightPanel('agent')
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
