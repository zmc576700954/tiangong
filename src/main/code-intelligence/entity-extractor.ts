/**
 * 技术实体提取器
 * 从用户自然语言输入中提取技术实体（类名、方法名、文件路径等）
 */

/**
 * 技术实体类型
 */
export type EntityType = 'class' | 'function' | 'method' | 'interface' | 'file' | 'module' | 'keyword'

export interface ExtractedEntity {
  name: string
  type: EntityType
  confidence: number // 0-1
  position?: { start: number; end: number } // 在原文中的位置
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  intent: 'implement' | 'fix' | 'refactor' | 'explain' | 'test' | 'unknown'
  targetDescription?: string // 去实体化后的描述文本
}

/**
 * 从用户自然语言输入中提取技术实体
 * 使用规则 + 启发式方法（后续可替换为 LLM-based 提取）
 */
export class EntityExtractor {
  // 意图关键词映射
  private readonly intentPatterns: Array<{ pattern: RegExp; intent: ExtractionResult['intent'] }> = [
    { pattern: /(?:实现|添加|创建|新增|开发|build|implement|add|create|develop)/i, intent: 'implement' },
    { pattern: /(?:修复|解决|bug|fix|repair|resolve)/i, intent: 'fix' },
    { pattern: /(?:重构|优化|改进|整理|refactor|optimize|improve|cleanup)/i, intent: 'refactor' },
    { pattern: /(?:解释|说明|怎么|为什么|explain|describe|how|why)/i, intent: 'explain' },
    { pattern: /(?:测试|test|spec|unit test|e2e)/i, intent: 'test' },
  ]

  /**
   * 从用户输入中提取技术实体和意图
   */
  extract(input: string): ExtractionResult {
    const entities = this.extractEntities(input)
    const intent = this.detectIntent(input)
    const targetDescription = this.buildTargetDescription(input, entities)

    return { entities, intent, targetDescription }
  }

  private extractEntities(input: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = []
    const seen = new Set<string>()

    // 1. 提取大驼峰命名（类名、接口名等）
    const pascalPattern = /\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g
    let match: RegExpExecArray | null
    while ((match = pascalPattern.exec(input)) !== null) {
      const name = match[0]
      if (seen.has(name)) continue
      seen.add(name)

      // 启发式判断类型
      let type: EntityType = 'class'
      if (name.endsWith('Service')) type = 'class'
      else if (name.endsWith('Controller')) type = 'class'
      else if (name.endsWith('Repository')) type = 'class'
      else if (name.endsWith('Dto') || name.endsWith('DTO')) type = 'interface'
      else if (name.endsWith('Interface')) type = 'interface'
      else if (name.endsWith('Type') || name.endsWith('Types')) type = 'interface'
      else if (/^[A-Z]/.test(name) && name.length > 3) type = 'class'

      entities.push({
        name,
        type,
        confidence: this.calculateEntityConfidence(name, type, input),
        position: { start: match.index, end: match.index + name.length },
      })
    }

    // 2. 提取文件路径模式（如 src/user/service.ts）
    const filePattern = /\b(?:[\w\-]+\/)+[\w\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt)\b/g
    while ((match = filePattern.exec(input)) !== null) {
      const name = match[0]
      if (seen.has(name)) continue
      seen.add(name)
      entities.push({
        name,
        type: 'file',
        confidence: 0.95,
        position: { start: match.index, end: match.index + name.length },
      })
    }

    // 3. 提取常见技术关键词
    const techKeywords = [
      'API', 'REST', 'GraphQL', 'database', 'cache', 'middleware', 'auth', 'JWT',
      'OAuth', 'websocket', 'queue', 'event', 'listener', 'hook', 'decorator',
      '拦截器', '中间件', '装饰器', '队列', '事件', '监听器',
    ]
    for (const keyword of techKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi')
      while ((match = regex.exec(input)) !== null) {
        const name = match[0]
        const key = `${name}-${match.index}`
        if (seen.has(key)) continue
        seen.add(key)
        entities.push({
          name,
          type: 'keyword',
          confidence: 0.6,
          position: { start: match.index, end: match.index + name.length },
        })
      }
    }

    // 4. 提取 "ClassName.methodName" 模式（如 UserController.login）
    const dotMethodPattern = /\b([A-Z][a-zA-Z0-9]*)\.([a-z][a-zA-Z0-9]*)\b/g
    while ((match = dotMethodPattern.exec(input)) !== null) {
      const className = match[1]
      const methodName = match[2]
      if (!seen.has(className)) {
        seen.add(className)
        entities.push({
          name: className,
          type: 'class',
          confidence: 0.85,
          position: { start: match.index, end: match.index + className.length },
        })
      }
      if (!seen.has(methodName)) {
        seen.add(methodName)
        entities.push({
          name: methodName,
          type: 'method',
          confidence: 0.9,
          position: { start: match.index + className.length + 1, end: match.index + className.length + 1 + methodName.length },
        })
      }
    }

    // 5. 尝试提取 "X 的 Y 方法" 模式
    const methodPattern = /([一-龥\w]+)[的\s]+(\w+)[\s]*(?:方法|函数|method|function)/gi
    while ((match = methodPattern.exec(input)) !== null) {
      const className = match[1]
      const methodName = match[2]
      if (!seen.has(methodName)) {
        seen.add(methodName)
        const methodPos = match[0].indexOf(methodName)
        entities.push({
          name: methodName,
          type: 'method',
          confidence: 0.85,
          position: { start: match.index + methodPos, end: match.index + methodPos + methodName.length },
        })
      }
      // 同时添加类名
      if (!seen.has(className) && /^[A-Z]/.test(className)) {
        seen.add(className)
        entities.push({
          name: className,
          type: 'class',
          confidence: 0.7,
          position: { start: match.index, end: match.index + className.length },
        })
      }
    }

    // 去重并按置信度排序
    return entities
      .filter((e, i, arr) => arr.findIndex((x) => x.name === e.name && x.type === e.type) === i)
      .sort((a, b) => b.confidence - a.confidence)
  }

  private detectIntent(input: string): ExtractionResult['intent'] {
    for (const { pattern, intent } of this.intentPatterns) {
      if (pattern.test(input)) return intent
    }
    return 'unknown'
  }

  private buildTargetDescription(input: string, entities: ExtractedEntity[]): string {
    let desc = input
    // 移除已识别的实体名，保留描述性文本
    for (const entity of entities.sort((a, b) => (b.position?.start ?? 0) - (a.position?.start ?? 0))) {
      if (entity.position) {
        desc = desc.slice(0, entity.position.start) + `[${entity.type}]` + desc.slice(entity.position.end)
      }
    }
    return desc.replace(/\s+/g, ' ').trim()
  }

  private calculateEntityConfidence(name: string, type: EntityType, context: string): number {
    let score = 0.7
    // 命名规范加分
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name) && type === 'class') score += 0.1
    if (/^[a-z][a-zA-Z0-9]*$/.test(name) && type === 'function') score += 0.1
    // 上下文佐证加分
    const surrounding = context.slice(Math.max(0, context.indexOf(name) - 30), context.indexOf(name) + name.length + 30)
    if (/class|interface|function|method|组件|类|接口|函数|方法/.test(surrounding)) score += 0.1
    return Math.min(1.0, score)
  }
}
