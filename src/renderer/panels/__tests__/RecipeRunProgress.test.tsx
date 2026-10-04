// @vitest-environment jsdom
/**
 * Tests for RecipeRunProgress Panel (D5c-3)
 *
 * 覆盖：
 *  - 进度更新：模拟 IPC 事件流，验证步骤状态实时更新
 *  - 错误显示：failed 步骤 + 错误 banner
 *  - 折叠 / 展开：toggle 按钮控制列表可见性
 *  - 取消按钮：调 recipes:cancel
 *  - 初始状态：基于 Recipe 派生步骤列表（全部 pending）
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { RecipeRunProgress } from '../RecipeRunProgress'
import type {
  RecipeDefinition,
  RecipeRunProgressEvent,
} from '@shared/types/recipe'

/**
 * @xyflow/react 在 jsdom 中需要 ResizeObserver；
 * matchMedia 也是 jsdom 缺失的 API。给它们最小 stub。
 */
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function makeRecipe(): RecipeDefinition {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1',
    steps: [
      { id: 'first', kind: 'agent', agent_type: 'explore', description: 'first', prompt: 'p' },
      { id: 'second', kind: 'shell', command: ['echo', 'x'] },
      { id: 'third', kind: 'agent', agent_type: 'implement', description: 'third', prompt: 'p' },
    ],
  }
}

function makeApi(opts?: {
  onProgress?: (cb: (data: RecipeRunProgressEvent) => void) => () => void
  cancel?: (runId: string) => Promise<boolean>
}) {
  const onProgress = opts?.onProgress ?? ((): (() => void) => () => undefined)
  const cancel = opts?.cancel ?? (async () => true)
  return {
    'recipes:getRun': vi.fn(async () => null),
    'recipes:cancel': cancel,
    onRecipeRunProgress: onProgress,
  }
}

describe('RecipeRunProgress', () => {
  it('renders all steps in pending state initially', () => {
    const recipe = makeRecipe()
    const api = makeApi()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByTestId('recipe-progress-counter').textContent).toBe('0/3')
    expect(screen.getAllByTestId(/^recipe-progress-step-\d+$/)).toHaveLength(3)
    // All in pending
    expect(screen.getByTestId('recipe-progress-step-0').getAttribute('data-status')).toBe('pending')
    expect(screen.getByTestId('recipe-progress-step-2').getAttribute('data-status')).toBe('pending')
    // Recipe steps labels visible
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.getByText('third')).toBeTruthy()
  })

  it('updates step statuses as progress events arrive', async () => {
    let progressCb: ((data: RecipeRunProgressEvent) => void) | null = null
    const api = makeApi({
      onProgress: (cb) => {
        progressCb = cb
        return () => undefined
      },
    })
    const onStepUpdate = vi.fn()
    const recipe = makeRecipe()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onStepUpdate={onStepUpdate}
        onClose={() => undefined}
      />,
    )

    expect(progressCb).not.toBeNull()

    // First step starts
    act(() => {
      progressCb!({
        runId: 'run-1',
        recipeId: 'demo',
        stepId: 'first',
        status: 'running',
        stepIndex: 0,
        totalSteps: 3,
        completedSteps: 0,
        failedSteps: 0,
        startedAt: Date.now(),
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('recipe-progress-step-0').getAttribute('data-status')).toBe('running')
    })
    expect(onStepUpdate).toHaveBeenCalledWith('first', 'running', undefined)

    // First step completes
    act(() => {
      progressCb!({
        runId: 'run-1',
        recipeId: 'demo',
        stepId: 'first',
        status: 'completed',
        stepIndex: 0,
        totalSteps: 3,
        completedSteps: 1,
        failedSteps: 0,
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('recipe-progress-step-0').getAttribute('data-status')).toBe('completed')
    })
    expect(screen.getByTestId('recipe-progress-counter').textContent).toBe('1/3')

    // Second step runs and fails
    act(() => {
      progressCb!({
        runId: 'run-1',
        recipeId: 'demo',
        stepId: 'second',
        status: 'running',
        stepIndex: 1,
        totalSteps: 3,
        completedSteps: 1,
        failedSteps: 0,
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('recipe-progress-step-1').getAttribute('data-status')).toBe('running')
    })
    act(() => {
      progressCb!({
        runId: 'run-1',
        recipeId: 'demo',
        stepId: 'second',
        status: 'failed',
        stepIndex: 1,
        totalSteps: 3,
        completedSteps: 1,
        failedSteps: 1,
        error: 'Shell exited with code 1',
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('recipe-progress-step-1').getAttribute('data-status')).toBe('failed')
    })
    expect(screen.getByTestId('recipe-progress-counter').textContent).toBe('2/3')
  })

  it('shows error banner when a step fails and lets user dismiss it', async () => {
    let progressCb: ((data: RecipeRunProgressEvent) => void) | null = null
    const api = makeApi({
      onProgress: (cb) => {
        progressCb = cb
        return () => undefined
      },
    })
    const recipe = makeRecipe()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onClose={() => undefined}
      />,
    )

    act(() => {
      progressCb!({
        runId: 'run-1',
        recipeId: 'demo',
        stepId: 'second',
        status: 'failed',
        stepIndex: 1,
        totalSteps: 3,
        completedSteps: 0,
        failedSteps: 1,
        error: 'Boom',
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('recipe-progress-error-banner')).toBeTruthy()
    })
    // Use within() to scope to the banner — the same error text may also appear under the step.
    expect(screen.getByTestId('recipe-progress-error-banner').textContent).toContain('Boom')

    // Dismiss
    fireEvent.click(screen.getByLabelText('关闭错误提示'))
    await waitFor(() => {
      expect(screen.queryByTestId('recipe-progress-error-banner')).toBeNull()
    })
  })

  it('collapses and expands the body via the toggle button', () => {
    const api = makeApi()
    const recipe = makeRecipe()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onClose={() => undefined}
      />,
    )
    // Body visible by default
    expect(screen.getByTestId('recipe-progress-bar')).toBeTruthy()
    // Toggle
    fireEvent.click(screen.getByTestId('recipe-progress-collapse-toggle'))
    expect(screen.queryByTestId('recipe-progress-bar')).toBeNull()
    // Toggle back
    fireEvent.click(screen.getByTestId('recipe-progress-collapse-toggle'))
    expect(screen.getByTestId('recipe-progress-bar')).toBeTruthy()
  })

  it('invokes recipes:cancel when the cancel button is clicked while running', async () => {
    let progressCb: ((data: RecipeRunProgressEvent) => void) | null = null
    const cancel = vi.fn<(runId: string) => Promise<boolean>>(async () => true)
    const api = makeApi({
      onProgress: (cb) => {
        progressCb = cb
        return () => undefined
      },
      cancel,
    })
    const recipe = makeRecipe()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onClose={() => undefined}
      />,
    )

    act(() => {
      progressCb!({
        runId: 'run-1',
        recipeId: 'demo',
        stepId: 'first',
        status: 'running',
        stepIndex: 0,
        totalSteps: 3,
        completedSteps: 0,
        failedSteps: 0,
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('recipe-progress-cancel')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('recipe-progress-cancel'))
    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith('run-1')
    })
  })

  it('calls onClose when the close button is clicked', () => {
    const api = makeApi()
    const recipe = makeRecipe()
    const onClose = vi.fn()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByTestId('recipe-progress-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores progress events for other run ids', async () => {
    let progressCb: ((data: RecipeRunProgressEvent) => void) | null = null
    const api = makeApi({
      onProgress: (cb) => {
        progressCb = cb
        return () => undefined
      },
    })
    const recipe = makeRecipe()
    render(
      <RecipeRunProgress
        recipe={recipe}
        runId="run-1"
        electronAPI={api}
        onClose={() => undefined}
      />,
    )
    act(() => {
      progressCb!({
        runId: 'OTHER-RUN',
        recipeId: 'demo',
        stepId: 'first',
        status: 'completed',
        stepIndex: 0,
        totalSteps: 3,
        completedSteps: 1,
        failedSteps: 0,
      })
    })
    // Should remain pending; not affected by foreign run
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByTestId('recipe-progress-step-0').getAttribute('data-status')).toBe('pending')
  })
})
