/**
 * 执行计划生成器
 * 从用户提取的实体和意图生成执行步骤序列
 */

import { EntityExtractor, type ExtractionResult } from './entity-extractor'

export interface ExecutionStep {
  id: string
  action: 'read' | 'modify' | 'create' | 'test' | 'verify'
  target: string // 目标文件或符号
  description: string
  dependencies: string[] // 依赖的其他 step id
}

export interface ExecutionPlan {
  intent: string
  steps: ExecutionStep[]
  estimatedComplexity: 'simple' | 'moderate' | 'complex'
  requiresNewFiles: boolean
  affectedSymbols: string[]
}

/**
 * 执行计划生成器
 * 从用户提取的实体和意图生成执行步骤序列
 */
export class ExecutionPlanner {
  private entityExtractor: EntityExtractor

  constructor() {
    this.entityExtractor = new EntityExtractor()
  }

  /**
   * 从用户输入生成执行计划
   */
  generatePlan(userQuery: string): ExecutionPlan {
    const extraction = this.entityExtractor.extract(userQuery)

    switch (extraction.intent) {
      case 'implement':
        return this.planImplementation(extraction, userQuery)
      case 'fix':
        return this.planFix(extraction, userQuery)
      case 'refactor':
        return this.planRefactor(extraction, userQuery)
      case 'test':
        return this.planTest(extraction, userQuery)
      default:
        return this.planGeneric(extraction, userQuery)
    }
  }

  private planImplementation(extraction: ExtractionResult, query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const classEntities = extraction.entities.filter((e) => e.type === 'class')
    const methodEntities = extraction.entities.filter((e) => e.type === 'method' || e.type === 'function')
    const fileEntities = extraction.entities.filter((e) => e.type === 'file')

    // 步骤 1: 读取现有相关代码
    for (const cls of classEntities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: cls.name,
        description: `阅读 ${cls.name} 的现有实现，理解上下文`,
        dependencies: [],
      })
    }

    // 步骤 2: 修改或创建方法
    for (const method of methodEntities) {
      const parentClass = classEntities.find((c) => query.includes(`${c.name}.${method.name}`))
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'modify',
        target: parentClass ? `${parentClass.name}.${method.name}` : method.name,
        description: `在 ${parentClass?.name ?? '目标位置'} 中实现 ${method.name} 方法`,
        dependencies: parentClass ? [`step-${steps.findIndex((s) => s.target === parentClass.name) + 1}`] : [],
      })
    }

    // 步骤 3: 如果没有指定具体类，可能需要创建新文件
    const requiresNewFiles = classEntities.length === 0 && fileEntities.length === 0
    if (requiresNewFiles) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'create',
        target: 'new-file',
        description: '创建新文件实现需求',
        dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
      })
    }

    // 步骤 4: 验证
    steps.push({
      id: `step-${steps.length + 1}`,
      action: 'verify',
      target: 'implementation',
      description: '验证实现是否符合需求',
      dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
    })

    return {
      intent: 'implement',
      steps,
      estimatedComplexity: steps.length > 5 ? 'complex' : steps.length > 2 ? 'moderate' : 'simple',
      requiresNewFiles,
      affectedSymbols: [...classEntities, ...methodEntities].map((e) => e.name),
    }
  }

  private planFix(extraction: ExtractionResult, _query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const entities = extraction.entities.filter((e) => e.type === 'class' || e.type === 'method' || e.type === 'function')

    // 步骤 1: 定位问题
    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: entity.name,
        description: `检查 ${entity.name} 的实现，定位问题`,
        dependencies: [],
      })
    }

    // 步骤 2: 修复
    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'modify',
        target: entity.name,
        description: `修复 ${entity.name} 中的问题`,
        dependencies: [`step-${steps.findIndex((s) => s.target === entity.name && s.action === 'read') + 1}`],
      })
    }

    // 步骤 3: 测试验证
    steps.push({
      id: `step-${steps.length + 1}`,
      action: 'test',
      target: entities.map((e) => e.name).join(', '),
      description: '运行测试验证修复',
      dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
    })

    return {
      intent: 'fix',
      steps,
      estimatedComplexity: entities.length > 2 ? 'complex' : 'simple',
      requiresNewFiles: false,
      affectedSymbols: entities.map((e) => e.name),
    }
  }

  private planRefactor(extraction: ExtractionResult, _query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const entities = extraction.entities.filter((e) => e.type === 'class' || e.type === 'method' || e.type === 'function')

    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: entity.name,
        description: `分析 ${entity.name} 的当前实现`,
        dependencies: [],
      })
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'modify',
        target: entity.name,
        description: `重构 ${entity.name}`,
        dependencies: [`step-${steps.length - 1}`],
      })
    }

    return {
      intent: 'refactor',
      steps,
      estimatedComplexity: 'moderate',
      requiresNewFiles: false,
      affectedSymbols: entities.map((e) => e.name),
    }
  }

  private planTest(extraction: ExtractionResult, _query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const entities = extraction.entities.filter((e) => e.type === 'class' || e.type === 'method')

    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: entity.name,
        description: `理解 ${entity.name} 的功能和边界情况`,
        dependencies: [],
      })
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'create',
        target: `${entity.name}.test`,
        description: `为 ${entity.name} 编写测试用例`,
        dependencies: [`step-${steps.length - 1}`],
      })
    }

    return {
      intent: 'test',
      steps,
      estimatedComplexity: 'moderate',
      requiresNewFiles: true,
      affectedSymbols: entities.map((e) => e.name),
    }
  }

  private planGeneric(extraction: ExtractionResult, _query: string): ExecutionPlan {
    return {
      intent: 'unknown',
      steps: [
        {
          id: 'step-1',
          action: 'read',
          target: 'project',
          description: '分析项目结构以理解需求',
          dependencies: [],
        },
      ],
      estimatedComplexity: 'simple',
      requiresNewFiles: false,
      affectedSymbols: extraction.entities.map((e) => e.name),
    }
  }
}
