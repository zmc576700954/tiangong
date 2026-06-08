/**
 * CJK 感知的 Token 估算
 * 中文约 1.5 字符/token，英文约 4 字符/token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[一-鿿]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5 + other / 4)
}
