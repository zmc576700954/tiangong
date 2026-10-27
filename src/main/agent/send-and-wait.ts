/**
 * 通过 AgentManager 发送 prompt 并等待完成
 * 输出会实时显示在 AgentChat 面板中
 *
 * 共享工具函数，供 mindmap IPC 和 GraphService 使用
 */

import type { AgentOutput, AgentSessionConfig } from '@shared/types'
import type { TerminationReason } from '@shared/types/agent'
import type { AgentManager } from './agent-manager'
import { AgentError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'

const logger = createLogger('sendPromptViaAgent')

export interface CreateAgentSessionOptions {
  nodeTitle?: string
  timeoutMs?: number
  adapterName?: string
  threadId?: string
}

/**
 * 仅为 prompt 创建一个 Agent 会话并返回 sessionId。
 * 调用方需要自行 addSessionOutputListener + sendCommand，以便实时消费输出。
 */
export async function createAgentSessionForPrompt(
  agentManager: AgentManager,
  projectPath: string,
  _prompt: string,
  options?: CreateAgentSessionOptions,
): Promise<string> {
  const config: AgentSessionConfig = {
    workingDirectory: projectPath,
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: options?.nodeTitle ?? '思维导图生成',
    acceptanceCriteria: [],
    timeoutMs: options?.timeoutMs ?? 300_000,
    threadId: options?.threadId,
    // 注意：这里**不能**开 verifyOnly。
    // verifyOnly 会让 AgentManager 建一个空白名单的 ScopeGuard 沙箱，而本会话的
    // workingDirectory 是用户的真实项目目录 —— 沙箱根就是用户项目。
    // 后果有两处，都是破坏性的：
    //   1) watcher 监听整棵项目树，用户在生成期间改任何文件都被判为越界 →
    //      会话被 terminate('error')，生成中途夭折；
    //   2) terminate 时的 commitChanges() 发现越界新文件会直接 unlink 掉 ——
    //      用户自己新建的文件被 BizGraph 删除。
    // A2A 那条链路可以用 verifyOnly，因为它的沙箱根是隔离的空临时目录。
    // 这里保持 allowedFiles=[]（不建沙箱）：写权限由 CLI 层面挡住 ——
    // mindmap-internal 的 runClaude 默认禁掉 Write/Edit 工具
    // （见 mindmap-agent/claude-runner.ts 的 buildClaudeArgs）。
  }

  const adapterName = options?.adapterName ?? 'claude-code'
  const { sessionId } = await agentManager.startSession(adapterName, config)
  return sessionId
}

/**
 * 创建会话、发送 prompt、收集全部输出
 * @returns Claude 的完整文本输出
 */
export async function sendPromptViaAgent(
  agentManager: AgentManager,
  projectPath: string,
  prompt: string,
  options?: {
    nodeTitle?: string
    timeoutMs?: number
    adapterName?: string
  },
): Promise<string> {
  const config: AgentSessionConfig = {
    workingDirectory: projectPath,
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    nodeTitle: options?.nodeTitle ?? '思维导图生成',
    acceptanceCriteria: [],
    // 同上：workingDirectory 是用户的真实项目目录，不能开 verifyOnly 沙箱
    // （回滚会删除用户在生成期间新建的文件）。详见 createAgentSessionForPrompt。
  }

  const adapterName = options?.adapterName ?? 'claude-code'
  const { sessionId } = await agentManager.startSession(adapterName, config)

  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let settled = false
    const startTime = Date.now()

    // 超时保护
    const timeoutMs = options?.timeoutMs ?? 300_000
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true
        agentManager.removeSessionOutputListener(handler)
        agentManager.terminateSession(sessionId, 'timeout').catch((err) => {
          logger.warn('Failed to terminate session on timeout:', err)
        })
        if (chunks.length > 0) {
          logger.info('超时但有部分输出，使用已收到的内容')
          resolve(chunks.join('\n'))
        } else {
          reject(new AgentError(`timeout: ${Math.round(timeoutMs / 1000)}s 内未收到任何输出`, ErrorCode.AGENT_PROCESS_ERROR))
        }
      }
    }, timeoutMs)

    // 回收一次性会话：否则 CLI 子进程、ScopeGuard 沙箱与 AgentManager 的会话
    // 槽位会一直留着，直到触发「Maximum concurrent sessions exceeded」。
    const terminate = (reason: TerminationReason) => {
      agentManager.terminateSession(sessionId, reason).catch((err) => {
        logger.warn('Failed to terminate session:', err)
      })
    }

    // 使用会话级输出监听器，仅接收目标 session 的输出，防止跨会话污染
    const handler = (output: AgentOutput) => {
      if (output.type === 'stdout' || output.type === 'file_change') {
        chunks.push(output.data)
      }
      if (output.type === 'complete') {
        if (!settled) {
          settled = true
          clearTimeout(timeoutId)
          agentManager.removeSessionOutputListener(handler)
          logger.info(`完成, 耗时 ${Math.round((Date.now() - startTime) / 1000)}s, 输出 ${chunks.length} 块`)
          resolve(chunks.join('\n'))
          terminate('user')
        }
      }
      if (output.type === 'error') {
        if (!settled) {
          settled = true
          clearTimeout(timeoutId)
          agentManager.removeSessionOutputListener(handler)
          reject(new AgentError(output.data || 'Agent error', ErrorCode.AGENT_PROCESS_ERROR))
          terminate('error')
        }
      }
    }

    agentManager.addSessionOutputListener(sessionId, handler)

    agentManager.sendCommand(sessionId, {
      type: 'implement',
      description: prompt,
      targetNodeId: '',
    }).catch((err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeoutId)
        agentManager.removeSessionOutputListener(handler)
        reject(err)
        terminate('error')
      }
    })
  })
}
