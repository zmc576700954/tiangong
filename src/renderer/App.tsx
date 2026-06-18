import { useState, useEffect, Component, type ReactNode } from 'react'
import { LeftPanel } from './panels/LeftPanel'
import { RightPanel } from './panels/RightPanel'
import { GraphCanvas } from './canvas/GraphCanvas'
import { GraphTabs } from './components/GraphTabs'
import { useGraphStore } from './store/graphStore'
import { useAgentStore } from './store/agentStore'
import { useResizablePanel } from './hooks/useResizablePanel'

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
  const leftPanel = useResizablePanel({
    initialWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    direction: 'left',
  })

  const rightPanel = useResizablePanel({
    initialWidth: 320,
    minWidth: 240,
    maxWidth: 500,
    direction: 'right',
  })

  const [expandedAgent, setExpandedAgent] = useState(false)

  // Responsive layout detection
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const isSmallScreen = windowWidth < 1024

  const graphs = useGraphStore((s) => s.graphs)
  const currentGraphId = useGraphStore((s) => s.currentGraphId)
  const loadGraphs = useGraphStore((s) => s.loadGraphs)

  useEffect(() => {
    loadGraphs()
    // 启动时从 DB 恢复 agent 聊天记录
    useAgentStore.getState().hydrateOnStart()
  }, [loadGraphs])

  // 同步展开模式到右侧面板固定宽度
  useEffect(() => {
    rightPanel.setFixedWidth(expandedAgent ? 480 : null)
  }, [expandedAgent])

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen bg-background overflow-hidden">
        {/* Left directory tree — hidden on small screens */}
        {!isSmallScreen && (
          <>
            <div style={{ width: leftPanel.width, minWidth: leftPanel.width }} className="shrink-0">
              <LeftPanel />
            </div>
            <div
              className="group relative flex cursor-col-resize items-center justify-center shrink-0 select-none"
              style={{ width: '3px' }}
              onMouseDown={leftPanel.startResize}
            >
              <div className="h-full w-px bg-border group-hover:w-0.5 group-hover:bg-primary/50 transition-all" />
            </div>
          </>
        )}

        {/* Center canvas area */}
        <div className="flex-1 flex flex-col min-w-0">
          <GraphTabs graphs={graphs} currentGraphId={currentGraphId} />
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

        {/* Right Agent panel — always visible */}
        <div
          className="group relative flex cursor-col-resize items-center justify-center shrink-0 select-none"
          style={{ width: '3px' }}
          onMouseDown={rightPanel.startResize}
        >
          <div className="h-full w-px bg-border group-hover:w-0.5 group-hover:bg-primary/50 transition-all" />
        </div>
        <div
          style={{ width: rightPanel.width, minWidth: rightPanel.width }}
          className="shrink-0"
        >
          <RightPanel
            expandedAgent={expandedAgent}
            onToggleExpand={() => setExpandedAgent(!expandedAgent)}
          />
        </div>
      </div>
    </ErrorBoundary>
  )
}

export default App
