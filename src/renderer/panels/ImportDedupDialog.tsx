/**
 * 导入查重确认框（S1 §2.6 / §9.2）。
 *
 * 为什么要有这个框：主进程的查重门禁在**任何图写入之前**判定，命中即拒绝并落
 * `import_rejections`。但确认路径（`allow_branch_variant`）要求调用方显式传
 * `allowBranchVariant: true`——界面不传，这条路径就是死的：同一仓库的分支/副本
 * 永远导不进来，而且用户看不到"为什么"。这里把判定证据摆出来，并给出唯一合法的
 * 三个出口：取消 / 确认（分支变体必须先勾选）/ 关闭（硬拒绝无出口）。
 *
 * 边界：本框只**展示**主进程给的判定，不自己算相似度、不改阈值；
 * 硬拒绝（step 1 / 2a / 3b / 4a）在服务端不可绕过，这里也不提供"强行导入"。
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, GitBranch, ShieldAlert, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import type { ImportAllowanceRow, ImportPreviewResult } from '@shared/types/ipc'
import { readIpcError } from '../lib/ipc-error'

const ipc = typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null

export interface ImportConfirmOptions {
  allowBranchVariant: boolean
  rememberForFingerprint: boolean
}

interface ImportDedupDialogProps {
  open: boolean
  projectName: string
  preview: ImportPreviewResult | null
  busy?: boolean
  onCancel: () => void
  onConfirm: (options: ImportConfirmOptions) => void
  /** 撤销放行规则后通知外层（例如刷新提示）。 */
  onAllowanceRevoked?: () => void
}

function percent(value: number | null): string {
  return value == null ? '未取得（采样失败）' : `${Math.round(value * 100)}%`
}

function nameSameText(value: boolean | null): string {
  if (value === true) return '相同'
  if (value === false) return '不同'
  return '未知（一侧没有项目名）'
}

export function ImportDedupDialog({
  open,
  projectName,
  preview,
  busy,
  onCancel,
  onConfirm,
  onAllowanceRevoked,
}: ImportDedupDialogProps) {
  const [branchAck, setBranchAck] = useState(false)
  const [remember, setRemember] = useState(false)
  const [allowances, setAllowances] = useState<ImportAllowanceRow[]>([])
  const [allowanceError, setAllowanceError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const action = preview?.action ?? 'allow'

  // 每次打开都重置勾选：上一次的「我确认过」不能顺延到另一次导入。
  useEffect(() => {
    if (!open) return
    setBranchAck(false)
    setRemember(false)
    setAllowanceError(null)
  }, [open, preview?.step, preview?.dirName])

  const loadAllowances = useCallback(async () => {
    if (!ipc) return
    try {
      const rows = await ipc['project:import:allowance:list']()
      setAllowances(rows)
      setAllowanceError(null)
    } catch (err) {
      // 读不到规则不能伪装成「没有规则」——否则用户会以为记住的放行丢了。
      setAllowances((prev) => prev)
      setAllowanceError(readIpcError(err).message)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadAllowances()
  }, [open, loadAllowances])

  const revoke = useCallback(
    async (id: string) => {
      if (!ipc) return
      setRevokingId(id)
      try {
        await ipc['project:import:allowance:revoke'](id, 'local-user')
        await loadAllowances()
        onAllowanceRevoked?.()
      } catch (err) {
        setAllowanceError(readIpcError(err).message)
      } finally {
        setRevokingId(null)
      }
    },
    [loadAllowances, onAllowanceRevoked],
  )

  if (!preview) return null

  const isReject = action === 'reject'
  const isBranch = action === 'allow_branch_variant' && !preview.remembered
  const isWarning = action === 'allow_with_warning'

  const title = isReject
    ? '无法导入：命中了已有项目'
    : isBranch
      ? '导入前确认：疑似同一仓库的分支或副本'
      : '导入前确认：同名目录，内容差异较大'

  const icon = isReject ? (
    <ShieldAlert className="w-4 h-4 text-destructive" />
  ) : isBranch ? (
    <GitBranch className="w-4 h-4 text-amber-600" />
  ) : (
    <AlertTriangle className="w-4 h-4 text-amber-600" />
  )

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent
        className="max-w-md"
        data-testid="import-dedup-dialog"
        closeLabel="关闭"
        // 说明文字是自绘的裸 <p>（基础 dialog 未导出 Description），显式声明
        // 无障碍描述由标题+正文承担，避免 Radix 打 "Missing Description" 警告。
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm" data-testid="import-dedup-title">
            {icon}
            {title}
          </DialogTitle>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium">{projectName}</span>
            {' · '}
            {preview.reason}
          </p>
        </DialogHeader>

        {/* 命中证据：全部来自主进程，界面不复算 */}
        <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1.5 text-xs" data-testid="import-dedup-signals">
          <dt className="text-muted-foreground">目录名</dt>
          <dd>
            {preview.dirName}
            {preview.signals.dirNameSame ? '（与已有项目同名）' : '（与已有项目不同名）'}
          </dd>
          <dt className="text-muted-foreground">项目名</dt>
          <dd>{nameSameText(preview.signals.nameSame)}</dd>
          <dt className="text-muted-foreground">内容相似度</dt>
          <dd>
            {percent(preview.signals.similarity)}
            <span className="text-muted-foreground">（重复 ≥ 60%，分支/副本 ≥ 80%）</span>
          </dd>
          <dt className="text-muted-foreground">采样文件</dt>
          <dd>{preview.signals.sampleCount} 个</dd>
          <dt className="text-muted-foreground">判定步骤</dt>
          <dd>{preview.step}</dd>
        </dl>

        {isBranch && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-2.5 text-xs">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                data-testid="import-branch-ack"
                checked={branchAck}
                onChange={(e) => setBranchAck(e.target.checked)}
              />
              <span>
                我确认这是同一仓库的<b>分支或副本</b>，按「新 lineage」导入（不会与已有项目合并）。
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                data-testid="import-remember"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className="text-muted-foreground">
                记住这条放行（只对「该指纹 + 该目录名」生效，可随时在下表撤销）
              </span>
            </label>
          </div>
        )}

        {isWarning && (
          <p className="rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
            同名目录但内容差异较大，可能是另一个项目；继续将按新项目导入。
          </p>
        )}

        {isReject && (
          <p className="rounded-md bg-destructive/10 p-2 text-[11px] text-destructive" data-testid="import-reject-note">
            这是硬拒绝（重复导入会产生第二套 lineage），服务端不允许强行放行。
            若确属分支/副本，请让目录名不同并保持内容相似度 ≥ 80% 后再导入。
          </p>
        )}

        {/* 放行规则：可查看、可撤销（§2.6 规则 7） */}
        <section className="border-t pt-2" data-testid="import-allowance-section">
          <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
            已记住的放行规则（{allowances.length}）
          </h4>
          {allowanceError && (
            <p className="text-[11px] text-destructive mb-1" data-testid="import-allowance-error">
              读取失败：{allowanceError}
            </p>
          )}
          {allowances.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              暂无。勾选「记住这条放行」后，同目录名的分支/副本会直接放行。
            </p>
          ) : (
            <ul className="space-y-1 max-h-28 overflow-y-auto">
              {allowances.map((row) => (
                <li
                  key={row.id}
                  data-testid={`import-allowance-${row.id}`}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-[11px]"
                >
                  <span className="truncate" title={row.rootPath ?? undefined}>
                    {row.dirName}
                    {row.projectName ? ` ← ${row.projectName}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => void revoke(row.id)}
                    disabled={revokingId === row.id}
                    className="shrink-0 flex items-center gap-1 text-destructive hover:underline disabled:opacity-50"
                    data-testid={`import-allowance-revoke-${row.id}`}
                  >
                    <Trash2 className="w-3 h-3" />
                    撤销
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <DialogFooter className="gap-2">
          {isReject ? (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded border hover:bg-muted"
              data-testid="import-dedup-close"
            >
              关闭
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="px-3 py-1.5 text-xs rounded border hover:bg-muted disabled:opacity-50"
                data-testid="import-dedup-cancel"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() =>
                  onConfirm({
                    allowBranchVariant: isBranch,
                    rememberForFingerprint: isBranch && remember,
                  })}
                disabled={busy || (isBranch && !branchAck)}
                title={isBranch && !branchAck ? '需要先确认这是分支/副本' : undefined}
                className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="import-dedup-confirm"
              >
                {busy ? '导入中…' : isBranch ? '确认导入' : '继续导入'}
              </button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
