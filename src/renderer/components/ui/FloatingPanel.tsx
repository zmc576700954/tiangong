import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '../../i18n/useI18n'

export type FloatingPanelVariant = 'corner' | 'fullscreen' | 'centered' | 'anchored'

export type FloatingPanelWidth = 'sm' | 'md' | 'lg' | 'xl'

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
  /**
   * 渲染到 document.body 并改用 fixed 定位。
   * 画布内的面板祖先带 backdrop-filter，会成为 fixed 后代的包含块，
   * 导致「相对视口」的定位被算成「相对祖先」—— portal 是唯一的解法。
   */
  portal?: boolean
  /** 透传到根节点的额外属性（测试 / 调试用）。可覆盖 data-testid。 */
  dataAttributes?: Record<string, string | number>
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
  corner: { sm: 'w-72', md: 'w-80', lg: 'w-96', xl: 'w-[480px]' },
  centered: { sm: 'w-72', md: 'w-80', lg: 'w-96', xl: 'w-[480px]' },
  anchored: { sm: 'w-72', md: 'w-80', lg: 'w-96', xl: 'w-[480px]' },
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
  portal = false,
  dataAttributes,
  className,
  children,
}: FloatingPanelProps) {
  const { t } = useI18n()
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

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={ariaModal}
      aria-label={ariaLabel}
      data-testid="floating-panel"
      data-variant={variant}
      style={style}
      {...dataAttributes}
      className={cn(variantClasses, widthClass, portal && 'fixed', className)}
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
              aria-label={t('common.close')}
              title={t('common.close')}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* flex 列容器：子面板用 flex-1 / h-full 撑满并滚动（block 父级里 flex-1 是失效的） */}
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">{children}</div>

      {footer && (
        <div className="border-t px-3 py-1.5 shrink-0">{footer}</div>
      )}
    </div>
  )

  return portal ? createPortal(panel, document.body) : panel
}
