# Agent 体系 M0 落地方案

> 设计依据：[agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md)。本文只排 M0 的施工顺序，不重复设计论证。

## M0 五个交付物与验收（D3/D5 因 Codex 实测扩围）

| # | 交付物 | 验收（以 spike 已跑通的同名用例为准） |
|---|---|---|
| D1 | 类型迁移 + 迁移 17→20（M1 再到 v23）+ 9 张表 + `ux_turns_active` + 进程登记/残留状态列 | 旧库副本行数/hash 不变；`npx tsc --noEmit` 通过；DDL 单测全绿 |
| D2 | `SessionLockRegistry`（`tryAcquire`/`acquire`/ALS/环检测）+ 显式 `TurnCorrelation` | 并发第二个 run 立即 `SESSION_BUSY`；同节点第二个非终态 turn → `NODE_BUSY`；重入不死锁；归属零错误；P99 < 0.1 ms |
| D3 | 3 个 Normalizer + 最小公共契约 + OpenCode 无工具轨迹降级 + `turn.completed` 完成判定 | 三后端 checkpoint 序列一致：`run.started → message.completed → tool.requested → tool.result → run.completed`；`seq` 连续；Codex 在 `turn.completed` 后 100 ms 内完成，不等迭代器 |
| D4 | 审批三段式 + `argsHash` + fail-closed + pending 重推 | 重复决定只执行 1 次；超时后迟到 allow 不执行；重启重放不自动批准；决定与事件同事务 |
| D5 | `startup-reconciler` + `executing_at` 三阶段 + turn 起始快照 + `stepOutcomes` + 分层进程回收 | 真 SIGKILL 后零悬空 `running`；崩溃窗口五行判定全部命中；`RecoveryPlan` 含 step 级结果；OpenCode 取消后 2 s 残留为 0；Claude 按本轮真实句柄回收（未登记句柄才 `unconfirmed`）；Codex 旧路径不承诺 0 残留但 `residual_risk` 可见；无法证明归属时 kill 调用数 = 0；`aborted` step 全部进 `stepOutcomes` |

## 依赖顺序

```
D1 ──► D2 ──► D3 ──┬──► D4 ──► D5
                  └──（D4 可与 D3 并行）
```

- D1 先行：所有 repository、锁、normalizer 都依赖类型与表。
- D2 先于 D3：normalizer 写事件时要用 `TurnCorrelation` 分配归属并拿锁。
- D3 的完成判定必须在第一个 Codex 用例里就生效，不能留到联调。
- D4 不依赖 D3，可与 D3 并行；但审批行落在 D1 的表上。
- D5 最后：同时依赖 D2 的锁（判定重入/归属）与 D4 的审批行（判定「已批准未执行」）；进程回收按 §6.5 的三层承诺实现（同进程按真实句柄、跨重启只清可证明归属、禁止裸 pid），并入 D5，不单独新增编号。
- 排队（`queueDepth=1`）不在 M0，列为 Phase 2 可选，待产品定调（见架构文档 §13）。

## M1 实际范围（2026-11-05）

M1 只收「成本账本」这一条主线，**产品已定：只记账，不熔断**。界面不得出现「限额」「剩余额度」「超限」「可用额度」等字样；只展示事实分类（已定价 / 缺价 / 未上报 / 历史行未标注）。

### 已交付

| 项 | 结果 |
|---|---|
| `agent_usage` 落库 | 会话 / 图 × 日归属，`turn_id` 可空，`dedupe_key` 幂等 |
| v23 分类列 | `cost_status`（`priced` / `missing_price` / `not_reported`）+ `tokens_reported`（1/0/NULL）；写入点统一派生，历史行不回填 |
| 只读用量视图 | 会话级 + 图按日；无记录 / 价格未知 / 后端未上报 / 历史未标注 分开展示，缺失值不渲染成 0 或 `$0.00` |
| legacy 路径用量 | `onUsage` → 归属 `chat_threads.session_id → graph_id/node_id`；未上报时合成 `source=unknown` 占位，不静默丢 |
| 价格来源 | `settings.agentRuntime.costRates` > 内置价格表（`BIZGRAPH_PRICING_PATH` 可整体覆盖内置表）；未配置的模型回落内置，两层都缺 → `cost_micros=NULL` + `missing_price`；`price_version` 记录命中来源 |
| 旧库升级 | v21 → v23 在**真实构建产物 + 真实 Electron**上验证：行数与关键字段不变、新列 NULL、索引与查询可用、连跑两次幂等。证据见 `docs/architecture/evidence/m1-migration-*` |

### 明确未做（及原因）

| 未做项 | 原因 |
|---|---|
| 排队（`queueDepth=1`） | 产品未定调；M0/M1 保持 `NODE_BUSY` fail-fast，不让用户面对未验证的排队语义 |
| 额度熔断 / 预算三级 | 无真实成本分布，阈值会定错；熔断会中断正在执行的任务，错误代价高。重新评估的触发条件见架构文档 §4.4.1（N 天 / X 金额为明确占位） |
| 长尾 CLI 逐 CLI parser | 各 CLI 没有稳定的结构化工具事件，逐家硬解析会把噪声当事实；当前保留 `file_change_evidence` 合成通道，不伪造逐步事件 |
| `RecoveryPlanner` 完整策略、`WorkspaceLease` worktree、策略编辑器 | M1 剩余项，与账本/迁移独立，先不扩围 |

账本的已知空白（历史不可回填、缺价、失败 turn、legacy 无 `turn_id`、token 不可知、历史分类列 NULL）逐条见架构文档 §4.4.2，不在本文重复。

## 第一个 PR 只改三个文件

1. **`src/shared/types/agent-runtime.ts`（新建）**：把 `spikes/agent-core/src/types.ts` 原样迁入，追加架构文档 §3.2 的补丁（`TurnStatus`、`StepStatus`、`TurnCorrelation`、`ExecutorSessionHandle`、`BackendDriverContract`、`AgentCapabilities` 等）。不要重新手写枚举，避免 TS2304。
2. **`src/main/database.ts`（修改）**：`CURRENT_SCHEMA_VERSION` 17→20（M1 再到 v23）；9 张表进 `TABLE_SCHEMAS`（`agent_sessions` 增加 `executor_pid`/`executor_pgid`/`executor_env_marker`，`agent_steps` 的 `status` 增加 `aborted`）；索引（含 `ux_turns_active ON agent_turns(node_id, branch_key) WHERE status IN ('running','waiting_approval','cancelling')`）进 `INDEX_SQLS`；更新 checksum。不动旧表列。
3. **`src/main/agent/runtime/db/repository.ts`（新建）**：只实现 `insertTurn` / `finishTurn` / `findActiveByNode`，并把唯一索引冲突映射为 `SESSION_BUSY` / `NODE_BUSY`。

配套测试（可放同一 PR）：`src/main/agent/runtime/__tests__/repository.test.ts`，断言「同节点第二条活跃 turn 被拒」「`queued` 不占活跃索引」「旧库副本迁移后行数与 hash 不变」。

验证命令：`npx tsc --noEmit && npx vitest run src/main/agent/runtime/__tests__/repository.test.ts`。

---

## 翻默认（2026-11-05，第六轮 5/5 通过后）

### 默认状态

Kernel 路径**默认开启**，但按后端能力门控：只有 `KERNEL_APPROVAL_CAPABLE_BACKENDS`（当前 `['claude']`）进入 kernel；Codex / OpenCode / 其余后端仍走旧路径，启动日志逐条打印 `[kernel] <adapter>: 旧路径（该后端尚未启用写前审批）`。

| 后端 | 路径 | 写前审批 |
|---|---|---|
| claude-code | kernel | ✅ 强制（PreToolUse → ask → canUseTool → 网关） |
| codex | 旧路径 | ❌ |
| opencode | 旧路径 | ❌ |
| 其他 | 旧路径 | ❌ |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BIZGRAPH_AGENT_KERNEL` | 未设置 = on | 总开关；`0/false/off/no` 全部回旧路径 |
| `BIZGRAPH_AGENT_KERNEL_BACKENDS` | `claude` | **完全指定（替换）**：设置后即为允许进 kernel 的完整集合；未列出的能力后端（如 Claude）同样回退，日志如实写「因白名单未列出而回退」 |
| `BIZGRAPH_AGENT_KERNEL_UNSAFE` | 未设置 | 仅显式 `1` 才允许**未具备审批能力**的后端进 kernel，并记 `degraded` + warn；对已具备审批的后端不产生降级标注 |

### 启动日志 reason（三类不得混写）

| 场景 | 日志 |
|---|---|
| 总开关关闭 | `[kernel] <adapter>: 旧路径（BIZGRAPH_AGENT_KERNEL=0 总开关关闭）` |
| 被完全指定列表排除 | `[kernel] <adapter>: 旧路径（因 BIZGRAPH_AGENT_KERNEL_BACKENDS 未列出而回退；该变量为完全指定…）` |
| 后端无写前审批能力 | `[kernel] <adapter>: 旧路径（该后端尚未启用写前审批）` |

### 回退

1. 代码：`isAgentKernelEnabled()` 改 `return false` → 重新构建（一行回退）。
2. 运行时：`BIZGRAPH_AGENT_KERNEL=0` 重启。

回退后**新会话**直接走旧路径；**既有会话**能续则续（`agent_sessions` + 可信原生 id），不能续（旧路径自建会话从未持久化原生 id）则明确显示「原会话不可续接，新建会话可继续」，并解除该 thread 的绑定，下次发送即新建。不会再出现「所有会话都报 AGENT_SESSION_NOT_FOUND」。回归测试见 `agent-manager-restore.test.ts` 的 `BIZGRAPH_AGENT_KERNEL=0 旧路径的会话恢复` 组。

### 已知风险

- codex/opencode 默认不做写前审批；不得对外宣称已受保护。
- `UNSAFE=1` 是降级运行，仅可用于排查，不能进默认发布。
- Bash 分级：Kernel 路径由宿主 `bash-readonly.ts` 两档策略决定；旧路径仍由 SDK/CLI 决定。写类工具已通过强制 ask 封堵用户 allow 规则绕过。
- 内存门限：macOS 只保留 64MB 硬下限（`os.freemem()` 不含可回收页），其他平台按总内存 2% + 128MB–2GB clamp，避免 512MB 绝对阈值误伤。

### 验收

`npx tsc --noEmit` / `npx eslint src --ext ts,tsx --max-warnings 0` / `npx vite build` / `npx vitest run` 全部分项通过（vitest 既有 better-sqlite3 ABI 失败单列）。
