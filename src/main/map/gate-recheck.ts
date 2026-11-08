/**
 * tick 第 2 步的 gate 重跑端口（session-map 蓝图 §5.9.9）。
 *
 * 边界（§14 已裁决规格的落地端口）：
 * - fail-closed：评估不可用（未注入 / 抛异常 / 返回不合规）时一律
 *   `incomplete + ['gate_engine_unavailable']`，**不伪造 pass**。
 * - 生产默认实现是 G1–G6 引擎（gate-engine.ts）；`unavailableGateRecheck`
 *   保留为引擎装配失败时的兜底与测试注入点。
 * - 重跑结果与库里旧 `gate_status` 无关；唯一例外是人工豁免三字段
 *   （gate_waived_*）——那是人工事实输入，不是被重跑的缓存结论（§14.2）。
 */

import type { WorkItemRow } from './work-item-service'

/** 生产默认缺失项：gate 引擎不可用（不是任何具体验收项缺失）。 */
export const GATE_ENGINE_UNAVAILABLE = 'gate_engine_unavailable'

/** 人工豁免记录（存储层 gate_waived_* 三字段；缺任一即不成立）。 */
export interface GateWaiverInfo {
  by: string
  at: number
  reason: string
}

/** G1–G6 的单道评估结论（纯诊断，不参与准入判定）。 */
export interface GateDiagnosticGate {
  gate: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6'
  ok: boolean
  /** 该道的缺失码（ok=false 时非空，顺序与引擎输出一致）。 */
  missing: string[]
}

/**
 * 一次 gate 评估的逐道诊断快照（§14 / D12 修订：改为落可查载体，见 gate-diagnostics.ts）。
 * 只用于排查「第 N 道为什么没过」，不写 work_items 的用户可见状态。
 */
export interface GateDiagnostics {
  evaluatorVersion: string
  /** G4 阈值快照（评估当时的实际取值，便于事后复算）。 */
  thresholds?: { g4MaxFiles: number; g4MaxLines: number }
  gates: GateDiagnosticGate[]
}

export interface GateRecheckResult {
  ok: boolean
  /** ok=false 时必填：写入 work_items.gate_missing_json。 */
  missing: string[]
  /**
   * ok=true 且本次结论是「人工豁免视同通过」时非空（§14.6：仅 G2 manual 可豁免，
   * 由评估器判定、调度器复核三字段）。纯内容 pass 时保持 undefined，
   * 调度器据此不覆盖库里的 waived 记录。
   */
  waived?: GateWaiverInfo
  /** 逐道结果。实现可缺省（兜底/测试注入点）；生产引擎必定填。 */
  diagnostics?: GateDiagnostics
}

export interface GateRecheck {
  /**
   * 每次 claim 前重跑。实现**不得**读取或信任 `work_items.gate_status`，
   * 否则等于没有重跑（§5.9.9 第 2 步）。
   */
  recheck(item: WorkItemRow): GateRecheckResult
}

/** 兜底实现：引擎未装配 / 装配失败时一律不通过（生产已注入 createGateEngine）。 */
export const unavailableGateRecheck: GateRecheck = {
  recheck: () => ({ ok: false, missing: [GATE_ENGINE_UNAVAILABLE] }),
}
