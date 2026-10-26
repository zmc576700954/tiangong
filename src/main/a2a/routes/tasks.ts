/**
 * GET /v1/tasks/:id 与 GET /v1/tasks — 任务查询
 *
 * Phase D9 C4. ListTasks 支持 ?contextId=... 与 ?status=... query。
 * GetTask 从 task-store 读取运行时缓存；缺失时返回 404（不查 DB —
 * 历史 task 由调用方用 chat_threads 持久化机制重建）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { encodeTaskListResponse } from '../codec'
import type { A2ATaskStore } from '../task-store'
import type { A2ATask } from '@shared/types/a2a'

export interface TasksRouteDeps {
  taskStore: A2ATaskStore
  /** 从 taskId 还原 A2ATask（含 history / artifacts 累积），用于 GetTask */
  buildTask: (taskId: string) => Promise<A2ATask | null>
}

export async function handleGetTask(
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  deps: TasksRouteDeps,
): Promise<void> {
  const task = await deps.buildTask(taskId)
  if (!task) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'task not found', taskId }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ task }))
}

export function handleListTasks(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TasksRouteDeps,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const contextId = url.searchParams.get('contextId') ?? undefined
  const statusRaw = url.searchParams.get('status')
  const status = (statusRaw ?? undefined) as
    | 'working' | 'completed' | 'failed' | 'canceled' | 'input-required'
    | undefined
  const records = deps.taskStore.list({
    ...(contextId !== undefined ? { contextId } : {}),
    ...(status !== undefined ? { status } : {}),
  })
  // ListTasks 返回 A2ATask[] (records 已经包含 artifacts/history 累积)
  const tasks = records.map((r) => ({
    id: r.taskId,
    contextId: r.contextId,
    status: { state: r.status },
    artifacts: r.artifacts,
    history: r.history,
    createdAt: r.startedAt,
    updatedAt: r.lastActivityAt,
  }))
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(encodeTaskListResponse({ tasks }))
}
