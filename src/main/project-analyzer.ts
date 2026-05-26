/**
 * 项目分析转换层
 * 将 ProjectScanResult 转换为 BizGraph 的节点和边
 * 提供自动布局算法
 *
 * 布局策略：从左到右的树状展开
 * 根(左上) → 模块(中左) → 流程(中右) → 功能点(右)
 */

import type {
  GraphNode,
  ProjectScanResult,
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
  edges: Array<{ sourceTempId: string; targetTempId: string; label?: string; graphId: string }>
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

      nodes.push({
        tempId: moduleTempId,
        type: 'module',
        status: 'confirmed',
        title: module.name,
        description: module.description,
        graphId: '',
        graphType: 'online',
        position: { x: moduleX, y: this.config.moduleY },
        metadata: {},
        acceptanceCriteria: [],
        ownerRole: 'product',
      })

      edges.push({
        sourceTempId: rootNode.tempId,
        targetTempId: moduleTempId,
        label: '',
        graphId: '',
      })

      // 3. 该模块下的所有流程 - 垂直堆叠
      const processCount = module.processes.length
      const processTotalHeight = (processCount - 1) * this.config.processSpacingY
      const processBaseY = this.config.processYStart

      for (let j = 0; j < processCount; j++) {
        const process = module.processes[j]
        const processY = processBaseY + j * this.config.processSpacingY
        const processTempId = `${moduleTempId}-process-${j}`

        nodes.push({
          tempId: processTempId,
          type: 'process',
          status: 'confirmed',
          title: process.name,
          description: process.description,
          graphId: '',
          graphType: 'online',
          position: { x: moduleX + 260, y: processY },
          metadata: {},
          acceptanceCriteria: [],
          parentTempId: moduleTempId,
          ownerRole: 'product',
        })

        edges.push({
          sourceTempId: moduleTempId,
          targetTempId: processTempId,
          label: '',
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
            type: 'feature',
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

          edges.push({
            sourceTempId: processTempId,
            targetTempId: featureTempId,
            label: '',
            graphId: '',
          })
        }
      }
    }

    return {
      projectName: scanResult.projectName,
      projectPath: scanResult.projectPath,
      framework: scanResult.framework,
      nodes,
      edges,
    }
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
      : `${scanResult.framework} project, ${scanResult.modules.length} business modules`

    return {
      tempId: 'root',
      type: 'module',
      status: 'confirmed',
      title: scanResult.projectName,
      description,
      graphId: '',
      graphType: 'online',
      position: { x: this.config.centerX, y: this.config.rootY },
      metadata: {
        services: deps.length > 0
          ? deps.map((d) => ({ name: d, description: 'project dependency' }))
          : undefined,
      },
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
  canvasWidth: number = 1400,
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
