# 全中文界面体系（i18n）· 设计文档

> 日期：2026-10-26
> 状态：待实施
> 相关：[../architecture/](../architecture/) · 约定见根目录 `CLAUDE.md`

## 背景与目标

BizGraph 目前**没有 i18n 框架**，界面文案直接硬编码在各组件里，导致中英混排：

- 已是中文：设置面板标签（基础设置 / 子代理类型 / 上下文水位）、多数领域提示（"社区只有一个节点"、"页面 C 没有入链"）、项目扫描结果
- 仍是英文：顶层框架（Projects、Node、Agent、Graph Index、Graph Log、Recipes、Threads）、空状态（"Welcome to Agent"、"No projects yet"、"No threads yet"）、全部 `placeholder` / `title` / `aria-label`、Electron 原生菜单（File / Edit / View / Window / Help）

规模盘点：**48 个渲染进程 `.tsx` + 31 个 `.ts` 文件、200+ 处可见文案**（明细见附录 A）。

本设计引入一套轻量 i18n 层，**以中文为唯一需要完整维护的语言**，英文作为兜底资源包，并提供设置面板内的语言下拉实现一键切换。目标：除少数不可译术语外，界面全部呈现中文。

## 关键决策

| 决策点 | 结论 | 来源 |
|---|---|---|
| 语言策略 | **中文为主，英文兜底**——zh 完整覆盖；en 保留现有英文文案作回退 | 用户拍板 |
| 覆盖范围 | **渲染进程 + Electron 原生菜单**；主进程日志/错误提示不在范围内 | 用户拍板 |
| 切换入口 | **设置 → 基础设置**里的语言下拉（不放常驻工具栏按钮） | 用户拍板 |
| "Agent" 译法 | **保留英文**——Agent / Subagent 作为产品术语不译，周围的句子译成中文 | 用户拍板 |
| 实现方式 | 自建轻量层，**不引入第三方 i18n 依赖**（对齐仓库零新依赖的现状） | 我的判断 |
| 资源位置 | `src/shared/i18n/`——主进程菜单与渲染进程共用同一份 | 我的判断 |
| 持久化 | `settings.locale` 存入 `settings.json`，默认 `zh-CN` | 我的判断 |
| 存储值 | 节点类型/状态等**存储值保持英文**，只翻译展示名，存量库零影响 | 我的判断 |
| 用户内容 | wiki 正文、recipe 内容、节点标题、会话消息、项目名**一律不译** | 我的判断 |
| locale 传播 | **新增 1 条推送通道 `locale:changed`**（不新增 invoke 通道），主进程广播到所有窗口 | 我的判断 |
| 启动初值 | preload 通过 `--bizgraph-locale=` 参数**同步**暴露初值，**无闪屏** | 我的判断 |
| 共享常量 | `src/shared/constants.ts` 的中文标签表**迁移**到 i18n 资源，删除静态表 | 我的判断 |
| `t()` 形态 | 组件用 `useI18n()`；store / toast 用**无 hook 的模块级 `t()`** | 我的判断 |
| 缺 Provider | `useI18n()` **不抛错**，回落默认 context（否则 4 个现有 `.test.tsx` 崩溃） | 我的判断 |
| 会话默认标题 | 存储值 `New Thread` **不动**；显示译为「新会话」；自动改名判定改用共享常量 | 用户拍板（"首条消息自动改名"） |
| 图表名后缀 | 存储值 `xxx - 产品蓝图` **不动**；显示时按语言替换后缀 | 用户拍板 |

## 架构

### 进程边界：一个共享模块 = 两份运行时实例

`src/shared/i18n/` 会被 Vite **分别打包进 `dist-electron/main`（主进程）和渲染进程 bundle**。因此运行时是**两个互不相通的模块实例**：

- 主进程实例：`getLocale()` / `setLocale()` / `subscribeLocale()` 供 `buildMenu()` 使用
- 渲染进程实例：同样一套 API，供 `I18nProvider` 与模块级 `t()` 使用

**共享资源（zh.ts / en.ts）是同一份源码，运行时状态互不相通。** 这决定了 locale 必须由主进程**显式广播**才能跨进程生效——共享层自身的 `subscribeLocale()` **不能**跨进程工作（这是本设计最初版本的错误，builder check 抓出）。

```
                    ┌──────────────────────────────────────┐
                    │  src/shared/i18n/  （源码唯一，两处各打包一份）│
                    │  ├── resources/zh.ts   ← 真值来源      │
                    │  ├── resources/en.ts   ← 兜底          │
                    │  ├── index.ts  t() / getLocale() /    │
                    │  │           setLocale() / subscribe()│
                    │  └── types.ts  Locale / TranslationKey│
                    └──────────────────────────────────────┘
             ▲ 打包进主进程            │ 打包进渲染进程
             │                         │
    ┌────────┴──────────┐   ┌────────┴──────────────────────────┐
    │ src/main/          │   │ src/renderer/i18n/               │
    │  index.ts          │   │  I18nProvider（React context）     │
    │   buildMenu()→t()  │   │  useI18n()  hook                  │
    │   subscribeLocale  │   │  共享层实例.setLocale() ← 同一进程  │
    │     → 重建菜单      │   │  模块级 t() ← store / toast 可用   │
    │  ipc/settings.ts   │   │                                  │
    │   settings:write   │   │                                  │
    │    → setLocale()   │   │                                  │
    │    → webContents  │──▶│  locale:changed 推送               │
    │      .send(所有窗口)│   │   → Provider.setState(locale)      │
    └────────────────────┘   └──────────────────────────────────┘
```

### locale 传播机制

| 环节 | 机制 |
|---|---|
| 主进程读初值 | `app.whenReady()` → `await readSettings()` → `setLocale(settings.locale ?? DEFAULT_LOCALE)` → 再 `buildMenu()` |
| 渲染进程拿初值 | `createWindow()` 传 `webPreferences.additionalArguments: ['--bizgraph-locale=' + getLocale()]`；preload 解析 `process.argv`，经 contextBridge 暴露为 `window.electronAPI.locale`（**同步**，与现有 `platform: process.platform` 同款写法） |
| 渲染进程改语言 | Provider 立即 `setState`（界面即时响应）→ `settings:write` → 主进程落盘 → 主进程 `setLocale()` → `Menu.setApplicationMenu(buildMenu())`（原生菜单同步）→ 主进程向**所有** `BrowserWindow` `webContents.send('locale:changed', locale)` |
| 其他窗口 | 收到 `locale:changed` → Provider `setState` → 立即跟随（**多窗口同步**） |
| 新开窗口 | `createWindow()` 在创建时读 `getLocale()`，天然拿到最新值 |
| 写盘失败 | Provider 回滚到原 locale + toast 提示 |

**多窗口同步是必须的**：应用支持 Cmd+N 新建窗口（原生菜单 "New Window"），"一键切换"应覆盖整个应用而非单个窗口。

**没有新增 invoke 通道**——`settings:read` / `settings:write` 已存在；只新增 1 条主→渲染的推送通道，形态照抄仓库既有的 `menu:openProject`（`src/preload/index.ts:264`）。

### 组件拆解

#### 共享层（`src/shared/i18n/`）

| 文件 | 职责 |
|---|---|
| `types.ts` | `Locale = 'zh-CN' \| 'en-US'`、`DEFAULT_LOCALE`、`FALLBACK_LOCALE`、`TranslationKey` |
| `resources/zh.ts` | 中文资源，**key 的真值来源**；导出 `as const` 以推导 key 联合类型 |
| `resources/en.ts` | 英文资源，key 集合与 zh 对齐 |
| `index.ts` | `t()` / `tRaw()` / `getLocale()` / `setLocale()` / `subscribeLocale()` / `nodeTypeLabel()` / `nodeStatusLabel()` |

#### 渲染进程（`src/renderer/i18n/`）

| 文件 | 职责 |
|---|---|
| `I18nProvider.tsx` | React context，提供 `{ locale, setLocale, t }`；挂载时用 `window.electronAPI.locale` 初始化，订阅 `locale:changed` |
| `useI18n.ts` | 消费 context 的 hook；**无 Provider 时回落默认 context，不抛错** |

挂载点：`src/renderer/App.tsx` 顶层包 `<I18nProvider>`。

**为什么 `useI18n()` 不抛错**：现有 4 个 `.test.tsx`（`RecipesPanel` / `LintPanel` / `WritebackPanel` / `toast`）没有 Provider，抛错会让它们全部崩溃。回落默认 context（`DEFAULT_LOCALE`）既不崩、也不静默失效——文案仍是正确的中文。另提供 `renderWithI18n()` 测试包装器供需要切换 locale 的用例使用。

#### 主进程

| 文件 | 职责 |
|---|---|
| `src/main/index.ts` | `buildMenu()` 内所有 label 改走 `t()`；`subscribeLocale()` 回调里 `Menu.setApplicationMenu(buildMenu())`；`createWindow()` 追加 `--bizgraph-locale=` 参数 |
| `src/main/ipc/settings.ts` | `settings:write` 落盘后，若 `locale` 变化则 `setLocale()` + 广播 `locale:changed` |
| `src/main/settings.ts` | `mergeSettings` 补 `locale` 字段默认值 |

#### 设置面板

`src/renderer/panels/SettingsPanel.tsx` 的「基础设置」页新增「界面语言」下拉：
- 选项：简体中文 / English
- 切换时：更新 context state（立即生效）→ 调 `settings:write` 持久化
- 持久化失败时 toast 提示并回滚到原值

## 数据流与类型

### 共享层类型

```ts
// src/shared/i18n/types.ts
export type Locale = 'zh-CN' | 'en-US'
export const DEFAULT_LOCALE: Locale = 'zh-CN'
export const FALLBACK_LOCALE: Locale = 'en-US'
```

```ts
// src/shared/i18n/resources/zh.ts
export const zh = {
  'projects.title': '项目',
  'agent.tab': 'Agent',
  'agent.welcome': '欢迎使用 Agent',
  'nodeType.feature': '功能',
  'status.developing': '开发中',
  // …
} as const

// key 联合类型由 zh 推导 —— 写错 key 直接编译报错
export type TranslationKey = keyof typeof zh
```

### `t()` 语义

```ts
// 严格：key 必须是已知字面量，编译期可查
export function t(key: TranslationKey, vars?: Record<string, string | number>): string
// 宽松：动态 key（拼接出来的），命中不到时 dev 环境 console.warn
export function tRaw(key: string, vars?: Record<string, string | number>): string
```

**为什么拆两个函数**：最初设计是 `t(key: TranslationKey | string)`，但 `| string` 让编译期检查完全失效。拆开后，静态调用点受 `TranslationKey` 约束，只有真正需要动态 key 的地方才用 `tRaw`。

**动态 key 的正解——类型安全的查表函数**：`nodeTypeLabel(type)` / `nodeStatusLabel(status)` 内部持有 `Record<NodeType, TranslationKey>` 静态映射表，既能按运行时值查译文，又保持编译期可查；**禁止**用 `t(\`nodeType.${type}\`)` 模板拼接——那会退回 `tRaw`，丢掉类型检查。

```ts
const NODE_TYPE_KEYS: Record<NodeType, TranslationKey> = {
  project: 'nodeType.project',
  module: 'nodeType.module',
  process: 'nodeType.process',
  feature: 'nodeType.feature',
  bug: 'nodeType.bug',
  'wiki-page': 'nodeType.wikiPage',
}
export function nodeTypeLabel(type: NodeType): string {
  return t(NODE_TYPE_KEYS[type])
}
```

**查找顺序**：

1. `resources[locale][key]` —— 当前语言命中则返回
2. `resources[DEFAULT_LOCALE][key]` —— 当前语言缺 key，回落**中文**（zh 是完整真值来源，英文界面下缺词也显示中文而非裸 key）
3. `key` 本身 —— 两边都缺（只可能是拼错的 key），返回 key 并在 dev 环境 `console.warn`

> 注：原设计是「当前语言 → 英文 → key」，会让英文界面下漏翻的 key 显示成 `projects.title` 这种裸 key。改为回落中文后，任何已知 key 在任何语言下都有可读文案。

插值：`{name}` 占位符替换 `vars`。

### 设置持久化

`src/shared/types/agent.ts` 的 `BizGraphSettings` 追加（沿用 `writeback` 的可选字段写法）：

```ts
/** 界面语言：zh-CN（默认，中文为主）| en-US（兜底） */
locale?: 'zh-CN' | 'en-US'
```

### locale 变更时序

```
用户改下拉
  → Provider 内部 setState(locale)              ← 界面立即切换
  → await ipc['settings:write']({...settings, locale})
       → 主进程写 settings.json
       → 主进程 setLocale(locale)
            ├─ 共享层通知订阅者 → Menu.setApplicationMenu(buildMenu())  ← 原生菜单同步
            └─ webContents.send('locale:changed', locale) → 所有窗口     ← 多窗口同步
  （写盘失败 → Provider 回滚 + toast）
```

## 翻译资源组织

**key 命名**：`域.语义`，全小写驼峰分段，与组件/功能域对应：

| 域 | 覆盖内容 | 例 |
|---|---|---|
| `app.*` | 应用级 | `app.title` |
| `projects.*` | 左侧项目面板 | `projects.empty` |
| `canvas.*` | 画布与图 | `canvas.graphIndex`、`canvas.layoutTidy` |
| `node.*` / `nodeType.*` / `status.*` | 节点与属性编辑器、类型/状态展示名 | `node.editor.save`、`status.draft` |
| `graph.*` | 图类型与自动生成图名后缀 | `graph.type.online`、`graph.nameSuffix.online` |
| `agent.*` | Agent 面板与聊天 | `agent.welcome`、`agent.input.placeholder` |
| `thread.*` | 会话列表 | `thread.empty`、`thread.defaultTitle` |
| `recipes.*` | Recipes 面板 | `recipes.run` |
| `settings.*` | 设置面板 | `settings.language`、`settings.language.zhCN` |
| `common.*` | 跨域通用（取消/保存/删除/加载中…） | `common.cancel` |

**节点类型 / 状态展示名**单独成域，因为它们是"存储值 → 展示名"的映射，存储值一律不动：

| 存储值（不变） | 中文展示 | 英文兜底展示 |
|---|---|---|
| `project` | 项目 | Project |
| `module` | 业务模块 | Module |
| `process` | 业务流程 | Process |
| `feature` | 功能点 | Feature |
| `bug` | BUG点 | Bug |
| `wiki-page` | Wiki 页面 | Wiki Page |
| `draft` | 草稿 | Draft |
| `confirmed` | 已确认 | Confirmed |
| `developing` | 开发中 | Developing |
| `testing` | 待测试 | Testing |
| `review` | 待验收 | Review |
| `published` | 已发布 | Published |
| `placeholder` | 占位 | Placeholder |

> **中文一栏直接沿用 `src/shared/constants.ts` 里现有 UI 原文**（业务模块 / 业务流程 / 功能点 / BUG点 / 待测试 / 待验收 / 占位），迁移时**不改写**——用户已经在看这些词，重写只会造成无谓的界面变动。英文一栏是本次新增的兜底文案。

> `placeholder` 是真实存在的 `NodeStatus`（dev 图的 feature 节点初始化时置为它），实现时必须一并覆盖，否则会漏。

## 共享常量的迁移

`src/shared/constants.ts` 现有**静态中文标签表**，被 6 个渲染文件直接引用：

| 常量 | 消费者 |
|---|---|
| `NODE_TYPE_LABELS` | NodeEditor、NodeContextMenu、CanvasOverlay、BizNode、GraphCanvas、useNodeOperations |
| `NODE_STATUS_LABELS` | 同上 |
| `BUG_SEVERITY_LABELS` / `BUG_STATUS_LABELS` | NodeEditor、BugPanel |
| `GRAPH_TYPE_LABELS` | GraphTabs |
| `EDGE_TYPE_OPTIONS`（label + description） | EdgeEditor |
| `CANVAS_NODE_TYPES[].label` | 画布右键菜单 |
| `AGENT_COMMAND_LABELS` | Agent 面板 |

**这些表必须迁入 i18n 资源**（`nodeType.*` / `status.*` / `bug.*` / `graph.*` / `edge.*` / `command.*` 域），否则英文 locale 下它们仍显示中文——英文界面会半中半英。

- 展示名 → `t('nodeType.feature')` / `nodeTypeLabel(type)`
- `EDGE_TYPE_OPTIONS` 里的 `description` 也要进资源
- **`src/shared/constants.ts` 中的静态表删除**，只保留枚举本身与颜色等非文案数据
- **`src/shared/__tests__/constants.test.ts` 同步更新**：现有"每个枚举成员都有非空 label"的断言改为"每个枚举成员都有对应的 translation key"，而不是继续断言静态 label 表存在

## 保留英文的术语清单

以下**必须保留英文**，不做翻译（界面里出现时原样显示）：

- **产品/CLI 名称**：Claude Code、Codex、OpenCode、Cline、Kilo Code、Kimi Code、CodeBuddy、Qoder、Qwen Code、Cursor
- **核心产品术语**：Agent、Subagent、Agent CLI、Wiki
- **技术缩写**：MCP、API Key、JSON、YAML
- **键盘/交互提示**：Shift+Enter
- **图标按钮的 aria-label** 若指向上述专有名词

## 不翻译的范围（Anti-goals）

- **主进程日志与错误提示**（用户明确排除；`logger.error(...)` 等保持英文）
- **用户创作的内容**：wiki 正文、recipe YAML 的 name/description、节点标题与会话消息、项目名
- **代码标识符**：变量名、类型名、IPC 通道名、DB 列名、协议字段
- **存储值**：节点 `type`/`status`、图 `graphType`、适配器 id
- **Prompt 模板的 label/description**（这些是 UI 上可见的文案，可译）**与 prompt 正文**（prompt 正文是发给 LLM 的，不译）——两者必须分开处理
- **Graph Index / Graph Log 特殊页的内部标识与页面标题**——只译画布上的按钮文案，内部 slug 与标题解析逻辑不动（`WikiIndexService` 依赖英文标识，贸然改动会破坏特殊页识别）

## 特殊取值：会话默认标题

`'New Thread'` 在代码里承担**三个不同角色**：

| 位置 | 角色 |
|---|---|
| `src/main/services/chat-service.ts:37,44` | 持久化到 `chat_threads.title` 的默认值 |
| `src/renderer/store/sessionStore.ts:211` | **首条消息自动改名**的判定依据（`t.title === 'New Thread' ? content.slice(0, 30) : t.title`） |
| `AgentChatPanel.tsx:360` / `ChatHeader.tsx:140` / `ThreadListSidebar.tsx:221,224` | 界面显示 |

**做法（用户拍板："首条消息自动改名"）**：

1. 抽共享常量 `DEFAULT_THREAD_TITLE = 'New Thread'`，三处引用它，**不再用内联字面量**
2. **存储值不变**（仍是 `'New Thread'`），零数据迁移
3. **显示时翻译**：界面读到 `title === DEFAULT_THREAD_TITLE` 时显示 `t('thread.defaultTitle')`（中文「新会话」）
4. 自动改名判定改为比较 `DEFAULT_THREAD_TITLE` 常量，**行为完全不变**——首条消息后仍自动改为内容摘要

## 特殊取值：自动生成的图表名

存库的是 `${projectName} - 产品蓝图` / `${projectName} - 开发场景`（`src/main/services/graph-service.ts:75,345,350,398,406`），图表名**不可编辑**（无重命名入口）。

**做法（用户拍板）**：**存储值不变**，渲染时按语言替换后缀：

```
存储：tiangong - 产品蓝图
中文界面：tiangong - 产品蓝图
英文界面：tiangong - Product Blueprint
```

实现为共享层的一个纯函数（放 `src/shared/i18n/`，两侧共用）：

```ts
// 已知后缀 → 本地化后缀
const GRAPH_NAME_SUFFIXES: { zh: string; en: string; key: TranslationKey }[] = [
  { zh: '产品蓝图', en: 'Product Blueprint', key: 'graph.nameSuffix.online' },
  { zh: '开发场景', en: 'Dev Scenario', key: 'graph.nameSuffix.dev' },
]
export function localizeGraphName(name: string): string
```

未匹配到已知后缀的图名原样返回（用户自建图 / 从源项目派生的图）。

## 测试策略

| 层次 | 用例 |
|---|---|
| 单元 | `t()` 查找顺序：zh 命中 / en 命中 / en 缺 → 回落中文 / 两边都缺 → 裸 key + warn |
| 单元 | `tRaw()` 动态 key 路径；`t()` 的 `TranslationKey` 类型约束（类型层用 `expectTypeOf` 或编译期检查） |
| 单元 | `nodeTypeLabel()` / `nodeStatusLabel()`：每个枚举成员都有译文；**存储值不变** |
| 单元 | 共享层 `setLocale` / `subscribeLocale` 通知与退订；`getLocale()` 默认值 |
| 单元 | `localizeGraphName()`：中英后缀替换 + 未匹配原样返回 |
| 单元 | `DEFAULT_THREAD_TITLE` 判定：首条消息后仍自动改名 |
| 渲染 | Provider 下 `t()` 生效；切换 locale 后已渲染文案随之更新（参照 `RecipesPanel.test.tsx` 的 mock 方式） |
| 渲染 | **无 Provider 时 `useI18n()` 不抛错**，返回默认 locale |
| 渲染 | 设置面板语言下拉存在、切换触发 `settings:write` |
| 回归 | 现有 4 个 `.test.tsx` 中断言**应用文案**的用例需同步更新（已知：`RecipesPanel.test.tsx` 的 `'Run Recipe'` / `'Running…'`）。同文件里的 `'Target path'` 属于 recipe `inputs_schema` 的 label（用户内容，不译），断言保持不变 |
| 回归 | `src/shared/__tests__/constants.test.ts` 改为断言"枚举成员 → translation key"齐全 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 200+ 处文案的长尾遗漏 | 附录用脚本扫描渲染层残留的英文字面量，产出清单逐项清零；CI 加一个**只报告不阻断**的扫描任务（白名单放行保留术语与专有名词） |
| 改测试断言时误改业务逻辑 | 只改字符串字面量，不动测试结构与断言语义 |
| `zh.ts` 成为大文件后可读性下降 | 按域分文件（`resources/zh/*.ts`）再汇总，或单文件 + 域注释分隔——**实施时由计划阶段定夺** |
| 翻译后 UI 宽度溢出（中文通常更短，风险低，但按钮/标签类可能变化） | 实施后逐屏目视检查，重点看设置面板与节点编辑器的标签排布 |
| 共享模块双实例被误当成单一实例 | 文档已明示；跨进程只经由 `locale:changed` 推送通道，代码里不出现"主进程 setLocale 能影响渲染进程"的假设 |
| 与 CLAUDE.md 的边界约定冲突 | 本改动只碰展示层文案，不触碰任何 Agent CLI 边界、ScopeGuard 语义、IPC 协议 |

## 附录 A：待翻译文件清单

按候选文案数排序（48 个 `.tsx`；另有 31 个 `.ts` 含零散文案，完整清单由扫描脚本产出）：

```
src/renderer/panels/TreeView.tsx            17   src/renderer/components/agent/ChatBubble.tsx        11
src/renderer/panels/RecipesPanel.tsx        17   src/renderer/panels/LeftPanel.tsx                 10
src/renderer/panels/NodeEditor.tsx          17   src/renderer/canvas/GraphCanvas.tsx               10
src/renderer/panels/SubagentTypesTab.tsx    14   src/renderer/components/agent/AdapterSetupGuide.tsx  9
src/renderer/components/agent/ChatHeader.tsx  7   src/renderer/App.tsx                              6
src/renderer/panels/EdgeEditor.tsx           5   src/renderer/components/agent/HistorySidebar.tsx    5
src/renderer/components/agent/AgentChatPanel.tsx 5   src/renderer/components/wiki/WritebackPanel.tsx   4
src/renderer/panels/SettingsPanel.tsx       3   src/renderer/panels/RightPanel.tsx                3
src/renderer/panels/FileTreeContextMenu.tsx  3   src/renderer/components/agent/ThreadListSidebar.tsx 3
src/renderer/components/agent/ChatInput.tsx  3   src/renderer/panels/ContextWaterlineTab.tsx        2
src/renderer/lib/toast.tsx                  2   src/renderer/components/wiki/WikiPageEditor.tsx    2
src/renderer/components/agent/SubagentInvocationsPanel.tsx 2
src/renderer/components/agent/FanoutPromptDialog.tsx 2
src/renderer/canvas/BizEdge.tsx             2   其余约 16 个文件各 1 处
```

**额外必查点**：
- `src/renderer/components/ui/dialog.tsx:40` 与 `sheet.tsx:53` 的 `<span className="sr-only">Close</span>`
- `src/renderer/store/fileTreeStore.ts` 的 3 条英文 toast（`'Pasted successfully'` / `'Renamed successfully'` / `'Moved successfully'`）——**store 里不能调 hook**，走模块级 `t()`
- `src/renderer/promptTemplates.ts`（若存在）的 label/description 可译，**prompt 正文不可译**

## 附录 B：扫描脚本（设计要点）

`scripts/check-i18n.mjs`：遍历 `src/renderer/**/*.{ts,tsx}`（排除 `__tests__`），用正则抓出
JSX 文本节点与 `placeholder` / `title` / `aria-label` / `label` 属性里的拉丁字母串，
与保留术语白名单比对后输出残留清单。

- **只报告不阻断**起步，等残留清零后再考虑接入 CI 阻断
- 白名单至少包含：本设计「保留英文的术语清单」全部条目、纯数字/符号串、`kebab-case` 的 CSS 类名
- 需覆盖 `.ts` 文件（31 个）——`.tsx` 之外的 `store/` / `lib/` / `components/ui/` 里有零散英文
