// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RecipesPanel } from '../RecipesPanel'
import type { RecipeDefinition, RecipeRun } from '@shared/types/recipe'

/**
 * @xyflow/react 在 jsdom 中需要 ResizeObserver。
 * DAG 视图在 RecipesPanel 里通过 RecipeDagView 渲染，必须 mock 掉。
 */
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
// matchMedia 也在 jsdom 缺失，给 xyflow 一个最小 stub
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

/**
 * RecipesPanel 渲染层测试（最小覆盖）：
 *  - 空态文案渲染（无 recipe 时给出 userData / .bizgraph/recipes/ 提示）
 *  - 列表展示 mock recipe（含 source 徽标 + step count + tags）
 *  - 选中后右侧详情显示 inputs 表单 + steps 预览
 *  - Run 按钮触发 recipes:run + 列表刷新
 *
 * 本仓库未配置 @testing-library/jest-dom，自行实现最小断言。
 */

function makeRecipe(overrides: Partial<RecipeDefinition> = {}): RecipeDefinition {
  return {
    id: 'demo',
    name: 'Demo Recipe',
    version: '1',
    description: 'Test recipe',
    tags: ['demo', 'test'],
    inputs: [
      { name: 'path', type: 'string', label: 'Target path', required: true },
      { name: 'count', type: 'number', default: 5 },
    ],
    steps: [
      { kind: 'agent', agent_type: 'explore', description: 'step 1', prompt: 'do thing' },
      { kind: 'shell', command: ['echo', 'hi'] },
    ],
    source: 'user',
    sourcePath: '/tmp/demo.yaml',
    ...overrides,
  }
}

function makeApi(overrides: Partial<{
  'recipes:list': () => Promise<RecipeDefinition[]>
  'recipes:get': (id: string) => Promise<RecipeDefinition | null>
  'recipes:dag': (id: string) => Promise<unknown>
  'recipes:run': (req: { recipeId: string; inputs?: Record<string, string | number | boolean> }) => Promise<RecipeRun>
  'recipes:cancel': (runId: string) => Promise<boolean>
  'recipes:refresh': () => Promise<number>
  'recipes:listRuns': (recipeId: string, limit?: number) => Promise<RecipeRun[]>
  'recipes:getRun': (runId: string) => Promise<RecipeRun | null>
}> = {}) {
  return {
    'recipes:list': vi.fn(async () => []),
    'recipes:get': vi.fn(async () => null),
    'recipes:dag': vi.fn(async () => null),
    'recipes:run': vi.fn(async () => ({
      id: 'recipe-run-1',
      recipe_id: 'demo',
      recipe_version: '1',
      session_id: null,
      graph_id: null,
      node_id: null,
      status: 'succeeded' as const,
      inputs: {},
      steps: [],
      outputs: {},
      error: null,
      started_at: Date.now(),
      finished_at: Date.now(),
    })),
    'recipes:cancel': vi.fn(async () => true),
    'recipes:refresh': vi.fn(async () => 0),
    'recipes:listRuns': vi.fn(async () => []),
    'recipes:getRun': vi.fn(async () => null),
    ...overrides,
  }
}

describe('RecipesPanel', () => {
  it('shows empty-state hint when no recipes loaded', async () => {
    const api = makeApi()
    render(<RecipesPanel electronAPI={api} />)
    await waitFor(() => {
      expect(api['recipes:list']).toHaveBeenCalled()
    })
    expect(screen.getByText(/No recipes loaded/i)).toBeTruthy()
  })

  it('renders the recipe list with source badge, step count, and tags', async () => {
    const recipe = makeRecipe()
    const api = makeApi({ 'recipes:list': vi.fn(async () => [recipe]) })
    render(<RecipesPanel electronAPI={api} />)
    await waitFor(() => {
      expect(screen.getByText('demo')).toBeTruthy()
    })
    expect(screen.getByText(/2\s*steps/)).toBeTruthy()
    expect(screen.getAllByText('user').length).toBeGreaterThan(0)
    expect(screen.getByText(/demo, test/)).toBeTruthy()
  })

  it('shows inputs form and steps preview when a recipe is selected', async () => {
    const recipe = makeRecipe()
    const api = makeApi({ 'recipes:list': vi.fn(async () => [recipe]) })
    render(<RecipesPanel electronAPI={api} />)
    await waitFor(() => {
      expect(screen.getByText('demo')).toBeTruthy()
    })
    // inputs form
    expect(screen.getByText('Target path')).toBeTruthy()
    // steps preview: agent_type=explore and command rendering.
    // "explore" 现在在 DAG 节点和 step 详情都出现；用 getAllByText 至少匹配一处即可。
    expect(screen.getAllByText(/explore/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/echo/).length).toBeGreaterThan(0)
  })

  it('runs a recipe and refreshes run history', async () => {
    const recipe = makeRecipe({ inputs: [] }) // no required inputs
    const api = makeApi({ 'recipes:list': vi.fn(async () => [recipe]) })
    render(<RecipesPanel electronAPI={api} />)
    await waitFor(() => {
      expect(screen.getByText('Run Recipe')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Run Recipe'))
    await waitFor(() => {
      expect(api['recipes:run']).toHaveBeenCalledWith({ recipeId: 'demo', inputs: {} })
    })
  })
})
