// @vitest-environment jsdom
/**
 * WikiPageEditor 单元测试
 * - 使用 jsdom + @testing-library/react
 * - 通过 vi.stubGlobal 注入 window.electronAPI mock
 * - 通过 useGraphStore.setState 注入 graphStore 状态
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { WikiPageEditor } from '../WikiPageEditor'
import { useGraphStore } from '@/store/graphStore'
import type { GraphNode } from '@shared/types'

// ─── jsdom polyfill: Radix Dialog 在 jsdom 下访问 getComputedStyle 会失败 ──
//   该 polyfill 必须在 vi.stubGlobal('window', ...) 之后再次确认一次，因为 stubGlobal 会替换整个 window 对象
if (typeof window !== 'undefined' && typeof window.getComputedStyle !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).getComputedStyle = () => ({
    getPropertyValue: () => '',
  })
}

// ─── electronAPI mock（在现有 window 上挂属性，保留 jsdom 的 getComputedStyle）──
const parseContentMock = vi.fn().mockResolvedValue({ frontmatter: {}, title: undefined, links: [] })
const getBacklinksMock = vi.fn().mockResolvedValue([])
const createNodeMock = vi.fn()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = window as any
if (!w.electronAPI) {
  Object.defineProperty(w, 'electronAPI', { configurable: true, value: {} })
}
w.electronAPI['wiki:parseContent'] = parseContentMock
w.electronAPI['wiki:getBacklinks'] = getBacklinksMock

// stubGlobal 之后再补一次 polyfill（stubGlobal 会抹掉之前的）
if (typeof window.getComputedStyle !== 'function') {
  window.getComputedStyle = (() => ({
    getPropertyValue: () => '',
  })) as unknown as typeof window.getComputedStyle
}

// ─── helpers ──────────────────────────────────────────────────────────
function makeNode(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: over.id ?? 'n-current',
    type: 'wiki-page',
    status: 'draft',
    title: over.title ?? 'Current',
    graphId: over.graphId ?? 'g1',
    graphType: over.graphType ?? 'online',
    position: { x: 0, y: 0 },
    createdAt: '',
    updatedAt: '',
    wikiContent: over.wikiContent ?? '',
    wikiMeta: over.wikiMeta ?? {},
    ...over,
  }
}

function renderEditor(props: Partial<React.ComponentProps<typeof WikiPageEditor>> = {}) {
  const onUpdate = props.onUpdate ?? vi.fn()
  const onNavigate = props.onNavigate ?? vi.fn()
  const utils = render(
    <WikiPageEditor
      nodeId={props.nodeId ?? 'n-current'}
      graphId={props.graphId ?? 'g1'}
      wikiContent={props.wikiContent}
      wikiMeta={props.wikiMeta}
      onUpdate={onUpdate}
      onNavigate={onNavigate}
    />,
  )
  return { ...utils, onUpdate, onNavigate }
}

function setupGraphStore(nodes: GraphNode[], graphs: { id: string; type: 'online' | 'dev' }[] = []) {
  useGraphStore.setState({
    nodes,
    graphs: graphs.map((g) => ({ ...g, name: g.id, createdAt: '', updatedAt: '' })),
  } as never)
}

beforeEach(() => {
  parseContentMock.mockClear()
  parseContentMock.mockResolvedValue({ frontmatter: {}, title: undefined, links: [] })
  getBacklinksMock.mockClear()
  getBacklinksMock.mockResolvedValue([])
  createNodeMock.mockClear()
  createNodeMock.mockResolvedValue(makeNode({ id: 'n-new', title: 'NewPage' }))
  // 默认注入一个 graph 供 handleCreatePage 查找
  setupGraphStore(
    [makeNode()],
    [{ id: 'g1', type: 'online' }],
  )
  // 默认 createNode 通过 store 调用 electronAPI
  useGraphStore.setState({ createNode: createNodeMock as never })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WikiPageEditor — 基础渲染', () => {
  it('默认进入 Markdown 编辑页签', () => {
    renderEditor({ wikiContent: '# Hello' })
    // textarea 显示初始 wikiContent
    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    expect(textarea.value).toBe('# Hello')
  })

  it('wikiContent 为 undefined 时草稿为空', () => {
    renderEditor({ wikiContent: undefined })
    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('展示顶部 Wiki 页面标题与四个页签', () => {
    renderEditor()
    expect(screen.getByText('Wiki 页面')).toBeTruthy()
    expect(screen.getByText('Markdown')).toBeTruthy()
    expect(screen.getByText('预览')).toBeTruthy()
    expect(screen.getByText('反向链接')).toBeTruthy()
    expect(screen.getByText('Meta')).toBeTruthy()
  })
})

describe('WikiPageEditor — 编辑与失焦保存', () => {
  it('编辑 textarea 后失焦触发 parseContent + onUpdate', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: { tags: ['x'] },
      title: undefined,
      links: [],
    })
    const { onUpdate } = renderEditor({ wikiContent: 'old' })

    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'new content' } })
    })
    await act(async () => {
      fireEvent.blur(textarea)
    })

    expect(parseContentMock).toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith({
      wikiContent: 'new content',
      wikiMeta: expect.objectContaining({ frontmatter: { tags: ['x'] } }),
    })
  })

  it('草稿未变更时失焦不触发 onUpdate', async () => {
    const { onUpdate } = renderEditor({ wikiContent: 'same content' })

    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    // 不修改内容，直接 blur
    await act(async () => {
      fireEvent.blur(textarea)
    })

    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('frontmatter YAML 错误时仍保存内容，wikiMeta 不变', async () => {
    parseContentMock.mockRejectedValueOnce(new Error('YAML parse error'))
    const { onUpdate } = renderEditor({ wikiContent: 'old', wikiMeta: { tags: ['old'] } })

    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'new' } })
    })
    await act(async () => {
      fireEvent.blur(textarea)
    })

    // 错误分支仅传 wikiContent，不更新 wikiMeta
    expect(onUpdate).toHaveBeenCalledWith({ wikiContent: 'new' })
  })
})

describe('WikiPageEditor — 解析防抖与 dirty 守卫', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('编辑后 500ms 内连续变更只触发一次解析（防抖）', async () => {
    renderEditor({ wikiContent: '' })

    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    parseContentMock.mockClear()

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'a' } })
      await vi.advanceTimersByTimeAsync(100)
      fireEvent.change(textarea, { target: { value: 'ab' } })
      await vi.advanceTimersByTimeAsync(100)
      fireEvent.change(textarea, { target: { value: 'abc' } })
      await vi.advanceTimersByTimeAsync(600)
    })

    // 三次输入只触发一次解析（防抖合并）
    expect(parseContentMock).toHaveBeenCalledTimes(1)
    expect(parseContentMock).toHaveBeenLastCalledWith('g1', 'abc')
  })

  it('外部 wikiContent 变化在 dirty=false 时覆盖草稿', async () => {
    const { rerender } = renderEditor({ wikiContent: 'initial' })
    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    expect(textarea.value).toBe('initial')

    rerender(
      <WikiPageEditor
        nodeId="n-current"
        graphId="g1"
        wikiContent="external update"
        wikiMeta={{}}
        onUpdate={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )

    expect(textarea.value).toBe('external update')
  })

  it('切换 nodeId 强制复位草稿（即使内容相同）', async () => {
    const { rerender } = renderEditor({ nodeId: 'n-a', wikiContent: '# A' })
    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    expect(textarea.value).toBe('# A')

    // 切换到 node-b，wikiContent 不同
    await act(async () => {
      rerender(
        <WikiPageEditor
          nodeId="n-b"
          graphId="g1"
          wikiContent="# B"
          wikiMeta={{}}
          onUpdate={vi.fn()}
          onNavigate={vi.fn()}
        />,
      )
    })

    expect(textarea.value).toBe('# B')
  })
})

describe('WikiPageEditor — 预览页签', () => {
  it('切换到预览页签渲染 Markdown 内容', async () => {
    renderEditor({ wikiContent: '# Title\n\n正文' })

    await switchToTab('预览')

    // Markdown 渲染出 h1
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy()
  })

  it('draft 为空时显示「暂无内容」提示', async () => {
    renderEditor({ wikiContent: '' })

    await switchToTab('预览')

    expect(screen.getByText(/暂无内容/)).toBeTruthy()
  })

  it('wikilink 在预览页以链接形式呈现', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: {},
      title: undefined,
      links: [{ targetTitle: '页面A', resolved: true, nodeId: 'n-a' }],
    })
    renderEditor({ wikiContent: '正文 [[页面A]]' })

    await switchToTab('预览')

    // 链接区出现
    expect(screen.getByTestId('wiki-links')).toBeTruthy()
  })

  it('悬空 wikilink 点击触发创建对话框', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: {},
      title: undefined,
      links: [{ targetTitle: '缺失页', resolved: false }],
    })
    renderEditor({ wikiContent: '见 [[缺失页]]' })

    await switchToTab('预览')

    // 点击悬空链接按钮（标题「页面「缺失页」不存在，点击创建」）
    const btn = screen.getByTitle('页面「缺失页」不存在，点击创建')
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(screen.getByText('创建 Wiki 页面「缺失页」？')).toBeTruthy()
  })

  it('已解析 wikilink 点击触发 onNavigate', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: {},
      title: undefined,
      links: [{ targetTitle: '页面A', resolved: true, nodeId: 'n-a' }],
    })
    const { onNavigate } = renderEditor({ wikiContent: '见 [[页面A]]' })

    await switchToTab('预览')

    // 等待 debounced parseContent 完成，链接列表刷新
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
      await Promise.resolve() // 让微任务队列中的 .then(setLinks) 完成
    })

    const link = screen.getByTitle('跳转到「页面A」')
    await act(async () => {
      fireEvent.click(link)
    })

    expect(onNavigate).toHaveBeenCalledWith('n-a')
  })

  it('wikilink 别名语法 [[目标|显示文本]] 使用 displayText', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: {},
      title: undefined,
      links: [{ targetTitle: '页面A', displayText: '别名', resolved: true, nodeId: 'n-a' }],
    })
    renderEditor({ wikiContent: '见 [[页面A|别名]]' })

    await switchToTab('预览')

    // 显示文本是「别名」，不是「页面A」
    expect(screen.getByText('别名')).toBeTruthy()
  })

  it('创建对话框确认后调用 createNode 并触发 onNavigate', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: {},
      title: undefined,
      links: [{ targetTitle: '新页', resolved: false }],
    })
    const { onNavigate } = renderEditor({ wikiContent: '见 [[新页]]' })

    await switchToTab('预览')

    await act(async () => {
      fireEvent.click(screen.getByTitle('页面「新页」不存在，点击创建'))
    })

    await act(async () => {
      fireEvent.click(screen.getByText('创建'))
    })

    expect(createNodeMock).toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('n-new')
  })

  it('取消创建按钮关闭对话框', async () => {
    parseContentMock.mockResolvedValue({
      frontmatter: {},
      title: undefined,
      links: [{ targetTitle: '新页', resolved: false }],
    })
    renderEditor({ wikiContent: '见 [[新页]]' })

    await switchToTab('预览')

    await act(async () => {
      fireEvent.click(screen.getByTitle('页面「新页」不存在，点击创建'))
    })

    expect(screen.getByText('创建 Wiki 页面「新页」？')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByText('取消'))
    })

    expect(screen.queryByText('创建 Wiki 页面「新页」？')).toBeNull()
  })
})

describe('WikiPageEditor — 反向链接页签', () => {
  it('切到 backlinks 时拉取列表', async () => {
    getBacklinksMock.mockResolvedValueOnce([
      { id: 'n-1', title: '页面一' },
      { id: 'n-2', title: '页面二' },
    ])
    const { onNavigate } = renderEditor()

    await switchToTab('反向链接')

    expect(getBacklinksMock).toHaveBeenCalledWith('n-current')

    // 点击任一反向链接触发 onNavigate
    await act(async () => {
      fireEvent.click(screen.getByText('页面一'))
    })
    expect(onNavigate).toHaveBeenCalledWith('n-1')
  })

  it('反向链接为空时显示「暂无」提示', async () => {
    getBacklinksMock.mockResolvedValueOnce([])
    renderEditor()

    await switchToTab('反向链接')

    expect(screen.getByText(/暂无其他页面链接到本页/)).toBeTruthy()
  })

  it('getBacklinks 失败时不报错', async () => {
    getBacklinksMock.mockRejectedValueOnce(new Error('boom'))
    renderEditor()

    await switchToTab('反向链接')

    // 不应抛错，列表为 null-safe 渲染
    expect(screen.getByText(/暂无其他页面链接到本页/)).toBeTruthy()
  })
})

describe('WikiPageEditor — Meta 页签', () => {
  it('无 frontmatter 时显示提示', async () => {
    renderEditor({ wikiMeta: {} })

    await switchToTab('Meta')

    expect(screen.getByText(/无 frontmatter/)).toBeTruthy()
  })

  it('展示 frontmatter 的所有键值（字符串 / 数组 / 对象）', async () => {
    renderEditor({
      wikiMeta: {
        frontmatter: {
          title: '页面标题',
          tags: ['a', 'b'],
          meta: { key: 'value' },
        },
      },
    })

    await switchToTab('Meta')

    expect(screen.getByText('页面标题')).toBeTruthy()
    expect(screen.getByText('a, b')).toBeTruthy()
    expect(screen.getByText('{"key":"value"}')).toBeTruthy()
  })
})

/** Radix Tabs 需要 keyboard/pointer activation；fireEvent.click 不会触发 onValueChange */
async function switchToTab(name: string) {
  await act(async () => {
    const trigger = screen.getByRole('tab', { name })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(trigger)
  })
}

describe('WikiPageEditor — 大文档性能', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('100KB Markdown 输入下渲染不卡死（< 1000ms）', async () => {
    const big = 'lorem ipsum '.repeat(10000) // ~120KB
    const t0 = Date.now()
    renderEditor({ wikiContent: big })
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(1000)
    const textarea = screen.getByPlaceholderText(/输入 Markdown 内容/) as HTMLTextAreaElement
    expect(textarea.value.length).toBe(big.length)
  })
})