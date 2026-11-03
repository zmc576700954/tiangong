// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScopeEditor } from '../ScopeEditor'

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({ t: (k: string, vars?: Record<string, unknown>) => {
    const suffix = vars?.count !== undefined ? `:${vars.count}` : ''
    return `${k}${suffix}`
  }, locale: 'zh-CN' }),
}))

describe('ScopeEditor — 文件范围三态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('只读态：说明「Agent 不能修改文件」并给出放开范围的入口', () => {
    render(
      <ScopeEditor
        effectiveFiles={[]}
        readonly
        adapterSupportsReadonly
        onAddFile={vi.fn()}
        onRemoveFile={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )

    expect(screen.getByTestId('scope-editor-readonly')).toBeTruthy()
    expect(screen.getByTestId('scope-editor-open-scope')).toBeTruthy()
    // 只读态不该出现「清空全部」—— 没有东西可清
    expect(screen.queryByTestId('scope-editor-clear-all')).toBeNull()
  })

  it('可写态：列出范围文件，点删除按钮调 onRemoveFile', () => {
    const onRemoveFile = vi.fn()
    render(
      <ScopeEditor
        effectiveFiles={['src/a.ts', 'src/b.ts']}
        readonly={false}
        adapterSupportsReadonly
        onAddFile={vi.fn()}
        onRemoveFile={onRemoveFile}
        onClearAll={vi.fn()}
      />,
    )

    expect(screen.getByTestId('scope-editor-writable')).toBeTruthy()
    expect(screen.getByTestId('scope-editor-clear-all')).toBeTruthy()

    fireEvent.click(screen.getByTestId('scope-editor-remove-src/a.ts'))
    expect(onRemoveFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('点「清空全部」调 onClearAll', () => {
    const onClearAll = vi.fn()
    render(
      <ScopeEditor
        effectiveFiles={['src/a.ts']}
        readonly={false}
        adapterSupportsReadonly
        onAddFile={vi.fn()}
        onRemoveFile={vi.fn()}
        onClearAll={onClearAll}
      />,
    )

    fireEvent.click(screen.getByTestId('scope-editor-clear-all'))
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('适配器不支持只读时渲染警告条', () => {
    render(
      <ScopeEditor
        effectiveFiles={[]}
        readonly
        adapterSupportsReadonly={false}
        onAddFile={vi.fn()}
        onRemoveFile={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )

    expect(screen.getByTestId('scope-editor-adapter-warning')).toBeTruthy()
  })

  it('添加文件：输入路径后确认调 onAddFile', () => {
    const onAddFile = vi.fn()
    render(
      <ScopeEditor
        effectiveFiles={[]}
        readonly
        adapterSupportsReadonly
        onAddFile={onAddFile}
        onRemoveFile={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('scope-editor-open-scope'))
    fireEvent.change(screen.getByTestId('scope-editor-add-input'), {
      target: { value: 'src/new.ts' },
    })
    fireEvent.click(screen.getByTestId('scope-editor-add-confirm'))

    expect(onAddFile).toHaveBeenCalledWith('src/new.ts')
  })

  it('添加文件时空输入不调 onAddFile', () => {
    const onAddFile = vi.fn()
    render(
      <ScopeEditor
        effectiveFiles={[]}
        readonly
        adapterSupportsReadonly
        onAddFile={onAddFile}
        onRemoveFile={vi.fn()}
        onClearAll={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('scope-editor-open-scope'))
    fireEvent.change(screen.getByTestId('scope-editor-add-input'), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('scope-editor-add-confirm'))

    expect(onAddFile).not.toHaveBeenCalled()
  })
})
