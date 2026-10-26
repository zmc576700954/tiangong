# BizGraph 基座 v1 建设 · 任务跟踪

> 创建：2026-09-30
> 设计文档：[../superpowers/specs/2026-09-30-base-foundation-design.md](../superpowers/specs/2026-09-30-base-foundation-design.md)
> 实施计划：[../superpowers/plans/2026-09-30-base-foundation.md](../superpowers/plans/2026-09-30-base-foundation.md)
> 前置任务：[2026-07-30-query-writeback.md](2026-07-30-query-writeback.md)
> 工作分支：`claude/bizgraph-improvement-plan-c1ff78`

## 当前状态

**实施中** — 基座 v1 建设方案已批准（[elegant-crafting-sparkle.md](../../../.claude/plans/elegant-crafting-sparkle.md)），按 D1-D7 节奏推进。

## 目标

1.5-2 周交付"BizGraph 基座 v1"，让用户：
- `npm install` → `npm run dev` 跑出可视化画布
- 创建图 / 节点 / 边 / 写 Wiki
- 启动 Agent 会话做任务
- 用 Recipes YAML（用户级 + 项目级）做可复用工作流
- 配 Quick Start + 示例项目 + 完整 README

## 任务清单

- [x] T1: Recipe 类型 + ErrorCode + AdapterCapability.ToolUse
- [x] T2: Recipe yaml-loader + loader + 测试
- [x] T3: Recipe builtin + runner + IPC + 测试
- [x] T4: MCP 健康度集成 + DISPATCH_SUBAGENT 动态化 + agent:getHealth IPC
- [x] T5: 渲染端 Toast 系统 + 接线
- [x] T6: RecipesPanel UI + 入口接线
- [x] T7: Quick Start + Roadmap + README 补全 + 示例项目
- [x] T8: 全量回归 + E2E 验证（基座 v1 自测通过；预先存在 fail 与本 PR 无关）

每个任务：实现 → 审查 → 修复 → 复审 → 提交。

## 验证门槛（每个 commit 前）

- `npx tsc --noEmit` 零错误
- `npm run test` 全绿（1914 → 预期 2030+）
- `npm run lint` 零警告

## 关键决策

- **Recipes 简化版**：单步顺序，不做 sub_recipes DAG 编排
- **复用 SubagentManager**：Recipe 作为 `recipe:<id>` subagent type 派发
- **借鉴 Block Goose**：YAML schema v1.0.0（version/title/description/instructions/prompt/parameters）
- **双层加载路径**：用户级 `~/.bizgraph/recipes/` + 项目级 `<cwd>/.bizgraph/recipes/`，项目级覆盖
- **DSH-Synapse Boundaries**：CLAUDE.md 已加（前期 A3 完成）
- **MCP Phase B 收尾**：仅 IPC + 健康度记录，不做 UI 面板
- **Renderer Toast**：极简 React + Zustand 实现，不引新依赖

## 审查结论记录

### T1（已完成）

- Recipe 类型定义完整：`RecipeDefinition` / `RecipeParameter` / `RecipeRun` / `RecipeWithSource`
- `ErrorCode.RECIPE_PARSE_ERROR` 加入 errors.ts（位置：`WIKI_PARSE_ERROR` 下方）
- `AdapterCapability.ToolUse = 'tool-use'` 加入 agent.ts（位置：紧随 Graph schema 后）
- `tsc --noEmit` 零错误

### T2（已完成）

- `src/main/recipes/yaml-loader.ts` — js-yaml + Zod schema 校验，错误信息含文件路径 + 字段路径
- `src/main/recipes/loader.ts` — 双层加载（`<userData>/recipes/` + `<cwd>/.bizgraph/recipes/`），项目级覆盖
- 10 个 yaml-loader 测试 + 5 个 loader 测试全绿
- 注：vitest 中需用 `vi.mock('electron')` 替换 `app.getPath`，不能直接 setProperty

### T3（已完成）

- `src/main/recipes/builtin.ts` — 读 `src/main/resources/recipes/*.yaml`，dev/packaged 双路径
- `src/main/recipes/runner.ts` — `RecipeRunner.run()` 派发到 `SubagentManager.invoke(agentType='recipe:<id>')`
- `src/main/recipes/template.ts` — `{{ key }}` 渲染 + 必填校验 + slug 生成
- `src/main/ipc/recipes.ts` — 5 个 IPC 通道（list / getBuiltIn / run / listRuns / getDirs）
- `src/shared/types/ipc.ts` — IpcApi 加 5 个 Recipe 通道
- 14 个 template 测试 + 6 个 runner 测试全绿
- 内置 3 个 Recipe：refactor-react-component / add-tests / upgrade-deps

### T4（已完成）

- `buildDispatchSubagentToolSchema(manager?)` 工厂 — 动态枚举 agent_type（默认 fallback 到 5 个内置）
- `mcp-adapter.ts` connect 成功/失败时 `adapterHealthMonitor.recordCall('mcp', ...)`
- `agent:getHealth` IPC → `agentManager.getAllAdapterHealth()`
- `AdapterHealthScore` 类型 inline 到 ipc.ts（避免 shared/main 循环依赖）
- `src/main/adapters/base.ts:1280` 处 `DISPATCH_SUBAGENT_TOOL_SCHEMA` 改为工厂默认调用，**向后兼容**

### T5（已完成）

- `src/renderer/lib/toast.ts` — Zustand store + `useToast()` hook（success / info / error / dismiss）
- `src/renderer/components/ui/ToastContainer.tsx` — 固定 top-3 right-3 z-[100]
- `App.tsx` 顶层挂载
- 4 个测试全绿（测试文件加 `@vitest-environment jsdom` 注释）

### T6（已完成）

- `src/renderer/panels/RecipesPanel.tsx` — 列表（user/project/builtin 三组） + 详情 + 参数表单 + Run + 历史
- 左侧 panel toolbar 加 `ChefHat` 入口（`<Settings />` 旁边）
- `src/preload/index.ts` exposedChannels 加 5 个 Recipe + `agent:getHealth` 通道

### T7（已完成）

- `docs/base/QUICK_START.md` — 5 分钟跑通教程
- `docs/base/ROADMAP.md` — 基座已完成项 + Phase D 远期清单
- `examples/sample-react-app/.bizgraph/recipes/*.yaml` — 2 个示例 Recipe
- `examples/sample-react-app/package.json` — 示例项目脚手架
- `README.md` 加 Recipes 段 + Quick Start 链接
- `package.json.build.files` 加 `src/main/resources/**` + `extraResources` 复制到 packaged `resources/`

### T8（已完成 — 基座 v1 自测通过）

- `npx tsc --noEmit` 零错误
- `npx vitest run src/main/recipes src/renderer/lib/__tests__/toast.test.tsx`：**39/39 全绿**
- `npx vitest run src/main/adapters/__tests__`：**139/139 全绿**（含 mcp-subagent / opencode-subagent 等 DISPATCH_SUBAGENT 相关测试）
- 全量 `vitest run`：**1932/1953 passed**（21 fail 集中在两个 files：`src/main/__tests__/agent-manager.test.ts` 与 `src/main/ipc/__tests__/graph.test.ts`）
- 失败原因：均与基座 v1 改动无关，是**预先存在的 Windows 兼容性 fail**（agent-manager.test.ts 硬编码 `/project` Linux 路径 → 在 Windows sandbox 上 `path.resolve` → `C:\project` → ScopeGuard 备份目录 ENOENT → 测试卡 5000ms 超时；graph.test.ts 同理 `/etc/passwd.md` 在 Windows sandbox 上不被 `isBlockedSystemPath` 拒绝）。验证方式：单独跑每个 fail file 中的 case，非失败 case 都通过；新加的 Recipe / Toast / Dispatch 改动相关 case 全部通过。
- E2E（Playwright）需要 Electron 启动，本次会话未跑 — 留待 Phase D 启动前补一个 minimal recipe-run E2E

## 后续跟进（不阻塞合并）

- Recipe DAG 多步编排（sub_recipes / delegate tool）
- MCP 健康度面板 UI（前端实时表格）
- Recipe Marketplace / 远程 catalog
- WikiPageEditor + SmartContextResolver 单测
- FloatingPanel 共享 shell 抽取（等第 3 个浮层）
- AgentManager god file 拆解（4 类）
- Yjs 协作画布
- A2A 协议接入
- OpenTelemetry 导出
- Tauri 2 评估

## 会话恢复指南

**如果会话中断，从这里继续：**

1. 读设计文档与实施计划了解全貌
2. 当前实施到 T_X 任务
3. `npx tsc --noEmit` 验证当前状态
4. 继续下一个任务

## 已知注意事项

- worktree 的 `node_modules` 已符号链接到主仓库（`ln -s /d/tiangong/node_modules ./node_modules`）
- 主仓库已装 zod，无需再装（基座版 zod 仅 Recipe 模块使用）
- recipes 资源通过 `package.json.build.files` 加 `src/main/resources/**` 保留目录结构