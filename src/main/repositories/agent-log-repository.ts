/**
 * Agent Log Repository
 * 负责 Agent 执行日志的写入和查询
 */

import type { Client } from '@libsql/client'
import type { AgentLog } from '@shared/types'
import { generateId } from '../shared/env'
import { safeJsonParse } from '../shared/db-utils'

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
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      adapterName: row.adapter_name as string,
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      command: safeJsonParse(row.command as string, null) as unknown as AgentLog['command'],
      outputs: safeJsonParse(row.outputs as string, []) as unknown as AgentLog['outputs'],
      result: row.result as 'success' | 'failure' | 'cancelled',
      duration: row.duration as number,
      createdAt: row.created_at as string,
    }
  }
}
