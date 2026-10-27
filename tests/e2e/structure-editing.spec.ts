/**
 * 结构编辑的浏览器 e2e 验收闸门。
 *
 * 覆盖八件事：
 *   1. 父子关系由 `nodes.parent_id` 派生 → 父子之间**恰好一条**线（存储里的层级边不重复画）
 *   2. 拖到另一个节点上 → 旧线消失、新线出现
 *   3. 拖到类型不允许的父节点上 → 被拒，`graph:reparent` **根本没被调用**
 *   4. 拖到自己的后代上 → 被拒，`graph:reparent` **根本没被调用**
 *   5. 删除父节点 → 子节点留在画布上、变成根（不再连着已删的父）
 *   6. 布局选择持久化 → 切到力导向 → 刷新后仍是力导向
 *   7. 布局选择的读回时机 → 启动时读回存着的模式，不会被首帧写成 tree
 *   8. 点层级线 → 什么都不选中（不开空白右面板、不留删不掉的选中框）
 *
 * ⚠️ **拒绝类用例为什么必须断言「IPC 没被调用」**：
 * 只断言「连线没变」是不够的 —— 落点被默默接受、而 mock 的 `movedPositions` 是空数组时，
 * 连线同样不会变，测试照样绿。唯一能证明「渲染层在 IPC 之前就拒绝了落点」的断言，
 * 是 `graph:reparent` 的调用记录为空。
 *
 * ⚠️ **每条拒绝用例后面都跟一次合法拖拽当对照组**：
 * 对照组证明「调用记录为空」不是因为 IPC 通道坏了、也不是因为读得太早 ——
 * 同一页、同一个通道，合法落点确实会留下调用记录。
 *
 * ⚠️ **必须写 `127.0.0.1`，不能写 `localhost`**：
 * macOS 上 `localhost` 优先解析成 IPv6 `::1`，本机上 `[::1]:5173` 被别的项目占着 →
 * Playwright 会连到**别人的应用**上 → 一个永远绿、却什么都没验的假闸门。
 */
import { test, expect, type Page } from '@playwright/test'
import { waitForCanvas } from './helpers/graph-helpers'
import { setupMockIpc, getReparentCalls, type MockNode, type MockEdge } from './helpers/mock-ipc'
import { canvasZh } from '@shared/i18n/resources/domains/canvas'
import { projectsZh } from '@shared/i18n/resources/domains/projects'

/** mock 图的项目路径 —— 布局模式的 localStorage 键按它分区 */
const MOCK_PROJECT_PATH = '/tmp/bizgraph-e2e-project'
const LAYOUT_MODE_KEY = `bizgraph.layoutMode.${MOCK_PROJECT_PATH}`

const MODULE_A = 'node_mod_a'
const MODULE_D = 'node_mod_d'
const MODULE_G = 'node_mod_g'
const PROCESS_B = 'node_proc_b'
const PROCESS_F = 'node_proc_f'
const FEATURE_E = 'node_feat_e'

/** 层级边的 id 形如 `derived-<父>-<子>` */
function derivedEdgeId(parentId: string, childId: string): string {
  return `derived-${parentId}-${childId}`
}

function makeNode(
  id: string,
  type: string,
  title: string,
  position: { x: number; y: number },
  parentId?: string,
): MockNode {
  return {
    id,
    graphId: 'graph_e2e_001',
    graphType: 'dev',
    type,
    title,
    description: '',
    position,
    status: 'placeholder',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    content: {},
    ...(parentId ? { parentId } : {}),
  }
}

/**
 * 打开 mock 图。
 *
 * ⚠️ 用 `127.0.0.1` 而不是 `localhost` —— 见文件头注释。
 */
async function gotoMockGraph(page: Page): Promise<void> {
  await page.goto('http://127.0.0.1:5173')
  await page.click('text=E2E Test Graph')
  await waitForCanvas(page)
}

/**
 * 等画布布局稳定。
 *
 * 首屏会自动跑一次 dagre 布局 + fitView 动画（400ms）—— 动画没跑完就量节点位置，
 * 量到的是动画中途的坐标，拖拽就会落到错误的落点上。
 *
 * 要求**连续 5 次**读数相同（间隔 100ms）才认为稳定：只看两次的话，
 * 有可能刚好在布局开始前读到两个相同的值就返回。
 */
async function waitForStableLayout(page: Page, nodeIds: string[]): Promise<void> {
  let previous = ''
  let stableRounds = 0
  for (let attempt = 0; attempt < 100; attempt++) {
    const boxes = await Promise.all(
      nodeIds.map((id) => page.locator(`[data-id="${id}"]`).boundingBox()),
    )
    const signature = JSON.stringify(boxes)
    if (signature === previous && boxes.every((box) => box !== null)) {
      stableRounds += 1
      if (stableRounds >= 5) return
    } else {
      stableRounds = 0
    }
    previous = signature
    await page.waitForTimeout(100)
  }
  throw new Error(`画布布局没有稳定下来：${nodeIds.join(', ')}`)
}

async function nodeCenter(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-id="${nodeId}"]`).boundingBox()
  if (!box) throw new Error(`节点 ${nodeId} 不在画布上`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * 把一个节点拖到另一个节点上并松手。
 *
 * @param onHover 松手**之前**的回调 —— 用来断言落点反馈（红框 / 原因提示）。
 *                落点判定在拖拽过程中实时跑，松手后候选就被清掉了。
 */
async function dragNodeOnto(
  page: Page,
  fromId: string,
  toId: string,
  onHover?: () => Promise<void>,
): Promise<void> {
  const from = await nodeCenter(page, fromId)
  const to = await nodeCenter(page, toId)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // 先挪一点点越过 nodeDragThreshold（3px），拖拽才会真正开始
  await page.mouse.move(from.x - 15, from.y, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 20 })
  // 等落点判定跑完（候选是拖拽过程中实时算的）
  await page.waitForTimeout(250)
  if (onHover) await onHover()
  await page.mouse.up()
  await page.waitForTimeout(300)
}

/** 层级边的选择器 —— 排除拖拽中的幽灵连线 */
const HIERARCHY_EDGE_SELECTOR = '.react-flow__edge:not([data-id^="ghost-"])'

/**
 * 画布上所有**层级**边的 id（排序后）。
 *
 * ⚠️ 拖拽结束的瞬间画布会闪一下 —— 派生边要等节点重新量完尺寸才画得出来，
 * 那一瞬间边是空的。所以「边集合没变」这种断言必须用 `expect.poll`（等稳定态），
 * 不能用一次性读取。
 *
 * ⚠️ 排除 `ghost-*`：幽灵连线是拖拽中的临时提示，不是层级关系。
 */
async function edgeIds(page: Page): Promise<string[]> {
  const ids = await page
    .locator(HIERARCHY_EDGE_SELECTOR)
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-id') ?? ''))
  return ids.sort()
}

test.describe('结构编辑（层级派生 / 拖拽重挂 / 删除父节点 / 布局持久化）', () => {
  /**
   * 用一个**更宽的视口**跑这些用例。
   *
   * xyflow 的 `autoPanOnNodeDrag` 是开的：指针进到画布容器边缘 40px 以内就会
   * 自动平移视口。落点一旦漂移，命中判定就落空 —— 拖拽看起来「没反应」，
   * 其实是被自动平移带跑了。默认的 1280 宽视口下，最右边那列节点正好贴着
   * 画布右边缘（容器只有 ~800px 宽），必然踩这个坑。
   *
   * 这不是测试的将就，是应用真实存在的交互边界 —— 1600 宽只是为了把落点
   * 挪出自动平移的触发区，让断言测的是「重挂规则」而不是「自动平移」。
   */
  test.use({ viewport: { width: 1600, height: 900 } })

  test('父子关系由 parent_id 派生：父子之间恰好一条线，存储里的层级边不重复画', async ({ page }) => {
    // 存储里**同时**有一条历史层级边（父子同向）—— 渲染时必须被丢弃，
    // 否则父子之间会出现两条线。
    const storedEdge: MockEdge = {
      id: 'edge_stored_hier',
      graphId: 'graph_e2e_001',
      source: MODULE_A,
      target: PROCESS_B,
      edgeType: 'hierarchical',
    }
    await setupMockIpc(page, {
      nodes: [
        makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 }),
        makeNode(PROCESS_B, 'process', 'Process B', { x: 600, y: 300 }, MODULE_A),
      ],
      edges: [storedEdge],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [MODULE_A, PROCESS_B])

    // 两个业务节点都在（画布另有自动创建的 project 根节点，不算在里面）
    await expect(
      page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') }),
    ).toHaveCount(2)

    // 恰好一条线，且是**派生**出来的那条（存储里的层级边不参与渲染）
    await expect(page.locator(HIERARCHY_EDGE_SELECTOR)).toHaveCount(1)
    await expect(
      page.locator(`.react-flow__edge[data-id="${derivedEdgeId(MODULE_A, PROCESS_B)}"]`),
    ).toHaveCount(1)
  })

  test('拖到另一个节点上：旧线消失、新线出现', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [
        makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 }),
        makeNode(MODULE_D, 'module', 'Module D', { x: 200, y: 600 }),
        makeNode(PROCESS_B, 'process', 'Process B', { x: 600, y: 300 }, MODULE_A),
      ],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [MODULE_A, MODULE_D, PROCESS_B])

    // 拖之前：只有 A → B 一条线
    await expect.poll(() => edgeIds(page)).toEqual([derivedEdgeId(MODULE_A, PROCESS_B)])

    // 把 Process B 拖到 Module D 上（module 允许 process 子节点 → 合法落点）
    await dragNodeOnto(page, PROCESS_B, MODULE_D)

    // IPC 真的被调用了，且参数是「被拖节点 → 新父节点」
    await expect
      .poll(() => getReparentCalls(page))
      .toEqual([{ nodeId: PROCESS_B, newParentId: MODULE_D }])

    // 新线在
    await expect(
      page.locator(`.react-flow__edge[data-id="${derivedEdgeId(MODULE_D, PROCESS_B)}"]`),
    ).toHaveCount(1)
    // 旧线没了 —— 画布上总共就这一条线
    await expect(page.locator(HIERARCHY_EDGE_SELECTOR)).toHaveCount(1)
  })

  test('拖到类型不允许的父节点上：被拒，graph:reparent 根本没被调用', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [
        makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 }),
        makeNode(MODULE_D, 'module', 'Module D', { x: 200, y: 600 }),
        makeNode(MODULE_G, 'module', 'Module G', { x: 200, y: 900 }),
        makeNode(PROCESS_B, 'process', 'Process B', { x: 600, y: 300 }, MODULE_A),
        makeNode(PROCESS_F, 'process', 'Process F', { x: 600, y: 600 }, MODULE_A),
        makeNode(FEATURE_E, 'feature', 'Feature E', { x: 900, y: 300 }, PROCESS_B),
      ],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [
      MODULE_A,
      MODULE_D,
      MODULE_G,
      PROCESS_B,
      PROCESS_F,
      FEATURE_E,
    ])

    const edgesBefore = [
      derivedEdgeId(MODULE_A, PROCESS_B),
      derivedEdgeId(MODULE_A, PROCESS_F),
      derivedEdgeId(PROCESS_B, FEATURE_E),
    ]
    await expect.poll(() => edgeIds(page)).toEqual(edgesBefore)

    // feature 的 allowedParentTypes 只有 ['process'] → 挂到 module 上类型不允许
    await dragNodeOnto(page, FEATURE_E, MODULE_D, async () => {
      await expect(page.getByText(canvasZh['canvas.reparent.invalidType'])).toBeVisible()
    })

    // 核心断言：渲染层在 IPC 之前就拒了 —— 一次都没调用
    expect(await getReparentCalls(page)).toEqual([])
    // 连线一条没动（poll 等的是稳定态：拖拽结束的瞬间画布会闪一下）
    await expect.poll(() => edgeIds(page)).toEqual(edgesBefore)

    // 对照组：另一个节点拖到合法的父节点（另一个 module）上 → IPC 会被调用。
    // 这一步证明「调用记录为空」不是因为 IPC 通道坏了、也不是因为读得太早。
    await dragNodeOnto(page, PROCESS_B, MODULE_G)
    await expect
      .poll(() => getReparentCalls(page))
      .toEqual([{ nodeId: PROCESS_B, newParentId: MODULE_G }])
    await expect(
      page.locator(`.react-flow__edge[data-id="${derivedEdgeId(MODULE_G, PROCESS_B)}"]`),
    ).toHaveCount(1)
  })

  test('拖到自己的后代上：被拒，graph:reparent 根本没被调用', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [
        makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 }),
        makeNode(MODULE_D, 'module', 'Module D', { x: 200, y: 600 }),
        makeNode(MODULE_G, 'module', 'Module G', { x: 200, y: 900 }),
        makeNode(PROCESS_B, 'process', 'Process B', { x: 600, y: 300 }, MODULE_A),
        makeNode(PROCESS_F, 'process', 'Process F', { x: 600, y: 600 }, MODULE_A),
        makeNode(FEATURE_E, 'feature', 'Feature E', { x: 900, y: 300 }, PROCESS_B),
      ],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [
      MODULE_A,
      MODULE_D,
      MODULE_G,
      PROCESS_B,
      PROCESS_F,
      FEATURE_E,
    ])

    const edgesBefore = [
      derivedEdgeId(MODULE_A, PROCESS_B),
      derivedEdgeId(MODULE_A, PROCESS_F),
      derivedEdgeId(PROCESS_B, FEATURE_E),
    ]
    await expect.poll(() => edgeIds(page)).toEqual(edgesBefore)

    // Feature E 是 Process B 的孩子 → 把 B 拖到 E 上会成环。
    //
    // ⚠️ 这一条落点**类型上也不合法**（feature 的 allowedChildTypes 只有 ['bug']），
    // 所以「文案断言」必须钉住**具体是哪条规则**在拦：判定顺序是
    // ① 成环 → ② 跨图 → ③ 类型，环排在类型**前面** → 显示的一定是「成环」文案。
    // 把环判定去掉的话，这条用例会立刻红（文案变成「类型不允许」）。
    await dragNodeOnto(page, PROCESS_B, FEATURE_E, async () => {
      await expect(page.getByText(canvasZh['canvas.reparent.cycle'])).toBeVisible()
    })

    // 核心断言：渲染层在 IPC 之前就拒了 —— 一次都没调用
    expect(await getReparentCalls(page)).toEqual([])
    // 连线一条没动（poll 等的是稳定态：拖拽结束的瞬间画布会闪一下）
    await expect.poll(() => edgeIds(page)).toEqual(edgesBefore)

    // 对照组：另一个节点拖到不相干的 module 上 → 类型与环都合法 → IPC 会被调用
    await dragNodeOnto(page, PROCESS_F, MODULE_G)
    await expect
      .poll(() => getReparentCalls(page))
      .toEqual([{ nodeId: PROCESS_F, newParentId: MODULE_G }])
    await expect(
      page.locator(`.react-flow__edge[data-id="${derivedEdgeId(MODULE_G, PROCESS_F)}"]`),
    ).toHaveCount(1)
  })

  test('删除父节点：子节点留在画布上，并变成根（不再连着已删的父）', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [
        makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 }),
        makeNode(PROCESS_B, 'process', 'Process B', { x: 600, y: 300 }, MODULE_A),
      ],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [MODULE_A, PROCESS_B])

    // 拖之前确实有一条父子线
    await expect(page.locator(HIERARCHY_EDGE_SELECTOR)).toHaveCount(1)

    // 走 UI 的删除菜单。
    //
    // ⚠️ **这里没有用共享的 `deleteNodeViaMenu()`，是有意的偏离，必须记在报告里**：
    // `openNodeMenu` 用 `node.dispatchEvent('contextmenu')` 触发菜单 ——
    // 合成事件没有 clientX/clientY，`useMenuPosition` 算出 NaN 偏移 →
    // 菜单 portal 停在静态位置（实测 top=720、按钮在 y=1171）→ 落在视口外 →
    // Playwright 报 "element is outside of the viewport"。
    // 这正是 `node-interactions.spec.ts › should delete a node via context menu`
    // 那条**既有失败**的成因（1600×900 视口下也照样失败，已实测）。
    //
    // 本任务不修那个失败（超范围）、也不改共享 helper（会让别的 spec 跟着变），
    // 更不能让新 spec 依赖它 —— 所以这里用**真右键**（Playwright 的
    // `click({ button: 'right' })` 带着真实坐标），菜单位置就对了。
    // 删的还是同一条 UI 路径：同一个 `[data-testid="node-menu-delete"]` 按钮。
    await page.locator(`[data-id="${MODULE_A}"]`).click({ button: 'right' })
    await page.click('[data-testid="node-menu-delete"]')

    // 父节点没了
    await expect(page.locator(`[data-id="${MODULE_A}"]`)).toHaveCount(0)
    // 子节点还在（孤儿不产生边 → 看上去就是一个根节点）
    await expect(page.locator(`[data-id="${PROCESS_B}"]`)).toHaveCount(1)
    await expect(
      page.locator('[data-id].react-flow__node').filter({ has: page.locator('[role="button"]') }),
    ).toHaveCount(1)
    // 父子线也没了
    await expect(page.locator(HIERARCHY_EDGE_SELECTOR)).toHaveCount(0)
  })

  test('布局选择持久化：切到力导向 → 刷新后仍是力导向', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 })],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [MODULE_A])

    const trigger = page.locator('[data-testid="layout-menu-trigger"]')
    await expect(trigger).toContainText(canvasZh['canvas.layout.modeTree'])

    // 切到力导向
    await trigger.click()
    await page.click('[data-testid="layout-force"]')
    await expect(trigger).toContainText(canvasZh['canvas.layout.modeForce'])

    // 写进了「按项目分区」的键
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_MODE_KEY)).toBe(
      'force',
    )

    // 刷新页面 → 重新选图 → 仍然是力导向
    await page.reload()
    await page.click('text=E2E Test Graph')
    await waitForCanvas(page)
    await expect(trigger).toContainText(canvasZh['canvas.layout.modeForce'])

    // 刷新不会把存的值冲掉
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_MODE_KEY)).toBe(
      'force',
    )
  })

  test('布局选择持久化：启动时读回存着的模式，不会被首帧写成 tree', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 })],
    })
    // 存值**在应用脚本跑之前**就写好 —— 首帧读到的 projectPath 还是空的，
    // 若读值放在 useState 初始化函数里、或者写值放在 effect 里，
    // 这个 'force' 会被首帧的 'tree' 冲掉。
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, 'force')
    }, LAYOUT_MODE_KEY)

    await gotoMockGraph(page)
    await waitForStableLayout(page, [MODULE_A])

    const trigger = page.locator('[data-testid="layout-menu-trigger"]')
    await expect(trigger).toContainText(canvasZh['canvas.layout.modeForce'])
    // 首帧没有把用户存的值覆盖掉
    expect(await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_MODE_KEY)).toBe(
      'force',
    )
  })

  /**
   * 「层级线点了没反应」是**被接受的产品语义**（层级是 parent_id 的渲染产物，
   * 没有可编辑的存储边对象），但「没反应」必须干净：
   * 不能弹出空白的右面板，也不能留一个删不掉的选中框。
   *
   * 这条用例把这两点钉死 —— `onEdgeClick` 里那道 `edgeType === 'hierarchical'` 的
   * 守卫一旦被去掉，选中态就会落到一条**并不存在**的存储边上：
   * 右面板找不到对应的边 → 空白面板；浮动条弹出「按 Delete 删除连接线」→ 删不掉。
   */
  test('点击层级线：什么都不选中 —— 不开空白右面板，也不留删不掉的选中框', async ({ page }) => {
    await setupMockIpc(page, {
      nodes: [
        makeNode(MODULE_A, 'module', 'Module A', { x: 200, y: 300 }),
        makeNode(PROCESS_B, 'process', 'Process B', { x: 600, y: 300 }, MODULE_A),
      ],
    })
    await gotoMockGraph(page)
    await waitForStableLayout(page, [MODULE_A, PROCESS_B])

    // 取层级线路径上**真正的一个点**。
    //
    // ⚠️ `getPointAtLength` 返回的是路径**自身坐标系**里的点，不是屏幕坐标；
    // 画布有缩放平移，直接当屏幕坐标用会点偏（点到空气上，断言就成了空转）。
    // `getScreenCTM()` 才能把它换算到屏幕坐标。
    const point = await page.evaluate(() => {
      const path = document.querySelector<SVGPathElement>(
        '.react-flow__edge[data-id^="derived-"] path.react-flow__edge-path',
      )
      if (!path) return null
      const mid = path.getPointAtLength(path.getTotalLength() / 2)
      const ctm = path.getScreenCTM()
      if (!ctm) return null
      const screen = new DOMPoint(mid.x, mid.y).matrixTransform(ctm)
      return { x: screen.x, y: screen.y }
    })
    if (!point) throw new Error('画布上没有层级线')
    await page.mouse.click(point.x, point.y)
    await page.waitForTimeout(500)

    // 没有选中框（框选矩形）
    await expect(page.locator('.react-flow__selection')).toHaveCount(0)
    // 没有选中任何一条边（选中态的边会带 .selected）
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(0)
    // 没有弹出「按 Delete 删除连接线」的浮动条 —— 那是个删不掉的选中残留
    await expect(page.getByText(canvasZh['canvas.delete.edgeHint'])).toHaveCount(0)
    // 右面板仍是「未选中」的空态，而不是一块空白面板
    await expect(page.getByText(projectsZh['right.emptyTitle'])).toBeVisible()
  })
})
