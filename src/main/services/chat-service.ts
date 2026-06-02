/**
 * Chat Service
 * 线程 CRUD、消息存储、自动命名、session_id 回写
 */

import type { Client } from '@libsql/client'
import type { ChatMessage, AgentThread } from '@shared/types'
import { ChatRepository, type ChatThreadRow, type ChatMessageRow } from '../repositories/chat-repository'
import { generateId } from '../shared/env'

export class ChatService {
  private repo: ChatRepository

  constructor(db: Client) {
    this.repo = new ChatRepository(db)
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
    await this.repo.saveMessage({
      id: message.id,
      threadId,
      role: message.role === 'agent' ? 'assistant' : message.role,
      content: message.content,
      adapterName: message.adapterName ?? '',
      status: message.status,
      error: message.error ? JSON.stringify(message.error) : undefined,
      sessionId: message.sessionId,
      contextRefs: message.contextRefs ? JSON.stringify(message.contextRefs) : undefined,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
      createdAt: message.timestamp,
    })
    await this.repo.updateThread(threadId, { updatedAt: Date.now() })
  }

  async saveMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    await this.repo.saveMessages(messages.map((m) => ({
      id: m.id,
      threadId,
      role: m.role === 'agent' ? 'assistant' : m.role,
      content: m.content,
      adapterName: m.adapterName ?? '',
      status: m.status,
      error: m.error ? JSON.stringify(m.error) : undefined,
      sessionId: m.sessionId,
      contextRefs: m.contextRefs ? JSON.stringify(m.contextRefs) : undefined,
      toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
      createdAt: m.timestamp,
    })))
    await this.repo.updateThread(threadId, { updatedAt: Date.now() })
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    const rows = await this.repo.listMessages(threadId)
    return rows.map((r) => this.rowToMessage(r))
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
    }
  }

  private rowToMessage(row: ChatMessageRow): ChatMessage {
    return {
      id: row.id,
      role: (row.role === 'assistant' ? 'agent' : row.role) as ChatMessage['role'],
      content: row.content,
      timestamp: row.created_at,
      adapterName: row.adapter_name || undefined,
      status: row.status as ChatMessage['status'],
      error: row.error ? JSON.parse(row.error) : undefined,
      sessionId: row.session_id ?? undefined,
      contextRefs: row.context_refs ? JSON.parse(row.context_refs) : undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    }
  }
}
