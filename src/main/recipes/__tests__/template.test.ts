import { describe, it, expect } from 'vitest'
import { renderTemplate, findMissingRequired, slugifyRecipeId } from '../template'

describe('renderTemplate', () => {
  it('replaces {{ key }} placeholders with stringified values', () => {
    const tpl = 'Hello {{ name }}, your age is {{ age }}.'
    expect(renderTemplate(tpl, { name: 'Alice', age: 30 })).toBe('Hello Alice, your age is 30.')
  })

  it('replaces missing values with empty string', () => {
    const tpl = 'Before {{ a }} middle {{ missing }} after {{ b }}'
    expect(renderTemplate(tpl, { a: 'X', b: 'Y' })).toBe('Before X middle  after Y')
  })

  it('returns empty string when template is undefined', () => {
    expect(renderTemplate(undefined, { x: 1 })).toBe('')
  })

  it('renders missing keys as empty string (base design — required check happens upstream)', () => {
    // 设计选择：基座版缺失参数渲染为空串（不抛错）。
    // 必填校验在 runner.run 中由 findMissingRequired 提前拦截，缺失必填参数时 RecipeRun 直接 failed。
    const tpl = 'hello {{ unknown }} world'
    expect(renderTemplate(tpl, { other: 1 })).toBe('hello  world')
  })

  it('handles null/undefined values as empty string', () => {
    expect(renderTemplate('{{ a }}-{{ b }}', { a: null, b: undefined })).toBe('-')
  })

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('{{  name  }}', { name: 'x' })).toBe('x')
  })
})

describe('findMissingRequired', () => {
  it('returns keys missing from inputs', () => {
    const params = [
      { key: 'a', required: true },
      { key: 'b', required: true },
      { key: 'c', required: false },
    ]
    expect(findMissingRequired(params, { a: 1 })).toEqual(['b'])
  })

  it('returns empty when all required provided', () => {
    const params = [{ key: 'a', required: true }]
    expect(findMissingRequired(params, { a: 'x' })).toEqual([])
  })

  it('treats undefined as missing', () => {
    const params = [{ key: 'a', required: true }]
    expect(findMissingRequired(params, { a: undefined })).toEqual(['a'])
  })

  it('returns empty when parameters undefined', () => {
    expect(findMissingRequired(undefined, {})).toEqual([])
  })
})

describe('slugifyRecipeId', () => {
  it('converts title to kebab-case', () => {
    expect(slugifyRecipeId('Refactor React Component')).toBe('refactor-react-component')
  })

  it('strips leading/trailing dashes', () => {
    expect(slugifyRecipeId('  --foo--  ')).toBe('foo')
  })

  it('returns "recipe" for empty/symbol-only inputs', () => {
    expect(slugifyRecipeId('!!!')).toBe('recipe')
    expect(slugifyRecipeId('')).toBe('recipe')
  })

  it('collapses multiple non-alphanum into single dash', () => {
    expect(slugifyRecipeId('foo___bar   baz')).toBe('foo-bar-baz')
  })
})