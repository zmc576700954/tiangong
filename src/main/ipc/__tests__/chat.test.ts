import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerChatHandlers } from '../chat'
import type { ChatService } from '../../services/chat-service'
import type { TypedHandle } from '../utils'

function makeMockChatService(): ChatService {
  return {
    listThreads: vi.fn().mockResolvedValue([]),
    getThreadWithMessages: vi.fn().mockResolvedValue(null),
    createThread: vi.fn().mockResolvedValue({ id: 't1' }),
    updateThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    searchThreads: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(undefined),
    archiveStaleThreads: vi.fn().mockResolvedValue(0),
    cleanupArchivedThreads: vi.fn().mockResolvedValue(0),
  } as unknown as ChatService
}

describe('registerChatHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>
  let chatService: ChatService

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    chatService = makeMockChatService()
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerChatHandlers(chatService, typedHandle)
  })

  it('registers thread:list handler', () => {
    expect(handlers['thread:list']).toBeDefined()
  })

  it('thread:list calls listThreads', async () => {
    await handlers['thread:list']({}, null)
    expect(chatService.listThreads).toHaveBeenCalled()
  })

  it('thread:load calls getThreadWithMessages', async () => {
    await handlers['thread:load']({}, 'thread-1')
    expect(chatService.getThreadWithMessages).toHaveBeenCalledWith('thread-1')
  })

  it('thread:create calls createThread', async () => {
    const data = { title: 'Test Thread' }
    await handlers['thread:create']({}, data)
    expect(chatService.createThread).toHaveBeenCalledWith(data)
  })

  it('thread:update calls updateThread', async () => {
    await handlers['thread:update']({}, 'thread-1', { title: 'Updated' })
    expect(chatService.updateThread).toHaveBeenCalledWith('thread-1', { title: 'Updated' })
  })

  it('thread:delete calls deleteThread', async () => {
    await handlers['thread:delete']({}, 'thread-1')
    expect(chatService.deleteThread).toHaveBeenCalledWith('thread-1')
  })

  it('thread:search calls searchThreads', async () => {
    await handlers['thread:search']({}, 'query')
    expect(chatService.searchThreads).toHaveBeenCalledWith('query')
  })

  it('message:list calls listMessages', async () => {
    await handlers['message:list']({}, 'thread-1', 10, 0)
    expect(chatService.listMessages).toHaveBeenCalledWith('thread-1', 10, 0)
  })

  it('message:save calls saveMessage', async () => {
    const msg = { role: 'user', content: 'hello' }
    await handlers['message:save']({}, 'thread-1', msg)
    expect(chatService.saveMessage).toHaveBeenCalledWith('thread-1', msg)
  })

  it('chat:archiveStale calls archiveStaleThreads', async () => {
    await handlers['chat:archiveStale']({}, 'proj-1', 30)
    expect(chatService.archiveStaleThreads).toHaveBeenCalledWith('proj-1', 30)
  })

  it('chat:cleanupArchived calls cleanupArchivedThreads', async () => {
    await handlers['chat:cleanupArchived']({})
    expect(chatService.cleanupArchivedThreads).toHaveBeenCalledWith(90)
  })
})
