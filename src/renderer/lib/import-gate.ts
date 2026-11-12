/**
 * 导入查重的「走哪条门」判定（纯函数，便于验收）。
 *
 * 背景：主进程 `graph:initFromProject` 的查重门禁在**写入之前**判定，命中即
 * 拒绝；唯一能放行分支/副本的开关是调用方显式传 `allowBranchVariant: true`。
 * 界面不传 → 这条路径永远是死的，且用户只看到"点了没反应"。
 *
 * 这里把「什么情况可以直接导入 / 什么情况必须问用户 / 什么情况根本不能导」
 * 固化成三分，renderer 只按结果走，避免把判定散落在组件里：
 * - proceed：无冲突或已由记住的规则放行，不必打扰用户
 * - confirm：需要用户显式确认（分支/副本；或同名但内容差异大）
 * - blocked：硬拒绝，服务端不可绕过，界面只解释原因
 */

import type { ImportPreviewResult } from '@shared/types/ipc'

export type ImportGate = 'proceed' | 'confirm' | 'blocked'

export function decideImportGate(preview: ImportPreviewResult): ImportGate {
  switch (preview.action) {
    case 'allow':
    case 'allow_rebuild':
      return 'proceed'
    case 'allow_branch_variant':
      // 命中「记住的放行规则」时无需再确认，但界面仍应知道这次是规则放行的。
      return preview.remembered ? 'proceed' : 'confirm'
    case 'allow_with_warning':
      return 'confirm'
    case 'reject':
      return 'blocked'
    default:
      // 未知动作按最保守处理：不静默导入，也不谎称可以导。
      return 'blocked'
  }
}
