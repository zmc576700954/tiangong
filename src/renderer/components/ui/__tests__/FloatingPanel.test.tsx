// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FloatingPanel } from '../FloatingPanel'

describe('FloatingPanel — variants', () => {
  it('corner variant applies corner positioning + backdrop blur', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="corner">
        body
      </FloatingPanel>,
    )
    const panel = screen.getByTestId('floating-panel')
    expect(panel.className).toContain('absolute')
    expect(panel.className).toContain('top-16')
    expect(panel.className).toContain('right-4')
    expect(panel.className).toContain('z-50')
    expect(panel.className).toContain('max-h-[70vh]')
    expect(panel.className).toContain('bg-background/95')
    expect(panel.className).toContain('backdrop-blur')
    expect(panel.className).toContain('border')
    expect(panel.className).toContain('rounded-lg')
    expect(panel.className).toContain('shadow-lg')
  })

  it('fullscreen variant applies inset-0 + no rounded border', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="fullscreen">
        body
      </FloatingPanel>,
    )
    const panel = screen.getByTestId('floating-panel')
    expect(panel.className).toContain('absolute')
    expect(panel.className).toContain('inset-0')
    expect(panel.className).toContain('z-50')
    expect(panel.className).toContain('bg-background/95')
    expect(panel.className).toContain('backdrop-blur')
  })

  it('centered variant applies centered transform', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="centered">
        body
      </FloatingPanel>,
    )
    const panel = screen.getByTestId('floating-panel')
    expect(panel.className).toContain('top-1/2')
    expect(panel.className).toContain('left-1/2')
    expect(panel.className).toContain('-translate-x-1/2')
    expect(panel.className).toContain('-translate-y-1/2')
    expect(panel.className).toContain('bg-background')
    expect(panel.className).toContain('shadow-lg')
  })

  it('anchored variant applies inline style + shadow-xl', () => {
    render(
      <FloatingPanel
        isOpen
        onClose={vi.fn()}
        title="t"
        variant="anchored"
        anchor={{ x: 120, y: 80 }}
      >
        body
      </FloatingPanel>,
    )
    const panel = screen.getByTestId('floating-panel')
    expect(panel.className).toContain('bg-background')
    expect(panel.className).toContain('shadow-xl')
    expect(panel.getAttribute('style')).toContain('left: 120px')
    expect(panel.getAttribute('style')).toContain('top: 80px')
  })
})

describe('FloatingPanel — width', () => {
  it('width="sm" applies w-72', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="corner" width="sm">
        body
      </FloatingPanel>,
    )
    expect(screen.getByTestId('floating-panel').className).toContain('w-72')
  })

  it('width="md" applies w-80', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="corner" width="md">
        body
      </FloatingPanel>,
    )
    expect(screen.getByTestId('floating-panel').className).toContain('w-80')
  })

  it('width="lg" applies w-96', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="corner" width="lg">
        body
      </FloatingPanel>,
    )
    expect(screen.getByTestId('floating-panel').className).toContain('w-96')
  })

  it('fullscreen variant ignores width prop', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="fullscreen" width="lg">
        body
      </FloatingPanel>,
    )
    const cls = screen.getByTestId('floating-panel').className
    expect(cls).not.toContain('w-96')
  })
})

describe('FloatingPanel — open/close rendering', () => {
  it('returns null when isOpen is false', () => {
    render(
      <FloatingPanel isOpen={false} onClose={vi.fn()} title="t">
        body
      </FloatingPanel>,
    )
    expect(screen.queryByTestId('floating-panel')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders role="dialog" when isOpen is true', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t">
        body
      </FloatingPanel>,
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('renders children inside body area', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t">
        <p data-testid="child">child content</p>
      </FloatingPanel>,
    )
    expect(screen.getByTestId('child')).toBeTruthy()
    expect(screen.getByText('child content')).toBeTruthy()
  })
})

describe('FloatingPanel — header elements', () => {
  it('renders title text', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="My Title">
        body
      </FloatingPanel>,
    )
    expect(screen.getByText('My Title')).toBeTruthy()
  })

  it('uses title as aria-label when title is a string', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="Accessible Title">
        body
      </FloatingPanel>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Accessible Title')
  })

  it('renders icon ReactNode before title', () => {
    render(
      <FloatingPanel
        isOpen
        onClose={vi.fn()}
        title="t"
        icon={<span data-testid="icon-marker">★</span>}
      >
        body
      </FloatingPanel>,
    )
    expect(screen.getByTestId('icon-marker')).toBeTruthy()
  })

  it('renders subtitle when provided', () => {
    render(
      <FloatingPanel
        isOpen
        onClose={vi.fn()}
        title="t"
        subtitle="3 项异常"
      >
        body
      </FloatingPanel>,
    )
    expect(screen.getByText('3 项异常')).toBeTruthy()
  })

  it('renders headerActions in the header', () => {
    render(
      <FloatingPanel
        isOpen
        onClose={vi.fn()}
        title="t"
        headerActions={<button data-testid="action">Action</button>}
      >
        body
      </FloatingPanel>,
    )
    expect(screen.getByTestId('action')).toBeTruthy()
  })
})

describe('FloatingPanel — close button', () => {
  it('calls onClose when X close button is clicked (default showCloseButton=true)', () => {
    const onClose = vi.fn()
    render(
      <FloatingPanel isOpen onClose={onClose} title="t">
        body
      </FloatingPanel>,
    )
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides X close button when showCloseButton=false', () => {
    const onClose = vi.fn()
    render(
      <FloatingPanel
        isOpen
        onClose={onClose}
        title="t"
        showCloseButton={false}
        footer={
          <button data-testid="cancel" onClick={onClose}>
            取消
          </button>
        }
      >
        body
      </FloatingPanel>,
    )
    expect(screen.queryByTitle('关闭')).toBeNull()
    expect(screen.queryByLabelText('关闭')).toBeNull()
    fireEvent.click(screen.getByTestId('cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('FloatingPanel — footer slot', () => {
  it('renders footer ReactNode after body', () => {
    render(
      <FloatingPanel
        isOpen
        onClose={vi.fn()}
        title="t"
        footer={<button data-testid="footer-btn">Save</button>}
      >
        <p>body</p>
      </FloatingPanel>,
    )
    const panel = screen.getByTestId('floating-panel')
    const footerBtn = screen.getByTestId('footer-btn')
    expect(footerBtn).toBeTruthy()
    // footer element should have border-t separator class
    expect(footerBtn.parentElement?.className).toContain('border-t')
    // ordering: panel contains header, body, footer in document order
    const headerEl = panel.firstElementChild
    const footerEl = footerBtn.parentElement
    expect(panel.children.length).toBe(3)
    expect(headerEl?.className).toContain('border-b')
    expect(footerEl?.className).toContain('border-t')
  })

  it('does not render footer wrapper when footer is not provided', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t">
        body
      </FloatingPanel>,
    )
    const panel = screen.getByTestId('floating-panel')
    expect(panel.children.length).toBe(2)
  })
})

describe('FloatingPanel — ARIA', () => {
  it('fullscreen variant has aria-modal="true"', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="fullscreen">
        body
      </FloatingPanel>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('centered variant has aria-modal="true"', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="centered">
        body
      </FloatingPanel>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('anchored variant has aria-modal="true"', () => {
    render(
      <FloatingPanel
        isOpen
        onClose={vi.fn()}
        title="t"
        variant="anchored"
        anchor={{ x: 0, y: 0 }}
      >
        body
      </FloatingPanel>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('corner variant does NOT add aria-modal', () => {
    render(
      <FloatingPanel isOpen onClose={vi.fn()} title="t" variant="corner">
        body
      </FloatingPanel>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBeNull()
  })
})

describe('FloatingPanel — Esc close behavior', () => {
  it('calls onClose when Esc is pressed and focus is inside the panel', () => {
    const onClose = vi.fn()
    render(
      <FloatingPanel isOpen onClose={onClose} title="t">
        <input data-testid="inside" />
      </FloatingPanel>,
    )
    const input = screen.getByTestId('inside')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onClose when Esc is pressed outside the panel', () => {
    const onClose = vi.fn()
    render(
      <div>
        <input data-testid="outside" />
        <FloatingPanel isOpen onClose={onClose} title="t">
          body
        </FloatingPanel>
      </div>,
    )
    const outside = screen.getByTestId('outside')
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT call onClose on Esc when closeOnEsc=false', () => {
    const onClose = vi.fn()
    render(
      <FloatingPanel isOpen onClose={onClose} title="t" closeOnEsc={false}>
        <input data-testid="inside2" />
      </FloatingPanel>,
    )
    const input = screen.getByTestId('inside2')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT register Esc listener when isOpen=false', () => {
    const onClose = vi.fn()
    render(
      <div>
        <input data-testid="external" />
        <FloatingPanel isOpen={false} onClose={onClose} title="t">
          body
        </FloatingPanel>
      </div>,
    )
    const external = screen.getByTestId('external')
    external.focus()
    fireEvent.keyDown(external, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
