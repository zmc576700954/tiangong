# BizGraph 思维导图功能完善计划

## 一、现状诊断

### 1.1 当前架构
- **技术栈**：Electron + React 19 + @xyflow/react 12.4 + Tailwind CSS 4 + Zustand + LibSQL
- **数据层**：`GraphNode` 已有 `parentId` 字段，但未在视觉层利用
- **画布层**：`GraphCanvas.tsx` 使用自由布局，节点位置完全手动/随机
- **边层**：仅含 `source/target/label`，无样式、无流程逻辑表达

### 1.2 现存问题清单
| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 1 | 节点无层级关联展示 | parentId 仅存数据，无布局算法 | 思维导图失去树形结构语义 |
| 2 | 无法创建子节点 | 缺少"以某节点为父"的交互入口 | 无法构建层级关系 |
| 3 | 节点无法添加备注 | 数据模型无 notes 字段，UI 无入口 | 节点信息承载力不足 |
| 4 | 连接线效果薄弱 | 使用默认直线边，无正交连线 | 导图脉络不清晰 |
| 5 | 无法表达流程逻辑 | 边无 condition/style 字段 | 无法表示分支/条件流转 |

---

## 二、总体设计目标

将当前自由画布升级为**支持双模式（自由布局 / 树形思维导图布局）**的可视化节点编辑器：

1. **树形模式**：基于 `parentId` 自动计算层级位置，呈现标准思维导图结构
2. **子节点体系**：任意节点可一键创建子节点，自动建立父子关系和连线
3. **备注系统**：每个节点支持富文本备注，可折叠/展开查看
4. **连接线增强**：支持正交折线、贝塞尔曲线，边上可标注条件逻辑
5. **流程逻辑**：边上支持条件表达式（如 `if approved`、`while retry < 3`），不同逻辑用不同线型/颜色区分

---

## 三、分阶段实施计划

### 阶段一：数据模型扩展（第 1 轮）
**目标**：为所有新功能打好数据基础，确保前后兼容。

#### 3.1.1 GraphNode 模型扩展
```typescript
export interface GraphNode {
  // ... 现有字段 ...
  parentId?: string

  /** 新增：节点备注（支持 Markdown） */
  notes?: string

  /** 新增：节点在树形模式下的折叠状态 */
  collapsed?: boolean

  /** 新增：节点自定义样式覆盖 */
  style?: {
    backgroundColor?: string
    borderColor?: string
    width?: number
    height?: number
  }
}
```

#### 3.1.2 GraphEdge 模型扩展
```typescript
export interface GraphEdge {
  // ... 现有字段 ...
  label?: string

  /** 新增：连线类型 */
  edgeType?: 'default' | 'straight' | 'step' | 'smoothstep' | 'bezier'

  /** 新增：连线样式 */
  style?: {
    stroke?: string
    strokeWidth?: number
    strokeDasharray?: string  // 虚线模式
  }

  /** 新增：流程条件 / 逻辑表达式 */
  condition?: string

  /** 新增：箭头类型 */
  markerEnd?: 'arrow' | 'arrow-closed' | 'none'
}
```

#### 3.1.3 数据库迁移（database.ts）
- 在 `migrate()` 中增加字段检测与追加逻辑（SQLite `ALTER TABLE`）
- `nodes` 表追加：`notes TEXT`, `collapsed INTEGER DEFAULT 0`, `style TEXT`
- `edges` 表追加：`edge_type TEXT`, `style TEXT`, `condition TEXT`, `marker_end TEXT`
- 存量数据兼容：新字段均为可选，不影响已有数据

#### 3.1.4 IPC API 扩展（ipc-handlers.ts）
- `node:update` 支持更新 `notes` / `collapsed` / `style`
- `edge:update` 新增 IPC 通道，支持更新边的所有新属性
- `edge:update` 需要在 `IpcApi` 中声明

#### 3.1.5 Store 层扩展（graphStore.ts）
- 新增 `updateEdge(id, data)` 方法
- 节点操作保持向后兼容

---

### 阶段二：树形布局引擎（第 2 轮）
**目标**：让 parentId 真正驱动视觉层级。

#### 3.2.1 布局模式设计
引入两种布局模式，用户可切换：
- **Free Mode（自由模式）**：当前行为，节点位置自由拖拽
- **Tree Mode（树形模式）**：基于 parentId 自动排列，禁止手动拖拽（或拖拽后自动重新平衡）

#### 3.2.2 树形布局算法
**选型**：自研轻量级树布局（不引入 dagre，减少依赖）

算法思路（横向思维导图）：
```
1. 构建父子映射：Map<parentId, children[]>
2. 从根节点（parentId = undefined）开始 DFS
3. 每层节点在 X 轴上等距排列，Y 轴按深度递进
4. 计算每个子树的"高度"（叶子节点数），确保兄弟子树不重叠
5. 支持展开/折叠：collapsed=true 的节点不渲染其子树
```

关键参数：
- `TREE_NODE_WIDTH = 200`
- `TREE_NODE_HEIGHT = 80`
- `TREE_LEVEL_GAP = 180`（层间距）
- `TREE_SIBLING_GAP = 24`（兄弟节点间距）

#### 3.2.3 集成到 GraphCanvas
- 添加 `layoutMode: 'free' | 'tree'` state
- 切换模式时调用布局算法重新计算所有节点 position
- Tree Mode 下：
  - 节点位置由算法决定，拖拽后可选是否重新布局
  - 节点显示折叠/展开按钮（有子节点时）
  - 边使用 `SmoothStepEdge` 或自定义 `MindMapEdge` 实现正交折线

#### 3.2.4 自定义 MindMapEdge 组件
使用 @xyflow/react 的自定义 Edge，实现思维导图风格的连接线：
- 从父节点右侧中点出发
- 水平延伸一段后向下/上折线
- 进入子节点左侧中点
- 边上可显示 `condition` 标签

---

### 阶段三：子节点创建体系（第 3 轮）
**目标**：让"创建子节点"成为一等公民操作。

#### 3.3.1 节点右键菜单增强
在 `BizNodeComponent` 或画布层面增加节点级右键菜单（区别于画布空白处右键）：
```
节点右键菜单项：
├── 编辑节点        → 打开右侧属性面板
├── 添加子节点       → 创建子节点 + 自动连线
├── 折叠/展开子树    → 切换 collapsed 状态
├── 更改状态        → 子菜单：草稿/已确认/开发中...
├── 删除节点        → 级联删除子节点（确认弹窗）
└── 复制节点        → 复制节点数据（不含ID）
```

#### 3.3.2 自动布局子节点位置
当用户在树形模式下点击"添加子节点"：
1. 计算该父节点当前已有子节点数
2. 新子节点位置 = 父节点位置 + (TREE_LEVEL_GAP, 子节点索引 × (TREE_NODE_HEIGHT + TREE_SIBLING_GAP))
3. 自动创建 `GraphEdge`：source=父节点, target=新子节点
4. 如果父节点处于 `collapsed=true`，自动展开

#### 3.3.3 画布空白处右键菜单调整
现有右键菜单保留，但增加一个选项：
- **添加根节点**：创建的节点 `parentId = undefined`

---

### 阶段四：节点备注系统（第 4 轮）
**目标**：让每个节点可以承载更多上下文信息。

#### 3.4.1 数据层
- 已在前序阶段扩展 `notes` 字段

#### 3.4.2 节点视觉指示
- 有备注的节点右下角显示小图标（`StickyNote` from lucide-react）
- 鼠标 hover 时显示备注浮层（Tooltip / Popover）

#### 3.4.3 属性面板编辑
右侧面板需要重构为**可切换的上下文面板**：
```
右侧面板 Tab 切换：
┌─────────────────────────────────────┐
│  [节点属性]  [Agent 面板]             │
├─────────────────────────────────────┤
│  节点属性面板内容：                     │
│  ─ 标题（input）                       │
│  ─ 类型（select）                      │
│  ─ 状态（select）                      │
│  ─ 描述（textarea）                    │
│  ─ 备注（富文本 textarea，支持 Markdown）│
│  ─ 验收标准（可增删列表）                │
│  ─ 自定义样式（颜色选择器）               │
└─────────────────────────────────────┘
```

#### 3.4.4 备注查看弹窗
- 点击节点备注图标，弹出可滚动弹窗展示完整备注
- 支持 Markdown 渲染（简易实现：行内代码、粗体、列表）

---

### 阶段五：连接线 & 流程逻辑（第 5 轮）
**目标**：让边不再只是一条线，而是承载逻辑的脉络。

#### 3.5.1 边类型升级
@xyflow/react 12 原生支持多种 edge type：
- 自由模式下使用 `default`（贝塞尔）或 `straight`
- 树形模式下使用 `smoothstep` 或自定义 `MindMapEdge`
- 支持双击边切换类型

#### 3.5.2 自定义 MindMapEdge 详细设计
```typescript
// 实现正交折线 + 条件标签
function MindMapEdge({ id, sourceX, sourceY, targetX, targetY, data, label }) {
  // 计算中点折线路径
  // 如果 sourceX < targetX（父在左，子在右）：
  //   path = 父右侧 → 水平中点 → 垂直到子Y → 子左侧
  // 如果 sourceX > targetX（父在右，子在左）：
  //   path = 父左侧 → 水平中点 → 垂直到子Y → 子右侧
}
```

#### 3.5.3 流程条件标注
- 边上可编辑 `condition` 文本（如 `审批通过`, `库存 > 0`, `重试次数 < 3`）
- 条件文本显示为边标签，带小背景框
- 不同条件可用不同颜色边区分

#### 3.5.4 边编辑交互
- 双击边：弹出边属性编辑浮层
  - 条件文本输入
  - 连线类型选择
  - 连线颜色/粗细/虚实
  - 箭头类型选择
- 边的右键菜单：编辑 / 删除

---

### 阶段六：画布交互与视觉优化（第 6 轮）
**目标**：提升整体使用体验。

#### 3.6.1 画布工具栏增强
顶部工具栏增加：
- **布局模式切换**：自由布局 ⟷ 树形布局
- **自动排列**：一键重新计算树形布局
- **全部展开 / 全部折叠**
- **适配视图**（现有）

#### 3.6.2 节点选中态优化
- 选中节点时高亮其所有子树（降低其他节点透明度）
- 选中节点时高亮其所有入边和出边

#### 3.6.3 键盘快捷键
| 快捷键 | 功能 |
|--------|------|
| Tab | 为选中节点创建子节点 |
| Delete / Backspace | 删除选中节点 |
| Space | 折叠/展开选中节点 |
| Ctrl+E | 编辑选中节点属性 |
| Ctrl+L | 切换布局模式 |

#### 3.6.4 动画过渡
- 节点展开/折叠时添加位置变化动画
- 布局切换时节点平滑移动（@xyflow/react 的 `useNodesState` 配合 CSS transition）

---

## 四、文件改动清单

### 4.1 新增文件
```
src/renderer/canvas/
  ├── edges/
  │   └── MindMapEdge.tsx          # 自定义思维导图连线
  │   └── EdgeLabel.tsx            # 边条件标签组件
  ├── nodes/
  │   └── BizNodeComponent.tsx     # 提取节点组件（从 GraphCanvas 拆出）
  ├── layout/
  │   └── treeLayout.ts            # 树形布局算法
  │   └── useLayoutMode.ts         # 布局模式 Hook
  └── hooks/
      └── useNodeContextMenu.ts    # 节点右键菜单 Hook

src/renderer/panels/
  ├── NodePropertyPanel.tsx        # 节点属性面板（右侧 Tab 页1）
  └── PanelTabs.tsx                # 右侧面板 Tab 切换器

src/renderer/components/
  ├── NodeNotesPopover.tsx         # 节点备注浮层
  └── EdgeEditPopover.tsx          # 边编辑浮层
```

### 4.2 修改文件
```
src/shared/types.ts                # 扩展 GraphNode / GraphEdge / IpcApi
src/shared/constants.ts            # 新增边类型、箭头类型常量

src/main/database.ts               # 数据库表结构迁移
src/main/ipc-handlers.ts           # 新增 edge:update 处理
src/preload/index.ts               # 暴露 edge:update 通道

src/renderer/store/graphStore.ts   # 新增 updateEdge / 布局相关 state
src/renderer/canvas/GraphCanvas.tsx # 集成布局模式、自定义 Edge、右键菜单
src/renderer/panels/RightPanel.tsx  # 重构为可切换 Tab 面板
src/renderer/App.tsx               # 可能的结构调整（极小）
src/renderer/index.css             # 新增节点/边样式
```

---

## 五、依赖评估

### 5.1 新增依赖（建议）
| 包名 | 版本 | 用途 | 是否必须 |
|------|------|------|---------|
| 无额外依赖 | - | @xyflow/react 12 已内置所有需要的 Edge 类型 | - |

> 方案选择：不引入 dagre 等重型布局库，自研轻量级树布局算法，保持包体积精简。

### 5.2 现有依赖是否足够
- `@xyflow/react@12.4`：✅ 完全支持自定义 Edge、Sub Flows、折叠展开
- `zustand`：✅ 状态管理已足够
- `lucide-react`：✅ 已有需要的图标（ ChevronRight/ChevronDown/StickyNote 等）

---

## 六、实施优先级与工作量估算

| 阶段 | 功能 | 预估工作量 | 优先级 |
|------|------|-----------|--------|
| 阶段一 | 数据模型扩展 | 2h | P0（阻塞后续所有阶段） |
| 阶段二 | 树形布局引擎 | 4h | P0（核心功能） |
| 阶段三 | 子节点创建体系 | 3h | P0（核心功能） |
| 阶段四 | 节点备注系统 | 3h | P1 |
| 阶段五 | 连接线 & 流程逻辑 | 4h | P1 |
| 阶段六 | 交互与视觉优化 | 3h | P2 |
| **合计** | | **~19h** | |

---

## 七、验收标准

### 7.1 树形布局
- [ ] 创建有 parentId 的节点后，Tree Mode 下自动按层级排列
- [ ] 根节点居中，子节点向右下方（或下方）扇形展开
- [ ] 切换 Tree Mode / Free Mode 时节点平滑过渡
- [ ] 折叠节点后，其所有子孙节点隐藏，对应边隐藏

### 7.2 子节点创建
- [ ] 右键节点可"添加子节点"
- [ ] 添加子节点后自动创建父子连线
- [ ] 子节点位置合理，不与兄弟重叠
- [ ] Tab 快捷键可为选中节点添加子节点

### 7.3 节点备注
- [ ] 节点属性面板可编辑备注
- [ ] 有备注的节点显示备注图标
- [ ] 鼠标悬停可查看备注预览

### 7.4 连接线
- [ ] 树形模式下使用正交折线连接父子节点
- [ ] 边上可显示条件标签
- [ ] 双击边可编辑条件、线型、颜色

### 7.5 流程逻辑
- [ ] 边编辑面板可输入条件文本
- [ ] 不同条件可用不同颜色边表示
- [ ] 条件文本持久化到数据库

---

## 八、风险与应对

| 风险 | 影响 | 应对策略 |
|------|------|---------|
| 树形布局算法复杂度过高 | 开发时间超预期 | 采用简化的层级布局（固定层间距），不追求完美的空间利用率 |
| @xyflow/react 12 自定义 Edge API 变化 | 升级困难 | 严格遵循官方文档，使用推荐 API 模式 |
| 存量数据兼容性问题 | 旧图打不开 | 数据库迁移时使用 `ALTER TABLE ADD COLUMN`，全部设默认值/可为空 |
| 性能问题（节点数 > 100） | 布局卡顿 | 延迟布局计算（debounce），虚拟化渲染（后续优化） |
