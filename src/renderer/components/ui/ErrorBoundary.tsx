import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  label?: string
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
    console.error(`ErrorBoundary${this.props.label ? ` [${this.props.label}]` : ''} caught:`, error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      const label = this.props.label ?? '应用'
      return (
        <div className="flex items-center justify-center h-full w-full bg-background text-foreground p-8">
          <div className="text-center space-y-4 max-w-md">
            <h1 className="text-xl font-semibold text-destructive">{label}发生错误</h1>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message ?? '未知错误'}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
            >
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
