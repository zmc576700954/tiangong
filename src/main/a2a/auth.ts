/**
 * A2A server-side bearer token verification.
 *
 * Phase D9 C4. Constant-time comparison to prevent timing oracles
 * (per CLAUDE.md: BizGraph 不替换 Agent CLI 认证，但 server 端
 * 自己颁发的 Bearer Token 必须 constant-time 比对，防止本地 side channel)。
 *
 * 用法：
 *   verifyBearer(req.headers.authorization, config.apiKey)
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { BizGraphError, ErrorCode } from '../errors'

const BEARER_PREFIX = 'Bearer '

/**
 * 比较两个字符串是否相等（constant-time）。
 * 长度不等时返回 false，但仍执行一次等长 dummy 比较以保持 constant-time。
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Force a same-length comparison by padding with a dummy string of identical
    // length. We still return false unconditionally; the dummy work is just to
    // keep the time-to-completion roughly constant regardless of input length.
    const dummyA = Buffer.alloc(a.length)
    const dummyB = Buffer.alloc(a.length)
    timingSafeEqual(dummyA, dummyB)
    return false
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * 从 IncomingMessage 提取 Bearer Token；缺失或格式错误抛 A2A_UNAUTHORIZED。
 */
export function extractBearer(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header !== 'string') {
    throw new BizGraphError('Missing Authorization header', ErrorCode.A2A_UNAUTHORIZED)
  }
  if (!header.startsWith(BEARER_PREFIX)) {
    throw new BizGraphError('Authorization header must use Bearer scheme', ErrorCode.A2A_UNAUTHORIZED)
  }
  const token = header.slice(BEARER_PREFIX.length).trim()
  if (token.length === 0) {
    throw new BizGraphError('Bearer token is empty', ErrorCode.A2A_UNAUTHORIZED)
  }
  return token
}

/**
 * 校验请求的 Bearer Token 与配置的 expectedKey 是否匹配（constant-time）。
 * 不匹配抛 A2A_UNAUTHORIZED；不泄漏 expectedKey 长度给 attacker。
 */
export function verifyBearer(req: IncomingMessage, expectedKey: string): void {
  const provided = extractBearer(req)
  if (!safeEqual(provided, expectedKey)) {
    throw new BizGraphError('Invalid bearer token', ErrorCode.A2A_UNAUTHORIZED)
  }
}
