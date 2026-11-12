// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScopeEditor } from '../ScopeEditor'

/**
 * 范围编辑器的「冻结」态。
 *
 * 背景：主进程在 startSession 时就把范围**冻结**了 —— 复用会话时新算出来的
 * config 会被丢弃。所以会话在跑时：
 * - 面板必须显示**会话启动时**的范围（否则「面板说只读、会话仍可写」）
 * - 编辑必须禁用（改了对在跑的会话不生效）
 */

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (k: string) => k, locale: 'zh-CN' }),
}))

describe('ScopeEditor — 会话运行中的冻结态', () => {
  it('冻结时给出说明', () => {
    render(
      <ScopeEditor
        effectiveFiles={['src/a.ts']}
        readonly={false}
        adapterSupportsReadonly
        frozen
        onAddFile={() => {}}
        onRemoveFile={() => {}}
        onClearAll={() => {}}
      />,
    )
    expect(screen.getByTestId('scope-editor-frozen')).toBeTruthy()
  })

  it('冻结时隐藏「添加文件」与「清空全部」（改了也不对在跑的会话生效）', () => {
    render(
      <ScopeEditor
        effectiveFiles={['src/a.ts']}
        readonly={false}
        adapterSupportsReadonly
        frozen
        onAddFile={() => {}}
        onRemoveFile={() => {}}
        onClearAll={() => {}}
      />,
    )
    expect(screen.queryByTestId('scope-editor-open-scope')).toBeNull()
    expect(screen.queryByTestId('scope-editor-clear-all')).toBeNull()
  })

  it('冻结时只读态也不显示「放开范围」', () => {
    render(
      <ScopeEditor
        effectiveFiles={[]}
        readonly
        adapterSupportsReadonly
        frozen
        onAddFile={() => {}}
        onRemoveFile={() => {}}
        onClearAll={() => {}}
      />,
    )
    expect(screen.getByTestId('scope-editor-readonly')).toBeTruthy()
    expect(screen.queryByTestId('scope-editor-open-scope')).toBeNull()
  })

  it('未冻结时编辑入口都在', () => {
    render(
      <ScopeEditor
        effectiveFiles={['src/a.ts']}
        readonly={false}
        adapterSupportsReadonly
        onAddFile={() => {}}
        onRemoveFile={() => {}}
        onClearAll={() => {}}
      />,
    )
    expect(screen.queryByTestId('scope-editor-frozen')).toBeNull()
    expect(screen.getByTestId('scope-editor-open-scope')).toBeTruthy()
    expect(screen.getByTestId('scope-editor-clear-all')).toBeTruthy()
  })
})
