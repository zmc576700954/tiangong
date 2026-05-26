import { useState, useEffect } from 'react'
import { LeftPanel } from './panels/LeftPanel'
import { RightPanel } from './panels/RightPanel'
import { GraphCanvas } from './canvas/GraphCanvas'
import { GraphTabs } from './components/GraphTabs'
import { useGraphStore } from './store/graphStore'

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
  )
}

export default App
