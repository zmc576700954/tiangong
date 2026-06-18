/**
 * Chat IPC Handlers
 * 线程和消息的 CRUD 操作
 */

import type { ChatService } from '../services/chat-service'
import type { TypedHandle } from './utils'

export function registerChatHandlers(chatService: ChatService, typedHandle: TypedHandle): void {
  typedHandle('thread:list', async (_, filters) => {
    return chatService.listThreads(filters ?? undefined)
  })

  typedHandle('thread:load', async (_, threadId) => {
    return chatService.getThreadWithMessages(threadId)
  })

  typedHandle('thread:create', async (_, data) => {
    return chatService.createThread(data)
  })

  typedHandle('thread:update', async (_, threadId, data) => {
    return chatService.updateThread(threadId, data)
  })

  typedHandle('thread:delete', async (_, threadId) => {
    return chatService.deleteThread(threadId)
  })

  typedHandle('thread:search', async (_, query) => {
    return chatService.searchThreads(query)
  })

  typedHandle('message:list', async (_, threadId, limit, offset) => {
    return chatService.listMessages(threadId, limit, offset)
  })

  typedHandle('message:save', async (_, threadId, message) => {
    return chatService.saveMessage(threadId, message)
  })

  typedHandle('message:saveBatch', async (_, threadId, messages) => {
    return chatService.saveMessages(threadId, messages)
  })

  typedHandle('chat:archiveStale', async (_, projectId, staleDays) => {
    return chatService.archiveStaleThreads(projectId, staleDays)
  })

  // Task 2.5.2: 90-day archived thread cleanup
  typedHandle('chat:cleanupArchived', async () => {
    return chatService.cleanupArchivedThreads(90)
  })
}
