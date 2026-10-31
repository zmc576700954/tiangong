// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { ChatHeader } from '../ChatHeader'

/**
 * ChatHeader 渲染层测试：适配器下拉按「已安装数量」自适应。
 *
 * 三种形态：
 *   - 0 个已装 → 保留原有空态引导（AlertCircle 形态 + 菜单里的未安装项点击引导去设置页）
 *   - 1 个已装 → 不渲染下拉触发按钮，只显示一个不可点的静态适配器名标签
 *   - ≥2 个已装 → 渲染下拉，菜单里只列已安装的，底部有「安装更多适配器…」
 *
 * 断言用 data-testid 而不是 queryByRole('combobox')——这个下拉是自定义的
 * <button> + 浮层 div，不是 <select>，combobox 断言会假绿（下拉还在也照样通过）。
 * 本仓库未配置 @testing-library/jest-dom，断言用原生写法。
 */

type HeaderProps = ComponentProps<typeof ChatHeader>

function renderHeader(overrides: Partial<HeaderProps> = {}) {
  const props: HeaderProps = {
    adapterName: 'auto',
    adapters: [],
    threadTitle: '测试会话',
    viewMode: 'chat',
    expanded: false,
    onSelectAdapter: vi.fn(),
    onNewThread: vi.fn(),
    onToggleThreads: vi.fn(),
    onToggleView: vi.fn(),
    onToggleExpand: vi.fn(),
    ...overrides,
  }
  return render(<ChatHeader {...props} />)
}

const TWO_INSTALLED: HeaderProps['adapters'] = [
  { name: 'claude-code', installed: true },
  { name: 'codex', installed: true },
  { name: 'cline', installed: false },
]

describe('ChatHeader — 适配器下拉按已装数量自适应', () => {
  it('装了 ≥2 个：渲染下拉，菜单里只列已安装的（未安装项不出现在菜单里）', () => {
    const onSelectAdapter = vi.fn()
    renderHeader({ adapters: TWO_INSTALLED, onSelectAdapter })

    const trigger = screen.getByTestId('adapter-menu-trigger')
    expect(trigger).toBeTruthy()

    fireEvent.click(trigger)

    const menu = screen.getByTestId('adapter-menu')
    expect(within(menu).getByText('claude-code')).toBeTruthy()
    expect(within(menu).getByText('codex')).toBeTruthy()
    // 未安装的那个不该出现在菜单里
    expect(screen.queryByText('cline')).toBeNull()
    // 「auto」（用默认适配器）仍然保留在菜单里
    expect(within(menu).getByText('自动')).toBeTruthy()

    // 点已安装的项仍然走 onSelectAdapter
    fireEvent.click(within(menu).getByText('codex'))
    expect(onSelectAdapter).toHaveBeenCalledWith('codex')
  })

  it('装了 ≥2 个：菜单底部有「安装更多适配器…」，点击走 onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    renderHeader({ adapters: TWO_INSTALLED, onOpenSettings })

    fireEvent.click(screen.getByTestId('adapter-menu-trigger'))

    const menu = screen.getByTestId('adapter-menu')
    const installMore = within(menu).getByTestId('adapter-menu-install-more')
    expect(installMore.textContent).toContain('安装更多适配器…')
    fireEvent.click(installMore)

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('装了 1 个：不渲染下拉触发按钮，只显示静态的适配器名标签', () => {
    renderHeader({
      adapters: [
        { name: 'claude-code', installed: true },
        { name: 'cline', installed: false },
      ],
    })

    // 下拉触发按钮不存在（不是断言 combobox 角色——那会假绿）
    expect(screen.queryByTestId('adapter-menu-trigger')).toBeNull()

    // 静态标签显示已安装适配器的名字
    const label = screen.getByTestId('adapter-static-label')
    expect(label.textContent).toContain('claude-code')
    // 不可点：不是 button，点它也不会开出菜单
    expect(label.tagName).not.toBe('BUTTON')
    fireEvent.click(label)
    expect(screen.queryByText('cline')).toBeNull()
  })

  it('装了 0 个：保留原有空态引导（AlertCircle 形态）', () => {
    const { container } = renderHeader({
      adapters: [{ name: 'cline', installed: false }],
      noAdaptersInstalled: true,
    })

    // 原有形态：下拉触发按钮还在（引导去设置页的入口）
    expect(screen.getByTestId('adapter-menu-trigger')).toBeTruthy()
    // AlertCircle 形态：红色告警图标
    const alertIcon = container.querySelector('svg.lucide-circle-alert')
    expect(alertIcon).toBeTruthy()
    expect(alertIcon?.getAttribute('class')).toContain('text-red-400')
  })

  it('装了 0 个：菜单仍列出未安装的适配器，点击引导去设置页（维持原有行为）', () => {
    const onOpenSettings = vi.fn()
    renderHeader({
      adapters: [{ name: 'cline', installed: false }],
      noAdaptersInstalled: true,
      onOpenSettings,
    })

    fireEvent.click(screen.getByTestId('adapter-menu-trigger'))

    const notInstalled = screen.getByText('cline')
    expect(notInstalled).toBeTruthy()
    fireEvent.click(notInstalled)

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})
