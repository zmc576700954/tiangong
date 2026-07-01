import { describe, it, expect } from 'vitest'
import { buildFeaturePrompt, buildBugfixPrompt, buildRefactorPrompt, buildPrompt } from '../synthesis/prompt-templates'
import type { PromptContext } from '../synthesis/prompt-templates'

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    node: { id: 'n1', type: 'feature', title: 'Login Feature', description: 'User login' },
    ancestors: [{ title: 'Auth Module', description: 'Handles authentication' }],
    children: [{ title: 'Token Validation', description: 'Validate JWT' }],
    relatedEdges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'depends_on' }],
    relatedNodes: [{ title: 'User Service', description: 'User management' }],
    ...overrides,
  }
}

describe('buildFeaturePrompt', () => {
  it('includes business context section', () => {
    const prompt = buildFeaturePrompt(makeCtx())
    expect(prompt).toContain('# 业务上下文')
    expect(prompt).toContain('Auth Module')
  })

  it('includes feature node title', () => {
    const prompt = buildFeaturePrompt(makeCtx())
    expect(prompt).toContain('Login Feature')
  })

  it('includes children', () => {
    const prompt = buildFeaturePrompt(makeCtx())
    expect(prompt).toContain('Token Validation')
  })

  it('includes related nodes', () => {
    const prompt = buildFeaturePrompt(makeCtx())
    expect(prompt).toContain('User Service')
  })

  it('includes business rules when present', () => {
    const ctx = makeCtx({
      node: {
        id: 'n1', type: 'feature', title: 'Login', description: 'Login',
        content: {
          businessRules: [{ title: 'Rule 1', condition: 'user exists', action: 'allow login' }],
          acceptanceCriteria: [],
          relatedFiles: [],
          implementationNotes: [],
          codeSignatures: [],
        },
      },
    })
    const prompt = buildFeaturePrompt(ctx)
    expect(prompt).toContain('业务规则')
    expect(prompt).toContain('Rule 1')
  })

  it('includes acceptance criteria when present', () => {
    const ctx = makeCtx({
      node: {
        id: 'n1', type: 'feature', title: 'Login', description: 'Login',
        content: {
          businessRules: [],
          acceptanceCriteria: ['Must validate password'],
          relatedFiles: [],
          implementationNotes: [],
          codeSignatures: [],
        },
      },
    })
    const prompt = buildFeaturePrompt(ctx)
    expect(prompt).toContain('验收标准')
    expect(prompt).toContain('Must validate password')
  })

  it('includes related files as scope constraints', () => {
    const ctx = makeCtx({
      node: {
        id: 'n1', type: 'feature', title: 'Login', description: 'Login',
        content: {
          businessRules: [],
          acceptanceCriteria: [],
          relatedFiles: ['src/auth.ts'],
          implementationNotes: [],
          codeSignatures: [],
        },
      },
    })
    const prompt = buildFeaturePrompt(ctx)
    expect(prompt).toContain('范围约束')
    expect(prompt).toContain('src/auth.ts')
  })

  it('includes extra context when present', () => {
    const prompt = buildFeaturePrompt(makeCtx({ extraContext: 'Custom note' }))
    expect(prompt).toContain('Custom note')
  })
})

describe('buildBugfixPrompt', () => {
  it('includes bug description', () => {
    const prompt = buildBugfixPrompt(makeCtx(), 'App crashes on login')
    expect(prompt).toContain('App crashes on login')
  })

  it('includes problem section', () => {
    const prompt = buildBugfixPrompt(makeCtx())
    expect(prompt).toContain('问题所在')
  })

  it('includes task instruction', () => {
    const prompt = buildBugfixPrompt(makeCtx())
    expect(prompt).toContain('修复')
  })
})

describe('buildRefactorPrompt', () => {
  it('includes refactor goal', () => {
    const prompt = buildRefactorPrompt(makeCtx(), 'Improve code structure')
    expect(prompt).toContain('Improve code structure')
  })

  it('includes impact section when edges exist', () => {
    const prompt = buildRefactorPrompt(makeCtx())
    expect(prompt).toContain('影响范围')
  })

  it('includes task instruction', () => {
    const prompt = buildRefactorPrompt(makeCtx())
    expect(prompt).toContain('重构')
  })
})

describe('buildPrompt', () => {
  it('dispatches to feature prompt', () => {
    const prompt = buildPrompt('feature', makeCtx())
    expect(prompt).toContain('# 业务上下文')
  })

  it('dispatches to bugfix prompt', () => {
    const prompt = buildPrompt('bugfix', makeCtx(), { bugDescription: 'crash' })
    expect(prompt).toContain('问题所在')
  })

  it('dispatches to refactor prompt', () => {
    const prompt = buildPrompt('refactor', makeCtx(), { refactorGoal: 'clean up' })
    expect(prompt).toContain('重构')
  })
})
