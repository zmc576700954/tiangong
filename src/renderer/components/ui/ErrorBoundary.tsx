import { Component, type ReactNode } from 'react'
import { t, type TranslationKey } from '@shared/i18n'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 出错区域的名称——传 i18n key，文案按当前语言渲染 */
  labelKey?: TranslationKey
  /** 错误上报回调；如需发送到主进程日志，可在外部通过 IPC 包装 */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  /**
   * When this key changes, the boundary auto-resets.
   * Use to force child components to remount with fresh state after an error.
   */
  resetKey?: string | number
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`ErrorBoundary${this.props.labelKey ? ` [${this.props.labelKey}]` : ''} caught:`, error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Auto-reset when resetKey changes
    if (this.state.hasError && this.props.resetKey !== prevProps.resetKey) {
      this.setState({ hasError: false, error: undefined })
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (this.state.hasError) {
      // 类组件拿不到 context，用共享层的模块级 t()——Provider 切换语言时会同步
      const label = t(this.props.labelKey ?? 'app.errorBoundary.defaultLabel')
      return (
        <div className="flex items-center justify-center h-full w-full bg-background text-foreground p-8">
          <div className="text-center space-y-4 max-w-md">
            <h1 className="text-xl font-semibold text-destructive">
              {t('app.errorBoundary.message', { label })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message ?? t('app.errorBoundary.unknown')}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.reset}
                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm hover:bg-secondary/90"
                aria-label={t('app.errorBoundary.retryLabel', { label })}
              >
                {t('app.errorBoundary.retry')}
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
                aria-label={t('app.errorBoundary.reload')}
              >
                {t('app.errorBoundary.reload')}
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
