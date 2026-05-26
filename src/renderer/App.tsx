import { useState, useEffect, Component, type ReactNode } from 'react'
import { LeftPanel } from './panels/LeftPanel'
import { RightPanel } from './panels/RightPanel'
import { GraphCanvas } from './canvas/GraphCanvas'
import { GraphTabs } from './components/GraphTabs'
import { useGraphStore } from './store/graphStore'

// 全局错误边界
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('React ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen w-screen bg-background text-foreground p-8"
        >
          <div className="text-center space-y-4 max-w-md"
          >
            <h1 className="text-xl font-semibold text-destructive"
            >应用发生错误</h1>
            <p className="text-sm text-muted-foreground"
            >
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

function App() {
  const [leftPanelWidth, setLeftPanelWidth] = useState(240)
  const [rightPanelWidth, setRightPanelWidth] = useState(320)
  const [isResizingLeft, setIsResizingLeft] = useState(false)
  const [isResizingRight, setIsResizingRight] = useState(false)

  const { graphs, currentGraphId, loadGraphs } = useGraphStore()

  useEffect(() => {
    loadGraphs()
  }, [loadGraphs])

  // 拖拽调整面板宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingLeft) {
        setLeftPanelWidth(Math.max(180, Math.min(400, e.clientX)))
      }
      if (isResizingRight) {
        setRightPanelWidth(Math.max(240, Math.min(500, window.innerWidth - e.clientX)))
      }
    }

    const handleMouseUp = () => {
      setIsResizingLeft(false)
      setIsResizingRight(false)
    }

    if (isResizingLeft || isResizingRight) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingLeft, isResizingRight])

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen bg-background overflow-hidden select-none">
        {/* 左侧目录树 */}
        <div style={{ width: leftPanelWidth, minWidth: leftPanelWidth }} className="flex-shrink-0">
          <LeftPanel />
        </div>

        {/* 左侧分割线 */}
        <div
          className="w-1 cursor-col-resize hover:bg-primary/50 transition-colors flex-shrink-0"
          onMouseDown={() => setIsResizingLeft(true)}
        />

        {/* 中间画布区域 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 图 Tab 切换 */}
          <GraphTabs graphs={graphs} currentGraphId={currentGraphId} />

          {/* 画布 */}
          <div className="flex-1 relative">
            {currentGraphId ? (
              <GraphCanvas graphId={currentGraphId} />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  <p className="text-lg font-medium mb-2">欢迎使用 BizGraph</p>
                  <p className="text-sm">创建或选择一个图开始工作</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右侧分割线 */}
        <div
          className="w-1 cursor-col-resize hover:bg-primary/50 transition-colors flex-shrink-0"
          onMouseDown={() => setIsResizingRight(true)}
        />

        {/* 右侧 Agent 面板 */}
        <div style={{ width: rightPanelWidth, minWidth: rightPanelWidth }} className="flex-shrink-0">
          <RightPanel />
        </div>
      </div>
    </ErrorBoundary>
  )
}

export default App
