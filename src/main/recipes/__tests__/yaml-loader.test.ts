/**
 * Tests for Recipe YAML Loader
 *
 * 覆盖：
 *  - parseRecipe 顶层校验（id/name/version/steps）
 *  - 步骤校验（agent / shell 两类 kind）
 *  - inputs schema 校验（type=enum 时 options 必填）
 *  - shell 命令黑名单
 *  - depends_on 引用校验
 *  - 模板替换 applyInputTemplate（required/default/fallback）
 */

import { describe, it, expect } from 'vitest'
import { parseRecipe, stringifyRecipe, applyInputTemplate } from '../yaml-loader'
import { BizGraphError, ErrorCode } from '../../errors'

describe('parseRecipe', () => {
  it('parses a minimal recipe', () => {
    const yaml = `
id: greet
name: Say hello
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: Greet the user
    prompt: Say hi
`
    const def = parseRecipe(yaml)
    expect(def.id).toBe('greet')
    expect(def.name).toBe('Say hello')
    expect(def.version).toBe('1')
    expect(def.steps).toHaveLength(1)
    expect(def.steps[0]!.kind).toBe('agent')
  })

  it('parses inputs schema with enum type', () => {
    const yaml = `
id: deploy
name: Deploy
version: "1"
inputs:
  - name: env
    type: enum
    options: [staging, prod]
  - name: tag
    type: string
    required: false
    default: latest
steps:
  - kind: shell
    command: ["echo", "deploy"]
`
    const def = parseRecipe(yaml)
    expect(def.inputs).toHaveLength(2)
    expect(def.inputs![0]!.type).toBe('enum')
    expect(def.inputs![0]!.options).toEqual(['staging', 'prod'])
    expect(def.inputs![1]!.default).toBe('latest')
  })

  it('parses shell step with cwd + timeout', () => {
    const yaml = `
id: build
name: Build
version: "1"
steps:
  - kind: shell
    command: ["npm", "run", "build"]
    cwd: src
    timeout_ms: 60000
`
    const def = parseRecipe(yaml)
    expect(def.steps[0]!.kind).toBe('shell')
    if (def.steps[0]!.kind === 'shell') {
      expect(def.steps[0]!.command).toEqual(['npm', 'run', 'build'])
      expect(def.steps[0]!.cwd).toBe('src')
      expect(def.steps[0]!.timeout_ms).toBe(60000)
    }
  })

  it('throws RECIPE_PARSE_ERROR on invalid YAML', () => {
    expect(() => parseRecipe('id: : : ')).toThrow(BizGraphError)
    try {
      parseRecipe('id: : : ')
    } catch (err) {
      expect((err as BizGraphError).code).toBe(ErrorCode.RECIPE_PARSE_ERROR)
    }
  })

  it('throws RECIPE_INVALID_STEP when id is missing', () => {
    const yaml = `
name: No id
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    expect(() => parseRecipe(yaml)).toThrow(BizGraphError)
    try {
      parseRecipe(yaml)
    } catch (err) {
      expect((err as BizGraphError).code).toBe(ErrorCode.RECIPE_INVALID_STEP)
    }
  })

  it('throws when id is not kebab-case', () => {
    const yaml = `
id: BadId
name: x
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    expect(() => parseRecipe(yaml)).toThrow(/kebab-case/)
  })

  it('throws when version is not "1"', () => {
    const yaml = `
id: foo
name: x
version: "2"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    expect(() => parseRecipe(yaml)).toThrow(/version/)
  })

  it('throws when steps is empty', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps: []
`
    expect(() => parseRecipe(yaml)).toThrow(/at least 1 step/)
  })

  it('throws when shell command is empty', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps:
  - kind: shell
    command: []
`
    expect(() => parseRecipe(yaml)).toThrow(/non-empty 'command'/)
  })

  it('throws on forbidden shell binary', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps:
  - kind: shell
    command: ["rm", "-rf", "/"]
`
    expect(() => parseRecipe(yaml)).toThrow(/forbidden binary/)
  })

  it('matches forbidden binary basename (handles full paths)', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps:
  - kind: shell
    command: ["/usr/bin/rm", "-rf", "/"]
`
    expect(() => parseRecipe(yaml)).toThrow(/forbidden binary/)
  })

  it('throws on duplicate step id', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps:
  - id: a
    kind: agent
    agent_type: explore
    description: x
    prompt: y
  - id: a
    kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    expect(() => parseRecipe(yaml)).toThrow(/Duplicate step id/)
  })

  it('throws on unknown depends_on reference', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps:
  - id: a
    kind: agent
    agent_type: explore
    description: x
    prompt: y
    depends_on: [b]
`
    expect(() => parseRecipe(yaml)).toThrow(/unknown step "b"/)
  })

  it('throws on unknown step kind', () => {
    const yaml = `
id: foo
name: x
version: "1"
steps:
  - kind: unknown
`
    expect(() => parseRecipe(yaml)).toThrow(/kind must be 'agent' or 'shell'/)
  })

  it('throws when enum type lacks options', () => {
    const yaml = `
id: foo
name: x
version: "1"
inputs:
  - name: env
    type: enum
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
`
    expect(() => parseRecipe(yaml)).toThrow(/requires 'options'/)
  })
})

describe('stringifyRecipe', () => {
  it('round-trips through parseRecipe', () => {
    const def = parseRecipe(`
id: greet
name: Say hello
version: "1"
description: Friendly greeting
tags: [hello, demo]
steps:
  - kind: agent
    agent_type: explore
    description: Greet
    prompt: Say hi
`)
    const yamlText = stringifyRecipe(def)
    const def2 = parseRecipe(yamlText)
    expect(def2.id).toBe(def.id)
    expect(def2.name).toBe(def.name)
    expect(def2.description).toBe('Friendly greeting')
    expect(def2.tags).toEqual(['hello', 'demo'])
    expect(def2.steps).toHaveLength(1)
  })
})

describe('applyInputTemplate', () => {
  it('substitutes ${input.x} placeholders', () => {
    const result = applyInputTemplate('Hello ${input.name}!', { name: 'BizGraph' })
    expect(result).toBe('Hello BizGraph!')
  })

  it('substitutes multiple placeholders', () => {
    const result = applyInputTemplate('${input.a} + ${input.b}', { a: 'x', b: 'y' })
    expect(result).toBe('x + y')
  })

  it('coerces non-string values to string', () => {
    const result = applyInputTemplate('count=${input.n}', { n: 42 as number })
    expect(result).toBe('count=42')
  })

  it('uses default when value missing and required=false', () => {
    const result = applyInputTemplate(
      'env=${input.env}',
      {},
      [{ name: 'env', type: 'string', default: 'dev', required: false }],
    )
    expect(result).toBe('env=dev')
  })

  it('throws when required input missing', () => {
    expect(() => applyInputTemplate('${input.x}', {}, undefined)).toThrow(
      /required but not provided/,
    )
  })

  it('returns empty string when non-required and no default', () => {
    const result = applyInputTemplate(
      'env=${input.env}',
      {},
      [{ name: 'env', type: 'string', required: false }],
    )
    expect(result).toBe('env=')
  })
})