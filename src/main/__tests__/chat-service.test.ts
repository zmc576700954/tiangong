/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatService } from '../services/chat-service'
import type { ChatRepository, ChatThreadRow, ChatMessageRow } from '../repositories/chat-repository'
import type { ChatMessage } from '@shared/types'

// Mock ChatRepository — 保留 vi.fn() 的 Mock 类型，避免 as unknown as 丢失 mockResolvedValue
type MockChatRepository = { [K in keyof ChatRepository]: ReturnType<typeof vi.fn> }
const mockRepo: MockChatRepository = {
  createThread: vi.fn(),
  getThread: vi.fn(),
  listThreads: vi.fn(),
  updateThread: vi.fn(),
  deleteThread: vi.fn(),
  searchThreads: vi.fn(),
  saveMessage: vi.fn(),
  saveMessages: vi.fn(),
  listMessages: vi.fn(),
  deleteMessagesByThread: vi.fn(),
  archiveStaleThreads: vi.fn(),
  cleanupArchivedThreads: vi.fn(),
  setContextWindowMax: vi.fn(),
  setLastCompactedAt: vi.fn(),
  resetContextTokens: vi.fn(),
}

// Mock generateId to return predictable IDs
vi.mock('../shared/env', () => ({
  generateId: vi.fn().mockReturnValue('thread-123'),
}))

// Mock Date.now for predictable timestamps
const MOCK_NOW = 1_700_000_000_000
vi.spyOn(Date, 'now').mockReturnValue(MOCK_NOW)

describe('ChatService', () => {
  let service: ChatService

  beforeEach(() => {
    vi.clearAllMocks()
    // ChatService 构造函数创建 repo，我们通过 prototype 替换它
    service = new ChatService({} as any)
    service['repo'] = mockRepo as unknown as ChatRepository
  })

  // ==================== Thread Operations ====================

  describe('createThread', () => {
    it('should create a thread with defaults', async () => {
      mockRepo.createThread.mockResolvedValue({
        id: 'thread-123',
        title: 'New Thread',
        adapter_name: 'claude',
        node_id: null,
        graph_id: null,
        session_id: null,
        status: 'active',
        created_at: MOCK_NOW,
        updated_at: MOCK_NOW,
        parent_thread_id: null,
        context_tokens_used: 0,
        context_window_max: 200000,
        last_compacted_at: null,
      })

      const result = await service.createThread({ adapterName: 'claude' })

      expect(mockRepo.createThread).toHaveBeenCalledWith({
        id: 'thread-123',
        title: 'New Thread',
        adapterName: 'claude',
        nodeId: undefined,
        graphId: undefined,
      })
      expect(result.id).toBe('thread-123')
      expect(result.title).toBe('New Thread')
      expect(result.adapterName).toBe('claude')
      expect(result.status).toBe('idle')
      expect(result.messages).toEqual([])
      expect(result.createdAt).toBe(MOCK_NOW)
    })

    it('should create a thread with node and graph binding', async () => {
      mockRepo.createThread.mockResolvedValue({
        id: 'thread-123',
        title: 'New Thread',
        adapter_name: 'claude',
        node_id: 'node-456',
        graph_id: 'graph-789',
        session_id: null,
        status: 'active',
        created_at: MOCK_NOW,
        updated_at: MOCK_NOW,
        parent_thread_id: null,
        context_tokens_used: 0,
        context_window_max: 200000,
        last_compacted_at: null,
      })

      const result = await service.createThread({
        adapterName: 'claude',
        nodeId: 'node-456',
        graphId: 'graph-789',
      })

      expect(result.nodeBound).toBe('node-456')
      expect(mockRepo.createThread).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 'node-456', graphId: 'graph-789' }),
      )
    })
  })

  describe('getThread', () => {
    it('should return null when thread not found', async () => {
      mockRepo.getThread.mockResolvedValue(null)

      const result = await service.getThread('non-existent')

      expect(result).toBeNull()
    })

    it('should return mapped thread when found', async () => {
      const row: ChatThreadRow = {
        id: 'thread-123',
        title: 'Test Thread',
        adapter_name: 'codex',
        node_id: 'node-1',
        graph_id: null,
        session_id: 'session-1',
        status: 'active',
        created_at: MOCK_NOW,
        updated_at: MOCK_NOW,
        parent_thread_id: null,
        context_tokens_used: 0,
        context_window_max: 200000,
        last_compacted_at: null,
      }
      mockRepo.getThread.mockResolvedValue(row)

      const result = await service.getThread('thread-123')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('thread-123')
      expect(result!.title).toBe('Test Thread')
      expect(result!.adapterName).toBe('codex')
      expect(result!.sessionId).toBe('session-1')
    })
  })

  describe('getThreadWithMessages', () => {
    it('should return thread with messages', async () => {
      const threadRow: ChatThreadRow = {
        id: 'thread-123',
        title: 'Test',
        adapter_name: 'claude',
        node_id: null,
        graph_id: null,
        session_id: null,
        status: 'active',
        created_at: MOCK_NOW,
        updated_at: MOCK_NOW,
        parent_thread_id: null,
        context_tokens_used: 0,
        context_window_max: 200000,
        last_compacted_at: null,
      }
      const messageRows: ChatMessageRow[] = [
        {
          id: 'msg-1',
          thread_id: 'thread-123',
          role: 'user',
          content: 'Hello',
          adapter_name: 'claude',
          status: 'complete',
          error: null,
          session_id: null,
          context_refs: null,
          tool_calls: null,
          created_at: MOCK_NOW,
          token_count: 0,
        },
      ]
      mockRepo.getThread.mockResolvedValue(threadRow)
      mockRepo.listMessages.mockResolvedValue(messageRows)

      const result = await service.getThreadWithMessages('thread-123')

      expect(result).not.toBeNull()
      expect(result!.messages).toHaveLength(1)
      expect(result!.messages[0].content).toBe('Hello')
      expect(result!.messages[0].role).toBe('user')
    })

    it('should return null when thread not found', async () => {
      mockRepo.getThread.mockResolvedValue(null)

      const result = await service.getThreadWithMessages('non-existent')

      expect(result).toBeNull()
      expect(mockRepo.listMessages).not.toHaveBeenCalled()
    })
  })

  describe('listThreads', () => {
    it('should list and map threads with active status filter', async () => {
      const rows: ChatThreadRow[] = [
        {
          id: 'thread-1',
          title: 'Thread 1',
          adapter_name: 'claude',
          node_id: null,
          graph_id: null,
          session_id: null,
          status: 'active',
          created_at: MOCK_NOW,
          updated_at: MOCK_NOW,
          parent_thread_id: null,
          context_tokens_used: 0,
          context_window_max: 200000,
          last_compacted_at: null,
        },
      ]
      mockRepo.listThreads.mockResolvedValue(rows)

      const result = await service.listThreads()

      expect(mockRepo.listThreads).toHaveBeenCalledWith({ status: 'active' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('thread-1')
    })

    it('should pass nodeId and graphId filters', async () => {
      mockRepo.listThreads.mockResolvedValue([])

      await service.listThreads({ nodeId: 'node-1', graphId: 'graph-1' })

      expect(mockRepo.listThreads).toHaveBeenCalledWith({
        nodeId: 'node-1',
        graphId: 'graph-1',
        status: 'active',
      })
    })
  })

  describe('updateThread', () => {
    it('should update thread with timestamp', async () => {
      mockRepo.updateThread.mockResolvedValue(undefined)

      await service.updateThread('thread-123', { title: 'Updated', status: 'archived' })

      expect(mockRepo.updateThread).toHaveBeenCalledWith('thread-123', {
        title: 'Updated',
        status: 'archived',
        updatedAt: MOCK_NOW,
      })
    })
  })

  describe('deleteThread', () => {
    it('should delete thread by id', async () => {
      mockRepo.deleteThread.mockResolvedValue(undefined)

      await service.deleteThread('thread-123')

      expect(mockRepo.deleteThread).toHaveBeenCalledWith('thread-123')
    })
  })

  describe('searchThreads', () => {
    it('should search and map results', async () => {
      const rows: ChatThreadRow[] = [
        {
          id: 'thread-1',
          title: 'Search Result',
          adapter_name: 'claude',
          node_id: null,
          graph_id: null,
          session_id: null,
          status: 'active',
          created_at: MOCK_NOW,
          updated_at: MOCK_NOW,
          parent_thread_id: null,
          context_tokens_used: 0,
          context_window_max: 200000,
          last_compacted_at: null,
        },
      ]
      mockRepo.searchThreads.mockResolvedValue(rows)

      const result = await service.searchThreads('test query')

      expect(mockRepo.searchThreads).toHaveBeenCalledWith('test query')
      expect(result).toHaveLength(1)
      expect(result[0].title).toBe('Search Result')
    })
  })

  // ==================== Message Operations ====================

  describe('saveMessage', () => {
    it('should save a message and update thread timestamp', async () => {
      mockRepo.saveMessage.mockResolvedValue(undefined)
      mockRepo.updateThread.mockResolvedValue(undefined)

      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: MOCK_NOW,
        status: 'success',
      }

      await service.saveMessage('thread-123', message)

      expect(mockRepo.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-1',
          threadId: 'thread-123',
          role: 'user',
          content: 'Hello',
          status: 'success',
        }),
      )
      expect(mockRepo.updateThread).toHaveBeenCalledWith('thread-123', { updatedAt: MOCK_NOW })
    })

    it('should serialize error and contextRefs', async () => {
      mockRepo.saveMessage.mockResolvedValue(undefined)
      mockRepo.updateThread.mockResolvedValue(undefined)

      const message: ChatMessage = {
        id: 'msg-1',
        role: 'agent',
        content: 'Error occurred',
        timestamp: MOCK_NOW,
        status: 'error',
        error: { code: 'ERR_1', message: 'Something failed' },
        contextRefs: [{ type: 'node', id: 'node-1', label: 'Auth' }],
      }

      await service.saveMessage('thread-123', message)

      const savedCall = mockRepo.saveMessage.mock.calls[0][0]
      expect(savedCall.error).toBe(JSON.stringify({ code: 'ERR_1', message: 'Something failed' }))
      expect(savedCall.contextRefs).toBe(JSON.stringify([{ type: 'node', id: 'node-1', label: 'Auth' }]))
    })
  })

  describe('saveMessages', () => {
    it('should batch save messages', async () => {
      mockRepo.saveMessages.mockResolvedValue(undefined)
      mockRepo.updateThread.mockResolvedValue(undefined)

      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hi', timestamp: MOCK_NOW, status: 'success' },
        { id: 'msg-2', role: 'agent', content: 'Hello', timestamp: MOCK_NOW, status: 'success' },
      ]

      await service.saveMessages('thread-123', messages)

      expect(mockRepo.saveMessages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'msg-1', role: 'user' }),
          expect.objectContaining({ id: 'msg-2', role: 'agent' }),
        ]),
      )
      expect(mockRepo.updateThread).toHaveBeenCalledWith('thread-123', { updatedAt: MOCK_NOW })
    })
  })

  describe('archiveStaleThreads', () => {
    it('should pass numeric millisecond cutoff to repository', async () => {
      mockRepo.archiveStaleThreads.mockResolvedValue(2)

      const result = await service.archiveStaleThreads('project-1', 30)

      const cutoff = mockRepo.archiveStaleThreads.mock.calls[0][1]
      expect(typeof cutoff).toBe('number')
      expect(cutoff).toBeLessThan(MOCK_NOW)
      expect(result).toBe(2)
    })
  })

  describe('cleanupArchivedThreads', () => {
    it('should pass numeric millisecond cutoff to repository', async () => {
      mockRepo.cleanupArchivedThreads.mockResolvedValue(3)

      const result = await service.cleanupArchivedThreads(90)

      const cutoff = mockRepo.cleanupArchivedThreads.mock.calls[0][0]
      expect(typeof cutoff).toBe('number')
      expect(cutoff).toBeLessThan(MOCK_NOW)
      expect(result).toBe(3)
    })
  })

  describe('listMessages', () => {
    it('should list and deserialize messages', async () => {
      const rows: ChatMessageRow[] = [
        {
          id: 'msg-1',
          thread_id: 'thread-123',
          role: 'agent',
          content: 'Result',
          adapter_name: 'claude',
          status: 'success',
          error: null,
          session_id: 'session-1',
          context_refs: JSON.stringify([{ type: 'node', id: 'n1' }]),
          tool_calls: null,
          created_at: MOCK_NOW,
          token_count: 0,
        },
      ]
      mockRepo.listMessages.mockResolvedValue(rows)

      const result = await service.listMessages('thread-123')

      expect(result).toHaveLength(1)
      expect(result[0].role).toBe('agent')
      expect(result[0].sessionId).toBe('session-1')
      expect(result[0].contextRefs).toEqual([{ type: 'node', id: 'n1' }])
    })

    it('should handle null JSON fields gracefully', async () => {
      const rows: ChatMessageRow[] = [
        {
          id: 'msg-1',
          thread_id: 'thread-123',
          role: 'user',
          content: 'Hello',
          adapter_name: '',
          status: 'success',
          error: null,
          session_id: null,
          context_refs: null,
          tool_calls: null,
          created_at: MOCK_NOW,
          token_count: 0,
        },
      ]
      mockRepo.listMessages.mockResolvedValue(rows)

      const result = await service.listMessages('thread-123')

      expect(result[0].error).toBeUndefined()
      expect(result[0].contextRefs).toBeUndefined()
      expect(result[0].toolCalls).toBeUndefined()
    })
  })
})
