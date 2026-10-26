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
 *
 * 比较的是 **UTF-8 字节** 长度，不是 JS 字符长度：字符数相同但字节数不同的
 * 字符串（例如 16 个 ASCII 字符 vs 16 个多字节字符）会让 timingSafeEqual 抛
 * ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，而不是返回 false。
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) {
    // Force a same-length comparison by padding with a dummy buffer of identical
    // length. We still return false unconditionally; the dummy work is just to
    // keep the time-to-completion roughly constant regardless of input length.
    const dummy = Buffer.alloc(bufA.length)
    timingSafeEqual(dummy, dummy)
    return false
  }
  return timingSafeEqual(bufA, bufB)
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
