# BizGraph 基座 v1 路线图

> 创建日期：2026-09-30
> 状态：基座 v1 已交付（Phase A/B/C 完成），Phase D-0 框架硬伤修复已落地并完成末尾整体评审修复，D-0 后续批次待启动

## 基座 v1 已交付（Phase A + B + C）

### Phase A — 边界与质量（A1/A2/A3）

- ✅ **A1 状态机**：NodeStatus / BugStatus 转换规则统一，`TRANSITION_RULES` 与 `NODE_STATUS_TRANSITIONS` 一致性自检
- ✅ **A2 WritebackPanel**：会话产物回写审核队列 UI 接入（pending/accepted/discarded）
- ✅ **A3 CLAUDE.md 边界**：采纳 DSH-Synapse "Boundaries with Agent CLI" 哲学，固化到项目指令

### Phase B — MCP 收尾 + 健康度

- ✅ **AdapterCapability.ToolUse**：结构化工具调用能力标识
- ✅ **DISPATCH_SUBAGENT 动态化**：`buildDispatchSubagentToolSchema(manager?)` 工厂，agent_type 枚举跟随 SubagentManager 注册的子代理类型（含 Recipe）
- ✅ **MCP 健康度集成**：`mcp-adapter` connect 成功/失败均记录到 `adapterHealthMonitor`
- ✅ **agent:getHealth IPC**：渲染端可查询所有适配器健康评分

### Phase C — Recipes（核心缺口）

- ✅ **Recipe 类型定义**：`RecipeDefinition / RecipeInputSpec / RecipeRun / RecipeDefinitionWithSource`
- ✅ **ErrorCode.RECIPE_PARSE_ERROR**：YAML 解析失败错误码
- ✅ **YAML Loader**：js-yaml + Zod schema 校验，错误信息含文件路径 + 字段路径
- ✅ **三层加载器**：内置 `src/main/resources/recipes/` → 用户级 `<userData>/recipes/` → 项目级 `<cwd>/.bizgraph/recipes/`，后者覆盖前者
- ✅ **3 个内置 Recipe**：`refactor-react-component.yaml` / `add-tests.yaml` / `upgrade-deps.yaml`
- ✅ **RecipeRunner**：参数校验 + `${input.x}` 模板替换 + 派发到 SubagentManager
- ✅ **IPC channels**：`recipes:list` / `recipes:run` / `recipes:listRuns` / `recipes:get` / `recipes:refresh`
- ✅ **渲染端 UI**：`RecipesPanel.tsx`（画布工具条 Recipes 按钮入口，列表 + 详情 + 参数表单 + 历史 runs）
- ✅ **preload 暴露**：新通道通过 `contextBridge` 暴露

### 全局 Toast 系统（Phase A2 收尾）

- ✅ **lib/toast.tsx**：Zustand store + `useToast()` hook
- ✅ **ToastContainer**：固定 top-3 right-3 z-[100]，success/info/error 三种样式
- ✅ **App.tsx 顶层挂载**

## 测试覆盖增量

| 模块 | 增量 case | 累计 |
|------|-----------|------|
| `recipes/__tests__/yaml-loader.test.ts` | +10 | 10 |
| `recipes/__tests__/loader.test.ts` | +5 | 5 |
| `recipes/__tests__/template.test.ts` | +14 | 14 |
| `recipes/__tests__/runner.test.ts` | +6 | 6 |
| `renderer/lib/__tests__/toast.test.tsx` | +4 | 4 |
| **Phase C 小计** | **+39** | **39** |

### Phase D-0 — 框架硬伤修复（批次 1，F1–F9）

- ✅ **D1 Prompt 三段拆分**：`PromptContext { stable, turn }`；用户请求移出 system 通道；`codeContext` 移出 scope 段，KV-cache 前缀跨轮稳定
- ✅ **D2 scope 段标题单一来源**：`SCOPE_SECTION_HEADINGS` 常量表；压缩分级恢复生效（此前 Level 1/2/3 全是 no-op）；删除零消费者的第二份 scope 构造实现
- ✅ **D3 waterline 超预算截断自身**：不再反向抢占 context 预算
- ✅ **D4 claude-code 补齐会话终止与恢复契约**：发射 `sessionEnded`；原生恢复需真实 CLI 会话 id；原生恢复重发上一条命令
- ✅ **D5 schema 迁移慢路径无条件重建**：补上「改了 `createSql` 没 bump 版本」的兜底；比对项扩展到列类型
- ✅ **D6 MessageStatus 与 DB CHECK 对齐**：CHECK 扩容到 8 值（schema v16）
- ✅ **D7 JSON 列运行时校验**：形状守卫逐元素校验；脏数据退化为默认值而不是崩溃 / 盲转

**末尾整体评审的修复（1 Critical + 5 Important，全部已修）**：

- **C-1**（本分支引入）直接走 `AgentManager.sendCommand` 的 6 条路径上 scope 提示词整体消失 —— 黑名单唯一的执行手段就是提示词，丢了这条安全约束就静默消失。已把「任何投递路径都必须携带 scope」上升为框架级不变量
- **I-1** `stable` 段混入会话摘要与附加上下文 → 两者移入 `turn`，稳定前缀恢复跨轮逐字节一致
- **I-2** `safeJsonParse` 的 validator 放宽后失去编译期的「列类型 ↔ 守卫」耦合 → 恢复谓词签名，interface 一侧改用窄守卫
- **I-3** JSON 数组列只验容器不验元素（`[null]` 能过守卫而渲染层 `.map` 崩）→ 补 9 个逐元素守卫
- **I-4** claude-code 的 SDK `type:'result'` 错误通道未覆盖（`is_error:true` 被当成功、`error_*` subtype 不发终止事件）→ result 分支同时看 `subtype` 与 `is_error`
- **I-5**（本分支引入）`promptContext` 永不过期 → 跨轮注入上一轮 turn 段 → 与 C-1 同一机制修

> 落地记录：[`docs/tasks/2026-10-27-framework-hardening.md`](../tasks/2026-10-27-framework-hardening.md)

## Phase D 远期清单（不在本期范围）

| 项 | 工作量 | 优先级 | 备注 |
|----|--------|--------|------|
| 批次 2：记忆检索接线（`HybridSearchEngine` → agent prompt，`commandType` 打通） | 2-3 周 | 高 | 依赖 D1 的 stable/turn 段结构（已就绪） |
| 批次 3：Zod 校验层（`IpcApi` 同源）+ 集中事件总线 + 统一模型注册表 | 3-4 周 | 中 | 无前置依赖 |
| 批次 4：真实 tokenizer 替代 4 字符启发式 + `onUsage` 订阅 + 水位线按适配器真实 context window | 2 周 | 中 | 无前置依赖 |
| Recipe DAG 多步编排（sub_recipes） | 4-6 周 | 中 | 等基座落地、用户用熟后再上 |
| MCP 健康度面板 UI（前端实时表格） | 1 周 | 中 | 基座只暴露 IPC，UI 留待 Phase D |
| Recipe Marketplace / 远程 catalog | 4-6 周 | 低 | 远期 |
| WikiPageEditor + SmartContextResolver 单测覆盖 | 1 周 | 中 | 等有空补覆盖 |
| FloatingPanel 共享 shell 抽取 | 1 周 | 中 | 等第 3 个浮层出现（已 2 个：Settings + Recipes） |
| AgentManager god file 拆解（4 类） | 2-3 周 | 高 | 基座稳定后第一优先 |
| Yjs 协作画布 | 4-6 周 | 低 | 远期 |
| A2A 协议接入 | 2 周 | 低 | 跨进程 Agent 互操作 |
| OpenTelemetry 导出 | 3 天 | 中 | 观测性 |
| Tauri 2 评估 | 4-6 周 | 低 | 仅当 Electron 体积成问题 |
| Wiki Lint 面板增强（修复指引） | 1 周 | 中 | 当前只有 lint 结果展示 |
| 写回回滚 UI（用户撤回已接受的写回） | 1 周 | 中 | 当前只能 discard pending |

## 验证清单（每个 commit 前必过）

- ✅ `npx tsc --noEmit` 零错误
- ✅ `npm run test` 全绿（基座前 1914 → Phase C 后 1953+ → 框架硬伤修复后 2885）
- ✅ `npm run lint` 零警告
- ⏳ `npm run build:win` 成功且 bundled 资源存在（resources/recipes/*.yaml 已加入 build.files）
- ⏳ 手动 `npm run dev`：能跑内置 `refactor-react-component` recipe

## 参考

- **Block Goose Recipes** schema：https://block.github.io/goose/docs/getting-started/recipes
- **DSH-Synapse**：Boundaries with Agent CLI 哲学
- **LangFlow** / **Flowise**：React Flow 画布基座参考（项目已用 `@xyflow/react`）
- 详细 plan 见 [`.claude/plans/elegant-crafting-sparkle.md`](../../.claude/plans/elegant-crafting-sparkle.md)