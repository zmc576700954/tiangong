/**
 * 实体/模型提取模块
 */

import type { FileAnalysis, EntityInfo } from './types'

export function extractEntities(fileAnalyses: FileAnalysis[], framework: string): EntityInfo[] {
  const entities: EntityInfo[] = []
  const modelFiles = fileAnalyses.filter((f) =>
    f.purpose === 'model' || f.purpose === 'entity'
  )

  for (const file of modelFiles) {
    const extracted = parseEntities(file.content, framework, file.filePath)
    entities.push(...extracted)
  }

  return entities
}

function findClassEnd(content: string, startIndex: number): number {
  let depth = 0
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') depth++
    if (content[i] === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return content.length
}

function parseEntities(content: string, framework: string, filePath: string): EntityInfo[] {
  const entities: EntityInfo[] = []

  if (framework.includes('TypeScript') || framework.includes('Node.js') || framework.includes('NestJS')) {
    // 类定义: class User { ... }
    const classRegex = /class\s+(\w+).*?\{/g
    let match
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1]
      const startIdx = match.index
      const endIdx = findClassEnd(content, startIdx)
      const classBody = content.slice(startIdx, endIdx)

      // 提取字段
      const fields: string[] = []
      const fieldRegex = /(?:private|public|protected|readonly)?\s*(\w+)\??\s*:\s*(\w+)/g
      let fieldMatch
      while ((fieldMatch = fieldRegex.exec(classBody)) !== null) {
        fields.push(`${fieldMatch[1]}: ${fieldMatch[2]}`)
      }

      if (fields.length > 0 || classBody.includes('@Entity') || classBody.includes('@Schema')) {
        entities.push({ name: className, fields: fields.slice(0, 10), file: filePath })
      }
    }
  }

  if (framework.includes('Python')) {
    // Python 类定义
    const classRegex = /class\s+(\w+)(?:\([^)]*\))?\s*:/g
    let match
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1]
      // 跳过测试类和非模型类
      if (className.startsWith('Test')) continue

      const fields: string[] = []
      const lines = content.slice(match.index, match.index + 2000).split('\n')
      for (const line of lines.slice(1)) {
        if (line.match(/^\s+\w+\s*=\s*(models\.|Column|Field)/)) {
          const fieldMatch = line.match(/(\w+)\s*=/)
          if (fieldMatch) fields.push(fieldMatch[1])
        }
        if (line.trim() === '' || line.match(/^\s*class\s/)) break
      }

      if (fields.length > 0) {
        entities.push({ name: className, fields: fields.slice(0, 10), file: filePath })
      }
    }
  }

  if (framework.includes('Go')) {
    // Go struct 定义
    const structRegex = /type\s+(\w+)\s+struct\s*\{/g
    let match
    while ((match = structRegex.exec(content)) !== null) {
      const structName = match[1]
      const fields: string[] = []
      const lines = content.slice(match.index, match.index + 2000).split('\n')
      for (const line of lines.slice(1)) {
        if (line.includes('}')) break
        const fieldMatch = line.match(/^\s+(\w+)\s+\w+/)
        if (fieldMatch) fields.push(fieldMatch[1])
      }
      entities.push({ name: structName, fields: fields.slice(0, 10), file: filePath })
    }
  }

  if (framework.includes('Java')) {
    // Java 类定义
    const classRegex = /(?:public\s+)?class\s+(\w+)/g
    let match
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1]
      if (className.endsWith('Test')) continue
      const fields: string[] = []
      const lines = content.slice(match.index, match.index + 3000).split('\n')
      for (const line of lines.slice(1)) {
        if (line.includes('class ') && !line.includes('@')) break
        const fieldMatch = line.match(/(?:private|public|protected)\s+\w+\s+(\w+)\s*[;=]/)
        if (fieldMatch) fields.push(fieldMatch[1])
      }
      if (fields.length > 0) {
        entities.push({ name: className, fields: fields.slice(0, 10), file: filePath })
      }
    }
  }

  return entities
}
