/**
 * IPC 通信处理器
 * 注册所有主进程与渲染进程之间的通信通道
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { getClient } from './database'
import { ClaudeCodeAdapter } from './adapters/claude-code'
import { CodexAdapter } from './adapters/codex'
import { OpenCodeAdapter } from './adapters/opencode'
import { ScopeGuard } from './scope-guard'
import { GitAgent } from './git-agent'
import type {
  Graph,
  GraphNode,
  GraphEdge,
  BugNode,
  AgentSessionConfig,
  AgentCommand,
  AgentOutput,
  AgentAdapter,
} from '@shared/types'
import fs from 'node:fs/promises'
import path from 'node:path'

// ============================================
// Agent 管理器
// ============================================

class AgentManager {
  private adapters = new Map<string, AgentAdapter>()
  private outputListeners = new Map<string, ((output: AgentOutput) => void)[]>()

  constructor() {
    const claude = new ClaudeCodeAdapter()
    const codex = new CodexAdapter()
    const opencode = new OpenCodeAdapter()

    this.adapters.set(claude.name, claude)
    this.adapters.set(codex.name, codex)
    this.adapters.set(opencode.name, opencode)

    // 为每个适配器注册输出监听
    for (const adapter of this.adapters.values()) {
      adapter.onOutput((output) => {
        this.broadcastOutput(adapter.name, output)
      })
    }
  }

  getAdapter(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  async checkInstalled(name: string): Promise<boolean> {
    const adapter = this.adapters.get(name)
    if (!adapter) return false
    return adapter.checkInstalled()
  }

  async listAdapters(): Promise<{ name: string; version: string; installed: boolean }[]> {
    const results = []
    for (const adapter of this.adapters.values()) {
      results.push({
        name: adapter.name,
        version: adapter.version,
        installed: await adapter.checkInstalled(),
      })
    }
    return results
  }

  async startSession(adapterName: string, config: AgentSessionConfig): Promise<{ sessionId: string }> {
    const adapter = this.adapters.get(adapterName)
    if (!adapter) {
      throw new Error(`Adapter ${adapterName} not found`)
    }
    const session = await adapter.startSession(config)
    return { sessionId: session.id }
  }

  async sendCommand(sessionId: string, command: AgentCommand): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.sendCommand(sessionId, command)
        return
      } catch {
        // 尝试下一个适配器
      }
    }
    throw new Error(`No adapter found for session ${sessionId}`)
  }

  async terminateSession(sessionId: string): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.terminateSession(sessionId)
        return
      } catch {
        // 尝试下一个适配器
      }
    }
  }

  private broadcastOutput(adapterName: string, output: AgentOutput): void {
    // 向所有渲染进程广播
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('agent:onOutput', adapterName, output)
    }
  }
}

// ============================================
// 全局实例
// ============================================

const agentManager = new AgentManager()
const scopeGuard = new ScopeGuard()
const gitAgent = new GitAgent()

// ============================================
// IPC 处理器注册
// ============================================

export function registerIpcHandlers(): void {
  // ---------- 图操作 ----------
  ipcMain.handle('graph:create', async (_, data: { name: string; type: 'production' | 'development'; sourceGraphId?: string }) => {
    const db = getClient()
    const id = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const now = new Date().toISOString()

    await db.execute({
      sql: 'INSERT INTO graphs (id, name, type, source_graph_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, data.name, data.type, data.sourceGraphId ?? null, now, now],
    })

    return { id, name: data.name, type: data.type, sourceGraphId: data.sourceGraphId, createdAt: now, updatedAt: now } as Graph
  })

  ipcMain.handle('graph:list', async () => {
    const db = getClient()
    const result = await db.execute('SELECT * FROM graphs ORDER BY updated_at DESC')
    return result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      type: row.type as 'production' | 'development',
      sourceGraphId: row.source_graph_id as string | undefined,
      targetPlaceholderId: row.target_placeholder_id as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    })) as Graph[]
  })

  ipcMain.handle('graph:get', async (_, id: string) => {
    const db = getClient()
    const graphResult = await db.execute({
      sql: 'SELECT * FROM graphs WHERE id = ?',
      args: [id],
    })

    if (graphResult.rows.length === 0) return null

    const graph = graphResult.rows[0]

    const nodesResult = await db.execute({
      sql: 'SELECT * FROM nodes WHERE graph_id = ?',
      args: [id],
    })

    const edgesResult = await db.execute({
      sql: 'SELECT * FROM edges WHERE graph_id = ?',
      args: [id],
    })

    return {
      graph: {
        id: graph.id as string,
        name: graph.name as string,
        type: graph.type as 'production' | 'development',
        sourceGraphId: graph.source_graph_id as string | undefined,
        targetPlaceholderId: graph.target_placeholder_id as string | undefined,
        createdAt: graph.created_at as string,
        updatedAt: graph.updated_at as string,
      } as Graph,
      nodes: nodesResult.rows.map((row) => ({
        id: row.id as string,
        type: row.type as GraphNode['type'],
        status: row.status as GraphNode['status'],
        title: row.title as string,
        description: row.description as string | undefined,
        acceptanceCriteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria as string) : undefined,
        graphId: row.graph_id as string,
        graphType: row.graph_type as GraphNode['graphType'],
        parentId: row.parent_id as string | undefined,
        placeholderOf: row.placeholder_of as string | undefined,
        ownerRole: row.owner_role as GraphNode['ownerRole'],
        position: { x: row.position_x as number, y: row.position_y as number },
        notes: row.notes as string | undefined,
        collapsed: row.collapsed ? Boolean(row.collapsed) : undefined,
        style: row.style ? JSON.parse(row.style as string) : undefined,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      })) as GraphNode[],
      edges: edgesResult.rows.map((row) => ({
        id: row.id as string,
        source: row.source as string,
        target: row.target as string,
        label: row.label as string | undefined,
        graphId: row.graph_id as string,
        edgeType: row.edge_type as GraphEdge['edgeType'],
        style: row.style ? JSON.parse(row.style as string) : undefined,
        condition: row.condition as string | undefined,
        markerEnd: row.marker_end as GraphEdge['markerEnd'],
      })) as GraphEdge[],
    }
  })

  ipcMain.handle('graph:delete', async (_, id: string) => {
    const db = getClient()
    await db.execute({ sql: 'DELETE FROM edges WHERE graph_id = ?', args: [id] })
    await db.execute({ sql: 'DELETE FROM nodes WHERE graph_id = ?', args: [id] })
    await db.execute({ sql: 'DELETE FROM bug_nodes WHERE graph_id = ?', args: [id] })
    await db.execute({ sql: 'DELETE FROM graphs WHERE id = ?', args: [id] })
    return true
  })

  // ---------- 节点操作 ----------
  ipcMain.handle('node:create', async (_, data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => {
    const db = getClient()
    const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const now = new Date().toISOString()

    await db.execute({
      sql: `INSERT INTO nodes (
        id, type, status, title, description, acceptance_criteria,
        graph_id, graph_type, parent_id, placeholder_of, owner_role,
        position_x, position_y, notes, collapsed, style,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.type,
        data.status,
        data.title,
        data.description ?? null,
        data.acceptanceCriteria ? JSON.stringify(data.acceptanceCriteria) : null,
        data.graphId,
        data.graphType,
        data.parentId ?? null,
        data.placeholderOf ?? null,
        data.ownerRole ?? null,
        data.position.x,
        data.position.y,
        data.notes ?? null,
        data.collapsed ? 1 : 0,
        data.style ? JSON.stringify(data.style) : null,
        now,
        now,
      ],
    })

    return { ...data, id, createdAt: now, updatedAt: now } as GraphNode
  })

  ipcMain.handle('node:update', async (_, id: string, data: Partial<GraphNode>) => {
    const db = getClient()
    const now = new Date().toISOString()

    const updates: string[] = []
    const args: unknown[] = []

    if (data.type !== undefined) { updates.push('type = ?'); args.push(data.type) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }
    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.acceptanceCriteria !== undefined) { updates.push('acceptance_criteria = ?'); args.push(JSON.stringify(data.acceptanceCriteria)) }
    if (data.parentId !== undefined) { updates.push('parent_id = ?'); args.push(data.parentId) }
    if (data.ownerRole !== undefined) { updates.push('owner_role = ?'); args.push(data.ownerRole) }
    if (data.position !== undefined) { updates.push('position_x = ?, position_y = ?'); args.push(data.position.x, data.position.y) }
    if (data.notes !== undefined) { updates.push('notes = ?'); args.push(data.notes) }
    if (data.collapsed !== undefined) { updates.push('collapsed = ?'); args.push(data.collapsed ? 1 : 0) }
    if (data.style !== undefined) { updates.push('style = ?'); args.push(data.style ? JSON.stringify(data.style) : null) }

    updates.push('updated_at = ?')
    args.push(now)
    args.push(id)

    await db.execute({
      sql: `UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`,
      args,
    })

    const result = await db.execute({
      sql: 'SELECT * FROM nodes WHERE id = ?',
      args: [id],
    })

    const row = result.rows[0]
    return {
      id: row.id as string,
      type: row.type as GraphNode['type'],
      status: row.status as GraphNode['status'],
      title: row.title as string,
      description: row.description as string | undefined,
      acceptanceCriteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria as string) : undefined,
      graphId: row.graph_id as string,
      graphType: row.graph_type as GraphNode['graphType'],
      parentId: row.parent_id as string | undefined,
      placeholderOf: row.placeholder_of as string | undefined,
      ownerRole: row.owner_role as GraphNode['ownerRole'],
      position: { x: row.position_x as number, y: row.position_y as number },
      notes: row.notes as string | undefined,
      collapsed: row.collapsed ? Boolean(row.collapsed) : undefined,
      style: row.style ? JSON.parse(row.style as string) : undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } as GraphNode
  })

  ipcMain.handle('node:delete', async (_, id: string) => {
    const db = getClient()
    await db.execute({ sql: 'DELETE FROM edges WHERE source = ? OR target = ?', args: [id, id] })
    await db.execute({ sql: 'DELETE FROM bug_nodes WHERE node_id = ?', args: [id] })
    await db.execute({ sql: 'DELETE FROM nodes WHERE id = ?', args: [id] })
    return true
  })

  // ---------- 边操作 ----------
  ipcMain.handle('edge:create', async (_, data: Omit<GraphEdge, 'id'>) => {
    const db = getClient()
    const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    await db.execute({
      sql: `INSERT INTO edges (
        id, source, target, label, graph_id,
        edge_type, style, condition, marker_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.source,
        data.target,
        data.label ?? null,
        data.graphId,
        data.edgeType ?? null,
        data.style ? JSON.stringify(data.style) : null,
        data.condition ?? null,
        data.markerEnd ?? null,
      ],
    })

    return { ...data, id } as GraphEdge
  })

  ipcMain.handle('edge:update', async (_, id: string, data: Partial<GraphEdge>) => {
    const db = getClient()

    const updates: string[] = []
    const args: unknown[] = []

    if (data.source !== undefined) { updates.push('source = ?'); args.push(data.source) }
    if (data.target !== undefined) { updates.push('target = ?'); args.push(data.target) }
    if (data.label !== undefined) { updates.push('label = ?'); args.push(data.label) }
    if (data.edgeType !== undefined) { updates.push('edge_type = ?'); args.push(data.edgeType) }
    if (data.style !== undefined) { updates.push('style = ?'); args.push(data.style ? JSON.stringify(data.style) : null) }
    if (data.condition !== undefined) { updates.push('condition = ?'); args.push(data.condition) }
    if (data.markerEnd !== undefined) { updates.push('marker_end = ?'); args.push(data.markerEnd) }

    if (updates.length === 0) {
      // 没有可更新的字段，直接返回当前数据
      const result = await db.execute({ sql: 'SELECT * FROM edges WHERE id = ?', args: [id] })
      const row = result.rows[0]
      return mapEdgeRow(row)
    }

    args.push(id)
    await db.execute({
      sql: `UPDATE edges SET ${updates.join(', ')} WHERE id = ?`,
      args,
    })

    const result = await db.execute({ sql: 'SELECT * FROM edges WHERE id = ?', args: [id] })
    return mapEdgeRow(result.rows[0])
  })

  function mapEdgeRow(row: Record<string, unknown>): GraphEdge {
    return {
      id: row.id as string,
      source: row.source as string,
      target: row.target as string,
      label: row.label as string | undefined,
      graphId: row.graph_id as string,
      edgeType: row.edge_type as GraphEdge['edgeType'],
      style: row.style ? JSON.parse(row.style as string) : undefined,
      condition: row.condition as string | undefined,
      markerEnd: row.marker_end as GraphEdge['markerEnd'],
    } as GraphEdge
  }

  ipcMain.handle('edge:delete', async (_, id: string) => {
    const db = getClient()
    await db.execute({ sql: 'DELETE FROM edges WHERE id = ?', args: [id] })
    return true
  })

  // ---------- Bug 操作 ----------
  ipcMain.handle('bug:create', async (_, data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>) => {
    const db = getClient()
    const id = `bug-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const now = new Date().toISOString()

    await db.execute({
      sql: 'INSERT INTO bug_nodes (id, title, description, severity, status, node_id, graph_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, data.title, data.description, data.severity, data.status, data.nodeId, data.graphId, now, now],
    })

    return { ...data, id, createdAt: now, updatedAt: now } as BugNode
  })

  ipcMain.handle('bug:update', async (_, id: string, data: Partial<BugNode>) => {
    const db = getClient()
    const now = new Date().toISOString()

    const updates: string[] = []
    const args: unknown[] = []

    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.severity !== undefined) { updates.push('severity = ?'); args.push(data.severity) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }

    updates.push('updated_at = ?')
    args.push(now)
    args.push(id)

    await db.execute({
      sql: `UPDATE bug_nodes SET ${updates.join(', ')} WHERE id = ?`,
      args,
    })

    const result = await db.execute({
      sql: 'SELECT * FROM bug_nodes WHERE id = ?',
      args: [id],
    })

    const row = result.rows[0]
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      severity: row.severity as BugNode['severity'],
      status: row.status as BugNode['status'],
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } as BugNode
  })

  ipcMain.handle('bug:delete', async (_, id: string) => {
    const db = getClient()
    await db.execute({ sql: 'DELETE FROM bug_nodes WHERE id = ?', args: [id] })
    return true
  })

  ipcMain.handle('bug:listByNode', async (_, nodeId: string) => {
    const db = getClient()
    const result = await db.execute({
      sql: 'SELECT * FROM bug_nodes WHERE node_id = ? ORDER BY created_at DESC',
      args: [nodeId],
    })

    return result.rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      severity: row.severity as BugNode['severity'],
      status: row.status as BugNode['status'],
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    })) as BugNode[]
  })

  ipcMain.handle('bug:listByGraph', async (_, graphId: string) => {
    const db = getClient()
    const result = await db.execute({
      sql: 'SELECT * FROM bug_nodes WHERE graph_id = ? ORDER BY created_at DESC',
      args: [graphId],
    })

    return result.rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      severity: row.severity as BugNode['severity'],
      status: row.status as BugNode['status'],
      nodeId: row.node_id as string,
      graphId: row.graph_id as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    })) as BugNode[]
  })

  // ---------- Agent 操作 ----------
  ipcMain.handle('agent:checkInstalled', async (_, adapterName: string) => {
    return agentManager.checkInstalled(adapterName)
  })

  ipcMain.handle('agent:startSession', async (_, adapterName: string, config: AgentSessionConfig) => {
    return agentManager.startSession(adapterName, config)
  })

  ipcMain.handle('agent:sendCommand', async (_, sessionId: string, command: AgentCommand) => {
    return agentManager.sendCommand(sessionId, command)
  })

  ipcMain.handle('agent:terminateSession', async (_, sessionId: string) => {
    return agentManager.terminateSession(sessionId)
  })

  ipcMain.handle('agent:listAdapters', async () => {
    return agentManager.listAdapters()
  })

  // ---------- 文件系统 ----------

  // 安全限制常量
  const MAX_DIR_ENTRIES = 1000        // 单次目录读取最大条目数
  const MAX_READ_FILE_SIZE = 10 * 1024 * 1024  // 单文件读取最大 10 MB

  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    // 限制返回数量，防止大型项目内存溢出
    const limited = entries.slice(0, MAX_DIR_ENTRIES)
    return limited.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  })

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    // 先检查文件大小，防止读取超大文件导致内存溢出
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_READ_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(2)} MB). ` +
        `Maximum allowed size is ${MAX_READ_FILE_SIZE / 1024 / 1024} MB.`
      )
    }
    return fs.readFile(filePath, 'utf-8')
  })

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
  })

  // ---------- Git 操作 ----------
  ipcMain.handle('git:status', async (_, repoPath: string) => {
    return gitAgent.getStatus(repoPath)
  })

  ipcMain.handle('git:diff', async (_, repoPath: string) => {
    return gitAgent.getDiff(repoPath)
  })

  ipcMain.handle('git:commit', async (_, repoPath: string, message: string) => {
    return gitAgent.commit(repoPath, message)
  })
}

