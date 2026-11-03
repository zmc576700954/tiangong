import { describe, it, expect } from 'vitest'
import { computeScope } from '../scope'
import { fromRelative } from '../project-paths'
import { resolveReadonly } from '@shared/readonly'

/**
 * 渲染层与主进程必须对「这次会话是不是只读」给出**同一个答案**。
 *
 * 背景：渲染层算自己的只读判定、主进程收到 config 后又算一次。两边各写
 * 一遍「空即只读」的话，改了一边另一边不跟着变 —— 界面就会显示「本次只读」
 * 而会话其实可写（或者反过来）。
 *
 * 这条测试把两段**真的接在一起**：渲染层算出的范围 → 变成发出去的
 * `allowedFiles` → 交给**主进程同一份** `resolveReadonly` 判定。
 */

const PROJ = '/work/proj'

/** 模拟一次发送：渲染层算范围 → 组成 config → 主进程判定 */
function endToEnd(input: {
  projectDefaults: { allowedFiles?: string[] } | null
  sessionScope: string[]
  referencedFiles: string[]
}) {
  const scope = computeScope({
    projectPath: PROJ,
    projectDefaults: input.projectDefaults,
    sessionScope: input.sessionScope,
    referencedFiles: input.referencedFiles,
  })
  // 渲染层实际发出去的 config（见 AgentChatPanel.handleSend）
  const config = {
    workingDirectory: PROJ,
    allowedFiles: scope.relativeFiles.map((rel) => fromRelative(PROJ, rel)),
  }
  return {
    shownReadonly: scope.readonly,
    mainProcessReadonly: resolveReadonly(config),
    allowedFiles: config.allowedFiles,
  }
}

describe('渲染层与主进程的只读判定一致', () => {
  it('范围为空 → 两边都判只读', () => {
    const r = endToEnd({ projectDefaults: null, sessionScope: [], referencedFiles: [] })
    expect(r.shownReadonly).toBe(true)
    expect(r.mainProcessReadonly).toBe(true)
    expect(r.allowedFiles).toEqual([])
  })

  it('项目级默认有内容 → 两边都判可写', () => {
    const r = endToEnd({
      projectDefaults: { allowedFiles: ['src/a.ts'] },
      sessionScope: [],
      referencedFiles: [],
    })
    expect(r.shownReadonly).toBe(false)
    expect(r.mainProcessReadonly).toBe(false)
    expect(r.allowedFiles).toEqual(['/work/proj/src/a.ts'])
  })

  it('只有 @ 引用 → 两边都判可写（引用文件也要进 allowedFiles）', () => {
    const r = endToEnd({
      projectDefaults: null,
      sessionScope: [],
      referencedFiles: ['/work/proj/src/a.ts'],
    })
    expect(r.shownReadonly).toBe(false)
    expect(r.mainProcessReadonly).toBe(false)
  })

  it('只有本次会话加的 → 两边都判可写', () => {
    const r = endToEnd({
      projectDefaults: null,
      sessionScope: ['src/a.ts'],
      referencedFiles: [],
    })
    expect(r.shownReadonly).toBe(false)
    expect(r.mainProcessReadonly).toBe(false)
  })

  it('各种组合下两边判定都相同', () => {
    const cases = [
      { projectDefaults: null, sessionScope: [], referencedFiles: [] },
      { projectDefaults: { allowedFiles: [] }, sessionScope: [], referencedFiles: [] },
      { projectDefaults: { allowedFiles: ['a.ts'] }, sessionScope: [], referencedFiles: [] },
      { projectDefaults: { allowedFiles: ['a.ts'] }, sessionScope: ['b.ts'], referencedFiles: [] },
      { projectDefaults: null, sessionScope: [], referencedFiles: ['/work/proj/c.ts'] },
      { projectDefaults: null, sessionScope: [], referencedFiles: ['/outside/x.ts'] },
    ]
    for (const c of cases) {
      const r = endToEnd(c)
      expect(r.shownReadonly, JSON.stringify(c)).toBe(r.mainProcessReadonly)
    }
  })
})
