/**
 * Agent Log Repository
 * 负责 Agent 执行日志的写入和查询
 */

import type { Client } from '@libsql/client'
import type { AgentLog } from '@shared/types'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'
import { DatabaseError, ErrorCode } from '../errors'

export class AgentLogRepository {
  constructor(private db: Client) {}

  async create(data: Omit<AgentLog, 'id' | 'createdAt'>): Promise<AgentLog> {
    const id = generateId('agent_log')
    const now = new Date().toISOString()

    await this.db.execute({
      sql: `INSERT INTO agent_logs (id, session_id, adapter_name, node_id, graph_id, command, outputs, result, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, data.sessionId, data.adapterName, data.nodeId, data.graphId,
        JSON.stringify(data.command), JSON.stringify(data.outputs),
        data.result, data.duration, now,
      ],
    })

    return { ...data, id, createdAt: now }
  }

  async listByNode(nodeId: string): Promise<AgentLog[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM agent_logs WHERE node_id = ? ORDER BY created_at DESC',
      args: [nodeId],
    })
    return result.rows.map((row) => this.parseRow(row))
  }

  async listByGraph(graphId: string, limit = 100): Promise<AgentLog[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM agent_logs WHERE graph_id = ? ORDER BY created_at DESC LIMIT ?',
      args: [graphId, limit],
    })
    return result.rows.map((row) => this.parseRow(row))
  }

  async listBySession(sessionId: string): Promise<AgentLog[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM agent_logs WHERE session_id = ? ORDER BY created_at DESC',
      args: [sessionId],
    })
    return result.rows.map((row) => this.parseRow(row))
  }

  private parseRow(row: Record<string, unknown>): AgentLog {
    const requireString = (val: unknown, field: string): string => {
      if (val == null || val === '') {
        throw new DatabaseError(`Corrupted agent_logs row: ${field} is required`, ErrorCode.DB_QUERY_FAILED)
      }
      return String(val)
    }

    const command = safeJsonParse(row.command as string, { type: 'implement', description: '', targetNodeId: '' })
    if (
      command === null ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      typeof (command as Record<string, unknown>).type !== 'string' ||
      typeof (command as Record<string, unknown>).description !== 'string' ||
      typeof (command as Record<string, unknown>).targetNodeId !== 'string'
    ) {
      throw new DatabaseError('Corrupted agent_logs row: command is not a valid AgentCommand', ErrorCode.DB_QUERY_FAILED)
    }

    const outputs = safeJsonParse(row.outputs as string, [])
    if (!Array.isArray(outputs)) {
      throw new DatabaseError('Corrupted agent_logs row: outputs is not an array', ErrorCode.DB_QUERY_FAILED)
    }

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
      command: command as AgentLog['command'],
      outputs: outputs as AgentLog['outputs'],
      result: result as AgentLog['result'],
      duration: Number(row.duration ?? 0),
      createdAt: requireString(row.created_at, 'created_at'),
    }
  }
}
