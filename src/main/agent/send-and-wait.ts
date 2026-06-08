/**
 * 通过 AgentManager 发送 prompt 并等待完成
 * 输出会实时显示在 AgentChat 面板中
 *
 * 共享工具函数，供 mindmap IPC 和 GraphService 使用
 */

import type { AgentOutput, AgentSessionConfig } from '@shared/types'
import type { AgentManager } from './agent-manager'
import { AgentError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'

const logger = createLogger('sendPromptViaAgent')

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
        agentManager.removeOutputListener(handler)
        agentManager.terminateSession(sessionId).catch((err) => {
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

    const handler = (output: AgentOutput) => {
      if (output.type === 'stdout' || output.type === 'file_change') {
        chunks.push(output.data)
      }
      if (output.type === 'complete') {
        if (!settled) {
          settled = true
          clearTimeout(timeoutId)
          agentManager.removeOutputListener(handler)
          logger.info(`完成, 耗时 ${Math.round((Date.now() - startTime) / 1000)}s, 输出 ${chunks.length} 块`)
          resolve(chunks.join('\n'))
        }
      }
      if (output.type === 'error') {
        if (!settled) {
          settled = true
          clearTimeout(timeoutId)
          agentManager.removeOutputListener(handler)
          reject(new AgentError(output.data || 'Agent error', ErrorCode.AGENT_PROCESS_ERROR))
        }
      }
    }

    agentManager.addOutputListener(handler)

    agentManager.sendCommand(sessionId, {
      type: 'implement',
      description: prompt,
      targetNodeId: '',
    }).catch((err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeoutId)
        agentManager.removeOutputListener(handler)
        reject(err)
      }
    })
  })
}
