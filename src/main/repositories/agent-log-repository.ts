/**
 * Agent Log Repository
 * 负责 Agent 执行日志的写入和查询
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { AgentLog } from '@shared/types'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { isAgentCommand, isAgentOutputArray } from '@shared/type-guards'
import { DatabaseError, ErrorCode } from '../errors'

export class AgentLogRepository {
  constructor(private db: BetterSqlite3.Database) {}

  create(data: Omit<AgentLog, 'id' | 'createdAt'>): AgentLog {
    const id = generateId('agent_log')
    const now = new Date().toISOString()

    this.db.prepare(
      `INSERT INTO agent_logs (id, session_id, adapter_name, node_id, graph_id, command, outputs, result, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data.sessionId, data.adapterName, data.nodeId, data.graphId,
      JSON.stringify(data.command), JSON.stringify(data.outputs),
      data.result, data.duration, now,
    )

    return { ...data, id, createdAt: now }
  }

  listByNode(nodeId: string): AgentLog[] {
    const rows = this.db.prepare('SELECT * FROM agent_logs WHERE node_id = ? ORDER BY created_at DESC').all(nodeId) as Record<string, unknown>[]
    return rows.map((row) => this.parseRow(row))
  }

  listByGraph(graphId: string, limit = 100): AgentLog[] {
    const rows = this.db.prepare('SELECT * FROM agent_logs WHERE graph_id = ? ORDER BY created_at DESC LIMIT ?').all(graphId, limit) as Record<string, unknown>[]
    return rows.map((row) => this.parseRow(row))
  }

  listBySession(sessionId: string): AgentLog[] {
    const rows = this.db.prepare('SELECT * FROM agent_logs WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as Record<string, unknown>[]
    return rows.map((row) => this.parseRow(row))
  }

  /** 删除超过 N 天的旧日志，返回删除条数 */
  pruneOld(days = 90): number {
    const info = this.db.prepare("DELETE FROM agent_logs WHERE created_at < datetime('now', ?)").run(`-${days} days`)
    return info.changes
  }

  private parseRow(row: Record<string, unknown>): AgentLog {
    const requireString = (val: unknown, field: string): string => {
      if (val == null || val === '') {
        throw new DatabaseError(`Corrupted agent_logs row: ${field} is required`, ErrorCode.DB_QUERY_FAILED)
      }
      return String(val)
    }

    // command / outputs 是 JSON 列，脏数据退化为默认值而不是让整个列表查询崩溃
    const command = safeJsonParse<AgentLog['command']>(
      row.command as string,
      { type: 'implement', description: '', targetNodeId: '' },
      isAgentCommand,
    )
    const outputs = safeJsonParse<AgentLog['outputs']>(row.outputs as string, [], isAgentOutputArray)

    const result = String(row.result ?? '')
    if (!['success', 'failure', 'cancelled'].includes(result)) {
      throw new DatabaseError(`Corrupted agent_logs row: invalid result "${result}"`, ErrorCode.DB_QUERY_FAILED)
    }

    return {
      id: requireString(row.id, 'id'),
      sessionId: requireString(row.session_id, 'session_id'),
      adapterName: requireString(row.adapter_name, 'adapter_name'),
      nodeId: requireString(row.node_id, 'node_id'),
      graphId: requireString(row.graph_id, 'graph_id'),
      command,
      outputs,
      result: result as AgentLog['result'],
      duration: Number(row.duration ?? 0),
      createdAt: requireString(row.created_at, 'created_at'),
    }
  }
}
