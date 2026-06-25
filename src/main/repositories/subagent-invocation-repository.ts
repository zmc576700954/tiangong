/**
 * SubagentInvocationRepository
 * 持久化 subagent_invocations 表。
 *
 * Phase 1 落地骨架；Phase 4 起 SubagentManager 调用 create/updateStatus/
 * complete/fail；Phase 5 渲染层通过 IPC listByParent/get 拉取数据。
 */

import type BetterSqlite3 from 'better-sqlite3'
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

function toInvocation(row: Record<string, unknown>): SubagentInvocation {
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
  constructor(private db: BetterSqlite3.Database) {}

  /** Insert a new invocation with status='queued'. Returns the generated id. */
  create(data: SubagentInvocationCreate): string {
    const id = generateId('inv')
    this.db.prepare(
      `INSERT INTO subagent_invocations (
              id, parent_session_id, parent_message_id, graph_id,
              agent_type, description, prompt,
              adapter_name, node_id, allowed_files,
              status, result_text, result_files, tokens_used,
              started_at, finished_at, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
    )
    return id
  }

  /** Update just the status column (e.g. queued → running). */
  updateStatus(id: string, status: SubagentStatus): void {
    this.db.prepare(
      'UPDATE subagent_invocations SET status = ? WHERE id = ?'
    ).run(status, id)
  }

  /** Mark a row as completed and write terminal fields. */
  complete(id: string, data: SubagentInvocationComplete): void {
    this.db.prepare(
      `UPDATE subagent_invocations
            SET status = ?, result_text = ?, result_files = ?, tokens_used = ?, finished_at = ?
            WHERE id = ?`
    ).run(
      'completed',
      data.resultText,
      JSON.stringify(data.resultFiles),
      data.tokensUsed,
      data.finishedAt,
      id,
    )
  }

  /** Mark a row as failed and write the error message. */
  fail(id: string, data: SubagentInvocationFail): void {
    this.db.prepare(
      `UPDATE subagent_invocations
            SET status = ?, error = ?, finished_at = ?
            WHERE id = ?`
    ).run('failed', data.error, data.finishedAt, id)
  }

  /** Mark a row as cancelled. */
  cancel(id: string, finishedAt: number): void {
    this.db.prepare(
      `UPDATE subagent_invocations
            SET status = ?, finished_at = ?
            WHERE id = ? AND status IN ('queued','running')`
    ).run('cancelled', finishedAt, id)
  }

  /** List invocations under one parent session, newest first. */
  listByParent(parentSessionId: string, limit = 100): SubagentInvocation[] {
    const rows = this.db.prepare(
      `SELECT id, parent_session_id, parent_message_id, graph_id,
                   agent_type, description, prompt,
                   adapter_name, node_id, allowed_files,
                   status, result_text, result_files, tokens_used,
                   started_at, finished_at, error
            FROM subagent_invocations
            WHERE parent_session_id = ?
            ORDER BY started_at DESC
            LIMIT ?`
    ).all(parentSessionId, limit) as Record<string, unknown>[]
    return rows.map(toInvocation)
  }

  /** Fetch a single invocation by id. */
  get(id: string): SubagentInvocation | null {
    const row = this.db.prepare(
      `SELECT id, parent_session_id, parent_message_id, graph_id,
                   agent_type, description, prompt,
                   adapter_name, node_id, allowed_files,
                   status, result_text, result_files, tokens_used,
                   started_at, finished_at, error
            FROM subagent_invocations WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined
    return row ? toInvocation(row) : null
  }
}
