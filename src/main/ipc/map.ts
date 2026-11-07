/**
 * Map IPC Handlers（S2）
 * 跨图链接的人工创建入口。§8.4 上线边界：L1 仅允许 relates_to（用于已确认的
 * 分支/副本关联），不提供"合并 lineage"入口（合并已被导入期拒绝替代，§2.6）。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { LinkService, LinkValidationError } from '../map-migration/link-service'
import { runLinkIntegrityCheck } from '../map-migration/link-backfill'
import type { TypedHandle } from './utils'

export function registerMapHandlers(typedHandle: TypedHandle, db: BetterSqlite3.Database): void {
  const links = new LinkService(db)

  typedHandle('map:link:create', async (_, data) => {
    const linkType = (data as { linkType?: string })?.linkType ?? 'relates_to'
    if (linkType !== 'relates_to') {
      // §8.4：L1 人工入口只开 relates_to；其余 link_type 由系统回填/派生路径产生
      throw new LinkValidationError('matrix_violation', 'L1 期间人工创建仅允许 relates_to（其余类型由系统路径产生）')
    }
    const d = data as {
      projectPath: string
      fromEntityKey: string
      fromGraphId: string
      toEntityKey: string
      toGraphId: string
      reason?: string
    }
    return links.create({
      projectPath: d.projectPath,
      linkType: 'relates_to',
      fromEntityKey: d.fromEntityKey,
      fromGraphId: d.fromGraphId,
      toEntityKey: d.toEntityKey,
      toGraphId: d.toGraphId,
      origin: 'human',
      reason: d.reason,
    })
  })

  // 巡检手动触发（§2.3.1：启动 + 每日 + 手动）
  typedHandle('admin:map:integrity-check', async () => {
    return runLinkIntegrityCheck(db)
  })
}
