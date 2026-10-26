/**
 * Tests for D5a Recipe DAG schema
 *
 * 覆盖：
 *  - 合法 2-step DAG（sub_recipes + steps 共存）
 *  - 仅有 sub_recipes（无 steps）
 *  - sub_recipe name 唯一性
 *  - sub_recipe name 必须 kebab-case
 *  - sub_recipe recipe 必须非空
 *  - sub_recipe inputs 必须是 string|number|boolean
 *  - 引用不存在的 sub_recipe → validateRecipeGraph 抛错
 *  - 循环引用 → validateRecipeGraph 抛错
 *  - topoSortSubRecipes 保持顺序
 *  - applyTemplate ${outputs.x.y} 替换
 *  - applyTemplate 缺 outputs 抛错
 */

import { describe, it, expect } from 'vitest'
import {
  parseRecipe,
  validateRecipeGraph,
  topoSortSubRecipes,
  applyTemplate,
} from '../yaml-loader'
import { ErrorCode } from '../../errors'
import type { BizGraphError } from '../../errors'
import type { RecipeDefinition } from '@shared/types/recipe'

describe('D5a DAG schema — sub_recipes parsing', () => {
  it('parses a 2-step DAG with sub_recipes', () => {
    const yaml = `
id: parent
name: Parent
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: Top step
    prompt: hi
sub_recipes:
  - name: first-child
    recipe: child-a
  - name: second-child
    recipe: child-b
    inputs:
      message: "hello"
`
    const def = parseRecipe(yaml)
    expect(def.sub_recipes).toBeDefined()
    expect(def.sub_recipes!).toHaveLength(2)
    expect(def.sub_recipes![0]!.name).toBe('first-child')
    expect(def.sub_recipes![0]!.recipe).toBe('child-a')
    expect(def.sub_recipes![1]!.inputs).toEqual({ message: 'hello' })
  })

  it('accepts a Recipe with sub_recipes only (no steps)', () => {
    const yaml = `
id: dag-only
name: DAG Only
version: "1"
sub_recipes:
  - name: only-child
    recipe: something
`
    const def = parseRecipe(yaml)
    expect(def.sub_recipes).toBeDefined()
    expect(def.sub_recipes![0]!.name).toBe('only-child')
  })

  it('rejects duplicate sub_recipe names', () => {
    const yaml = `
id: dup
name: Dup
version: "1"
sub_recipes:
  - name: same
    recipe: a
  - name: same
    recipe: b
`
    expect(() => parseRecipe(yaml)).toThrow(/Duplicate sub_recipe name/)
  })

  it('rejects non-kebab-case sub_recipe name', () => {
    const yaml = `
id: bad-name
name: Bad Name
version: "1"
sub_recipes:
  - name: BadName
    recipe: a
`
    expect(() => parseRecipe(yaml)).toThrow(/kebab-case/)
  })

  it('rejects sub_recipe with empty recipe reference', () => {
    const yaml = `
id: no-ref
name: No Ref
version: "1"
sub_recipes:
  - name: lonely
    recipe: ""
`
    expect(() => parseRecipe(yaml)).toThrow(/non-empty 'recipe'/)
  })

  it('rejects sub_recipe inputs that contain non-scalar values', () => {
    const yaml = `
id: bad-inputs
name: Bad Inputs
version: "1"
sub_recipes:
  - name: bad
    recipe: a
    inputs:
      arr: [1, 2, 3]
`
    expect(() => parseRecipe(yaml)).toThrow(/must be string\|number\|boolean/)
  })

  it('rejects Recipe with neither steps nor sub_recipes', () => {
    const yaml = `
id: empty
name: Empty
version: "1"
`
    expect(() => parseRecipe(yaml)).toThrow(/at least 1 step or 1 sub_recipe/)
  })

  it('parses response.success_condition / failure_condition', () => {
    const yaml = `
id: with-resp
name: With Resp
version: "1"
steps:
  - kind: agent
    agent_type: explore
    description: x
    prompt: y
response:
  success_condition: "output mentions success"
  failure_condition: "output mentions failure"
`
    const def = parseRecipe(yaml)
    expect(def.response).toBeDefined()
    expect(def.response!.success_condition).toBe('output mentions success')
    expect(def.response!.failure_condition).toBe('output mentions failure')
  })
})

describe('D5a DAG schema — validateRecipeGraph', () => {
  function makeDef(
    id: string,
    subRefs: Array<{ name: string; recipe: string }>,
  ): RecipeDefinition {
    return {
      id,
      name: id,
      version: '1',
      steps: [
        {
          kind: 'agent',
          agent_type: 'explore',
          description: 'noop',
          prompt: 'noop',
        },
      ],
      sub_recipes: subRefs.map((r) => ({ name: r.name, recipe: r.recipe })),
    }
  }

  it('accepts a DAG with all references resolvable', () => {
    const all = new Map<string, RecipeDefinition>()
    all.set('parent', makeDef('parent', [{ name: 'c', recipe: 'child' }]))
    all.set('child', makeDef('child', []))
    expect(() => validateRecipeGraph(all.get('parent')!, all)).not.toThrow()
  })

  it('rejects sub_recipe referencing unknown recipe id', () => {
    const all = new Map<string, RecipeDefinition>()
    all.set('parent', makeDef('parent', [{ name: 'c', recipe: 'ghost' }]))
    expect(() => validateRecipeGraph(all.get('parent')!, all)).toThrow(
      /references unknown recipe "ghost"/,
    )
  })

  it('rejects cycle A → B → A', () => {
    const all = new Map<string, RecipeDefinition>()
    all.set('a', makeDef('a', [{ name: 'to-b', recipe: 'b' }]))
    all.set('b', makeDef('b', [{ name: 'to-a', recipe: 'a' }]))
    expect(() => validateRecipeGraph(all.get('a')!, all)).toThrow(/cycle/i)
  })

  it('rejects cycle A → B → C → A', () => {
    const all = new Map<string, RecipeDefinition>()
    all.set('a', makeDef('a', [{ name: 'to-b', recipe: 'b' }]))
    all.set('b', makeDef('b', [{ name: 'to-c', recipe: 'c' }]))
    all.set('c', makeDef('c', [{ name: 'to-a', recipe: 'a' }]))
    expect(() => validateRecipeGraph(all.get('a')!, all)).toThrow(/cycle/i)
  })

  it('accepts DAG-shaped graph (no cycles)', () => {
    // a -> b -> c
    // d -> b
    const all = new Map<string, RecipeDefinition>()
    all.set('a', makeDef('a', [{ name: 'to-b', recipe: 'b' }]))
    all.set('b', makeDef('b', [{ name: 'to-c', recipe: 'c' }]))
    all.set('c', makeDef('c', []))
    all.set('d', makeDef('d', [{ name: 'to-b', recipe: 'b' }]))
    expect(() => validateRecipeGraph(all.get('a')!, all)).not.toThrow()
    expect(() => validateRecipeGraph(all.get('d')!, all)).not.toThrow()
  })

  it('rejects when one branch contains a cycle (parent → bad)', () => {
    const all = new Map<string, RecipeDefinition>()
    all.set('parent', makeDef('parent', [{ name: 'b1', recipe: 'a' }, { name: 'b2', recipe: 'b' }]))
    all.set('a', makeDef('a', [{ name: 'to-b', recipe: 'b' }]))
    all.set('b', makeDef('b', [{ name: 'to-a', recipe: 'a' }]))
    expect(() => validateRecipeGraph(all.get('parent')!, all)).toThrow(/cycle/i)
  })

  it('error code is RECIPE_INVALID_STEP', () => {
    const all = new Map<string, RecipeDefinition>()
    all.set('parent', makeDef('parent', [{ name: 'c', recipe: 'ghost' }]))
    try {
      validateRecipeGraph(all.get('parent')!, all)
    } catch (err) {
      expect((err as BizGraphError).code).toBe(ErrorCode.RECIPE_INVALID_STEP)
    }
  })
})

describe('D5a DAG schema — topoSortSubRecipes', () => {
  it('preserves array order (base implementation)', () => {
    const subs = [
      { name: 'a', recipe: 'r-a' },
      { name: 'b', recipe: 'r-b' },
      { name: 'c', recipe: 'r-c' },
    ]
    const sorted = topoSortSubRecipes(subs)
    expect(sorted.map((s) => s.name)).toEqual(['a', 'b', 'c'])
  })

  it('rejects duplicate name (defensive)', () => {
    const subs = [
      { name: 'a', recipe: 'r-a' },
      { name: 'a', recipe: 'r-b' },
    ]
    expect(() => topoSortSubRecipes(subs)).toThrow(/Duplicate sub_recipe name/)
  })
})

describe('D5a DAG schema — applyTemplate with outputs', () => {
  it('substitutes ${outputs.x.y} placeholders', () => {
    const result = applyTemplate(
      'Result: ${outputs.first.summary}',
      {},
      { first: { summary: 'done' } },
    )
    expect(result).toBe('Result: done')
  })

  it('substitutes nested outputs path', () => {
    const result = applyTemplate(
      '${outputs.scrape.title} - ${outputs.scrape.count}',
      {},
      { scrape: { title: 'Hello', count: 3 } },
    )
    expect(result).toBe('Hello - 3')
  })

  it('substitutes both ${input.x} and ${outputs.x.y}', () => {
    const result = applyTemplate(
      '${input.greeting} ${outputs.step1.summary}',
      { greeting: 'Hi' },
      { step1: { summary: 'ok' } },
    )
    expect(result).toBe('Hi ok')
  })

  it('throws when referenced output is missing', () => {
    expect(() =>
      applyTemplate('${outputs.ghost.x}', {}, {}),
    ).toThrow(/Recipe output "ghost" is not available/)
  })

  it('throws when output path resolves to undefined', () => {
    expect(() =>
      applyTemplate('${outputs.first.missing}', {}, { first: { summary: 'ok' } }),
    ).toThrow(/resolved to undefined/)
  })

  it('JSON-serializes complex object outputs', () => {
    const result = applyTemplate(
      'data=${outputs.scan}',
      {},
      { scan: { rows: 3, ok: true } },
    )
    expect(result).toBe('data={"rows":3,"ok":true}')
  })
})