import { describe, it, expect } from 'vitest'
import { parseRecipeYaml } from '../yaml-loader'
import { BizGraphError, ErrorCode } from '../../errors'

describe('parseRecipeYaml', () => {
  it('parses valid recipe with instructions only', () => {
    const yaml = `
version: "1.0.0"
title: "重构 React 组件"
description: "不改变行为前提下重构组件"
instructions: |
  你是一位资深 React 工程师。
  不得修改 props 接口。
`
    const result = parseRecipeYaml('/fake/path/refactor.yaml', yaml)
    expect(result.version).toBe('1.0.0')
    expect(result.title).toBe('重构 React 组件')
    expect(result.description).toContain('不改变行为')
    expect(result.instructions).toContain('React 工程师')
    expect(result.prompt).toBeUndefined()
  })

  it('parses valid recipe with prompt only', () => {
    const yaml = `
version: "1.0.0"
title: "添加测试"
description: "为指定文件添加单元测试"
prompt: "请为 {{ filePath }} 添加测试"
parameters:
  - key: filePath
    inputType: string
    required: true
`
    const result = parseRecipeYaml('/fake/add-tests.yaml', yaml)
    expect(result.prompt).toBe('请为 {{ filePath }} 添加测试')
    expect(result.parameters).toHaveLength(1)
    expect(result.parameters![0].key).toBe('filePath')
    expect(result.parameters![0].required).toBe(true)
  })

  it('parses recipe with full parameters', () => {
    const yaml = `
version: "1.0.0"
title: "升级依赖"
description: "升级指定 package 到最新稳定版"
instructions: "升级 {{ packageName }}"
parameters:
  - key: packageName
    inputType: string
    required: true
    description: "要升级的包名"
  - key: useLatest
    inputType: boolean
    required: false
    default: true
defaultAdapter: "claude-code"
scopeStrategy: "subset"
allowedTools: ["Read", "Edit", "Bash"]
`
    const result = parseRecipeYaml('/fake/upgrade.yaml', yaml)
    expect(result.parameters).toHaveLength(2)
    expect(result.parameters![1].default).toBe(true)
    expect(result.defaultAdapter).toBe('claude-code')
    expect(result.scopeStrategy).toBe('subset')
    expect(result.allowedTools).toEqual(['Read', 'Edit', 'Bash'])
  })

  it('throws when version is missing', () => {
    const yaml = `
title: "no version"
description: "missing version"
prompt: "test"
`
    expect(() => parseRecipeYaml('/fake.yaml', yaml)).toThrow(BizGraphError)
    try {
      parseRecipeYaml('/fake.yaml', yaml)
    } catch (err) {
      expect(err).toBeInstanceOf(BizGraphError)
      expect((err as BizGraphError).code).toBe(ErrorCode.RECIPE_PARSE_ERROR)
    }
  })

  it('throws when title is empty', () => {
    const yaml = `
version: "1.0.0"
title: ""
description: "empty title"
prompt: "test"
`
    expect(() => parseRecipeYaml('/fake.yaml', yaml)).toThrow(/title is required/)
  })

  it('throws when version format is invalid', () => {
    const yaml = `
version: "1.0"
title: "bad version"
description: "x"
prompt: "y"
`
    expect(() => parseRecipeYaml('/fake.yaml', yaml)).toThrow(/version must be in format/)
  })

  it('throws when both instructions and prompt are missing', () => {
    const yaml = `
version: "1.0.0"
title: "no body"
description: "missing both"
`
    expect(() => parseRecipeYaml('/fake.yaml', yaml)).toThrow(
      /must have at least one of instructions or prompt/,
    )
  })

  it('throws when parameter key is empty', () => {
    const yaml = `
version: "1.0.0"
title: "bad param"
description: "x"
prompt: "y"
parameters:
  - key: ""
    inputType: string
    required: false
`
    expect(() => parseRecipeYaml('/fake.yaml', yaml)).toThrow(/path parameters.0.key|String must contain at least 1/)
  })

  it('throws when scopeStrategy is invalid', () => {
    const yaml = `
version: "1.0.0"
title: "bad scope"
description: "x"
prompt: "y"
scopeStrategy: "random"
`
    expect(() => parseRecipeYaml('/fake.yaml', yaml)).toThrow(/Invalid option/)
  })

  it('error message includes file path', () => {
    const yaml = `
title: "missing version"
description: "x"
prompt: "y"
`
    try {
      parseRecipeYaml('/specific/path/recipe.yaml', yaml)
    } catch (err) {
      expect((err as Error).message).toContain('/specific/path/recipe.yaml')
    }
  })
})