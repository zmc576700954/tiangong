import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createElement } from 'react'
import ReactDOMServer from 'react-dom/server'
import { parseSavedPanelWidth, useResizablePanel } from '../useResizablePanel'

function TestPanel() {
  const { width } = useResizablePanel({
    initialWidth: 250,
    minWidth: 100,
    maxWidth: 500,
    direction: 'left',
  })
  return createElement('div', { 'data-testid': 'width' }, width)
}

describe('parseSavedPanelWidth', () => {
  it('returns the saved width when it is a finite number', () => {
    expect(parseSavedPanelWidth('300', 250, 100, 500)).toBe(300)
  })

  it('clamps the saved width to min/max', () => {
    expect(parseSavedPanelWidth('50', 250, 100, 500)).toBe(100)
    expect(parseSavedPanelWidth('600', 250, 100, 500)).toBe(500)
  })

  it('falls back to initialWidth for null or empty saved width', () => {
    expect(parseSavedPanelWidth(null, 250, 100, 500)).toBe(250)
    expect(parseSavedPanelWidth('', 250, 100, 500)).toBe(250)
  })

  it('falls back to initialWidth for non-numeric saved width (NaN)', () => {
    expect(parseSavedPanelWidth('NaN', 250, 100, 500)).toBe(250)
    expect(parseSavedPanelWidth('abc', 250, 100, 500)).toBe(250)
    expect(parseSavedPanelWidth('Infinity', 250, 100, 500)).toBe(250)
  })
})

describe('useResizablePanel', () => {
  let originalWindow: typeof globalThis.window
  let originalLocalStorage: typeof globalThis.localStorage

  beforeAll(() => {
    originalWindow = globalThis.window
    originalLocalStorage = globalThis.localStorage
  })

  afterAll(() => {
    globalThis.window = originalWindow
    globalThis.localStorage = originalLocalStorage
  })

  function setStoredWidth(value: string | null) {
    const store: Storage = {
      getItem: vi.fn().mockReturnValue(value),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as unknown as Storage
    globalThis.localStorage = store
    globalThis.window = { localStorage: store } as unknown as typeof globalThis.window
  }

  it('uses the initial width when localStorage contains NaN', () => {
    setStoredWidth('NaN')
    const html = ReactDOMServer.renderToString(createElement(TestPanel))
    expect(html).toContain('>250<')
  })

  it('uses the saved width when it is valid', () => {
    setStoredWidth('320')
    const html = ReactDOMServer.renderToString(createElement(TestPanel))
    expect(html).toContain('>320<')
  })
})
