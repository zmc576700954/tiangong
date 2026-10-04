# D1a — AgentManager Session Lifecycle + 上下文组装/压缩 + 健康度辅助 + Phase B Handler

> 创建：2026-10-04
> 范围：Phase D 任务 D1a — AgentManager 会话生命周期解耦

## 当前状态

**代码完成 + 未 commit** — 8 个改动在工作区（6 新模块 + 1 文件修改 + 1 测试文件）

```
 M src/main/agent/agent-manager.ts                              (+475 / -1404)
?? src/main/agent/session-lifecycle-manager.ts                  (835 行)
?? src/main/agent/context-assembler.ts                          (275 行)
?? src/main/agent/context-compactor.ts                          (216 行)
?? src/main/agent/health-monitor-helpers.ts                     (225 行)
?? src/main/agent/phase-b-handler.ts                            (151 行)
?? src/main/agent/types.ts                                      (121 行)
?? src/main/agent/__tests__/session-lifecycle-manager.test.ts   (474 行)
```

god file 净减 929 行（agent-manager.ts: +475/-1404）。

## 目标

把 AgentManager 的会话生命周期逻辑与 Phase B MCP 集成拆分到专职模块：

- **SessionLifecycleManager**：会话状态机（start / pause / resume / end）
- **ContextAssembler**：上下文组装（smart resolver + memory + session history）
- **ContextCompactor**：上下文压缩（策略选择 + token 预算控制）
- **HealthMonitorHelpers**：健康度辅助（封装 AdapterHealthMonitor 交互）
- **PhaseBHandler**：MCP Phase B 集成 handler
- **types.ts**：AgentManager 内部共享类型

## 任务清单

### D1a-1 SessionLifecycleManager

- 新增 `src/main/agent/session-lifecycle-manager.ts`（835 行）
- 测试：`src/main/agent/__tests__/session-lifecycle-manager.test.ts`（474 行）

### D1a-2 ContextAssembler

- 新增 `src/main/agent/context-assembler.ts`（275 行）
- **测试：缺**

### D1a-3 ContextCompactor

- 新增 `src/main/agent/context-compactor.ts`（216 行）
- **测试：缺**

### D1a-4 HealthMonitorHelpers

- 新增 `src/main/agent/health-monitor-helpers.ts`（225 行）
- **测试：缺**

### D1a-5 PhaseBHandler

- 新增 `src/main/agent/phase-b-handler.ts`（151 行）
- **测试：缺**

### D1a-6 共享类型

- 新增 `src/main/agent/types.ts`（121 行）

### D1a-7 agent-manager.ts 集成

- agent-manager.ts 改动：+475 / -1404 行（god file 净减 929 行）
- 5 个新模块通过构造函数字段接入，6 个新模块均以 `import` 引入 types

## 验证门槛

- [ ] `npx tsc --noEmit` 0 errors
- [ ] `npm run lint` 0 warnings
- [ ] `npm run test` 全绿（仅 session-lifecycle-manager 有测试）
- [ ] 补齐 5 个新模块的单测（context-assembler / context-compactor / health-monitor-helpers / phase-b-handler / types）
- [ ] `types.ts` 为纯类型文件，lint/tsc 自带校验

## 下一步

1. 补齐 5 个新模块的单测：
   - `src/main/agent/__tests__/context-assembler.test.ts`
   - `src/main/agent/__tests__/context-compactor.test.ts`
   - `src/main/agent/__tests__/health-monitor-helpers.test.ts`
   - `src/main/agent/__tests__/phase-b-handler.test.ts`
   - `types.ts` 为纯类型无需单测
2. 跑 `npx tsc --noEmit` + `npm run lint` + `npm run test`
3. 决定与 D1b（agent-manager-fallback）的合并顺序（同 base 都改 agent-manager.ts）
4. `git add -A && git commit -m "feat(agent): D1a AgentManager 拆分 — SessionLifecycleManager / ContextAssembler / ContextCompactor / HealthMonitorHelpers / PhaseBHandler"`

## 关系

- 与 D1b（agent-manager-fallback）同 base（5107951）但拆分维度不同
- D1a 拆 6 个模块 + agent-manager.ts 净减 929 行（+475/-1404）
- D1b 拆 4 个模块 + agent-manager.ts 净减 464 行（+165/-629）
- 与 phase-d6（D6 OpenTelemetry）有 agent-manager.ts 交集
- Phase B MCP 集成（mcp 健康度集成 / 生命周期闭环）前置工作已合入 base（5107951），本任务承接其封装

## 关键决策

- **SessionLifecycleManager 单独成模块**（835 行）：生命周期状态机是 god file 内最大独立职责，单独抽离便于单元测试
- **ContextAssembler / ContextCompactor 分离**：组装（输入侧）和压缩（输出侧）职责相反，分模块比合并更清晰
- **HealthMonitorHelpers 而非直接用 AdapterHealthMonitor**：保留 god file 中对健康度的特殊处理（连续失败计数、degraded 模式），helper 层封装业务语义
- **PhaseBHandler 单独成模块**：MCP Phase B 集成是边界模块，与 Adapter 体系解耦，独立成模块便于 phase-d 系列其他任务引用
- **types.ts 而非嵌入各模块**：跨模块共享类型集中管理，便于 IDE 跳转

## 已知注意事项

- 与 D1b 同时修改 agent-manager.ts，存在合并冲突风险
- SessionLifecycleManager 单文件 835 行较大，考虑是否进一步拆分（startSession / pauseSession / resumeSession / endSession），目前作为单一职责先合入观察
- PhaseBHandler 与 Phase D 的 mcp 工作强相关，需确认 health-monitor-helpers 与其接口边界
- 5 个新模块均无单测是较大债务，本次必须补齐再 commit（types.ts 除外）
