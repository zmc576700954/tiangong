/**
 * Chat IPC Handlers
 * 线程和消息的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { ChatService } from '../services/chat-service'
import { NodeSessionLinkService } from '../map/work-run-service'
import type { TypedHandle } from './utils'
import { ensureString, ensureOptionalNumber } from './utils'

/** 图 → 项目路径（挂载链接用;查不到返回 undefined）。 */
function projectPathOfGraph(db: BetterSqlite3.Database, graphId: string): string | undefined {
  const row = db.prepare('SELECT project_path FROM graphs WHERE id = ?').get(graphId) as
    | { project_path: string | null }
    | undefined
  return row?.project_path ?? undefined
}

const MAX_QUERY_LEN = 2000

export function registerChatHandlers(
  chatService: ChatService,
  typedHandle: TypedHandle,
  db?: BetterSqlite3.Database,
): void {
  typedHandle('thread:list', async (_, filters) => {
    return chatService.listThreads(filters ?? undefined)
  })

  typedHandle('thread:load', async (_, threadId) => {
    return chatService.getThreadWithMessages(ensureString('threadId', threadId))
  })

  typedHandle('thread:create', async (_, data) => {
    const thread = await chatService.createThread(data)
    // S5a 会话挂载（§4.7.6）:会话首次落到节点/项目时写 node_session_links
    // （link_role='primary',幂等）——节点时间线（map:node:timeline）的数据源。
    // 挂载失败只告警,绝不阻断建线;无 graphId 的纯自由聊天不进地图时间线。
    if (db && data.graphId) {
      try {
        const links = new NodeSessionLinkService(db)
        let nodeEntityKey: string | undefined
        if (data.nodeId) {
          const node = db
            .prepare('SELECT entity_key FROM nodes WHERE id = ?')
            .get(data.nodeId) as { entity_key: string | null } | undefined
          nodeEntityKey = node?.entity_key ?? undefined
        }
        links.attach({
          projectPath: projectPathOfGraph(db, data.graphId) ?? '',
          graphId: data.graphId,
          nodeEntityKey,
          nodeId: data.nodeId,
          threadId: thread.id,
          linkRole: 'primary',
          sessionOrigin: 'manual_panel',
        })
      } catch (err) {
        console.warn('[chat] node_session_links attach failed:', err)
      }
    }
    return thread
  })

  typedHandle('thread:update', async (_, threadId, data) => {
    return chatService.updateThread(ensureString('threadId', threadId), data)
  })

  typedHandle('thread:delete', async (_, threadId) => {
    // S5a:会话结束只写 ended_at,不删除链接行（时间线保留历史,§4.7.6）。
    if (db) {
      try {
        new NodeSessionLinkService(db).end(ensureString('threadId', threadId))
      } catch (err) {
        console.warn('[chat] node_session_links end failed:', err)
      }
    }
    return chatService.deleteThread(ensureString('threadId', threadId))
  })

  typedHandle('thread:search', async (_, query) => {
    return chatService.searchThreads(ensureString('query', query, MAX_QUERY_LEN))
  })

  typedHandle('message:list', async (_, threadId, limit, offset) => {
    return chatService.listMessages(ensureString('threadId', threadId), ensureOptionalNumber('limit', limit), ensureOptionalNumber('offset', offset))
  })

  typedHandle('message:save', async (_, threadId, message) => {
    return chatService.saveMessage(ensureString('threadId', threadId), message)
  })

  typedHandle('message:saveBatch', async (_, threadId, messages) => {
    return chatService.saveMessages(ensureString('threadId', threadId), messages)
  })

  typedHandle('chat:archiveStale', async (_, projectId, staleDays) => {
    return chatService.archiveStaleThreads(ensureString('projectId', projectId), ensureOptionalNumber('staleDays', staleDays))
  })

  // Task 2.5.2: 90-day archived thread cleanup
  typedHandle('chat:cleanupArchived', async () => {
    return chatService.cleanupArchivedThreads(90)
  })
}
