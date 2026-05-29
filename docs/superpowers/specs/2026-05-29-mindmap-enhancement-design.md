# 思维导图增强设计：节点内容、边业务逻辑、层级功能完善

**日期**: 2026-05-29
**状态**: 已批准

## 背景

当前思维导图的连接线和节点内容未参与业务逻辑。连接线仅有简单的类型和标签，节点的 `description` 和 `metadata` 使用率低。本次增强旨在让思维导图真正成为业务逻辑的载体：

- **连接线**承载判断逻辑和跨模块业务关联
- **节点内容**关联具体的方法、文件、目录
- 新增 `project` 根节点作为项目中心
- 完善业务模块、业务流程、功能点、BUG 点的功能闭环

## 一、数据模型变更

### 1.1 节点类型扩展

新增 `project` 类型：

```typescript
type NodeType = 'project' | 'module' | 'process' | 'feature' | 'bug'
```

`project` 节点约束：
- 每张图（online/dev）自动创建，不可删除
- 自动画布居中，不可拖拽
- `parentId` 为空（所有模块的根）
- `status` 固定为 `'confirmed'`

### 1.2 NodeMetadata 扩展

新增 `fileAssociations` 字段：

```typescript
interface FileAssociation {
  path: string          // 文件/目录的相对路径
  type: 'file' | 'directory' | 'method'
  methodName?: string   // type='method' 时的方法名
  description?: string  // 简短说明
}

interface NodeMetadata {
  apis?: { name: string; method?: string; path?: string; description?: string }[]
  services?: { name: string; description?: string }[]
  entities?: { name: string; fields?: string; description?: string }[]
  fileAssociations?: FileAssociation[]  // 新增
}
```

### 1.3 GraphEdge 增加 edgeContent

新增结构化字段，保留现有 `label` 和 `edgeType`：

```typescript
interface EdgeContent {
  condition?: string    // 判断条件（如 "库存 > 0"）
  note?: string         // 业务备注（如 "退款时需同步回滚库存"）
}

interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  graphId: string
  edgeType?: EdgeType
  content?: EdgeContent  // 新增
}
```

### 1.4 边类型扩展

新增 `business-flow` 类型：

```typescript
type EdgeType = 'default' | 'success' | 'failure' | 'condition' | 'business-flow'
```

`business-flow` 视觉特征：
- 蓝色虚线（`stroke-dasharray: 8 4`，颜色 `#3b82f6`）
- 双线加粗箭头
- 流动虚线动画（`animated: true`）
- 标签胶囊形，蓝色背景白字

### 1.5 数据库变更

```sql
-- edges 表新增 content 字段
ALTER TABLE edges ADD COLUMN content TEXT;
-- edge_type CHECK 约束扩展加入 'business-flow'
```

节点表无需新增列，`fileAssociations` 存储在现有 `metadata` JSON 字段中。

## 二、节点层级与跨模块串联

### 2.1 层级规则

```
project（项目根，每图唯一）
  └── module（业务模块）
        ├── process（业务流程，模块内流程）
        ├── feature（功能点）
        └── bug（BUG点）
```

父子关系通过 `parentId` 维护。约束：
- `project` 的 `parentId` 为空
- `module` 的 `parentId` 指向 `project`
- `process/feature/bug` 的 `parentId` 指向 `module`（也可挂在 `process` 或 `feature` 下）

### 2.2 跨模块业务流程

通过 `edgeType: 'business-flow'` 的边实现跨模块串联，不引入新节点类型：

- 起止：模块 A 的节点 → 模块 B 的节点（module→module 或 feature→feature）
- `edgeContent.condition`：触发条件
- `edgeContent.note`：业务关联说明

示例——退款流程串联：
```
[订单模块] --business-flow--> [商品模块]
  condition: "退款申请通过"
  note: "需同步回滚库存数量"
```

## 三、Project 根节点

### 3.1 生命周期

加载图时检查是否存在 `type='project'` 节点，不存在则自动创建（使用图名称作为标题）。`deleteNode` 对 `project` 类型做拦截。

### 3.2 视觉样式

- 大圆角（`rounded-xl`）+ 渐变边框
- 字号 `text-lg font-bold`
- 不显示 status 标签和 bugCount
- 不可拖拽

### 3.3 画布行为

加载后以 project 节点为中心 `fitView`。新创建的 module 节点默认放在 project 节点周围环形偏移位置。

### 3.4 右键菜单调整

| 菜单项 | project | module | process | feature | bug |
|--------|---------|--------|---------|---------|-----|
| 添加子节点 | module | process, feature, bug | feature, bug | bug | - |
| 添加关联连线 | ✅ | ✅ | ✅ | ✅ | - |
| 状态切换 | - | ✅ | ✅ | ✅ | ✅ |
| 删除 | ❌ | ✅ | ✅ | ✅ | ✅ |

画布右键创建菜单：图中已有 project 时隐藏 project 选项。

## 四、边的可视化与交互

### 4.1 边标签显示逻辑

优先级：
1. `content.condition` → 显示条件摘要（截断 20 字）
2. `label` → 显示标签文本
3. 边类型默认标签

### 4.2 交互

- 悬停 tooltip 显示完整 `content.note`
- 选中时标签下方展开显示完整 condition 和 note
- `business-flow` 标签使用胶囊形蓝色样式

### 4.3 边创建流程

1. 选择边类型（四种现有 + business-flow）
2. 选择 `business-flow` 时，内联展开条件和备注输入框
3. 确认后同时创建边和 edgeContent
4. 跳过输入则 edgeContent 为空，后续在 EdgeEditor 补充

### 4.4 edge-utils 扩展

```typescript
'business-flow': {
  color: '#3b82f6',
  label: '业务流程',
  animated: true,
  strokeDasharray: '8 4',
}
```

## 五、Agent 上下文集成

### 5.1 关联文件注入

启动 Agent 时，`fileAssociations` 自动合并到 `allowedFiles`：
- 递归收集当前节点及所有祖先节点的 `fileAssociations`
- `type='file'` 和 `type='directory'` 加入 `allowedFiles`
- `type='method'` 以注释形式注入 prompt

### 5.2 跨模块业务约束注入

收集当前节点通过 `business-flow` 边连接的上下游节点，将 `content.note` 注入 `invariantRules`。

### 5.3 BUG 节点

- BUG 节点启动 Agent 时类型自动设为 `fix_bug`
- 继承父节点的 `fileAssociations` 和关联边规则

### 5.4 Prompt 模板扩展

在 `promptTemplates.ts` 中追加：
```
## 关联文件
- src/order/service.ts (方法: refund)
- src/order/ (目录)

## 跨模块业务约束
- 连接至「商品模块」: 退款时需同步回滚库存 (条件: 库存 > 0)
```

仅当节点有相关数据时才生成。

## 六、本次不实现

- 从文件树拖拽文件到节点创建关联（后续迭代）
- method 类型 fileAssociation 自动解析函数签名
- 跨模块 business-flow 边的双向影响提示
