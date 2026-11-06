/**
 * 故意破坏开关。仅用于证明测试不是摆设：
 * 同一套断言在 SPIKE_MUTATION=xxx 下必须变红。
 */
export type Mutation =
  | 'none'
  | 'seq-gap'
  | 'drop-tool-events'
  | 'no-orphan-sweep'
  | 'optimistic-recovery'
  | 'no-lock'
  | 'no-reentry'
  | 'no-unique-index'
  | 'slow-lock'
  | 'approval-overwrite'
  | 'approval-always-allow'

export function mutation(): Mutation {
  return (process.env.SPIKE_MUTATION as Mutation | undefined) ?? 'none'
}
