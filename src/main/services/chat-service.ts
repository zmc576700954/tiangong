/**
 * Chat Service
 * 线程 CRUD、消息存储、自动命名、session_id 回写
 */

import type { Client } from '@libsql/client'
import type { ChatMessage, AgentThread } from '@shared/types'
import { ChatRepository, type ChatThreadRow, type ChatMessageRow } from '../repositories/chat-repository'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { estimateTokens } from '../shared/token-utils'
import type { ContextWaterline } from '../memory/context-waterline'

export class ChatService {
  private repo: ChatRepository
  private waterline?: ContextWaterline

  constructor(dbOrRepo: Client | ChatRepository, waterline?: ContextWaterline) {
    // Backward compatible: accept either a libsql Client (constructs the repo here)
    // or an already-constructed ChatRepository (preferred for DI / testing).
    this.repo = dbOrRepo instanceof ChatRepository
      ? dbOrRepo
      : new ChatRepository(dbOrRepo)
    this.waterline = waterline
  }

  // ==================== Thread Operations ====================

  async createThread(data: {
    adapterName: string
    nodeId?: string
    graphId?: string
  }): Promise<AgentThread> {
    const id = generateId('thread')
    await this.repo.createThread({
      id,
      title: 'New Thread',
      adapterName: data.adapterName,
      nodeId: data.nodeId,
      graphId: data.graphId,
    })
    return {
      id,
      title: 'New Thread',
      adapterName: data.adapterName,
      messages: [],
      contextRefs: [],
      status: 'idle',
      createdAt: Date.now(),
      nodeBound: data.nodeId,
    }
  }

  async getThread(id: string): Promise<AgentThread | null> {
    const row = await this.repo.getThread(id)
    if (!row) return null
    return this.rowToThread(row)
  }

  async getThreadWithMessages(id: string): Promise<(AgentThread & { messages: ChatMessage[] }) | null> {
    const row = await this.repo.getThread(id)
    if (!row) return null
    const messageRows = await this.repo.listMessages(id)
    return {
      ...this.rowToThread(row),
      messages: messageRows.map((r) => this.rowToMessage(r)),
    }
  }

  async listThreads(filters?: { nodeId?: string; graphId?: string }): Promise<AgentThread[]> {
    const rows = await this.repo.listThreads({ ...filters, status: 'active' })
    return rows.map((r) => this.rowToThread(r))
  }

  async updateThread(id: string, data: { title?: string; status?: string; sessionId?: string }): Promise<void> {
    await this.repo.updateThread(id, { ...data, updatedAt: Date.now() })
  }

  async deleteThread(id: string): Promise<void> {
    await this.repo.deleteThread(id)
  }

  async searchThreads(query: string): Promise<AgentThread[]> {
    const rows = await this.repo.searchThreads(query)
    return rows.map((r) => this.rowToThread(r))
  }

  // ==================== Message Operations ====================

  async saveMessage(threadId: string, message: ChatMessage): Promise<void> {
    const tokenCount = estimateTokens(message.content)
    await this.repo.saveMessage({
      id: message.id,
      threadId,
      role: message.role,
      content: message.content,
      adapterName: message.adapterName ?? '',
      status: message.status,
      error: message.error ? JSON.stringify(message.error) : undefined,
      sessionId: message.sessionId,
      contextRefs: message.contextRefs ? JSON.stringify(message.contextRefs) : undefined,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
      createdAt: message.timestamp,
      tokenCount,
    })
    if (this.waterline) {
      this.waterline.onMessagePersisted(threadId, tokenCount)
    }
    await this.repo.updateThread(threadId, { updatedAt: Date.now() })
  }

  async saveMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    const messagesWithTokens = messages.map((m) => ({
      original: m,
      tokenCount: estimateTokens(m.content),
    }))
    await this.repo.saveMessages(messagesWithTokens.map(({ original: m, tokenCount }) => ({
      id: m.id,
      threadId,
      role: m.role,
      content: m.content,
      adapterName: m.adapterName ?? '',
      status: m.status,
      error: m.error ? JSON.stringify(m.error) : undefined,
      sessionId: m.sessionId,
      contextRefs: m.contextRefs ? JSON.stringify(m.contextRefs) : undefined,
      toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
      createdAt: m.timestamp,
      tokenCount,
    })))
    if (this.waterline && messagesWithTokens.length > 0) {
      const totalTokens = messagesWithTokens.reduce((sum, m) => sum + m.tokenCount, 0)
      this.waterline.onMessagePersisted(threadId, totalTokens)
    }
    await this.repo.updateThread(threadId, { updatedAt: Date.now() })
  }

  async listMessages(threadId: string, limit = 50, offset = 0): Promise<ChatMessage[]> {
    const rows = await this.repo.listMessages(threadId, limit, offset)
    return rows.map((r) => this.rowToMessage(r))
  }

  async archiveStaleThreads(projectId: string, staleDays = 30): Promise<number> {
    const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000
    return this.repo.archiveStaleThreads(projectId, cutoff)
  }

  /** Task 2.5.2: Delete archived threads older than 90 days */
  async cleanupArchivedThreads(archivedDays = 90): Promise<number> {
    const cutoff = Date.now() - archivedDays * 24 * 60 * 60 * 1000
    return this.repo.cleanupArchivedThreads(cutoff)
  }

  // ==================== Mappers ====================

  private rowToThread(row: ChatThreadRow): AgentThread {
    return {
      id: row.id,
      title: row.title,
      adapterName: row.adapter_name,
      messages: [],
      contextRefs: [],
      status: 'idle',
      createdAt: row.created_at,
      nodeBound: row.node_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      contextTokensUsed: row.context_tokens_used,
      contextWindowMax: row.context_window_max,
      lastCompactedAt: row.last_compacted_at ?? undefined,
    }
  }

  private rowToMessage(row: ChatMessageRow): ChatMessage {
    return {
      id: row.id,
      role: row.role as ChatMessage['role'],
      content: row.content,
      timestamp: row.created_at,
      adapterName: row.adapter_name || undefined,
      status: row.status as ChatMessage['status'],
      error: safeJsonParse(row.error, undefined),
      sessionId: row.session_id ?? undefined,
      contextRefs: safeJsonParse(row.context_refs, undefined),
      toolCalls: safeJsonParse(row.tool_calls, undefined),
    }
  }
}

