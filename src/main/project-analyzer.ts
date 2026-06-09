/**
 * 项目分析转换层
 * 将 ProjectScanResult 转换为 BizGraph 的节点和边
 * 使用 dagre 自动计算层级布局，避免节点重叠
 */

import dagre from '@dagrejs/dagre'
import type {
  GraphNode,
  GraphEdge,
  ProjectScanResult,
  ScanModule,
  NodeMetadata,
  NodeType,
} from '@shared/types'

// ============================================
// 节点尺寸配置（与 renderer 端 layout.ts 保持一致）
// ============================================

const NODE_SIZES: Record<NodeType, { width: number; height: number }> = {
  project: { width: 220, height: 90 },
  module:  { width: 200, height: 80 },
  process: { width: 180, height: 70 },
  feature: { width: 160, height: 60 },
  bug:     { width: 160, height: 60 },
}

// ============================================
// 主分析器类
// ============================================

export interface ProjectGraphResult {
  projectName: string
  projectPath: string
  framework: string
  nodes: Array<Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> & { tempId: string; parentTempId?: string }>
  edges: Array<{ sourceTempId: string; targetTempId: string; label?: string; edgeType?: GraphEdge['edgeType']; graphId: string; description?: string; dataFlow?: string; strength?: number }>
}

export class ProjectAnalyzer {
  analyze(scanResult: ProjectScanResult): ProjectGraphResult {
    const nodes: ProjectGraphResult['nodes'] = []
    const edges: ProjectGraphResult['edges'] = []

    // 1. 构建节点和边（先用占位 position，后面由 dagre 统一计算）
    const rootNode = this.createRootNode(scanResult)
    nodes.push(rootNode)

    for (let i = 0; i < scanResult.modules.length; i++) {
      const module = scanResult.modules[i]
      const moduleTempId = `module-${i}`
      const moduleMetadata = this.buildModuleMetadata(module)

      nodes.push({
        tempId: moduleTempId,
        type: 'module',
        status: 'confirmed',
        title: module.name,
        description: module.description,
        graphId: '',
        graphType: 'online',
        position: { x: 0, y: 0 }, // dagre 会覆盖
        metadata: moduleMetadata,
        acceptanceCriteria: [],
        ownerRole: 'product',
      })

      edges.push({
        sourceTempId: rootNode.tempId,
        targetTempId: moduleTempId,
        label: '包含',
        edgeType: 'default',
        graphId: '',
      })

      for (let j = 0; j < module.processes.length; j++) {
        const process = module.processes[j]
        const processTempId = `${moduleTempId}-process-${j}`
        const processTitle = module.processes.length > 1
          ? `${module.name} · ${process.name}`
          : process.name
        const processMetadata = this.buildProcessMetadata(process)

        nodes.push({
          tempId: processTempId,
          type: 'process',
          status: 'confirmed',
          title: processTitle,
          description: process.description,
          graphId: '',
          graphType: 'online',
          position: { x: 0, y: 0 },
          metadata: processMetadata,
          acceptanceCriteria: [],
          parentTempId: moduleTempId,
          ownerRole: 'product',
        })

        edges.push({
          sourceTempId: moduleTempId,
          targetTempId: processTempId,
          label: '',
          edgeType: 'default',
          graphId: '',
        })

        for (let k = 0; k < process.features.length; k++) {
          const feature = process.features[k]
          const featureTempId = `${processTempId}-feature-${k}`

          nodes.push({
            tempId: featureTempId,
            type: feature.type === 'bug' ? 'bug' : 'feature',
            status: 'draft',
            title: feature.name,
            description: feature.description,
            graphId: '',
            graphType: 'dev',
            position: { x: 0, y: 0 },
            metadata: {},
            acceptanceCriteria: [],
            parentTempId: processTempId,
            ownerRole: 'developer',
          })

          edges.push({
            sourceTempId: processTempId,
            targetTempId: featureTempId,
            label: '',
            edgeType: 'default',
            graphId: '',
          })
        }
      }
    }

    // 2. 检测模块间依赖关系
    const crossEdges = this.detectModuleDependencies(scanResult, nodes)
    edges.push(...crossEdges)

    // 3. 使用 dagre 计算布局
    this.applyDagreLayout(nodes, edges)

    return {
      projectName: scanResult.projectName,
      projectPath: scanResult.projectPath,
      framework: scanResult.framework,
      nodes,
      edges,
    }
  }

  /**
   * 根据标题长度估算节点宽度
   */
  private estimateWidth(node: ProjectGraphResult['nodes'][number]): number {
    const base = NODE_SIZES[node.type] ?? NODE_SIZES.feature
    const title = node.title ?? ''
    const cjkCount = (title.match(/[一-鿿]/g) || []).length
    const otherCount = title.length - cjkCount
    const textWidth = cjkCount * 14 + otherCount * 8 + 32
    return Math.max(base.width, Math.min(200, textWidth))
  }

  /**
   * 使用 dagre 计算所有节点的坐标（LR 方向）
   */
  private applyDagreLayout(
    nodes: ProjectGraphResult['nodes'],
    edges: ProjectGraphResult['edges'],
  ): void {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 120, ranksep: 280, edgesep: 30, marginx: 60, marginy: 60 })
    g.setDefaultEdgeLabel(() => ({}))

    for (const node of nodes) {
      const width = this.estimateWidth(node)
      const height = (NODE_SIZES[node.type] ?? NODE_SIZES.feature).height
      g.setNode(node.tempId, { width, height })
    }

    for (const edge of edges) {
      g.setEdge(edge.sourceTempId, edge.targetTempId)
    }

    dagre.layout(g)

    const nodeMap = new Map<string, ProjectGraphResult['nodes'][number]>()
    for (const node of nodes) {
      const dagreNode = g.node(node.tempId)
      if (!dagreNode) continue
      const width = this.estimateWidth(node)
      const height = (NODE_SIZES[node.type] ?? NODE_SIZES.feature).height
      node.position = {
        x: dagreNode.x - width / 2,
        y: dagreNode.y - height / 2,
      }
      nodeMap.set(node.tempId, node)
    }

    // 按边顺序修正子节点垂直排列，消除连线交叉
    const childrenByParent = new Map<string, string[]>()
    for (const edge of edges) {
      if (!childrenByParent.has(edge.sourceTempId)) {
        childrenByParent.set(edge.sourceTempId, [])
      }
      childrenByParent.get(edge.sourceTempId)!.push(edge.targetTempId)
    }

    for (const [, childIds] of childrenByParent) {
      if (childIds.length <= 1) continue
      const children = childIds.map((id) => nodeMap.get(id)).filter(Boolean) as typeof nodes
      if (children.length <= 1) continue

      const ys = children.map((n) => n.position.y)
      const height = (NODE_SIZES[children[0].type] ?? NODE_SIZES.feature).height
      const groupMinY = Math.min(...ys)

      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        const idx = childIds.indexOf(child.tempId)
        if (idx < 0) continue
        child.position = { ...child.position, y: groupMinY + idx * (height + 120) }
      }
    }
  }

  /**
   * 构建模块级别的元数据，汇总子流程信息
   */
  private buildModuleMetadata(module: ScanModule): NodeMetadata {
    const metadata: NodeMetadata = {}

    // 从所有流程的功能点中提取 API 信息
    const apis: NonNullable<NodeMetadata['apis']> = []
    const services: NonNullable<NodeMetadata['services']> = []
    const entities: NonNullable<NodeMetadata['entities']> = []

    for (const process of module.processes) {
      for (const feature of process.features) {
        const desc = feature.description || ''
        // 如果描述中包含 API 端点信息
        if (desc.includes('API') || desc.includes('endpoint') || desc.includes('端点')) {
          apis.push({ name: feature.name, description: desc })
        }
        // 如果描述中包含实体/字段信息
        if (desc.includes('字段') || desc.includes('实体') || desc.includes('数据')) {
          entities.push({ name: feature.name, description: desc })
        }
        // 服务信息
        if (desc.includes('服务') || desc.includes('业务')) {
          services.push({ name: feature.name, description: desc })
        }
      }
    }

    if (apis.length > 0) metadata.apis = apis.slice(0, 10)
    if (services.length > 0) metadata.services = services.slice(0, 10)
    if (entities.length > 0) metadata.entities = entities.slice(0, 10)

    return metadata
  }

  /**
   * 构建流程级别的元数据
   */
  private buildProcessMetadata(process: ScanModule['processes'][number]): NodeMetadata {
    const metadata: NodeMetadata = {}

    const apis: NonNullable<NodeMetadata['apis']> = []
    const entities: NonNullable<NodeMetadata['entities']> = []

    for (const feature of process.features) {
      const desc = feature.description || ''
      if (desc.includes('API') || desc.includes('端点')) {
        apis.push({ name: feature.name, description: desc })
      }
      if (desc.includes('字段') || desc.includes('实体')) {
        entities.push({ name: feature.name, description: desc })
      }
    }

    if (apis.length > 0) metadata.apis = apis
    if (entities.length > 0) metadata.entities = entities

    return metadata
  }

  /**
   * 检测模块间依赖关系
   *
   * 策略：
   * 1. 如果一个模块的描述中提到了另一个模块的名称，建立依赖边
   * 2. 如果共享相同的实体名称（如 order 引用 product），建立关联边
   * 3. 公共模块（common/shared/utils）被其他模块依赖
   */
  private detectModuleDependencies(
    scanResult: ProjectScanResult,
    _nodes: ProjectGraphResult['nodes'],
  ): ProjectGraphResult['edges'] {
    const crossEdges: ProjectGraphResult['edges'] = []
    const modules = scanResult.modules

    // 公共模块关键词（这些模块通常被其他模块依赖）
    const sharedKeywords = ['公共', 'common', 'shared', '工具', 'util', '基础', 'base', '核心', 'core']

    // 收集每个模块的功能点名称集合（小写），用于检测交叉引用
    const moduleFeatureNames = modules.map((m) => {
      const names = new Set<string>()
      for (const p of m.processes) {
        for (const f of p.features) {
          names.add(f.name.toLowerCase())
        }
      }
      return names
    })

    for (let i = 0; i < modules.length; i++) {
      const moduleA = modules[i]
      const moduleADesc = (moduleA.description + ' ' + moduleA.name).toLowerCase()

      for (let j = i + 1; j < modules.length; j++) {
        const moduleB = modules[j]
        const moduleBDesc = (moduleB.description + ' ' + moduleB.name).toLowerCase()

        let hasRelation = false

        // 策略1：公共模块被其他模块依赖
        const aIsShared = sharedKeywords.some((k) => moduleADesc.includes(k))
        const bIsShared = sharedKeywords.some((k) => moduleBDesc.includes(k))
        if (aIsShared && !bIsShared) {
          // B 依赖 A（公共模块）
          hasRelation = true
        } else if (bIsShared && !aIsShared) {
          // A 依赖 B（公共模块）
          hasRelation = true
        }

        // 策略2：一个模块的名称出现在另一个模块的描述/功能点中
        if (!hasRelation) {
          const aNameInB = moduleBDesc.includes(moduleA.name.toLowerCase())
          const bNameInA = moduleADesc.includes(moduleB.name.toLowerCase())
          if (aNameInB || bNameInA) {
            hasRelation = true
          }
        }

        // 策略3：共享相同的功能点名称（可能是同一实体在不同层）
        if (!hasRelation) {
          const featuresA = moduleFeatureNames[i]
          const featuresB = moduleFeatureNames[j]
          let sharedCount = 0
          for (const name of featuresA) {
            if (featuresB.has(name)) sharedCount++
          }
          if (sharedCount >= 2) {
            hasRelation = true
          }
        }

        if (hasRelation) {
          const sourceTempId = `module-${i}`
          const targetTempId = `module-${j}`

          // 确定边方向：公共模块 → 消费模块
          const aIsShared = sharedKeywords.some((k) => moduleADesc.includes(k))
          const src = aIsShared ? sourceTempId : targetTempId
          const dst = aIsShared ? targetTempId : sourceTempId

          crossEdges.push({
            sourceTempId: src,
            targetTempId: dst,
            label: '依赖',
            edgeType: 'condition',
            graphId: '',
          })
        }
      }
    }

    return crossEdges
  }

  private createRootNode(scanResult: ProjectScanResult): ProjectGraphResult['nodes'][number] {
    const deps = scanResult.packageJson
      ? [
          ...scanResult.packageJson.dependencies.slice(0, 5),
          ...scanResult.packageJson.devDependencies.slice(0, 3),
        ]
      : []

    const description = scanResult.packageJson?.description
      ? scanResult.packageJson.description
      : `${scanResult.framework} 项目，包含 ${scanResult.modules.length} 个业务模块`

    // 构建根节点的服务元数据
    const metadata: NodeMetadata = {}
    if (deps.length > 0) {
      metadata.services = deps.map((d) => ({ name: d, description: '项目依赖' }))
    }

    // 从模块中汇总实体信息
    const allEntities: NonNullable<NodeMetadata['entities']> = []
    for (const module of scanResult.modules) {
      for (const process of module.processes) {
        for (const feature of process.features) {
          if (feature.description?.includes('实体') || feature.description?.includes('数据')) {
            allEntities.push({ name: feature.name, description: feature.description })
          }
        }
      }
    }
    if (allEntities.length > 0) {
      metadata.entities = allEntities.slice(0, 8)
    }

    return {
      tempId: 'root',
      type: 'module',
      status: 'confirmed',
      title: scanResult.projectName,
      description,
      graphId: '',
      graphType: 'online',
      position: { x: 0, y: 0 }, // dagre 会覆盖
      metadata,
      acceptanceCriteria: [],
      ownerRole: 'product',
    }
  }
}

// computeOptimalLayout 已移除，布局由 dagre 在 ProjectAnalyzer.analyze() 内部完成
