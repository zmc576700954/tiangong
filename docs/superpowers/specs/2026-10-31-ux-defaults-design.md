# BizGraph 体验优化设计（默认值接线 · 步骤简化 · 静默失败归零）

> 创建日期：2026-10-31
> 状态：待评审
> 范围：五类——A 默认值接线 / B 消失的步骤 / C 静默失败归零 / D 可发现性与图归属错配 / E 只读默认与范围记忆
> 不在范围：撤销/重做、语义关系边的编辑体验、A2A 协议本身、Wiki 内容体系、全局视觉重设计

---

## 一、意图与为什么

BizGraph 的核心承诺是"**让 Agent 工具更可控、可协作、可审查**"——它不生成代码，它给 Agent CLI 划边界。

但今天"可控"的默认值是**反的**：

> 范围不填 → `session-lifecycle-manager.ts:302` 的 `config.allowedFiles.length > 0 || config.verifyOnly` 不成立 → **根本不建 ScopeGuard 沙箱** → Agent 可以改项目里任何文件，BizGraph 既不知道、改了也回滚不了。
>
> 而 `allowedFiles` 只有用户在输入框用 `@` 引用文件才会产生（`AgentChatPanel.tsx:262` 只从 file 类 contextRefs 取）。所以**绝大多数会话是在无边界状态下跑的**。

与此同时，界面上散落着两类摩擦：

- **每轮都要重来的重复动作**——选适配器、选模型、选范围、选子代理 scope 策略，每次都从零开始；数据模型里其实早就有这些字段，**只是没有界面**。
- **点了没反应的静默失败**——状态机拒绝转换时 unhandled rejection、空内容添加时静默 return、IPC 抛错时没有 toast。用户看到的是"界面就是不动"，而不是"为什么不动"。

用户明确提了三条：**简化不必要步骤**、**有些步骤可以设置默认，用户想要用再自定义**、**有些功能步骤设置不合理**。本设计对这三条的对应关系是：A 类接上默认值界面（第二、三条），B 类砍掉多余步骤（第一条），C/D/E 类修正不合理与不安全的行为（第三条）。

### 成功标准

- 装好一个适配器后，**直接发消息就能干活**——不必先理解"适配器 / 模型 / 范围"三个概念
- 同一项目里**第二次**开会话，不重复选适配器、模型、文件范围
- 空范围时 Agent **物理上写不了**文件，且用户**看得见**"本次是只读"
- 任何一次"点了没反应"都变成一句**明确的提示**，而不是界面僵住
- "扫描生成脑图"这类高价值动作不再依赖用户发现隐藏按钮

### 非目标（明确不做）

- **不改 Agent CLI 自身的权限模型**——CLAUDE.md《与 Agent CLI 的边界》已定：不替换 CLI 的认证/权限检查。E 类的只读靠**调用方的参数**实现（Claude Code SDK 的 tools 白名单、Codex 的 sandboxMode），不改 CLI 本身
- **撤销/重做**——沿用 structure-editing 设计的结论，继续推迟
- **不改 A2A 协议**——只允许 E 类的只读模式覆盖到 A2A 那条链路上的**显示**
- **不做全局视觉重设计**——沿用现有视觉语言（shadcn/ui + Tailwind）
- **不改语义关系边（business-flow 等）的编辑体验**

---

## 二、现状：五类裂缝

动手前先把地基摸清。以下每条都已在代码中核实。

### 裂缝 A：默认值只有数据，没有界面

| 设置项 | 现状 | 证据 |
|---|---|---|
| `defaultModel` | renderer 里 **0 次**引用，只能手改 `settings.json` | `grep -rn "defaultModel\|compactModel" src/renderer` → 0 命中。消费点在主进程：`claude-code.ts:227`、`mcp-adapter.ts:644,729,762` |
| `adapterPreferences` | IPC / preload / store 全都有，**但没有任何组件调用 `setAdapterPreferences`** | `src/renderer/store/adapterStore.ts:16,42`、`agentStore.ts:40,145` 定义了，组件层零调用 |
| ↳ 且被两份硬编码副本盖住 | `adapterStore.ts:23` 与 `agentStore.ts:132` 各硬编码一份 `{defaultAdapter:'claude-code', fallbackOrder:[10 个]}` | 与 `src/main/settings.ts:53-56` 的真设置重复，store 初始态不读真设置 |
| `compactModel` | renderer 里 **0 次**引用；**且主进程会静默丢弃它** | grep → 0 命中。`src/main/settings.ts:558-579` 的 `mergeSettings` **逐字段显式列举**，没有 `compactModel` → `settings:write` 能把它写进 settings.json，但下次 `readSettings()` 又丢掉 → `mcp-adapter.ts:1284` 的 `settings.compactModel \|\| settings.defaultModel` **永远取到 defaultModel**。**"压缩模型"控件今天是空操作。** |
| `contextWaterline` | 有 IPC（`settings:getContextWaterlineConfig` / `:setContextWaterlineConfig`，`src/shared/types/ipc.ts:196-197`），但**不在 `DEFAULT_SETTINGS` 里**，`src/main/settings.ts:568` 的 `saved.contextWaterline ?? defaults.contextWaterline` 两边都可能是 undefined | `src/main/settings.ts:66-113` |
| `cliTools` 覆盖面 | `DEFAULT_SETTINGS.cliTools` 只有 3 个（claude-code / codex / opencode），而 `KNOWN_ADAPTER_NAMES` 有 **12** 个 | `settings.ts:61-64` vs `settings.ts:68-87` |
| API key provider | UI 硬编码 3 个（anthropic / openai / deepseek），后端 `ALLOWED_PROVIDERS` 还允许 `gemini` | `src/renderer/panels/SettingsPanel.tsx:219` vs `src/main/settings.ts:775` |

> **关键结论**：`settings:write` 通道已经接受 `Partial<BizGraphSettings>`（`src/shared/types/ipc.ts:190`），所以 `defaultModel` / `compactModel` **不需要新 IPC**，直接复用。只有"按项目的覆盖"需要新存储（见 §四.E3）。

### 裂缝 B：每轮都要重来的步骤

| 步骤 | 现状 | 证据 |
|---|---|---|
| 选适配器 | 下拉列出**全部 10 个**，含 9 个没装的；点击未安装项会跳转到设置页 | `src/renderer/components/agent/ChatHeader.tsx:95-121` |
| ↳ 默认适配器 | `auto` → `null` → 主进程读 `preferences.defaultAdapter`（**读的是真实设置，不是写死**）：`sessionStore.ts:72,277` 把 `'auto'` 转 `null`，`agent-manager.ts:422-424` 用 `preferences.defaultAdapter`。写死的 `'claude-code'` 只是 `DEFAULT_ADAPTER_PREFERENCES` 的**默认值**（`settings.ts:53-56`），不是实际行为 | `sessionStore.ts:72,277` + `agent-manager.ts:422-424` |
| ↳ 但没人能改 | `setAdapterPreferences` 的 IPC 与 store 都在，**组件层零调用**——所以这个默认值实际永远等于 `claude-code` | 见 §二.A |
| 新建图选类型 | 弹窗要求选"产品蓝图 / 开发场景"，但**每个项目本来就固定各有一张**（`graph-service.ts:347-360` 一个事务建两张） | `src/renderer/components/GraphTabs.tsx:112-135` |
| 子代理 scope 策略 | 创建自定义类型时必选 inherit/subset/fresh，而 `subset` 显然是默认值 | `src/renderer/panels/SubagentTypesTab.tsx:18,120-129` |
| 状态切换 | 右键菜单给 7 个状态格子，**包含状态机禁止的转换**（如 draft→published） | `src/renderer/canvas/NodeContextMenu.tsx:33-41,186-207` vs `src/shared/state-machine.ts:63-82` |

### 裂缝 C：点了没反应

| 现象 | 根因 | 证据 |
|---|---|---|
| 点状态药丸不动，**也不报错** | `graphStore.updateNode` 对非法转换 `throw`，`RightPanel.tsx:111` 没 catch → unhandled rejection | `src/renderer/store/graphStore.ts:280-287` |
| ↳ 但根因是**两张转换表不一致** | renderer 用共享层较宽松的 `canTransition`（`state-machine.ts:63` 的 `TRANSITION_RULES`，**只看状态、不看节点类型**），主进程用较严的 `validateNodeTypeTransition(type, from, to)`（`state-machine.ts:128`，走 per-NodeType 矩阵 `NODE_STATUS_TRANSITIONS[type]`，`src/shared/types/graph.ts:420`）。宽松放行 → 主进程抛 `IpcError` → renderer 吞掉 | `src/shared/state-machine.ts:63,128`、`src/shared/types/graph.ts:420` |
| 右键菜单改状态失败 | 异常被 `console.error` 吞掉，菜单照常关闭 | `src/renderer/canvas/GraphCanvas.tsx:1503-1511` |
| 标题清空点 ✓ → 输入被静默丢弃 | `onSave` 跳过但退出编辑态，无提示 | `src/renderer/panels/NodeEditor.tsx:37-42` |
| 业务规则 / 验收标准 / API 空内容"添加" → 无反应 | `return`，无提示 | `NodeEditor.tsx:207-208` / `:454-455` / `:427-433` |
| 新建图空名字点保存 → 无反应 | `handleCreate` 直接 `return`，弹窗不关也不提示 | `src/renderer/components/GraphTabs.tsx:25-26` |
| IPC 层硬失败（标题超 200 字、类型非法等）→ 无提示 | 抛 `IpcError`，renderer 未接 toast | `src/main/ipc/utils.ts:168-173`、`src/main/ipc/graph.ts:44,200` |
| 建节点 / 建边失败 → 无提示 | `console.error` 后 `return` | `src/renderer/canvas/hooks/useNodeOperations.ts:48-53,64-66` |

> CLAUDE.md 已规定 toast 的唯一实现位于 `src/renderer/lib/toast.tsx`（导出 `pushToast` / `toastSuccess` / `toastError` / `toastInfo`）。**不要**新建 `src/renderer/lib/toast.ts` 或 `src/renderer/components/ui/ToastContainer.tsx`——同路径下 `.ts` 会先于 `.tsx` 被解析并遮蔽实现。

### 裂缝 D：藏起来的高价值动作 + 一个真 bug

1. **"扫描生成脑图"按钮 hover 才显现**：`src/renderer/panels/LeftPanel.tsx:262-273` 用 `opacity-0 group-hover:opacity-100`。这是项目导入后最有价值的一个动作（把代码库变成脑图），却需要用户先悬停才看得见。
2. **API key provider 少一个**：UI 硬编码 3 个，后端允许的 `gemini` 从来不提供（见 §二.A 表）。

3. **~~online/dev 标记错配（真 bug）~~ —— 撤回：这是刻意的设计，不是 bug。**
   > 本文档初稿曾把 `useNodeOperations.ts:42` 的 `graphType: childType === 'feature' || childType === 'bug' ? 'dev' : 'online'` 判为"按类型猜、跟所在图无关"的错误，并计划加一条 `graphType === graphs.type` 的落库校验 + 把存量 `graph_type` 重置为所在图类型。**两个动作都会造成破坏，现已撤回。**
   >
   > 真相来自已上线的 `2026-10-27-structure-editing-design.md` §4.4.1："`nodes` 表有两个相关字段：`graph_id`（**归属哪张图**）和 `graph_type`（**节点语义类别**）。二者**不等价**……同一张图里可以同时存在 `graph_type='online'` 和 `graph_type='dev'` 的节点"，并把"online 图里的 feature 节点挂到同图的 process 节点下"称为"**完全合法**"。
   >
   > 于是 `:42` 的规则正是**正确**的语义：feature/bug 天然是开发侧语义 → `'dev'`；module/process 天然是蓝图侧语义 → `'online'`——**哪怕它住在 dev 图里**。dev 图里同时存在 online 语义的骨架节点和 dev 语义的开发产物，是设计意图。
   >
   > 更关键的是：`node:create` **不应**加 `graphType === graphs.type` 的校验（那会拒掉合法节点创建），存量 `graph_type` **绝不可**按所在图重置（那会批量摧毁 feature/bug 的语义标注且不可逆）。
   >
   > 补充事实：当前**没有任何 SQL 按 `graph_type` 过滤**，所以两种读法在运行时都不被依赖——这条没有用户可见后果，不在本设计范围内。

### 裂缝 E：范围为空 = 全放开

见 §一 引文。补充两点事实：

- **`verifyOnly` 机制存在且可用**：`session-lifecycle-manager.ts:302` 中 `verifyOnly=true` 时即使 `allowedFiles` 为空也会建沙箱，此时 `allowedSet` 为空集 → 任何写入都算越界。`src/main/a2a/wiring.ts:99-101` 已在用这条路。
- **但这条路不能直接用在真实项目目录上**，且原因已被记录在代码里：`src/main/agent/send-and-wait.ts:44-56` 明确写道——
  > 注意：这里**不能**开 verifyOnly。……workingDirectory 是用户的真实项目目录 —— 沙箱根就是用户项目。后果有两处，都是破坏性的：① watcher 监听整棵项目树，用户在生成期间改任何文件都被判为越界 → 会话被 terminate('error')，生成中途夭折；② terminate 时的 commitChanges() 发现越界新文件会直接 unlink 掉 —— 用户自己新建的文件被 BizGraph 删除。

  根因是 ScopeGuard 的 watcher **分不清"Agent 写的"和"用户写的"**：`scope-guard.ts:306` 无条件把 `workingDir` 加入监听目录。

**结论**：只读**不能靠 ScopeGuard 实现**（会误伤用户文件），必须靠**适配器层禁写工具**。

---

## 三、两个已定的产品决定

2026-10-31 用户拍板：

| 决定 | 内容 |
|---|---|
| **D1 空范围的默认行为** | **默认只读，要写得显式开。** 空范围 → Agent 物理上写不了文件；用户显式给出范围才可写；范围被记住，下次自动带上 |
| **D2 默认值的存储层级** | **全局默认 + 项目级覆盖。** 设置里配一套全局默认（适配器 / 模型 / 压缩策略）；项目级可单独覆盖（适配器 / 模型 / 可改文件范围）；节点上可再临时改 |
| **D3 只读会话碰到不支持只读的适配器** | **直接拒绝发送。** 不提示后放行，也不自动换适配器——把写权限在用户不知情的情况下交出去是最坏的结果。错误信息要说清"哪个适配器、为什么不支持、可以怎么做" |
| **D4 默认模型的粒度** | **按适配器分别配。** `claude-code` / `codex` / `mcp` 各自一个字段，UI 按适配器分组。`mcp` 那一档同时充当 provider 推断依据 |

---

## 四、设计

### A. 默认值接线

**A1 · 设置面板新增「默认值」分区。** 在 `SettingsPanel.tsx` 现有 5 个 tab（general / subagents / waterline / health / a2a）之外新增一个 **「默认值 / Defaults」** tab（与项目内 i18n 资源同批新增 key）。内含四项：

| 控件 | 绑定字段 | 说明 |
|---|---|---|
| 默认适配器 | `adapterPreferences.defaultAdapter` | 下拉**只列已安装的**适配器；一个都没装时禁用并提示去装 |
| 回退顺序 | `adapterPreferences.fallbackOrder` | 已有 IPC，无需新增；排序交互复用现成 list 组件（若无则用上下移动按钮实现，不引新依赖） |
| 默认模型 | **按适配器分别配**（见 D4） | 拆成 `claude-code` / `codex` / `mcp` 三个字段。`claude-code` 那档喂 `claude-code.ts:227`；`codex` 那档是**新字段**（当前 codex 完全不读 `defaultModel`）；`mcp` 那档喂 `mcp-adapter.ts:412-458` 的 provider 推断依据（按模型名前缀挑 API key）。**必须同步改 `mergeSettings`**（A2b），否则新字段同样被静默丢弃。旧的 `defaultModel` 保留为向后兼容的回落 |
| 压缩模型 | `compactModel` | 走 `settings:write`（`Partial<BizGraphSettings>` 通道已存在），**不新增 IPC**。**前置条件：必须先修 `mergeSettings` 丢字段的 bug（见 A2b），否则这个控件是空操作**——保存会"成功"，但 `readSettings()` 会把它丢掉，`mcp-adapter.ts:1284` 永远取到 `defaultModel`。另注：该字段**只在 MCP 适配器路径生效**，Claude Code 的 SDK 路径走 SDK 自身压缩机制、不读它——面板需注明，否则用户会以为改了全局生效 |

**A2 · `contextWaterline` 进 `DEFAULT_SETTINGS`。** 现有 IPC 已经能读能写，但 `src/main/settings.ts:568` 的合并表达式在"从未保存过"时两边都是 undefined。把三项以 UI 里的现值为准写进 `DEFAULT_SETTINGS`（`autoCompactEnabled: true` / `autoCompactThreshold: 0.75` / `minCompactInterval: 60_000`，与 `ContextWaterlineTab.tsx:17-21` 的兜底一致），消除"UI 有默认值、设置里没有"的分裂。

**A2b · 修 `mergeSettings` 静默丢字段。** `src/main/settings.ts:558-579` 逐字段显式列举 `BizGraphSettings`，**漏了 `compactModel`**（以及任何将来新增但没登记的字段）。后果：`settings:write` 写进去 → 下次 `readSettings()` 丢掉 → 控件"保存成功但没效果"。这是**静默数据丢失**，比"没有界面"更糟。

修法（二选一，实施时定）：
- 改成**通用合并**：`{ ...defaults, ...pick(saved, Object.keys(defaults)) }` —— 但要保住两处**刻意的例外**：`userIdentity`（`settings.ts:108-110` 明确"不在默认值里，避免重装复用旧 userId"）与 `a2aServer` / `a2a`（整体替换、不深合并），通用合并时要把它们单列。
- 或保持显式列举，**补上 `compactModel`**，并加一条测试断言"新增设置字段必须同时登记到 `mergeSettings`"。

**A3 · 清掉 renderer 里两份硬编码的 `adapterPreferences` 副本。** `adapterStore.ts:23` 与 `agentStore.ts:132` 各写死一份 `{defaultAdapter:'claude-code', fallbackOrder:[10 个]}`。改为：store 初始态从 `settings:read` / `settings:getAdapterPreferences` 取真值；取不到才回落到那份字面量（**该字面量提到单一常量并从 `settings.ts` 导入，避免三处漂移**）。
> 补充：`adapterStore.loadAdapterPreferences()` **已经**被 `agentStore.ts:282` 调用，所以真值是能读到的——A3 的缺口只是**初始态的字面量**，不是"完全不读真设置"。

**A4 · `cliTools` 补到全部**真 CLI** 适配器。** `DEFAULT_SETTINGS.cliTools` 目前只有 3 个（claude-code / codex / opencode），而 `KNOWN_ADAPTER_NAMES` 有 **12** 个。

- **只能补到 10 个真 CLI**：`mcp` 与 `mindmap-internal` 没有 CLI 二进制，硬塞进去会违反 `src/main/ipc/settings.ts:71-81` 的 `assertSafeCommand`（要求非空、裸可执行名）。
- **`mergeCliTools`（`settings.ts:582-592`）只遍历 `defaults`** → 不在 `defaults` 里的项保存时会被丢弃。所以新增的 CLI **必须**进 `DEFAULT_SETTINGS.cliTools`，否则用户装完的状态存不住。
- **安装入口可能已有更好的来源**：`agent:getAdapterMarketplace` → `buildMarketplaceItems`（`src/main/adapters/registry.ts:296`）已列出全部非 hidden 适配器及其 `installMethods`。优先**复用 marketplace 数据**渲染安装入口，而不是自己造一份清单。

**A5 · API key provider 对齐后端。** `SettingsPanel.tsx:219` 的硬编码数组 `['anthropic','openai','deepseek']` 改为从后端白名单 `ALLOWED_PROVIDERS`（`settings.ts:775`）取（或在 renderer 侧维护同源常量），使 `gemini` 可用。

**A6 · 项目级覆盖的存储。** 见 §四.E3——与 E 共用同一份项目级配置结构。

---

### B. 消失的步骤

**B1 · 适配器选择按已装数量自适应。** `ChatHeader.tsx:95-121`：
- **已装 ≥ 2**：下拉**只列已安装的**适配器；未安装的从主列表移除，仅在列表底部保留一个「安装更多适配器…」入口（点了开设置页）。
- **已装 = 1**：整个下拉**不渲染**，改为一个静态标签显示该适配器名。
- **已装 = 0**：保留现有的 `AdapterSetupGuide` 空态（`AgentChatPanel.tsx:409-427`），不动。
- `auto` 项保留：它就是"用 `defaultAdapter`"，语义清晰。

**B2 · 新建图不再问类型，但必须绑定项目。** `GraphTabs.tsx:112-135`：
- 项目已固定有 online + dev 两张图（`graph-service.ts:347-360`），所以"新建图选类型"这个交互本身就是错的——选错类型等于造一张重复图。
- 改为：新建图的语义收敛为「**新建一张空的工作图**」，类型固定为 `dev`（工作副本），online 图不再允许手工新建。
- "从产品蓝图派生开发场景"的入口保留（`GraphTabs.tsx:136-150`）。
- 名字字段保留但**默认值预填**（如"新工作图 2"），且空名改为 toast 提示（见 C5）。
- **必须绑定 `project_path`**：当前 `graph:create` 只传 `{name, type}`（`graph-service.ts:58-63` / `graph-repository.ts:38-47`）→ `project_path` 落库为 NULL。后果有三：① `AgentChatPanel.tsx:261` 的 `workingDirectory: currentGraph?.projectPath ?? ''` 是空串 → **会话根本起不来**；② 该图拿不到任何项目级默认（见 E3）；③ 该图不在 `getProjectPaths()` 的 IPC 路径白名单里。
  - 修法：新建图对话框补一个"项目"选择（**多项目时必选、单项目时自动带入当前项目**），并让 `graph:create` 写入 `project_path`。

**B3 · 子代理 scope 策略给默认值。** `SubagentTypesTab.tsx:120-129`：新建自定义类型时 `scopeStrategy` 默认 `subset`（`EMPTY_TYPE` 已经是 `:18`，但 UI 仍把它作为一个必选项展示）。改为默认选中 `subset`、**不要求用户表态**；需要改的到「编辑该类型」时再改。

**B4 · 状态菜单只给合法转换，且对齐主进程的严宽。** 状态转换有**两张表**：

| 表 | 位置 | 粒度 | 谁在用 |
|---|---|---|---|
| `TRANSITION_RULES` | `src/shared/state-machine.ts:63` | **只看状态**，较宽松，**当前未导出** | renderer 的 `canTransition`（`graphStore.ts:279`） |
| `NODE_STATUS_TRANSITIONS[type]` | `src/shared/types/graph.ts:420` | **按节点类型**，较严 | 主进程的 `validateNodeTypeTransition(type, from, to)`（`state-machine.ts:128`） |

**不一致本身就是"右键改状态失败"的根因**：宽松表放行 → 主进程严格表抛 `IpcError` → renderer `console.error` 吞掉。

修法：
- **以 per-type 矩阵为准**（它是主进程真正的写入门禁）。在共享层导出一个统一的 `canTransitionForType(nodeType, from, to)`（或导出 `NODE_STATUS_TRANSITIONS` 供 renderer 用），renderer 的 `canTransition` 换成它。**不要**用 `TRANSITION_RULES` 过滤——那会留下"点得到但被主进程拒"的格子（如 module 节点的 `draft→developing`）。
- `NodeContextMenu.tsx:33-41` 的 7 个状态格子按 `canTransitionForType(node.type, current, candidate)` 过滤，不可达的不渲染。
- `NodeEditor.tsx:544` 的 `StatusSelector`（**药丸组，不是下拉**）同样过滤，并**补上 `placeholder`**——它当前只对 feature/bug 渲染（`:544-546`），且漏了状态机允许的 `draft → placeholder`。

---

### C. 静默失败归零

**统一原则**：任何用户可触发的失败路径，要么成功，要么给一句明确提示。禁止 `console.error` 后静默 `return`。

**C1 · 非法状态转换要看得见。** `graphStore.ts:280-287` 抛错 → `RightPanel.tsx:111` 补 catch → `toastError(错误信息)`；`GraphCanvas.tsx:1503-1511` 同样从 `console.error` 改为 toast。**同时**按 B4 过滤掉非法格子，让用户点不到非法转换——两层都做。

**C2 · 空内容添加要看得见。** `NodeEditor.tsx` 的四处（业务规则 `:207-208`、验收标准 `:454-455`、API/服务/实体 `:427-433`、标题 `:37-42`）：空内容时 `toastError` 说明"内容不能为空"，且**不退出编辑态**（当前标题清空会静默丢弃输入并退出编辑）。

**C3 · IPC 错误接到 toast。** `createTypedHandle`（`src/main/ipc/utils.ts`）已经把 `BizGraphError.toJSON()` 结构化透传。renderer 侧凡是 await IPC 的写操作，catch 后 `toastError`。至少覆盖：建节点、建边、建图、改标题、改状态、改描述、加规则、加验收标准。

**C4 · 建节点/建边失败要看得见。** `useNodeOperations.ts:48-53,64-66`：建节点失败 → toast 后 `return`（不建边，逻辑不变）；建层级边失败 → toast（节点已建成，边没建成，用户要知道图上少了一根线）。

**C5 · 空名提交要看得见。** `GraphTabs.tsx:25-26`：空名 → `toastError` + **不关弹窗**。

**C6 · 验收口径。** 改完这一类后，任何用户可触发的失败路径都不得出现"界面无反应且无提示"。实现时逐条对照 §二.C 表。

---

### D. 可发现性 + 图归属

**D1 · 扫描按钮常显。** `LeftPanel.tsx:262-273`：去掉 `opacity-0 group-hover:opacity-100`，改为常态可见（hover 时加强对比即可）。项目已导入但尚未扫描时，用一个明显的引导态（"扫描项目生成脑图"按钮 + 副文案）替代纯图标。

**D2 · ~~图归属跟随所在图~~ —— 撤回。** 见 §二.D 第 3 条：`useNodeOperations.ts:42` 的规则符合 `2026-10-27` spec §4.4.1 确立的语义（`graph_type` = 节点语义类别，非图归属），是**刻意设计**。既不加 `graphType === graphs.type` 的落库校验，也不迁移存量 `graph_type`——后者会批量摧毁 feature/bug 的语义标注且不可逆。

**D3 · API key provider 补齐**（同 A5，一并做）。

---

### E. 只读默认 + 范围记忆

**E1 · 新增 `readOnly` 会话模式。** `AgentSessionConfig`（`src/shared/types/agent.ts:20-71`）加一个可选字段 `readOnly?: boolean`。

**默认推导规则**（在 `AgentManager._startSessionInternal` 统一施加，renderer 之外的调用方也受约束）：

```
若 config.allowedFiles 为空 且 config.readOnly 未显式为 false
  → readOnly = true
若 config.allowedFiles 非空
  → readOnly = false
```

**E2 · 只读靠适配器层禁写工具，ScopeGuard 不介入。** 依据 §二.E 的结论：verifyOnly 沙箱会误伤用户文件（watcher 分不清 Agent 写和用户写），所以**只读模式下不建 ScopeGuard 沙箱**，改由适配器启动参数保证 Agent 物理上写不了。

| 适配器 | 只读实现 | 证据 |
|---|---|---|
| claude-code | Claude Code SDK 的 `tools` 选项传**只读工具白名单**（不含 `Write` / `Edit` / `NotebookEdit` / `Bash`）。SDK 语义已在用：`claude-code.ts:214-216` 注释说明 `tools: []` = 禁用全部内置工具；现有 `toolsOption` 只在子代理场景被设值（`:210-212`），**普通会话是 undefined（即全允许）** | `src/main/adapters/claude-code.ts:209-236`、`sdk.d.ts:1630-1638` |
| codex | `sandboxMode` 从写死的 `'workspace-write'` 改为只读档。SDK 的取值是 `"read-only" \| "workspace-write" \| "danger-full-access"` | `src/main/adapters/codex.ts:98,103`、`codex-sdk/dist/index.d.ts:236` |
| mcp | 照抄它自己 `transparent` 分支的做法：`mcpTools = []`（空工具集）即为只读 | `src/main/adapters/mcp-adapter.ts:678` |
| mindmap-internal | **豁免**——它本来就不给写工具（`claude-runner.ts` 的 `buildClaudeArgs` 在 `!allowWrites` 时推 `--disallowedTools`） | `src/main/mindmap-agent/claude-runner.ts:64-80` |
| 其余 7 个 CLI（opencode / cline / kilo-code / kimi-code / codebuddy / qoder / qwen-code / cursor） | **不支持只读的，UI 必须显式标注**"此适配器暂不支持只读模式"，并在范围为空时给二次确认，而不是静默全放开 | `src/main/adapters/` |

> claude-code 的 `permissionMode` 目前对非透明会话写死 `'acceptEdits'`（`claude-code.ts:229`），只读会话需改为 `'default'`。

**E3 · 项目级配置存储。** 新增一张表承载"项目级默认"（适配器 / 模型 / 可改文件范围）：

```
project_settings (
  project_path  TEXT PRIMARY KEY,
  defaults_json TEXT NOT NULL,   -- { defaultAdapter?, defaultModel?, allowedFiles?: string[] }
  updated_at    TEXT NOT NULL
)
```

- **为什么进 DB 而不是 `settings.json`**：CLAUDE.md 的既有先例是项目级配置进库（`graphs.writeback_disabled`，`database.ts:885` 的 `addColumnSafe`）；且 `settings.json` 是单文件整体重写，多窗口并发写会互相覆盖。
- **为什么单独建表而不是加在 `graphs` 上**：一个项目有 online + dev **两张**图，项目级配置放 `graphs` 上会重复两份；`project_settings` 以 `project_path` 为主键，天然一份。
- **schema 变更**：`CURRENT_SCHEMA_VERSION` 从 **17 → 18**（`src/main/database.ts:355`），按既有 `runIncrementalMigrations` 模式加表。
- 作用域优先级：**节点临时值 > 项目级覆盖 > 全局默认**。
- **键的解析路径**：renderer 侧的"项目"是 `useFileTreeStore.projects`（localStorage `bizgraph:projects`），DB 侧只有 `graphs.project_path`。实现时需要一条 **renderer 项目 → `project_path`** 的解析：B2 已保证新建图必写 `project_path`，扫描流程也写（`graph-service.ts`），所以解析以"当前图所属图的 `project_path`"为准即可，不必引入 renderer 项目 id 与 DB 路径的映射表。**注意 `project_path` 需做规范化**（统一分隔符、去掉尾斜杠），否则同一项目会因写法不同产生多行。

**E4 · 范围记忆与 UI。**
- 会话启动时，若项目级已有默认范围 → **自动带上**，用户不必再选。
- 用户显式给了范围 → 写入项目级默认（`allowedFiles`），下次自动带上。
- 用户在会话里显式清空范围 → **落回只读**，并清掉项目级那份范围（否则用户会觉得"我明明关了它又开了"）。
- 范围存**相对项目根**的相对路径（与 `scope-guard.ts` 的 `path.relative(workingDir, srcPath)` 一致），避免项目搬家后绝对路径失效。

**E5 · 范围编辑的入口。** 会话面板需要一处能改范围的地方：沿用现有的 `@` 文件引用机制（`ChatInput.tsx:159-167`），但把它从"顺带产生 allowedFiles"升级为**显式的范围编辑入口**——用户能看见当前范围是"只读"还是"这些 N 个文件"，并能增删。

**E6 · A2A 链路不受影响。** `a2a/wiring.ts:118,132` 已经显式传 `verifyOnly: true`，那是**隔离临时目录**场景，与本设计的"真实项目目录只读"不同，不要合并。

**E7 · 只读会话必须裁剪回退链，否则只读承诺会在回退中失效。** `src/main/agent/fallback-router.ts:150` 对链上**每个候选者传同一份 `initialConfig`**（只改 timeout）。所以一个 `readOnly: true` 的会话如果回退到 `mcp` 适配器——它会挂载 MCP server 的全部工具，而 `DEFAULT_SETTINGS.mcpServers` 默认就带 `filesystem` server，**能写**。

修法（按 D3）：**只读会话的回退链只保留"支持只读的适配器"**（claude-code / codex / mcp 只读档 / mindmap-internal，见 E2 表）。

- 链上**有**可用只读适配器 → 正常回退。
- 链上**无**可用只读适配器 → **直接拒绝发送**，错误信息说明：哪个适配器被选中、它为什么不支持只读、用户可以怎么做（换一个适配器 / 显式给出文件范围）。**不**提示后放行，**不**自动换适配器——把写权限在用户不知情的情况下交出去是最坏的结果。
- **用户显式给了文件范围**时（`allowedFiles` 非空 → `readOnly=false`），回退链不受此裁剪限制。

> 这条与 CLAUDE.md《与 Agent CLI 的边界》一致：BizGraph 只在调用边界之上组装 scope/memory，不改写 LLM 看到的输入——"回退到可写适配器"恰恰是把写权限在 BizGraph 不知情的情况下交出去。

---

## 五、约束与边界

1. **CLAUDE.md《与 Agent CLI 的边界》**：E 类的只读靠**调用参数**实现，不改 CLI 自身行为；不污染 KV-cache 前缀（只读模式不改变 prompt 内容，不注入额外 system 段）。
2. **toast 唯一实现**：`src/renderer/lib/toast.tsx`。不要新建同路径的 `.ts` 文件。
3. **i18n**：所有新文案必须走 `t()`，资源加在 `src/shared/i18n/resources/domains/` 下对应域文件；查表用 `Record<NodeType, TranslationKey>` 静态映射，**禁止模板拼接 key**。
4. **schema 变更**：新增 `project_settings` 表 → `CURRENT_SCHEMA_VERSION` 17 → 18。**不要**做存量 `graph_type` 校正（见 §二.D 第 3 条）。
5. **设置字段登记**：`BizGraphSettings` 新增字段时，**必须**同时登记到 `mergeSettings`（`settings.ts:558-579`），否则会被静默丢弃——`compactModel` 已经是现成的例子。修法见 A2b。
6. **状态机**：任何状态变更必须走 `NodeRepository.update()`（内部强制 `validateNodeTypeTransition`）；**不要**在别处直接 `UPDATE nodes SET status = ...`。renderer 侧的"能不能转"判断必须与主进程**用同一张表**（per-type 矩阵，见 B4）。
7. **类型迁移**：`validateNodeTypeTransition` 对 `graph_type` 无约束，本设计不引入节点类型变更，也**不改** `graph_type` 的语义（`2026-10-27` spec §4.4.1 已定：`graph_type` = 节点语义类别）。
8. **不改适配器协议**：CLAUDE.md 明确"多 Agent CLI 的协议不归一"，E2 逐适配器实现只加各自的只读开关，不做统一抽象层。

---

## 六、留给实现者的

实现者需要自己定的（不改变设计意图，小事可自行拍板）：

- 「默认值」tab 的具体控件形态（下拉 / 拖拽排序 / 组合框）与是否并入现有 general tab
- 只读工具白名单的具体工具名集合（以各 CLI 的实际工具名文档为准）
- `mergeSettings` 改成通用合并还是显式补字段（A2b 二选一，两条路都成立）
- 复用 `agent:getAdapterMarketplace` 渲染安装入口的具体接法（A4）
- 新建图对话框里"项目"选择器的形态（B2）
- 只读会话裁剪回退链的具体实现位置（`buildChain` 入参 vs 运行时过滤）
- 按适配器分开的模型字段命名与旧 `defaultModel` 的回落衔接（A1 / D4）
- 其余 7 个 CLI 适配器的只读降级提示文案
- 「扫描生成脑图」引导态的具体视觉
- `project_path` 的规范化规则（E3）

实现者**必须**回来问的：无。D3 / D4 已由用户拍板（见 §三）。若实施中发现某个 CLI 适配器根本无法表达"只读"，按 D3 的降级规则处理（拒绝发送 + 说明原因），不必再问。
