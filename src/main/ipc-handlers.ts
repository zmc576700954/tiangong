/**
 * IPC 通信处理器
 * 注册所有主进程与渲染进程之间的通信通道
 */

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { getClient } from './database'
import { ClaudeCodeAdapter } from './adapters/claude-code'
import { CodexAdapter } from './adapters/codex'
import { OpenCodeAdapter } from './adapters/opencode'
import { McpAdapter } from './adapters/mcp-adapter'
import { ScopeGuard } from './scope-guard'
import { GitAgent } from './git-agent'
import { ProjectScanner } from './project-scanner'
import { ProjectAnalyzer, computeOptimalLayout } from './project-analyzer'
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
    const mcp = new McpAdapter()

    this.adapters.set(claude.name, claude)
    this.adapters.set(codex.name, codex)
    this.adapters.set(opencode.name, opencode)
    this.adapters.set(mcp.name, mcp)

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

  async startSession(adapterName: string, config: AgentSessionConfig): Promise<{ sessionId: string; fallback?: boolean }> {
    const adapter = this.adapters.get(adapterName)
    if (!adapter) {
      throw new Error(`Adapter ${adapterName} not found`)
    }

    // Check if requested adapter is installed
    const isInstalled = await adapter.checkInstalled()
    if (!isInstalled) {
      // Auto-fallback to MCP if available
      const mcp = this.adapters.get('mcp')
      if (mcp && (await mcp.checkInstalled())) {
        const session = await mcp.startSession(config)
        return { sessionId: session.id, fallback: true }
      }
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
  ipcMain.handle('graph:create', async (_, data: { name: string; type: 'online' | 'dev' }) => {
    const db = getClient()
    const id = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const now = new Date().toISOString()

    await db.execute({
      sql: 'INSERT INTO graphs (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [id, data.name, data.type, now, now],
    })

    return { id, name: data.name, type: data.type, createdAt: now, updatedAt: now } as Graph
  })

  ipcMain.handle('graph:list', async () => {
    const db = getClient()
    const result = await db.execute('SELECT * FROM graphs ORDER BY updated_at DESC')
    return result.rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      type: row.type as 'online' | 'dev',
      projectPath: row.project_path as string | undefined,
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
        type: graph.type as 'online' | 'dev',
        projectPath: graph.project_path as string | undefined,
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
        rules: row.rules ? JSON.parse(row.rules as string) : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
        ownerRole: row.owner_role as GraphNode['ownerRole'],
        position: { x: row.position_x as number, y: row.position_y as number },
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
        graph_id, graph_type, parent_id, rules, metadata, owner_role,
        position_x, position_y, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.rules ? JSON.stringify(data.rules) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.ownerRole ?? null,
        data.position.x,
        data.position.y,
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
    const args: (string | number | null)[] = []

    if (data.type !== undefined) { updates.push('type = ?'); args.push(data.type) }
    if (data.status !== undefined) { updates.push('status = ?'); args.push(data.status) }
    if (data.title !== undefined) { updates.push('title = ?'); args.push(data.title) }
    if (data.description !== undefined) { updates.push('description = ?'); args.push(data.description) }
    if (data.acceptanceCriteria !== undefined) { updates.push('acceptance_criteria = ?'); args.push(JSON.stringify(data.acceptanceCriteria)) }
    if (data.parentId !== undefined) { updates.push('parent_id = ?'); args.push(data.parentId) }
    if (data.rules !== undefined) { updates.push('rules = ?'); args.push(JSON.stringify(data.rules)) }
    if (data.metadata !== undefined) { updates.push('metadata = ?'); args.push(JSON.stringify(data.metadata)) }
    if (data.ownerRole !== undefined) { updates.push('owner_role = ?'); args.push(data.ownerRole) }
    if (data.position !== undefined) { updates.push('position_x = ?, position_y = ?'); args.push(data.position.x, data.position.y) }

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
      rules: row.rules ? JSON.parse(row.rules as string) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      ownerRole: row.owner_role as GraphNode['ownerRole'],
      position: { x: row.position_x as number, y: row.position_y as number },
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
      sql: 'INSERT INTO edges (id, source, target, label, edge_type, graph_id) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, data.source, data.target, data.label ?? null, data.edgeType ?? null, data.graphId],
    })

    return { ...data, id } as GraphEdge
  })

  ipcMain.handle('edge:update', async (_, id: string, data: Partial<GraphEdge>) => {
    const db = getClient()

    const updates: string[] = []
    const args: (string | null)[] = []

    if (data.label !== undefined) { updates.push('label = ?'); args.push(data.label) }
    if (data.edgeType !== undefined) { updates.push('edge_type = ?'); args.push(data.edgeType) }

    if (updates.length === 0) {
      // Nothing to update, fetch and return current
      const result = await db.execute({ sql: 'SELECT * FROM edges WHERE id = ?', args: [id] })
      const row = result.rows[0]
      return {
        id: row.id as string,
        source: row.source as string,
        target: row.target as string,
        label: row.label as string | undefined,
        graphId: row.graph_id as string,
        edgeType: row.edge_type as GraphEdge['edgeType'],
      } as GraphEdge
    }

    args.push(id)
    await db.execute({
      sql: `UPDATE edges SET ${updates.join(', ')} WHERE id = ?`,
      args,
    })

    const result = await db.execute({
      sql: 'SELECT * FROM edges WHERE id = ?',
      args: [id],
    })
    const row = result.rows[0]
    return {
      id: row.id as string,
      source: row.source as string,
      target: row.target as string,
      label: row.label as string | undefined,
      graphId: row.graph_id as string,
      edgeType: row.edge_type as GraphEdge['edgeType'],
    } as GraphEdge
  })

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
    const args: (string | number | null)[] = []

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
  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  })

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
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

  // ---------- Dialog 操作 ----------
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择项目目录',
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // ---------- 项目扫描 ----------
  ipcMain.handle('project:scan', async (_, projectPath: string) => {
    const scanner = new ProjectScanner()
    return scanner.scan(projectPath)
  })

  // ---------- 从项目初始化图 ----------
  ipcMain.handle('graph:initFromProject', async (_, data: { projectPath: string; projectName: string }) => {
    const db = getClient()
    const { projectPath, projectName } = data
    const now = new Date().toISOString()

    // 1. 扫描项目
    const scanner = new ProjectScanner()
    const scanResult = await scanner.scan(projectPath)

    // 2. 分析生成节点和边（使用 tempId 关联）
    const layout = computeOptimalLayout(scanResult)
    const analyzer = new ProjectAnalyzer(layout)
    const graphResult = analyzer.analyze(scanResult)

    // 3. 创建 online 图（产品蓝图）
    const onlineGraphId = `graph-online-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    await db.execute({
      sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [onlineGraphId, `${projectName} - 产品蓝图`, 'online', projectPath, now, now],
    })

    // 4. 创建 dev 图（开发场景）
    const devGraphId = `graph-dev-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    await db.execute({
      sql: 'INSERT INTO graphs (id, name, type, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [devGraphId, `${projectName} - 开发场景`, 'dev', projectPath, now, now],
    })

    // 5. 辅助函数：创建节点
    const createNodes = async (graphId: string, graphType: 'online' | 'dev') => {
      const tempIdMap = new Map<string, string>()

      // 第一轮：创建所有节点，记录 tempId -> realId 映射
      for (const nodeData of graphResult.nodes) {
        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        tempIdMap.set(nodeData.tempId, nodeId)

        // dev 图中，feature 节点为 placeholder
        const status = graphType === 'dev' && nodeData.type === 'feature'
          ? 'placeholder'
          : nodeData.status

        await db.execute({
          sql: `INSERT INTO nodes (
            id, type, status, title, description, acceptance_criteria,
            graph_id, graph_type, parent_id, rules, metadata, owner_role,
            position_x, position_y, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nodeId,
            nodeData.type,
            status,
            nodeData.title,
            nodeData.description ?? null,
            nodeData.acceptanceCriteria ? JSON.stringify(nodeData.acceptanceCriteria) : null,
            graphId,
            graphType,
            null, // parent_id 第二轮更新
            nodeData.rules ? JSON.stringify(nodeData.rules) : null,
            nodeData.metadata ? JSON.stringify(nodeData.metadata) : null,
            nodeData.ownerRole ?? null,
            nodeData.position.x,
            nodeData.position.y + (graphType === 'dev' ? 20 : 0),
            now,
            now,
          ],
        })
      }

      // 第二轮：更新 parent_id
      for (const nodeData of graphResult.nodes) {
        if (nodeData.parentTempId) {
          const nodeId = tempIdMap.get(nodeData.tempId)
          const parentId = tempIdMap.get(nodeData.parentTempId)
          if (nodeId && parentId) {
            await db.execute({
              sql: 'UPDATE nodes SET parent_id = ? WHERE id = ?',
              args: [parentId, nodeId],
            })
          }
        }
      }

      // 第三轮：创建边
      for (const edgeData of graphResult.edges) {
        const sourceId = tempIdMap.get(edgeData.sourceTempId)
        const targetId = tempIdMap.get(edgeData.targetTempId)
        if (sourceId && targetId) {
          const edgeId = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
          await db.execute({
            sql: 'INSERT INTO edges (id, source, target, label, graph_id) VALUES (?, ?, ?, ?, ?)',
            args: [edgeId, sourceId, targetId, edgeData.label ?? null, graphId],
          })
        }
      }

      return tempIdMap
    }

    await createNodes(onlineGraphId, 'online')
    await createNodes(devGraphId, 'dev')

    return {
      onlineGraph: {
        id: onlineGraphId,
        name: `${projectName} - 产品蓝图`,
        type: 'online' as const,
        projectPath,
        createdAt: now,
        updatedAt: now,
      },
      devGraph: {
        id: devGraphId,
        name: `${projectName} - 开发场景`,
        type: 'dev' as const,
        projectPath,
        createdAt: now,
        updatedAt: now,
      },
      modules: scanResult.modules,
    }
  })
  // ---------- 配置管理 ----------
  ipcMain.handle('settings:read', async () => {
    const { readSettings } = await import('./settings')
    return readSettings()
  })

  ipcMain.handle('settings:write', async (_, settings) => {
    const { writeSettings } = await import('./settings')
    await writeSettings(settings)
  })

  ipcMain.handle('settings:refreshCli', async () => {
    const { refreshAllCliStatus } = await import('./settings')
    return refreshAllCliStatus()
  })

  ipcMain.handle('settings:installCli', async (_, name: string) => {
    const { installCliTool } = await import('./settings')
    return installCliTool(name)
  })

  ipcMain.handle('settings:setApiKey', async (_, provider: string, key: string, baseUrl?: string) => {
    const { setApiKey } = await import('./settings')
    await setApiKey(provider, key, baseUrl)
  })
}
