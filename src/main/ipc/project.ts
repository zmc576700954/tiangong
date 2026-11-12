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
import type { ImportAllowanceRow, ImportPreviewResult } from '@shared/types/ipc'
import { IpcError } from '../errors'
import { ErrorCode } from '../errors'
import type { ProjectSettingsRepository } from '../repositories/project-settings-repository'
import type { ProjectDefaults } from '@shared/types'
import { isPathWithinResolved } from '../shared/path-utils'
import path from 'node:path'

export function registerProjectHandlers(
  typedHandle: TypedHandle,
  graphService: GraphService,
  _chatService?: ChatService,
  db?: BetterSqlite3.Database,
  projectSettingsRepo?: ProjectSettingsRepository,
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
    // 选项随本次调用传入（不写在服务上），一次勾选不会变成永久开关。
    return graphService.initFromProject(
      { ...data, projectPath: validatedPath },
      {
        interactive: data.allowBranchVariant === true,
        rememberAllowance: data.rememberForFingerprint === true,
      },
    )
  })

  // §9.2 project:import:preview：导入前返回指纹命中证据（不写库,供确认框展示）
  typedHandle('project:import:preview', async (_, data): Promise<ImportPreviewResult> => {
    const d = (data ?? {}) as { projectPath?: unknown; projectName?: unknown }
    if (typeof d.projectPath !== 'string') throw new Error('projectPath is required')
    const validatedPath = validateProjectPath(d.projectPath)
    if (!db) throw new Error('db unavailable')
    const dedup = new ImportDedupService(db)
    const { decision, fingerprint } = await dedup.check({
      projectRoot: validatedPath,
      projectName: typeof d.projectName === 'string' ? d.projectName : undefined,
      // 预览一律按「用户会显式确认」判定：这样 3a 得到 allow_branch_variant（可放行待确认），
      // 而不是 3a-auto 的硬拒绝。硬拒绝（1/2a/3b/4a）不受此开关影响。
      interactive: true,
      preview: true,
    })
    return {
      action: decision.action,
      step: decision.step,
      reason: decision.reason,
      dirName: fingerprint.dirName,
      // 落库口径是下划线（MatchedSignals），出口统一驼峰，避免 renderer 绑定底层列名。
      signals: {
        dirNameSame: decision.signals.dir_name_same,
        nameSame: decision.signals.name_same,
        similarity: decision.signals.similarity,
        sampleCount: decision.signals.sample_count,
      },
      remembered: decision.step === '3a-remembered',
    }
  })

  // ---- S1：记住的分支/副本放行规则（可查看、可撤销；§2.6 规则 7）----
  if (db) {
    const dedup = new ImportDedupService(db)
    typedHandle('project:import:allowance:list', async (): Promise<ImportAllowanceRow[]> => {
      // 只返回生效中的规则：已撤销的留行作审计，但不在「当前放行谁」里出现。
      return dedup
        .listAllowances()
        .filter((row) => row.revoked_at == null)
        .map((row) => ({
          id: String(row.id),
          fingerprintId: String(row.fingerprint_id),
          dirName: String(row.dir_name),
          projectName: typeof row.project_name === 'string' ? row.project_name : null,
          rootPath: typeof row.root_path === 'string' ? row.root_path : null,
          grantedBy: typeof row.granted_by === 'string' ? row.granted_by : null,
          grantedAt: typeof row.granted_at === 'string' ? row.granted_at : null,
        }))
    })
    typedHandle('project:import:allowance:revoke', async (_, id: unknown, revokedBy: unknown) => {
      if (typeof id !== 'string' || id === '') throw new Error('allowance id is required')
      dedup.revokeAllowance(id, typeof revokedBy === 'string' && revokedBy !== '' ? revokedBy : 'local-user')
    })
  }

  /**
   * 项目路径必须是**已登记的项目根**。
   *
   * `validateProjectPath` 只拦系统目录与 root/home，不检查这个路径是不是
   * BizGraph 打开过的项目 —— 与 fs 家族的边界模型不一致（fs 家族用
   * `isUnderProject` 卡这一层）。这里补上同样的一道。
   */
  const requireRegisteredProject = async (projectPath: string): Promise<string> => {
    const validated = validateProjectPath(projectPath)
    const projectRoots = await graphService.getProjectPaths()
    const normalized = path.resolve(validated)
    const isUnderProject = projectRoots.some((root) =>
      isPathWithinResolved(path.resolve(root), normalized),
    )
    if (!isUnderProject) {
      throw new IpcError(
        'Access denied: path is not a registered project directory',
        ErrorCode.IPC_ACCESS_DENIED,
      )
    }
    return validated
  }

  // 项目级默认（适配器 / 模型 / 可改文件范围）。
  typedHandle('project:getDefaults', async (_, projectPath) => {
    if (!projectSettingsRepo) return null
    const validatedPath = await requireRegisteredProject(projectPath)
    return projectSettingsRepo.get(validatedPath) ?? null
  })

  typedHandle('project:setDefaults', async (_, projectPath, defaults: ProjectDefaults) => {
    if (!projectSettingsRepo) return
    const validatedPath = await requireRegisteredProject(projectPath)
    projectSettingsRepo.set(validatedPath, defaults)
  })
}
