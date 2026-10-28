import { describe, it, expect } from 'vitest'
import { isReparentEnabled } from '../reparent-gate'

/**
 * R-38 的 fail-closed 闸门。
 *
 * 这条不变量此前**没有任何自动化覆盖**：把 `=== 'tree'` 改成 fail-open 的
 * `!== 'force'`，13 条结构编辑 e2e 照样全绿（控制器亲手做的变异验证）。
 * 这三条断言就是那道缺失的闸门。
 */
describe('isReparentEnabled', () => {
  it('is off while the layout mode has not been read back yet', () => {
    // 模式未知（null）时必须**关着** —— 那正是「力导向项目」最容易被误伤的时刻。
    // 判成开 → 力导向项目的重挂在首屏那一瞬是开着的 → 仿真坐标覆盖重挂结果。
    expect(isReparentEnabled(null)).toBe(false)
  })

  it('is off in force layout', () => {
    // R-38 明确禁止力导向下重挂：力导向一次拖拽结束会把所有节点的仿真坐标
    // 整体写回数据库，覆盖掉重挂算出来的锚点位置与整棵子树的平移结果。
    expect(isReparentEnabled('force')).toBe(false)
  })

  it('is on in tree layout', () => {
    expect(isReparentEnabled('tree')).toBe(true)
  })
})
