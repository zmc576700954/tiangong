import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerDialogHandlers } from '../dialog'
import type { TypedHandle } from '../utils'

// Mock electron dialog
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
}))

import { dialog } from 'electron'

describe('registerDialogHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerDialogHandlers(typedHandle)
  })

  it('registers dialog:openDirectory handler', () => {
    expect(handlers['dialog:openDirectory']).toBeDefined()
  })

  it('returns selected directory path', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/selected/dir'],
    })

    const result = await handlers['dialog:openDirectory']({})
    expect(result).toBe('/selected/dir')
  })

  it('returns null when canceled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    })

    const result = await handlers['dialog:openDirectory']({})
    expect(result).toBeNull()
  })

  it('returns null when no files selected', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [],
    })

    const result = await handlers['dialog:openDirectory']({})
    expect(result).toBeNull()
  })
})
