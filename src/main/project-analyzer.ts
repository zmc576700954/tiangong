/**
 * 项目分析转换层
 * 将 ProjectScanResult 转换为 BizGraph 的节点和边
 * 提供自动布局算法
 *
 * 布局策略：从左到右的树状展开
 * 根(左上) → 模块(中左) → 流程(中右) → 功能点(右)
 *
 * v2 改进：
 * - 边附带 edgeType，默认为 'default'
 * - 自动检测模块间依赖关系，生成跨模块连线
 * - 节点元数据填充 API/服务/实体信息
 * - 流程节点名称包含模块前缀以便区分
 */

import type {
  GraphNode,
  GraphEdge,
  ProjectScanResult,
  ScanModule,
  NodeMetadata,
} from '@shared/types'

// ============================================
// 布局配置
// ============================================

export interface LayoutConfig {
  /** 画布中心 X */
  centerX: number
  /** 根节点 Y */
  rootY: number
  /** 模块层级 Y */
  moduleY: number
  /** 流程层级 Y 起始 */
  processYStart: number
  /** 功能点层级 X */
  featureX: number
  /** 模块之间水平间距 */
  moduleSpacingX: number
  /** 流程之间垂直间距 */
  processSpacingY: number
  /** 功能点之间垂直间距 */
  featureSpacingY: number
}

const DEFAULT_LAYOUT: LayoutConfig = {
  centerX: 600,
  rootY: 60,
  moduleY: 220,
  processYStart: 200,
  featureX: 1100,
  moduleSpacingX: 320,
  processSpacingY: 120,
  featureSpacingY: 70,
}

// ============================================
// 主分析器类
// ============================================

export interface ProjectGraphResult {
  projectName: string
  projectPath: string
  framework: string
  nodes: Array<Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> & { tempId: string; parentTempId?: string }>
  edges: Array<{ sourceTempId: string; targetTempId: string; label?: string; edgeType?: GraphEdge['edgeType']; graphId: string }>
}

export class ProjectAnalyzer {
  private config: LayoutConfig

  constructor(config: Partial<LayoutConfig> = {}) {
    this.config = { ...DEFAULT_LAYOUT, ...config }
  }

  analyze(scanResult: ProjectScanResult): ProjectGraphResult {
    const nodes: ProjectGraphResult['nodes'] = []
    const edges: ProjectGraphResult['edges'] = []

    // 1. 根节点
    const rootNode = this.createRootNode(scanResult)
    nodes.push(rootNode)

    // 2. 模块节点 - 水平展开
    const moduleCount = scanResult.modules.length
    const moduleTotalWidth = (moduleCount - 1) * this.config.moduleSpacingX
    const moduleBaseX = this.config.centerX - moduleTotalWidth / 2

    for (let i = 0; i < moduleCount; i++) {
      const module = scanResult.modules[i]
      const moduleX = moduleBaseX + i * this.config.moduleSpacingX
      const moduleTempId = `module-${i}`

      // 构建模块元数据：汇总该模块下所有流程的功能点信息
      const moduleMetadata = this.buildModuleMetadata(module)

      nodes.push({
        tempId: moduleTempId,
        type: 'module',
        status: 'confirmed',
        title: module.name,
        description: module.description,
        graphId: '',
        graphType: 'online',
        position: { x: moduleX, y: this.config.moduleY },
        metadata: moduleMetadata,
        acceptanceCriteria: [],
        ownerRole: 'product',
      })

      // 根节点 → 模块 边
      edges.push({
        sourceTempId: rootNode.tempId,
        targetTempId: moduleTempId,
        label: '包含',
        edgeType: 'default',
        graphId: '',
      })

      // 3. 该模块下的所有流程 - 垂直堆叠
      const processCount = module.processes.length
      const processBaseY = this.config.processYStart

      for (let j = 0; j < processCount; j++) {
        const process = module.processes[j]
        const processY = processBaseY + j * this.config.processSpacingY
        const processTempId = `${moduleTempId}-process-${j}`

        // 流程名称包含模块前缀以便在全局视图中区分
        const processTitle = processCount > 1
          ? `${module.name} · ${process.name}`
          : process.name

        // 构建流程元数据：汇总该流程下的功能点详情
        const processMetadata = this.buildProcessMetadata(process)

        nodes.push({
          tempId: processTempId,
          type: 'process',
          status: 'confirmed',
          title: processTitle,
          description: process.description,
          graphId: '',
          graphType: 'online',
          position: { x: moduleX + 260, y: processY },
          metadata: processMetadata,
          acceptanceCriteria: [],
          parentTempId: moduleTempId,
          ownerRole: 'product',
        })

        // 模块 → 流程 边
        edges.push({
          sourceTempId: moduleTempId,
          targetTempId: processTempId,
          label: '',
          edgeType: 'default',
          graphId: '',
        })

        // 4. 该流程下的功能点 - 在最右侧垂直展开
        const featureCount = process.features.length
        const featureTotalHeight = (featureCount - 1) * this.config.featureSpacingY
        const featureBaseY = processY - featureTotalHeight / 2

        for (let k = 0; k < featureCount; k++) {
          const feature = process.features[k]
          const featureY = featureBaseY + k * this.config.featureSpacingY
          const featureTempId = `${processTempId}-feature-${k}`

          nodes.push({
            tempId: featureTempId,
            type: feature.type === 'bug' ? 'bug' : 'feature',
            status: 'draft',
            title: feature.name,
            description: feature.description,
            graphId: '',
            graphType: 'dev',
            position: { x: this.config.featureX, y: featureY },
            metadata: {},
            acceptanceCriteria: [],
            parentTempId: processTempId,
            ownerRole: 'developer',
          })

          // 流程 → 功能点 边
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

    // 5. 检测模块间依赖关系，生成跨模块连线
    const crossEdges = this.detectModuleDependencies(scanResult, nodes)
    edges.push(...crossEdges)

    return {
      projectName: scanResult.projectName,
      projectPath: scanResult.projectPath,
      framework: scanResult.framework,
      nodes,
      edges,
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
      position: { x: this.config.centerX, y: this.config.rootY },
      metadata,
      acceptanceCriteria: [],
      ownerRole: 'product',
    }
  }
}

// ============================================
// 辅助函数：根据节点数量动态调整布局
// ============================================

export function computeOptimalLayout(
  scanResult: ProjectScanResult,
  _canvasWidth: number = 1400,
): LayoutConfig {
  const moduleCount = scanResult.modules.length
  const maxProcesses = Math.max(
    1,
    ...scanResult.modules.map((m) => m.processes.length),
  )
  const maxFeatures = Math.max(
    1,
    ...scanResult.modules.flatMap((m) => m.processes.map((p) => p.features.length)),
  )

  // 根据模块数量调整
  const moduleSpacingX = moduleCount <= 3 ? 340 : moduleCount <= 6 ? 280 : 240
  const moduleTotalWidth = (moduleCount - 1) * moduleSpacingX
  const centerX = Math.max(400, moduleTotalWidth / 2 + 200)

  // 功能点在最右侧，根据流程数量调整起始位置
  const processSpacingY = maxProcesses <= 2 ? 140 : maxProcesses <= 5 ? 120 : 100
  const featureSpacingY = maxFeatures <= 3 ? 80 : maxFeatures <= 6 ? 65 : 55

  // 确保功能点在最右侧有足够的空间
  const featureX = Math.max(1000, centerX + 600)

  return {
    centerX,
    rootY: 60,
    moduleY: 220,
    processYStart: 180,
    featureX,
    moduleSpacingX,
    processSpacingY,
    featureSpacingY,
  }
}
