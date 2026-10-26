/**
 * A2A Client — 远端 endpoint SSRF 防护
 *
 * Phase D9 C5. 设计要点：
 *   - 拒绝 RFC1918 / RFC4193 / link-local / CGNAT / loopback（除非 devAllowLocalhost）
 *   - 拒绝 file:// / ftp:// / ws:// 等非 http(s) scheme
 *   - 拒绝非 80/443 的非 http(s) 端口
 *   - 每次 call 时再次解析 hostname → IP（60s 缓存），防止 DNS rebinding
 *   - 仅当所有解析到的 IP 都安全时放行；任一不安全即拒
 *
 * 与 CLAUDE.md Boundaries 配套：
 *   - IPC 路径校验不替代 OS 级沙箱；本模块为 BizGraph 内部边界
 *   - 远端 agent 写入需经 ScopeGuard 兜底（沿用 AgentManager.startSession 路径）
 */

import { lookup, type LookupAddress } from 'node:dns'
import { URL } from 'node:url'
import { BizGraphError, ErrorCode } from '../errors'
import { A2A_DNS_CACHE_MS } from '@shared/types/a2a'

interface CacheEntry {
  addresses: string[]
  expiresAt: number
}

const dnsCache = new Map<string, CacheEntry>()

async function resolveHost(host: string): Promise<string[]> {
  const cached = dnsCache.get(host)
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.addresses
  }
  return new Promise((resolve, reject) => {
    lookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err) {
        reject(new BizGraphError(`DNS lookup failed for ${host}: ${err.message}`, ErrorCode.A2A_REMOTE_UNREACHABLE))
        return
      }
      const addresses = addrs.map((a: LookupAddress) => a.address)
      dnsCache.set(host, { addresses, expiresAt: Date.now() + A2A_DNS_CACHE_MS })
      resolve(addresses)
    })
  })
}

/**
 * 判断 IPv4 / IPv6 是否属于受保护的内网 / loopback / link-local 范围。
 *  涵盖：RFC1918 (10/8, 172.16/12, 192.168/16), RFC4193 (fc00::/7),
 *       link-local (169.254/16, fe80::/10), CGNAT (100.64/10),
 *       loopback (127/8, ::1), 0.0.0.0/8, multicast (224/4, ff00::/8)。
 */
export function isPrivateOrLoopbackIp(addr: string): boolean {
  // IPv6 — handle common special ranges first.
  if (addr.includes(':')) {
    const lower = addr.toLowerCase().split('%')[0] // strip zone id
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // link-local
    if (lower.startsWith('ff')) return true // multicast
    return false
  }
  // IPv4
  const parts = addr.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true // malformed
  const [a, b] = parts
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 0) return true // 0.0.0.0/8
  if (a >= 224 && a <= 239) return true // multicast
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

export interface AssertSafeEndpointOptions {
  /** 显式允许连接 127.0.0.1 / ::1（仅开发环境） */
  devAllowLocalhost?: boolean
}

/**
 * 校验远端 endpoint URL 是否安全：
 *   - scheme ∈ {http, https}
 *   - host 不是任何内网 / loopback / link-local IP（除非 devAllowLocalhost）
 *   - DNS 解析后的所有 IP 都安全（防 DNS rebinding）
 */
export async function assertSafeEndpoint(
  endpoint: string,
  options: AssertSafeEndpointOptions = {},
): Promise<void> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new BizGraphError(`Invalid endpoint URL: ${endpoint}`, ErrorCode.A2A_BAD_REQUEST)
  }

  // Scheme guard
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BizGraphError(`Unsupported scheme: ${url.protocol}`, ErrorCode.A2A_SSRF_BLOCKED)
  }

  // Host: literal IP or hostname
  const host = url.hostname
  let ips: string[]
  if (isIpLiteral(host)) {
    ips = [host]
  } else {
    ips = await resolveHost(host)
  }

  for (const ip of ips) {
    if (isPrivateOrLoopbackIp(ip)) {
      // loopback is OK only with explicit devAllowLocalhost
      const isLoopback = ip === '127.0.0.1' || ip === '::1'
      if (isLoopback && options.devAllowLocalhost === true) continue
      throw new BizGraphError(
        `Endpoint ${host} resolves to ${ip}, which is in a private/loopback range (devAllowLocalhost=${options.devAllowLocalhost === true})`,
        ErrorCode.A2A_SSRF_BLOCKED,
      )
    }
  }
}

function isIpLiteral(host: string): boolean {
  // Crude but sufficient: contains only digits, dots, colons, hex, and %.
  return /^[0-9a-fA-F:.%]+$/.test(host)
}

/** 同步校验（仅看 scheme + 已知 IP literal；不查 DNS）。用于 settings 保存时。 */
export function assertSafeEndpointSync(endpoint: string, options: AssertSafeEndpointOptions = {}): void {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new BizGraphError(`Invalid endpoint URL: ${endpoint}`, ErrorCode.A2A_BAD_REQUEST)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BizGraphError(`Unsupported scheme: ${url.protocol}`, ErrorCode.A2A_SSRF_BLOCKED)
  }
  const host = url.hostname
  if (isIpLiteral(host) && isPrivateOrLoopbackIp(host)) {
    const isLoopback = host === '127.0.0.1' || host === '::1'
    if (isLoopback && options.devAllowLocalhost === true) return
    throw new BizGraphError(
      `Endpoint IP ${host} is in a private/loopback range`,
      ErrorCode.A2A_SSRF_BLOCKED,
    )
  }
  // Hostname (non-IP) is allowed at save time; the async assertSafeEndpoint
  // will resolve and block on actual call.
}
