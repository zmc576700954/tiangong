/**
 * Chat IPC Handlers
 * 线程和消息的 CRUD 操作
 */

import type { ChatService } from '../services/chat-service'
import type { TypedHandle } from './utils'
import { ensureString, ensureOptionalNumber } from './utils'

const MAX_QUERY_LEN = 2000

export function registerChatHandlers(chatService: ChatService, typedHandle: TypedHandle): void {
  typedHandle('thread:list', async (_, filters) => {
    return chatService.listThreads(filters ?? undefined)
  })

  typedHandle('thread:load', async (_, threadId) => {
    return chatService.getThreadWithMessages(ensureString('threadId', threadId))
  })

  typedHandle('thread:create', async (_, data) => {
    return chatService.createThread(data)
  })

  typedHandle('thread:update', async (_, threadId, data) => {
    return chatService.updateThread(ensureString('threadId', threadId), data)
  })

  typedHandle('thread:delete', async (_, threadId) => {
    return chatService.deleteThread(ensureString('threadId', threadId))
  })

  typedHandle('thread:search', async (_, query) => {
    return chatService.searchThreads(ensureString('query', query, MAX_QUERY_LEN))
  })

  typedHandle('message:list', async (_, threadId, limit, offset) => {
    return chatService.listMessages(ensureString('threadId', threadId), ensureOptionalNumber('limit', limit), ensureOptionalNumber('offset', offset))
  })

  typedHandle('message:save', async (_, threadId, message) => {
    return chatService.saveMessage(ensureString('threadId', threadId), message)
  })

  typedHandle('message:saveBatch', async (_, threadId, messages) => {
    return chatService.saveMessages(ensureString('threadId', threadId), messages)
  })

  typedHandle('chat:archiveStale', async (_, projectId, staleDays) => {
    return chatService.archiveStaleThreads(ensureString('projectId', projectId), ensureOptionalNumber('staleDays', staleDays))
  })

  // Task 2.5.2: 90-day archived thread cleanup
  typedHandle('chat:cleanupArchived', async () => {
    return chatService.cleanupArchivedThreads(90)
  })
}
