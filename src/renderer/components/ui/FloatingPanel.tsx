import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type FloatingPanelVariant = 'corner' | 'fullscreen' | 'centered' | 'anchored'

export type FloatingPanelWidth = 'sm' | 'md' | 'lg'

interface FloatingPanelProps {
  isOpen: boolean
  onClose: () => void
  title: ReactNode
  icon?: ReactNode
  subtitle?: ReactNode
  variant?: FloatingPanelVariant
  width?: FloatingPanelWidth
  anchor?: { x: number; y: number }
  showCloseButton?: boolean
  headerActions?: ReactNode
  footer?: ReactNode
  closeOnEsc?: boolean
  className?: string
  children: ReactNode
}

const VARIANT_BASE_CLASSES: Record<FloatingPanelVariant, string> = {
  corner:
    'absolute top-16 right-4 z-50 max-h-[70vh] flex flex-col bg-background/95 backdrop-blur border rounded-lg shadow-lg',
  fullscreen: 'absolute inset-0 z-50 bg-background/95 backdrop-blur flex flex-col',
  centered:
    'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 flex flex-col bg-background border rounded-lg shadow-lg',
  anchored:
    'absolute z-50 flex flex-col bg-background border rounded-lg shadow-xl',
}

const VARIANT_WIDTHS: Record<Exclude<FloatingPanelVariant, 'fullscreen'>, Record<FloatingPanelWidth, string>> = {
  corner: { sm: 'w-72', md: 'w-80', lg: 'w-96' },
  centered: { sm: 'w-72', md: 'w-80', lg: 'w-96' },
  anchored: { sm: 'w-72', md: 'w-80', lg: 'w-96' },
}

export function FloatingPanel({
  isOpen,
  onClose,
  title,
  icon,
  subtitle,
  variant = 'corner',
  width = 'md',
  anchor,
  showCloseButton = true,
  headerActions,
  footer,
  closeOnEsc = true,
  className,
  children,
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen || !closeOnEsc) return

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const panel = panelRef.current
      if (!panel) {
        onClose()
        return
      }
      const active = document.activeElement
      if (!active || panel.contains(active)) {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, closeOnEsc, onClose])

  if (!isOpen) return null

  const variantClasses = VARIANT_BASE_CLASSES[variant]
  const widthClass = variant === 'fullscreen' ? '' : VARIANT_WIDTHS[variant][width]
  const ariaModal = variant !== 'corner' ? true : undefined
  const ariaLabel = typeof title === 'string' ? title : undefined
  const style = variant === 'anchored' && anchor ? { left: anchor.x, top: anchor.y } : undefined

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={ariaModal}
      aria-label={ariaLabel}
      data-testid="floating-panel"
      data-variant={variant}
      style={style}
      className={cn(variantClasses, widthClass, className)}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-sm font-medium truncate">{title}</span>
          {subtitle && (
            <span className="text-[10px] text-muted-foreground truncate">{subtitle}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {headerActions}
          {showCloseButton && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
              className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden min-h-0">{children}</div>

      {footer && (
        <div className="border-t px-3 py-1.5 shrink-0">{footer}</div>
      )}
    </div>
  )
}
