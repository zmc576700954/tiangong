import { describe, it, expect } from 'vitest'
import { validateNpmPackageName } from '../npm-package'

describe('validateNpmPackageName', () => {
  it('accepts plain and scoped package names', () => {
    expect(validateNpmPackageName('cline')).toBe(true)
    expect(validateNpmPackageName('opencode-ai')).toBe(true)
    expect(validateNpmPackageName('@anthropic-ai/claude-code')).toBe(true)
    expect(validateNpmPackageName('@kilocode/cli')).toBe(true)
  })

  it('rejects version suffixes — pkg@latest is not a valid package argument', () => {
    expect(validateNpmPackageName('opencode-ai@latest')).toBe(false)
    expect(validateNpmPackageName('@qwen-code/qwen-code@latest')).toBe(false)
  })

  it('rejects shell metacharacters and path separators', () => {
    expect(validateNpmPackageName('evil; rm -rf /')).toBe(false)
    expect(validateNpmPackageName('evil pkg')).toBe(false)
    expect(validateNpmPackageName('../evil')).toBe(false)
    expect(validateNpmPackageName('evil/../pkg')).toBe(false)
    expect(validateNpmPackageName('')).toBe(false)
  })
})
