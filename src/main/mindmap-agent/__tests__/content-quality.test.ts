import { describe, it, expect } from 'vitest'
import { evaluateContentQuality } from '../gates/content-quality'

describe('evaluateContentQuality', () => {
  it('passes relevant content with code', () => {
    const result = evaluateContentQuality('login authentication', [
      {
        title: 'Auth Module',
        content: 'function authenticate() { return true } src/auth.ts import jwt',
      },
    ])
    expect(result.isRelevant).toBe(true)
    expect(result.isSupportive).toBe(true)
    expect(result.filteredContent.length).toBe(1)
  })

  it('rejects noise content', () => {
    const result = evaluateContentQuality('login', [
      {
        title: 'npm scripts',
        content: 'npm run build and node_modules eslint config setup',
      },
    ])
    expect(result.rejectedItems.length).toBe(1)
    expect(result.rejectedItems[0].reason).toBe('噪音内容')
  })

  it('rejects irrelevant content', () => {
    const result = evaluateContentQuality('authentication login', [
      {
        title: 'Database Schema',
        content: 'CREATE TABLE users (id INT, name VARCHAR(255)) with no relevance',
      },
    ])
    expect(result.rejectedItems.length).toBe(1)
  })

  it('handles empty retrieved items', () => {
    const result = evaluateContentQuality('query', [])
    expect(result.filteredContent).toEqual([])
    expect(result.rejectedItems).toEqual([])
    expect(result.overallScore).toBe(0)
  })

  it('filters multiple items correctly', () => {
    const result = evaluateContentQuality('user authentication', [
      {
        title: 'Auth',
        content: 'function authenticate() { return validateToken() } src/auth.ts',
      },
      {
        title: 'Noise',
        content: 'npm run test node_modules eslint config',
      },
      {
        title: 'Relevant',
        content: 'interface User { authenticate(): Promise<boolean> } from auth module',
      },
    ])
    expect(result.filteredContent.length).toBeGreaterThanOrEqual(1)
    expect(result.rejectedItems.length).toBeGreaterThanOrEqual(1)
  })

  it('scores higher for content with code and paths', () => {
    const result = evaluateContentQuality('auth', [
      {
        title: 'Auth',
        content: 'function login() { return true } src/auth.ts GET /api/login',
      },
    ])
    expect(result.isSupportive).toBe(true)
    expect(result.overallScore).toBeGreaterThan(0.3)
  })
})
