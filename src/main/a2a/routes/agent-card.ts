/**
 * GET /.well-known/agent-card.json — 返回本机 AgentCard
 *
 * Phase D9 C4. 无需鉴权（A2A spec 要求 discovery endpoint 必须开放）。
 * 返回 ServerConfig 中配置的 agentCard 字段。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { encodeAgentCard } from '../codec'
import type { A2AAgentCard } from '@shared/types/a2a'

export function handleAgentCard(
  _req: IncomingMessage,
  res: ServerResponse,
  card: A2AAgentCard,
): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(encodeAgentCard(card))
}
