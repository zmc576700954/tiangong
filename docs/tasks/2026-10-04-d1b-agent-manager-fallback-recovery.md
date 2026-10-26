# D1b — AgentManager 拆分：FallbackRouter / RecoveryOrchestrator / PromptFormatter

> 创建：2026-10-04
> 范围：Phase D 任务 D1b — AgentManager god file 拆分（4 个模块）
> 合并落地：2026-10-26（与 D1a 合并后的最终形态见文末「落地结果」）

## 原始状态

D1b 与 D1a 同 base（5107951）并行开发，两者是**同一份 god file 的两套拆分方案**：
D1a 拆 lifecycle / context / compaction / health / phase-b / types，
D1b 拆 fallback / recovery / prompt / compaction。

```
 M src/main/agent/agent-manager.ts                          (+165 / -629)
?? src/main/agent/fallback-router.ts                       (199 行)
?? src/main/agent/recovery-orchestrator.ts                  (366 行)
?? src/main/agent/prompt-formatter.ts                       (190 行)
?? src/main/agent/compaction-manager.ts                     (201 行)
?? src/main/agent/__tests__/fallback-router.test.ts         (303 行)
?? src/main/agent/__tests__/recovery-orchestrator.test.ts   (293 行)
?? src/main/agent/__tests__/prompt-formatter.test.ts        (402 行)
```

god file 净减 464 行（agent-manager.ts: +165/-629）。

## 目标

把 `agent-manager.ts` 中混杂的逻辑拆分到 4 个专职模块：

- **FallbackRouter**：回退链路由（去重 / 健康度优先 / 连续超时计数 / degraded 超时减半 / onUnhealthy hook）
- **RecoveryOrchestrator**：替换 4 个 god 方法（`_handleSessionEnded / _resumeLastCommand / _startFallbackRecoveryCheck / startRecoveryCheck`）
- **PromptFormatter**：替换 4 个 prompt 格式化方法（`formatMemoryContext / formatSessionHistoryContext / formatCodeContext / getOptimalPromptBudget`）
- **CompactionManager**：替换 `compactContext / _doCompactContext`（并发去重 / 策略解析 / 历史持久化 / 水位线更新 / 广播）

## 任务清单

### D1b-1 FallbackRouter

- 新增 `src/main/agent/fallback-router.ts`（199 行）
- 测试：`src/main/agent/__tests__/fallback-router.test.ts`（303 行，2 describe）

### D1b-2 RecoveryOrchestrator

- 新增 `src/main/agent/recovery-orchestrator.ts`（366 行）
- 测试：`src/main/agent/__tests__/recovery-orchestrator.test.ts`（293 行，5 describe）

### D1b-3 PromptFormatter

- 新增 `src/main/agent/prompt-formatter.ts`（190 行）
- 测试：`src/main/agent/__tests__/prompt-formatter.test.ts`（402 行，4 describe）

### D1b-4 CompactionManager

- 新增 `src/main/agent/compaction-manager.ts`（201 行）
- **测试：缺**（需补 `compaction-manager.test.ts`）

### D1b-5 agent-manager.ts 集成

- agent-manager.ts 改动：+165 / -629 行（god file 净减 464 行）
- 4 个新模块通过 `this.fallbackRouter / recoveryOrchestrator / compactionManager / promptFormatter` 字段接入构造函数
- 保留所有公开方法签名（外部调用方无感）

## 验证门槛

- [ ] `npx tsc --noEmit` 0 errors
- [ ] `npm run lint` 0 warnings
- [ ] `npm run test` 全绿（含 4 个新模块测试）
- [ ] D1b-1 ~ D1b-5 全部完成
- [ ] 补 compaction-manager 测试

## 下一步

1. 补 `src/main/agent/__tests__/compaction-manager.test.ts`（并发去重 / 策略解析 / 历史持久化 / 水位线更新 / 广播）
2. 跑 `npx tsc --noEmit` + `npm run lint` + `npm run test`
3. `git add -A && git commit -m "feat(agent): D1b AgentManager 拆分 — FallbackRouter / RecoveryOrchestrator / PromptFormatter / CompactionManager"`

## 关系

- 与 `d1a-agent-manager-lifecycle`（D1a）同 base（5107951）但修改不同文件
- D1a 拆 6 个模块（lifecycle / context / health / phase-b / types）+ agent-manager.ts 净减 929 行（+475/-1404）
- D1b 拆 4 个模块 + agent-manager.ts 净减 464 行（+165/-629）
- 与 `agent-manager-fallback` 是同一个 worktree（D1b 即此任务）

## 关键决策

- **拆分粒度**：每个模块聚焦单一职责，避免再次出现 god file
- **公开 API 稳定**：agent-manager.ts 公开方法签名保持不变，4 个模块作为私有协作者
- **测试覆盖**：3/4 模块已附测试（fallback / recovery / prompt），compaction 缺测需补
- **不破坏 Boundary**：4 个新模块均为内部职责拆分，不改变与 Agent CLI 的边界（详见 CLAUDE.md Boundaries 章节）

## 已知注意事项

- 与 D1a 同时修改 agent-manager.ts，存在合并冲突风险；建议先后顺序：D1a 先合或 rebase 一次解决
- 4 个模块的依赖（SessionRouter / ContextWaterline / CompactHistoryRepository 等）需在构造函数中显式注入，便于测试 mock
- 提交前确认 fallback / recovery / compaction 模块对 SessionRouter 的回调注册路径正确（god file 内联调用 → 模块方法 → router 回调）


---

## 落地结果（2026-10-26 合并到 main）

D1a 先于 D1b 合入 main，因此合并时以 D1a 的架构为准，D1b 的模块按「**同一行为只有一份实现**」的原则逐个裁决：

| D1b 模块 | 裁决 | 说明 |
|---|---|---|
| `fallback-router.ts` | **采纳并接线** | 该逻辑在 D1a 之后仍留在 god file 内（`startSession` 的回退链）。现在 `AgentManager._startSessionInternal` 只负责会话注册，链路构建与尝试交给 FallbackRouter。 |
| `recovery-orchestrator.ts` | **采纳并接线** | 恢复决策（native / replacement / none）与两个探测定时器从 god file + housekeeper 迁入 RecoveryOrchestrator。housekeeper 只保留健康检查与内存压力。 |
| `prompt-formatter.ts` | **采纳并接线** | D1a 的 `ContextAssembler` 里三段格式化逻辑与「最优 token 预算」重复实现且**没有任何单测**。现在由 PromptFormatter 独家实现，ContextAssembler 委托调用，407 行单测随之生效。 |
| `compaction-manager.ts` | **未采纳** | 与 D1a 的 `ContextCompactor` 行为完全重复（并发去重 / 策略解析 / 历史持久化 / 水位线 / 广播），且原本就没有单测。保留 D1a 版本。 |

### 合并中的行为调整

- `FallbackRouter.resolveSession` 新增可选 `onSessionStarted` 钩子：会话注册（沙箱准备 / 状态镜像 / 路由绑定 / 节点状态推进）仍在 try 块内执行，注册失败与适配器启动失败同等处理（记为该候选者失败并回退）。
- 连续超时计数（`adapterTimeoutCounts`）改由 FallbackRouter 持有，AgentManager 保留同名 getter 供测试访问。
- 恢复探测定时器（`startRecoveryCheck` / `startFallbackRecoveryCheck`）从 `AgentHealthHousekeeper` 迁至 `RecoveryOrchestrator`，housekeeper 改为转发。`recoveryCheckIntervals` getter 随之指向 RecoveryOrchestrator。
- 原生恢复（native resume）重新绑定路由时保留 `originalAdapter`，避免回退信息被清空。
- 最优 token 预算改用按命令类型区分的默认值（fix_bug 6000 / add_test 6000 / refactor 10000 / implement 12000），
  替代此前所有命令类型统一使用 8000 的兜底值。

### 验证

- `npx tsc --noEmit` — 0 错误
- `npm run lint` — 0 警告
- `npm run test` — 2629 通过；仅剩 2 个 `agent-manager.test.ts` 失败，均为合并前既有失败
- 新增单测：`fallback-router` / `recovery-orchestrator` / `prompt-formatter` 共 57 例全绿
