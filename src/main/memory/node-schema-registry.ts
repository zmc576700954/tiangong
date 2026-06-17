import type { NodeType } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('node-schema-registry')

export interface FieldDef {
  type: 'string' | 'string[]' | 'number' | 'boolean'
  required?: boolean
  description: string
}

export interface NodeTypeSchema {
  fields: Record<string, FieldDef>
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

const SCHEMAS: Record<string, NodeTypeSchema> = {
  module: {
    fields: {
      frameworks: { type: 'string[]', description: '使用的框架列表' },
      entryPoints: { type: 'string[]', description: '入口文件路径' },
      keyFiles: { type: 'string[]', description: '关键文件列表' },
      techStack: { type: 'string[]', description: '技术栈' },
    }
  },
  process: {
    fields: {
      apiEndpoints: { type: 'string[]', description: 'API 端点列表' },
      dataFlow: { type: 'string', description: '数据流向描述' },
      stakeholders: { type: 'string[]', description: '相关干系人' },
      frequency: { type: 'string', description: '执行频率' },
    }
  },
  feature: {
    fields: {
      acceptanceCriteria: { type: 'string[]', description: '验收标准' },
      linkedFiles: { type: 'string[]', description: '关联文件' },
      testCoverage: { type: 'number', description: '测试覆盖率' },
      priority: { type: 'string', description: '优先级' },
    }
  },
  bug: {
    fields: {
      severity: { type: 'string', required: true, description: '严重程度' },
      reproduction: { type: 'string', description: '复现步骤' },
      affectedUsers: { type: 'string[]', description: '受影响用户群' },
      fixDeadline: { type: 'string', description: '修复截止日期' },
    }
  }
}

export const NodeSchemaRegistry = {
  get(nodeType: NodeType | string): NodeTypeSchema | undefined {
    return SCHEMAS[nodeType]
  },
  listTypes(): string[] {
    return Object.keys(SCHEMAS)
  },
  getFieldNames(nodeType: NodeType | string): string[] {
    return Object.keys(SCHEMAS[nodeType]?.fields ?? {})
  }
}

export function validateNodeMetadata(nodeType: NodeType | string, metadata: Record<string, unknown>): ValidationResult {
  const schema = SCHEMAS[nodeType]
  const errors: string[] = []
  const warnings: string[] = []

  if (!schema) {
    return { valid: true, errors, warnings }
  }

  const knownFields = new Set(Object.keys(schema.fields))

  for (const [key, value] of Object.entries(metadata)) {
    if (!knownFields.has(key)) {
      warnings.push(`Unknown field '${key}' for node type '${nodeType}'`)
      continue
    }

    const fieldDef = schema.fields[key]
    if (fieldDef.required && (value === undefined || value === null || value === '')) {
      errors.push(`Required field '${key}' is missing for node type '${nodeType}'`)
    }

    if (fieldDef.type === 'string[]' && !Array.isArray(value)) {
      errors.push(`Field '${key}' should be an array, got ${typeof value}`)
    }
    if (fieldDef.type === 'string' && typeof value !== 'string') {
      errors.push(`Field '${key}' should be a string, got ${typeof value}`)
    }
    if (fieldDef.type === 'number' && typeof value !== 'number') {
      errors.push(`Field '${key}' should be a number, got ${typeof value}`)
    }
  }

  for (const [key, def] of Object.entries(schema.fields)) {
    if (def.required && !(key in metadata)) {
      errors.push(`Required field '${key}' is missing for node type '${nodeType}'`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
