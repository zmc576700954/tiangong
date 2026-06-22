/**
 * SubagentInvocationRepository
 * 持久化 subagent_invocations 表。
 *
 * Phase 1 落地骨架；Phase 4 起 SubagentManager 调用 create/updateStatus/
 * complete/fail；Phase 5 渲染层通过 IPC listByParent/get 拉取数据。
 */

import type { Client, Row } from '@libsql/client'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import type { SubagentInvocation, SubagentStatus } from '@shared/types'

export interface SubagentInvocationCreate {
  parentSessionId: string
  parentMessageId?: string
  graphId?: string
  agentType: string
  description: string
  prompt: string
  adapterName?: string
  nodeId?: string
  allowedFiles?: string[]
  startedAt: number
}

export interface SubagentInvocationComplete {
  resultText: string
  resultFiles: string[]
  tokensUsed: number
  finishedAt: number
}

export interface SubagentInvocationFail {
  error: string
  finishedAt: number
}

function parseStringArray(raw: unknown): string[] | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  const parsed = safeJsonParse<unknown>(raw, null)
  if (!Array.isArray(parsed)) return null
  return parsed.filter((v): v is string => typeof v === 'string')
}

function toInvocation(row: Row): SubagentInvocation {
  return {
    id: String(row.id ?? ''),
    parentSessionId: String(row.parent_session_id ?? ''),
    parentMessageId: row.parent_message_id != null ? String(row.parent_message_id) : null,
    graphId: row.graph_id != null ? String(row.graph_id) : null,
    agentType: String(row.agent_type ?? ''),
    description: String(row.description ?? ''),
    prompt: String(row.prompt ?? ''),
    adapterName: row.adapter_name != null ? String(row.adapter_name) : null,
    nodeId: row.node_id != null ? String(row.node_id) : null,
    allowedFiles: parseStringArray(row.allowed_files),
    status: String(row.status ?? 'queued') as SubagentStatus,
    resultText: row.result_text != null ? String(row.result_text) : null,
    resultFiles: parseStringArray(row.result_files),
    tokensUsed: Number(row.tokens_used ?? 0),
    startedAt: Number(row.started_at ?? 0),
    finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
    error: row.error != null ? String(row.error) : null,
  }
}

export class SubagentInvocationRepository {
  constructor(private db: Client) {}

  /** Insert a new invocation with status='queued'. Returns the generated id. */
  async create(data: SubagentInvocationCreate): Promise<string> {
    const id = generateId('inv')
    await this.db.execute({
      sql: `INSERT INTO subagent_invocations (
              id, parent_session_id, parent_message_id, graph_id,
              agent_type, description, prompt,
              adapter_name, node_id, allowed_files,
              status, result_text, result_files, tokens_used,
              started_at, finished_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.parentSessionId,
        data.parentMessageId ?? null,
        data.graphId ?? null,
        data.agentType,
        data.description,
        data.prompt,
        data.adapterName ?? null,
        data.nodeId ?? null,
        data.allowedFiles ? JSON.stringify(data.allowedFiles) : null,
        'queued',
        null,
        null,
        0,
        data.startedAt,
        null,
        null,
      ],
    })
    return id
  }

  /** Update just the status column (e.g. queued → running). */
  async updateStatus(id: string, status: SubagentStatus): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE subagent_invocations SET status = ? WHERE id = ?',
      args: [status, id],
    })
  }

  /** Mark a row as completed and write terminal fields. */
  async complete(id: string, data: SubagentInvocationComplete): Promise<void> {
    await this.db.execute({
      sql: `UPDATE subagent_invocations
            SET status = ?, result_text = ?, result_files = ?, tokens_used = ?, finished_at = ?
            WHERE id = ?`,
      args: [
        'completed',
        data.resultText,
        JSON.stringify(data.resultFiles),
        data.tokensUsed,
        data.finishedAt,
        id,
      ],
    })
  }

  /** Mark a row as failed and write the error message. */
  async fail(id: string, data: SubagentInvocationFail): Promise<void> {
    await this.db.execute({
      sql: `UPDATE subagent_invocations
            SET status = ?, error = ?, finished_at = ?
            WHERE id = ?`,
      args: ['failed', data.error, data.finishedAt, id],
    })
  }

  /** Mark a row as cancelled. */
  async cancel(id: string, finishedAt: number): Promise<void> {
    await this.db.execute({
      sql: `UPDATE subagent_invocations
            SET status = ?, finished_at = ?
            WHERE id = ? AND status IN ('queued','running')`,
      args: ['cancelled', finishedAt, id],
    })
  }

  /** List invocations under one parent session, newest first. */
  async listByParent(parentSessionId: string, limit = 100): Promise<SubagentInvocation[]> {
    const result = await this.db.execute({
      sql: `SELECT id, parent_session_id, parent_message_id, graph_id,
                   agent_type, description, prompt,
                   adapter_name, node_id, allowed_files,
                   status, result_text, result_files, tokens_used,
                   started_at, finished_at, error
            FROM subagent_invocations
            WHERE parent_session_id = ?
            ORDER BY started_at DESC
            LIMIT ?`,
      args: [parentSessionId, limit],
    })
    return result.rows.map(toInvocation)
  }

  /** Fetch a single invocation by id. */
  async get(id: string): Promise<SubagentInvocation | null> {
    const result = await this.db.execute({
      sql: `SELECT id, parent_session_id, parent_message_id, graph_id,
                   agent_type, description, prompt,
                   adapter_name, node_id, allowed_files,
                   status, result_text, result_files, tokens_used,
                   started_at, finished_at, error
            FROM subagent_invocations WHERE id = ?`,
      args: [id],
    })
    return result.rows[0] ? toInvocation(result.rows[0]) : null
  }
}
