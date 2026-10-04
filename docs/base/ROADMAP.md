# BizGraph 基座 v1 路线图

> 创建日期：2026-09-30
> 状态：基座 v1 已交付（Phase A/B/C 完成），Phase D 待启动

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

- ✅ **Recipe 类型定义**：`RecipeDefinition / RecipeParameter / RecipeRun / RecipeWithSource`
- ✅ **ErrorCode.RECIPE_PARSE_ERROR**：YAML 解析失败错误码
- ✅ **YAML Loader**：js-yaml + Zod schema 校验，错误信息含文件路径 + 字段路径
- ✅ **双层加载器**：用户级 `<userData>/recipes/` + 项目级 `<cwd>/.bizgraph/recipes/`，项目级覆盖用户级
- ✅ **3 个内置 Recipe**：`refactor-react-component.yaml` / `add-tests.yaml` / `upgrade-deps.yaml`
- ✅ **RecipeRunner**：参数校验 + `{{ key }}` 模板替换 + 派发到 SubagentManager
- ✅ **IPC channels**：`recipes:list` / `recipes:run` / `recipes:listRuns` / `recipes:getBuiltIn` / `recipes:getDirs`
- ✅ **渲染端 UI**：`RecipesPanel.tsx`（ChefHat 入口，列表 + 详情 + 参数表单 + 历史 runs）
- ✅ **preload 暴露**：5 个新通道通过 `contextBridge` 暴露

### 全局 Toast 系统（Phase A2 收尾）

- ✅ **lib/toast.ts**：Zustand store + `useToast()` hook
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

## Phase D 远期清单（不在本期范围）

| 项 | 工作量 | 优先级 | 备注 |
|----|--------|--------|------|
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
- ✅ `npm run test` 全绿（基座前 1914 → 基座后 1953+，新增 39 case）
- ✅ `npm run lint` 零警告
- ⏳ `npm run build:win` 成功且 bundled 资源存在（resources/recipes/*.yaml 已加入 build.files）
- ⏳ 手动 `npm run dev`：能跑内置 `refactor-react-component` recipe

## 参考

- **Block Goose Recipes** schema：https://block.github.io/goose/docs/getting-started/recipes
- **DSH-Synapse**：Boundaries with Agent CLI 哲学
- **LangFlow** / **Flowise**：React Flow 画布基座参考（项目已用 `@xyflow/react`）
- 详细 plan 见 [`.claude/plans/elegant-crafting-sparkle.md`](../../.claude/plans/elegant-crafting-sparkle.md)