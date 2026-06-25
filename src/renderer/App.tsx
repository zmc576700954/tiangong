import { useState, useEffect, lazy, Suspense } from 'react'
import { LeftPanel } from './panels/LeftPanel'
import { GraphCanvas } from './canvas/GraphCanvas'
import { GraphTabs } from './components/GraphTabs'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { useGraphStore } from './store/graphStore'
import { useAgentStore } from './store/agentStore'
import { useResizablePanel } from './hooks/useResizablePanel'
import { PanelLeftOpen, PanelRightOpen } from 'lucide-react'

const RightPanel = lazy(() => import('./panels/RightPanel').then(m => ({ default: m.RightPanel })))

function RightPanelFallback() {
  return <div className="h-full w-full flex items-center justify-center bg-background/50" />
}

function App() {
  const {
    width: leftWidth,
    collapsed: leftCollapsed,
    toggleCollapse: toggleLeftPanel,
    startResize: startLeftResize,
  } = useResizablePanel({
    initialWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    direction: 'left',
  })

  const {
    width: rightWidth,
    setFixedWidth: setRightPanelWidth,
    startResize: startRightResize,
  } = useResizablePanel({
    initialWidth: 320,
    minWidth: 240,
    maxWidth: 500,
    direction: 'right',
  })

  const [expandedAgent, setExpandedAgent] = useState(false)

  const [rightPanelVisible, setRightPanelVisible] = useState(() => {
    const saved = localStorage.getItem('bizgraph:panel:right:visible')
    return saved !== null ? saved === 'true' : true
  })

  // Persist panel visibility to localStorage
  useEffect(() => {
    localStorage.setItem('bizgraph:panel:right:visible', String(rightPanelVisible))
  }, [rightPanelVisible])

  // Keyboard shortcuts for panel toggling
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        toggleLeftPanel()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'j') {
        e.preventDefault()
        setRightPanelVisible(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleLeftPanel])

  // Responsive layout detection
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout>
    const handler = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => setWindowWidth(window.innerWidth), 150)
    }
    window.addEventListener('resize', handler)
    return () => {
      clearTimeout(resizeTimer)
      window.removeEventListener('resize', handler)
    }
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

  // Auto-expand left panel when menu: Open Project fires
  useEffect(() => {
    const unsub = window.electronAPI.onMenuOpenProject(() => {
      if (leftCollapsed) toggleLeftPanel()
    })
    return unsub
  }, [leftCollapsed, toggleLeftPanel])

  // 同步展开模式到右侧面板固定宽度
  useEffect(() => {
    setRightPanelWidth(expandedAgent ? 480 : null)
  }, [expandedAgent, setRightPanelWidth])

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen bg-background overflow-hidden">
        {/* Left directory tree */}
        {!leftCollapsed && (
          <>
            <ErrorBoundary label="项目面板">
              <div style={{ width: leftWidth, minWidth: leftWidth }} className="shrink-0">
                <LeftPanel onCollapse={toggleLeftPanel} />
              </div>
            </ErrorBoundary>
            <div
              className="group relative flex cursor-col-resize items-center justify-center shrink-0 select-none"
              style={{ width: '3px' }}
              onMouseDown={startLeftResize}
            >
              <div className="h-full w-px bg-border group-hover:w-0.5 group-hover:bg-primary/50 transition-all" />
            </div>
          </>
        )}

        {/* Center canvas area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Left panel toggle */}
          {leftCollapsed && (
            <button
              onClick={toggleLeftPanel}
              className="absolute top-2 left-2 z-10 p-1.5 rounded hover:bg-muted transition-colors"
              title="Show project panel"
              aria-label="Show project panel"
              aria-expanded="false"
            >
              <PanelLeftOpen className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
          <GraphTabs graphs={graphs} currentGraphId={currentGraphId} />
          <ErrorBoundary label="画布">
            <div className="flex-1 relative">
              {leftCollapsed && !isSmallScreen && (
                <button
                  onClick={() => toggleLeftPanel()}
                  className="absolute left-0 top-0 bottom-0 z-10 w-6 flex items-center justify-center bg-primary/5 border-r border-primary/20 hover:bg-primary/10 hover:w-8 transition-all group"
                  title="Show file tree (Ctrl+B)"
                  aria-label="Show file tree"
                  aria-expanded="false"
                >
                  <PanelLeftOpen className="w-4 h-4 text-primary/60 group-hover:text-primary transition-colors" />
                </button>
              )}
              {!rightPanelVisible && (
                <button
                  onClick={() => setRightPanelVisible(true)}
                  className="absolute right-0 top-0 bottom-0 z-10 w-6 flex items-center justify-center bg-primary/5 border-l border-primary/20 hover:bg-primary/10 hover:w-8 transition-all group"
                  title="Show panel (Ctrl+J)"
                  aria-label="Show right panel"
                  aria-expanded="false"
                >
                  <PanelRightOpen className="w-4 h-4 text-primary/60 group-hover:text-primary transition-colors" />
                </button>
              )}
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
          </ErrorBoundary>
        </div>

        {/* Right Agent panel — conditionally visible */}
        {rightPanelVisible && (
          <>
            <div
              className="group relative flex cursor-col-resize items-center justify-center shrink-0 select-none"
              style={{ width: '3px' }}
              onMouseDown={startRightResize}
            >
              <div className="h-full w-px bg-border group-hover:w-0.5 group-hover:bg-primary/50 transition-all" />
            </div>
            <ErrorBoundary label="Agent 面板">
              <div
                style={{ width: rightWidth, minWidth: rightWidth }}
                className="shrink-0"
              >
                <Suspense fallback={<RightPanelFallback />}>
                  <RightPanel
                    expandedAgent={expandedAgent}
                    onToggleExpand={() => setExpandedAgent(v => !v)}
                    onClose={() => setRightPanelVisible(false)}
                  />
                </Suspense>
              </div>
            </ErrorBoundary>
          </>
        )}
      </div>
    </ErrorBoundary>
  )
}

export default App
