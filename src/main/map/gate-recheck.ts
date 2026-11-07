/**
 * tick 第 2 步的 gate 重跑端口（session-map 蓝图 §5.9.9）。
 *
 * 边界（裁决 A）：
 * - 生产默认实现 fail-closed：G1–G6 gate 引擎尚未落地，因此每次 claim 前都返回
 *   `incomplete + ['gate_engine_unavailable']`。**不伪造 pass**，也不把「复核已落库
 *   的 gate_status」冒充「重跑 gate」。
 * - 代价：G1–G6 落地前所有 queued item 会被 tick 挡在 `blocked`，真实执行不可达。
 *   这一点必须如实记录，不得描述成「已可用」。
 * - 测试/后续里程碑可注入真实实现；重跑结果与库里旧值无关。
 */

import type { WorkItemRow } from './work-item-service'

/** 生产默认缺失项：gate 引擎不可用（不是任何具体验收项缺失）。 */
export const GATE_ENGINE_UNAVAILABLE = 'gate_engine_unavailable'

export interface GateRecheckResult {
  ok: boolean
  /** ok=false 时必填：写入 work_items.gate_missing_json。 */
  missing: string[]
}

export interface GateRecheck {
  /**
   * 每次 claim 前重跑。实现**不得**读取或信任 `work_items.gate_status`，
   * 否则等于没有重跑（§5.9.9 第 2 步）。
   */
  recheck(item: WorkItemRow): GateRecheckResult
}

/** 生产默认：gate 引擎未实施，一律不通过（fail-closed）。 */
export const unavailableGateRecheck: GateRecheck = {
  recheck: () => ({ ok: false, missing: [GATE_ENGINE_UNAVAILABLE] }),
}
