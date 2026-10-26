import { describe, it, expect } from 'vitest'
import { DEFAULT_THREAD_TITLE } from '@shared/constants'

describe('default thread title', () => {
  it('is the sentinel used by the auto-rename heuristic', () => {
    expect(DEFAULT_THREAD_TITLE).toBe('New Thread')
  })
})
