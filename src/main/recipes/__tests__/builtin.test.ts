/**
 * Tests for the built-in recipe loader.
 *
 * 覆盖：
 *  - 打包资源目录里的内置 YAML 全部能按当前 schema 解析（防 schema 漂移）
 *  - 内置 Recipe 统一带 `builtin-` 前缀，source 为 'builtin'
 *  - 内置 Recipe 可被用户级同名 id 覆盖（优先级在 recipe-manager.test.ts 覆盖）
 */

import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { getBuiltinRecipeDir, loadBuiltInRecipes } from '../builtin'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/bizgraph-test'),
  },
}))

describe('builtin recipes', () => {
  it('resolves the dev-mode resource directory', () => {
    const dir = getBuiltinRecipeDir().replace(/\\/g, '/')
    expect(dir).toContain('/src/main/resources/recipes')
  })

  it('ships at least one built-in recipe', async () => {
    const recipes = await loadBuiltInRecipes()
    expect(recipes.length).toBeGreaterThan(0)
  })

  it('every shipped recipe parses against the current schema', async () => {
    const recipes = await loadBuiltInRecipes()
    for (const { def, yamlText } of recipes) {
      expect(def.id, `${def.id} must have an id`).toBeTruthy()
      expect(def.version).toBe('1')
      expect(def.steps?.length ?? 0, `${def.id} must have at least one step`).toBeGreaterThan(0)
      expect(yamlText).toContain(def.id)
    }
  })

  it('built-in ids are namespaced with the builtin- prefix', async () => {
    const recipes = await loadBuiltInRecipes()
    for (const { def } of recipes) {
      expect(def.id.startsWith('builtin-'), `${def.id} must be prefixed with builtin-`).toBe(true)
    }
  })

  it('built-in recipes are tagged with source=builtin', async () => {
    const recipes = await loadBuiltInRecipes()
    for (const { def } of recipes) {
      expect(def.source).toBe('builtin')
      expect(def.sourcePath).toContain('resources')
    }
  })

  it('declared input names are usable in prompt templates', async () => {
    // 输入名必须是 kebab-case（validateInputSpec 强制），模板正则也要接受 '-'
    const recipes = await loadBuiltInRecipes()
    for (const { def } of recipes) {
      for (const input of def.inputs ?? []) {
        expect(input.name).toMatch(/^[a-z][a-z0-9_-]*$/)
      }
    }
  })

  it('resource directory holds the packaged yaml files', async () => {
    const dir = getBuiltinRecipeDir()
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    expect(yamlFiles.length).toBeGreaterThan(0)
    expect(path.isAbsolute(dir)).toBe(true)
  })
})
