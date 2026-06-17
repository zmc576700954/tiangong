import { describe, test, expect } from 'vitest'
import { NodeSchemaRegistry, validateNodeMetadata } from '../node-schema-registry'

describe('NodeSchemaRegistry', () => {
  test('returns schema for each node type', () => {
    const moduleSchema = NodeSchemaRegistry.get('module')
    expect(moduleSchema).toBeDefined()
    expect(moduleSchema!.fields).toHaveProperty('frameworks')
    expect(moduleSchema!.fields).toHaveProperty('entryPoints')

    const processSchema = NodeSchemaRegistry.get('process')
    expect(processSchema).toBeDefined()
    expect(processSchema!.fields).toHaveProperty('apiEndpoints')

    const featureSchema = NodeSchemaRegistry.get('feature')
    expect(featureSchema).toBeDefined()
    expect(featureSchema!.fields).toHaveProperty('acceptanceCriteria')

    const bugSchema = NodeSchemaRegistry.get('bug')
    expect(bugSchema).toBeDefined()
    expect(bugSchema!.fields).toHaveProperty('severity')
  })

  test('validateNodeMetadata passes for valid module metadata', () => {
    const result = validateNodeMetadata('module', {
      frameworks: ['React', 'Electron'],
      entryPoints: ['src/main/index.ts'],
      keyFiles: ['package.json'],
      techStack: ['TypeScript', 'LibSQL']
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('validateNodeMetadata reports unknown fields', () => {
    const result = validateNodeMetadata('module', {
      frameworks: ['React'],
      unknownField: 'should be flagged'
    })
    expect(result.valid).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  test('validateNodeMetadata returns valid for empty metadata', () => {
    const result = validateNodeMetadata('feature', {})
    expect(result.valid).toBe(true)
  })

  test('validateNodeMetadata returns valid for project type (no schema)', () => {
    const result = validateNodeMetadata('project', { anything: 'goes' })
    expect(result.valid).toBe(true)
  })
})
