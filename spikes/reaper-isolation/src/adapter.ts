/**
 * 被测实现的唯一适配层。
 *
 * 测试只依赖本文件导出的 `ReaperUnderTest` 形状与 `createReaper()`，
 * **不直接 import 任何内部实现细节**。D5 重写后若公开导出有变化，只需改这一处。
 *
 * 当前实现 = `src/main/agent/runtime/process/reaper.ts` 的公开导出 `ProcessReaper`
 * （只读引用，本测试台不修改 `src/**`）。
 *
 * 切换实现（用于对抗对照）：环境变量 `REAPER_IMPL`
 *   - current（默认）
 *   - sabotage:shared-registry | sabotage:bare-pid | sabotage:group-wide
 */
import {
  ProcessReaper,
  type ProcIdentity,
  type ProcInfo,
  type ReapReport,
} from '../../../src/main/agent/runtime/process/reaper'
import { createSabotageReaper } from './sabotage'

export type { ProcIdentity, ProcInfo, ReapReport }

export interface RegisterInput {
  pid?: number
  pgid?: number
  envMarker?: string
}

export interface ReaperUnderTest {
  readonly implId: string
  register(turnId: string, proc: RegisterInput): ProcIdentity | undefined
  reap(turnId: string): ReapReport
  killRegistered(expected: ProcIdentity[], options?: { marker?: string }): ReapReport
  forget(turnId: string): void
  residualCount(marker: string): number
  scanResidual(marker: string): ProcInfo[]
}

class CurrentReaper implements ReaperUnderTest {
  readonly implId = 'current'
  private readonly inner: ProcessReaper

  constructor() {
    this.inner = new ProcessReaper()
  }

  register(turnId: string, proc: RegisterInput): ProcIdentity | undefined {
    return this.inner.registerProcess(turnId, proc)
  }

  reap(turnId: string): ReapReport {
    return this.inner.reap(turnId)
  }

  killRegistered(expected: ProcIdentity[], options: { marker?: string } = {}): ReapReport {
    return this.inner.killRegistered(expected, options)
  }

  forget(turnId: string): void {
    this.inner.forget(turnId)
  }

  residualCount(marker: string): number {
    return this.inner.residualCount(marker)
  }

  scanResidual(marker: string): ProcInfo[] {
    return this.inner.scanResidual(marker)
  }
}

export const IMPL_ID = process.env.REAPER_IMPL ?? 'current'

/** 每次调用返回新的实例：C3「崩溃后新进程清扫」需要模拟重启。 */
export function createReaper(): ReaperUnderTest {
  if (IMPL_ID === 'current') return new CurrentReaper()
  return createSabotageReaper(IMPL_ID)
}
