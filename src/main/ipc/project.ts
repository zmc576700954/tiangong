/**
 * Project IPC Handlers
 * 项目扫描、分析、导入查重（S1 §2.6）
 */

import { ProjectScanner } from '../project-scanner'
import type { GraphService } from '../services/graph-service'
import type { ChatService } from '../services/chat-service'
import type BetterSqlite3 from 'better-sqlite3'
import { ImportDedupService } from '../map-migration/import-dedup'
import { validateProjectPath } from './utils'
import type { TypedHandle } from './utils'

export function registerProjectHandlers(
  typedHandle: TypedHandle,
  graphService: GraphService,
  _chatService?: ChatService,
  db?: BetterSqlite3.Database,
): void {
  typedHandle('project:scan', async (_, projectPath) => {
    const validatedPath = validateProjectPath(projectPath)
    const scanner = new ProjectScanner()
    return scanner.scan(validatedPath)
  })

  typedHandle('graph:initFromProject', async (_, data) => {
    // 校验 projectPath
    const validatedPath = validateProjectPath(data.projectPath)
    // §9.2 project:import:confirm：allowed_branch 与 remember_for_fingerprint
    // 由用户显式勾选传入；自动导入（未勾选）在判定层 3a-auto 一律拒绝（§2.6 规则 5）。
    graphService.setImportOptions({
      interactive: data.allowBranchVariant === true,
      rememberAllowance: data.rememberForFingerprint === true,
    })
    return graphService.initFromProject({ ...data, projectPath: validatedPath })
  })

  // §9.2 project:import:preview：导入前返回指纹命中证据（不写库,供确认框展示）
  typedHandle('project:import:preview', async (_, data) => {
    const d = (data ?? {}) as { projectPath?: unknown; projectName?: unknown }
    if (typeof d.projectPath !== 'string') throw new Error('projectPath is required')
    const validatedPath = validateProjectPath(d.projectPath)
    if (!db) throw new Error('db unavailable')
    const dedup = new ImportDedupService(db)
    const { decision, fingerprint } = await dedup.check({
      projectRoot: validatedPath,
      projectName: typeof d.projectName === 'string' ? d.projectName : undefined,
      interactive: true,
      preview: true,
    })
    return { decision, signals: decision.signals, reason: decision.reason, dirName: fingerprint.dirName }
  })

  // ---- S1：记住的分支/副本放行规则（可查看、可撤销；§2.6 规则 7）----
  if (db) {
    const dedup = new ImportDedupService(db)
    typedHandle('project:import:allowance:list', async () => {
      return dedup.listAllowances()
    })
    typedHandle('project:import:allowance:revoke', async (_, id: unknown, revokedBy: unknown) => {
      if (typeof id !== 'string' || id === '') throw new Error('allowance id is required')
      dedup.revokeAllowance(id, typeof revokedBy === 'string' && revokedBy !== '' ? revokedBy : 'local-user')
    })
  }
}
