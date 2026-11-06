/**
 * Runtime 基础工具：确定性序列化、argsHash、本地日键、id。
 * 不引入任何第三方依赖。
 */

import { createHash, randomUUID } from 'node:crypto'

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/** 稳定序列化：对象键排序，保证同一参数不同键序得到同一 hash。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function hashArgs(toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${toolName}\n${stableStringify(args)}`).digest('hex')
}

/**
 * 本地日键。**时区固定为 Asia/Shanghai**（不随运行机器时区漂移）：
 * 额度/成本按「本地日」切分，跨机器/跨时区必须得到同一 day_key，
 * 否则同一笔用量在不同机器上落入不同日账（见 agent-architecture.md 成本账本节）。
 */
const DAY_KEY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function localDayKey(timestamp: number = Date.now()): string {
  return DAY_KEY_FORMATTER.format(new Date(timestamp))
}

/** 事件 id 由内容与序号共同决定，便于测试断言稳定。 */
export function eventIdFor(turnId: string, seq: number): string {
  return `evt_${turnId}_${String(seq).padStart(6, '0')}`
}
