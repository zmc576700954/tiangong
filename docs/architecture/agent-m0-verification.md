# Agent 体系 M0 施工成果 · 独立复核报告

> 复核者：独立复核会话（非实施者）。复核日期：2026-11-04。
> 复核对象：`docs/architecture/agent-m0-report.md` 所声明的 D1–D5 成果。
> 权威口径：`docs/architecture/agent-architecture.md`（§4 表结构、§5 状态机/恢复、§6.5 进程回收、§8 完成判定、M0 验收 V1–V7）、`docs/architecture/agent-decisions.md`（D-A–D-E、C1–C7）。

## 0. 结论先行

**M0 不能按“完成”整体验收。** 建议改为“条件验收”：

| 交付项 | 复核判定 | 说明 |
|---|---|---|
| D1 表结构 | **通过** | 9 张表、v18、扩展列、`ux_turns_active` 均真实存在；表结构本身无问题（step 主键跨轮覆盖缺陷见 P1-2） |
| D2 串行锁 | **部分成立** | Runtime 路径的 session/node 锁语义正确；`AgentManager` 旧路径用 `sessionId` 当 owner，同会话并发**根本不互斥**（实测） |
| D3 归一化/完成判定 | **部分成立** | 三后端共用 envelope；Codex 以 `turn.completed` 判完成成立；但 `unknown` 未落库、Claude 首块 delta/completed 重复、事件非增量落库 |
| D4 审批 | **部分完成（实施报告已自认）** | 后端/IPC/preload/argsHash/超时/幂等/重放均真实存在；Renderer 无 runtime 审批 UI；但存在**旧的 post-hoc“确认”弹窗**，属于“看起来有审批其实没有” |
| D5 恢复 | **部分成立，不可标“完成”** | DB 层的 `orphaned/aborted` 对账成立；但 `RecoveryPlan` **没有** step 级 `stepOutcomes`、`test_disposition` 从未写入、五行判定未实现；启动“杀残留”实际只计数不杀；pid/pgid/env marker 全链路从未落库 |

**一句话结论：** 表结构与 IO 骨架是真的；但“进程回收 / 启动恢复 / step 归因”三处在真实并发与多轮场景会产生错误行为，必须先修再进 M1。

### 复核方式标记

- **[实测]**：我亲自运行命令、进程、临时探针得到的结果。
- **[代码]**：我读了代码并确认逻辑，未在真实 Electron/真实 CLI 会话中跑到。
- **[推断]**：依赖 SDK/运行时行为，代码可见但未真机复现。
- **[未核实]**：本轮没有条件验证。

---

## 1. 逐项核实

### 1.1 表结构（D1）

| 声明 | 实际 | 证据 | 判定 |
|---|---|---|---|
| 9 张表 | 9 张：runs/sessions/turns/steps/events/approvals/artifacts/usage/snapshots | [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L25-L212) | 成立 [代码] |
| schema v18 | `CURRENT_SCHEMA_VERSION = 18` | [database.ts](file:///Users/zhumingchen/tiangong/src/main/database.ts#L356) | 成立 [代码] |
| `executor_pid/pgid/env_marker` | 三列均存在 | [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L53-L55) | 成立 [代码] |
| `agent_steps.status` 含 `aborted` | CHECK 含 `aborted` 与 `unknown` | [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L112) | 成立 [代码] |
| `agent_usage` 含 `graph_id/day_key/cost_micros` | 三列均存在 | [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L197-L203) | 成立 [代码] |
| `ux_turns_active` 至多一个非终态 turn、同节点不重复 | `UNIQUE(node_id, branch_key) WHERE status IN ('running','waiting_approval','cancelling')` | [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L235-L236) | 成立 [代码] |
| 与 `queued` 占位不冲突 | `queued` 不在索引谓词内；running+queued 可共存，第二个 running 被拒 | 我的探针 C [实测] | 成立 [实测] |

补充说明：
- 设计 §4 明确“M0 只设 `ux_turns_active`，`ux_turns_queue` 是 Phase 2 可选”，因此未建 queue 索引**不构成缺陷**（D-A 合规）。
- 设计 §4 要求“不设外键”，实际 DDL 无 `REFERENCES`，合规。
- 迁移层面：生产 `database.ts` 已把 `AGENT_TABLE_SCHEMAS` 并入迁移表并在 v18 触发；但仓库里的 `db-schema.test.ts` 直接调用 `applyAgentSchema`，**没有**覆盖真实 v17→v18 迁移路径。[代码，未在真实旧库上跑]

### 1.2 串行锁（D2）

| 声明 | 实际 | 证据 | 判定 |
|---|---|---|---|
| 显式上下文传参，非 ALS 栈顶推断 | `LockContext {held:Set}` 显式传入 | [session-lock.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/locks/session-lock.ts) | 成立 [代码] |
| `tryAcquire` / `acquire` 拆分 | 两个方法独立存在 | 同上 | 成立 [代码] |
| 重入不死锁 | 同 ctx 同 key 计数递增；测试覆盖 | `session-lock.test.ts` 通过 [实测] | 成立 [实测] |
| Runtime 同节点并发返回 `NODE_BUSY` | run-node 测试覆盖 | runtime 9 文件/53 用例全绿 [实测] | 成立 [实测] |
| Runtime 同会话并发返回 `SESSION_BUSY` | run-node 测试覆盖 | 同上 | 成立 [实测] |
| **旧路径也受锁保护** | **`AgentManager.sendCommand` 以 `sessionId` 作为 owner** | [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L582) | **不成立 [实测]** |

**探针 A（实测失败）**：连续两次
`tryAcquire(sessionLockKey('sess-x'), 'sess-x', ROOT_LOCK_CONTEXT)`
返回 `first=true, second=true`，快照为 `{"key":"session:sess-x","turnId":"sess-x","count":2}`。
原因：第二把锁看到 `existing.turnId === turnId`（都等于 `sessionId`），被当成“同 owner 重入”而放行。
影响：旧 `agent:send` 路径对同一会话的并发调用**不会**触发 `SESSION_BUSY`，D2 对旧路径的承诺未兑现。Runtime 路径不受影响（owner 用的是 per-request idempotency key）。

另有一个未验证风险 [推断]：runtime 的 session 锁 key 用 `adapterSessionId`，旧路径用 `AgentManager.sessionId`；若两者在真实调用中不相等，跨路径互斥也会失效。

### 1.3 归一化与完成判定（D3）

| 声明 | 实际 | 证据 | 判定 |
|---|---|---|---|
| 三后端走同一 `AgentEventEnvelope` | Claude/Codex/OpenCode 均经 `EventSink` 产出同一 envelope；长尾合成也构造同型 | [sink.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/normalize/sink.ts)、三个 normalizer | 成立 [代码] |
| Codex 以 `turn.completed` 判完成，不靠迭代器结束 | adapter 收到 `turn.completed` 后 `break`；normalizer `finish()` 据此发 `run.completed` | [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts)、[normalize/codex.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/normalize/codex.ts) | 成立 [代码 + 单测] |
| 中断后 item 标 `aborted/unknown` | `aborted` 分支成立；**无 `turn.completed` 时 `closeOpenItems('unknown')` 发出的是 `tool.failed`**，DB 最终是 `failed`，`unknown` 状态从未落库 | normalizer `finish()` + `syncStepFromEvent` 映射 | **部分成立 [代码]** |
| 三后端归一化序列一致 | 测试只对 OpenCode 断言“canonical shape”；Claude 首个 text block **同时发 `message.delta` 与 `message.completed`（同一文本）** | [claude.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/normalize/claude.ts)、`normalizers.test.ts` | **部分/未证实 [代码]** |
| 事件落库 | 所有归一化事件在 `sendCommand` **返回后**一次性 `record()`，不是逐事件落库 | [adapter-driver.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L99-L133)、[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L195-L199) | **不成立（非增量）[代码]** |

补充：
- 事件批量落库意味着 turn 中途崩溃会丢掉全部 backend 事件，与“最后一个已持久化事件”的恢复承诺不符。
- `onEvent` 广播的 `seq` 被替换为 run 级序号，而 `NormalizedEventEnvelope.seq` 的契约是 turn 内连续；同一 run 的第二个 turn 会看到跳号。[代码]
- Claude `finalText` 只保留最后一个 text block，前一个 block 的文本不会进入 `run.completed.summary`（最终文本仍可从 message 事件重建）。[代码]

### 1.4 审批（D4）

| 声明 | 实际 | 证据 | 判定 |
|---|---|---|---|
| IPC 三通道 main 侧接线 | `resolveApproval/getPendingApprovals` 用 `typedHandle`；两个事件通道通过 `broadcastToWindows('agent:onApprovalRequest'/'agent:onApprovalResolved')` 接线 | [ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L38-L42)、[ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L288-L289) | 成立 [代码] |
| 三通道进 preload 白名单 | invoke 通道在 `exposedChannels`；两个事件通道有 `onApprovalRequest` / `onApprovalResolved` 包装 | [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts) | 成立 [代码] |
| `argsHash` 参与匹配 | 请求时 `hashArgs(toolName,args)` 写库，决策时 `input.argsHash !== row.args_hash` 直接拒绝 | [gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L88-L146) | 成立 [代码] |
| 超时 | 交互 120s / 无人值守 30s，超时即 deny | `INTERACTIVE_TIMEOUT_MS/UNATTENDED_TIMEOUT_MS` | 成立 [代码 + 单测] |
| 幂等 | 已决行再决直接返回既有结果 | gateway `decide` | 成立 [代码 + 单测] |
| 重启重放 fail-closed | 重启后重新推送并重新计时，超时仍 deny | `replayPending` | 成立 [代码 + 单测] |
| Renderer 无审批 UI | `src/renderer` 对 `onApprovalRequest/resolveApproval/getPendingApprovals` **零引用** | 我的 grep [实测] | 成立 [实测] |
| 不存在“看起来有审批其实没有”的界面 | **存在 `ConfirmationDialog`**：在 `file_change`（PostToolUse，文件已改）之后弹出“确认/拒绝”，拒绝只是不把 toolCall 追加到聊天记录，**不能撤销已发生的文件修改** | [ConfirmationDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ConfirmationDialog.tsx)、[useAgentOutputListener.ts](file:///Users/zhumingchen/tiangong/src/renderer/hooks/useAgentOutputListener.ts#L118-L139) | **不成立 [实测 + 代码]** |

关键后果 [推断，必须真机验证]：`installClaudeApprovalHooks` 在 `permissionMode: 'acceptEdits'`（非透明模式）或 `'default'`（透明模式）下都会安装 `canUseTool`。由于 renderer 没有任何审批 UI，Claude 每个未被自动放行的工具调用都会等满 120s 后 fail-closed 拒绝。若 SDK 确实调用 `canUseTool`，**runNode + claude-code 的端到端任务会被逐工具卡死**，不只是“少一个 UI”。实施报告 §9.3 已承认未在真机跑完一轮 Claude。

其他缺口：
- `decide` 不校验 `expires_at`；若计时器回调滞后（休眠/主线程阻塞），迟到的 `allow` 仍会被接受。[代码，低概率]
- 重启后 pending 审批被重放，但原 waiter 已不存在；用户批准后不会驱动任何工具执行。对 M1 UI 是必须处理的语义。[代码]
- `sweepExpired` 未在生产路径定时调用（仅测试直接调用）；依赖每行 timer，基本可用但属死代码。[代码]

### 1.5 恢复（D5）

| 声明 | 实际 | 证据 | 判定 |
|---|---|---|---|
| 启动对账实现 | `planRecovery → applyRecoveryPlan → assertNoDangling → replayPending` | [runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L374-L413) | 成立 [代码 + 单测] |
| 崩溃后不留悬空 `running` | 非终态 turn 置 `orphaned`，开放 step 置 `aborted`；单测覆盖 | `recovery.test.ts` [实测] | DB 层成立 [实测]，但仅模拟行，**未在真实 SIGKILL 下验证** |
| `RecoveryPlan` 给到 step 级 `stepOutcomes` | **类型里没有该字段**，只有 run/turn/session/action/reason | [agent-runtime.ts](file:///Users/zhumingchen/tiangong/src/shared/types/agent-runtime.ts#L237-L248) | **不成立 [代码]** |
| `agent_steps.test_disposition` | 列存在，但**全仓库无任何写入**；V2 要求的五行判定（hash 对比/unknown-needs-rerun/needs-human）未实现 | 我的 grep [实测] | **不成立 [实测 + 代码]** |
| 启动“杀残留” | `orphaned` 会话的 `scanResidual` 结果**只累加计数，不调用 kill**；`active` 会话只按 pid/pgid 杀 | [runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L376-L399) | **不成立 [代码]** |
| pid/pgid/env marker 落库并可恢复 | `agent_sessions.executor_pid/pgid/env_marker` 从未被写入；`updateSessionProcess` 无调用者；spawn 时也没有注入 turn 级 env | 我的 grep [实测] | **不成立 [实测 + 代码]** |

结论：DB 的“无悬空 running”成立；OS 层的“孤儿进程回收”在重启后**事实不可用**。报告 §5 的“启动对账 → 杀残留”应降级为“只对账 DB”。

### 1.6 进程回收（复核项 6，重点）

**结论：会误杀。两个会话同时跑同一厂商 CLI 时，先结束的一方会杀掉另一方仍在跑的 CLI 进程。[实测复现]**

机制（[reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L101-L117)、[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L331-L335)）：

1. 每个 turn 开始时 `captureBaseline(turn.id)` 记录当时全部 PID。
2. 判定候选进程：`pid 未在 baseline` 且 `是主进程后代` 且 `command 命中 vendor 正则`（claude/codex/opencode）或 `含 marker`。
3. **`marker` 用的是 `turn.id`，但生产 spawn 从未把 turn id 注入 argv/env**；`registeredPids/Pgids` 也只在测试里使用。因此实际唯一生效的线索是 **vendor 正则**。
4. 关键：`reap` 不只在取消时调用，**每个 turn 正常完成后也会调用**（runtime L331）。

**探针 B（实测）**：

```
captureBaseline('turn-A')
spawn node ... codex turn-A   (turn A 自己的进程)
spawn node ... codex turn-B   (模拟另一会话，在 A baseline 之后启动)
reap('turn-A', {marker:'turn-A', commandPattern:/\bcodex\b/i, descendantsOnly:true})
→ {"discovered":2,"killed":2,"killedGroups":[A,B],"residual":0}
→ A alive=false, B alive=false
```

即：turn A 正常结束时，把 turn B 的 codex 进程一起杀了。M0 的节点锁只保证“同一 node+branch 串行”，不同节点并发是允许的，因此这是可触发的真实场景。报告 §9.6 把它写成“风险”，但实际是**默认路径的确定性行为**，且影响面比“取消路径”大。

附加风险：
- 长尾 executor 的 `executorPattern` 回退为 `/.*/`（[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L586)）。M0 未注册长尾驱动，暂未触发；一旦 M1 启用，等于“杀主进程所有后代”。
- 报告声称“取消后 2s 内 marker 进程数 0”的验收，在真实生产路径下**不可成立**：marker 从未被注入，`residualCount` 永远为 0，测试通过是空验。

### 1.7 双写兼容

| 声明 | 实际 | 判定 |
|---|---|---|
| 旧 `AgentOutput` 路径行为不变 | Claude/OpenCode/Base 的 diff 为纯增量（新增 raw event / hooks），未改旧 emit | 成立 [代码 + 16 文件/206 用例通过] |
| Codex 旧路径不变 | 由 `run()` 切为 `runStreamed()`，**删除了 `finalResponse` 的额外广播**，同时删除了对应测试断言 | **部分成立 [代码 + diff]** |
| 无悄悄改语义 | `AgentManager.sendCommand` 新增外层锁，旧路径开始可能抛 `SessionBusyError`（设计上合理；但因 owner=sessionId 的 bug，同会话并发实际不抛） | 部分成立 [实测] |

Codex 的 `finalResponse` 变化是**有意且可解释的**（C4 明确不承诺 token 级；最终文本由 `agent_message` item 提供）。但它确实改变了旧路径一次输出的语义，报告表格里的“未改语义”表述过强。

### 1.8 测试与基线

我亲自运行的结果：

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | 退出码 0，无输出 |
| `npm run lint` | `✖ 24 problems (24 errors)`，全部位于 `spikes/`（spike 代码不在 M0 交付） |
| `npx eslint src --ext .ts,.tsx` | 退出码 0，src 无错误 |
| `npx vitest run` | **992 个测试文件，26 个失败；3112 用例，173 失败，2849 通过** |
| `npx vitest run src/main/agent/runtime/__tests__` | 9 文件 / 53 用例 **全绿** |
| `npx vitest run src/main/adapters/__tests__` + `codex.test.ts` | 16 文件 / 206 用例 **全绿** |

> 探针 A–D 为复核期间临时写入的 characterization test，运行取证后已删除，仓库中未留下新增测试文件。

**“173 个失败全是 better-sqlite3 ABI”核实结论：成立。**
- 18 个带断言的失败文件：全部失败消息包含 `NODE_MODULE_VERSION`；无一条非 ABI 断言失败。
- 8 个“套件级失败、无断言文本”的文件，逐个单独复跑，全部复现为 `NODE_MODULE_VERSION`（`database-migration`、`hybrid-search`、`memory-store`、`graph-repository-clone`、`repositories/node-repository`、`yjs-hierarchy-guard`、`graph-service-sort-index`、`hierarchy-service`）。
- 报告中“基线 27 文件/174 用例 → 现在 26/173”的**基线数字无法在不回退改动的情况下独立复现**（需要 stash 含未跟踪文件），我未验证；当前数字与报告一致。

**`codex.test.ts` 改动判断：**
- 新增 `runStreamed` mock（thread/turn/item/turn.completed 事件流）是合理的，和真实 SDK 的流式形状一致。
- 删除的 `finalResponse` 广播断言（`'All done'`）造成一个小覆盖缺口：现在没有测试证明“当最终答案只从 `finalResponse` 出现、而没有对应 `agent_message` item 时，文本仍能到达 UI”。真实 Codex 通常会有 `agent_message` item，因此风险低；但建议补一条“流式路径最终文本只出现一次”的断言，防止未来重复/丢失两边都无覆盖。

### 1.9 改动范围

| 项 | 结果 |
|---|---|
| 是否超 M0 的顺手改动 | 未发现；改动集中在 schema/runtime/locks/approval/recovery/reaper/normalize、适配器 raw 事件、IPC/preload、settings/types、codex 测试 |
| 是否动 `spikes/` 断言 | **无证据**。spike 测试 mtime 为 18:12–18:16，M0 代码 mtime 为 20:05+；但 `spikes/` 整体未跟踪，git 无法证明。存在 `spikes/spikes/agent-core/.artifacts/sabotage` 嵌套空目录（18:15 生成，旧 sabotage 脚本路径 bug），与 M0 无关 |
| 是否 `git commit` | **无**。最新提交仍是 `2c00453`；工作区为未提交改动 |
| 旧路径 12 个适配器 | 仅改动 4 个（base/claude/codex/opencode），其余未动 |

---

## 2. 新发现的问题（按严重度）

> 每条标注“代码确认 / 实测 / 推断”。**P0 = 必须修复后才能进 M1。**

### P0-1 进程回收跨会话误杀（实测）

- **实测**：探针 B，`discovered=2, killed=2`，另一会话的 codex 进程被杀。
- **代码确认**：`reap` 在正常完成路径也执行（runtime L331），vendor 正则匹配所有同厂商进程，baseline 只保护“在 A 开始前已存在”的进程。
- **最小修复建议**：
  1. 只允许杀“本 turn 登记过的 pid/pgid”；删除 pattern + baseline + descendants 的启发式发现。
  2. 在 spawn 时注入 `BIZGRAPH_TURN_ID`（并确保 `buildSafeEnv` 不剥离该前缀），把它写进 `agent_sessions.executor_env_marker`。
  3. 通过 SDK 可用的 PID 暴露或自建进程组包装来登记 pid/pgid，写回 `agent_sessions`。
  4. 在拿到可靠句柄前，**正常完成路径不要 reap**；只在取消时按已登记句柄回收。
  5. 增加“两会话并发同厂商”的回归测试（当前测试只覆盖 marker/registered 的自洽路径）。

### P0-2 启动残留回收实际不杀（代码确认）

- `scanResidual` 返回的进程只被计数，没有任何 kill 调用（runtime L376-L380）。
- `executor_pid/pgid/env_marker` 在生产路径从未写入；`updateSessionProcess` 零调用者；`adapter-driver` 不使用 `context.envMarker`。
- 结果：重启后 OS 层孤儿进程仍在，报告中的“启动对账 → 杀残留”不成立。
- 修复：与 P0-1 一并做“turn 级进程登记 + spawn 时落库 + 启动按登记杀”；`scanResidual` 命中后必须显式 kill 并记录。

### P1-1 D5 恢复口径缺失（代码确认）

- `RecoveryPlan` 无 `stepOutcomes`；`test_disposition` 从不写；V2 要求的“五行判定全部命中”未实现。
- 修复：在 `planRecovery` 产出 step 级结果（至少 `unknown-needs-rerun` / `needs-human`），写入 `test_disposition`；补 `base_hash/result_hash` 快照对比；补真实 SIGKILL 集成用例。

### P1-2 step 主键跨 turn 覆盖（实测）

- **实测**：探针 D，`upsertStep('step-codex-1', turn-1)` 后再 `upsertStep('step-codex-1', turn-2)` → `turn-1` 行状态被改成 `done`，`turn-2` 查不到任何 step。
- 代码确认：`agent_steps.id` 是全局主键；Codex/OpenCode 的 step id 是 `step-codex-${n}` / `step-oc-${n}`，每 turn 从 1 重新计数；`upsertStep` 冲突更新不修改 `turn_id/seq`。
- 影响：同一 run 的第二个 Codex/OpenCode turn 会污染第一个 turn 的审计数据；审批 `args_hash` 也可能被覆盖。
- 修复：step id 用 `${turnId}:${localId}`（或 `PRIMARY KEY(turn_id,id)` 复合键），并补“多 turn 同名 step”测试。

### P1-3 D2 旧路径自锁失效（实测）

- 探针 A：同一会话连续两次 `tryAcquire` 均成功，count=2。
- 修复：`AgentManager` 的 owner 改成“每次 send 的唯一 id”（或 requestId），不要用 `sessionId`；补同会话并发测试。

### P1-4 无审批 UI 下的 Claude 端到端可用性（推断）

- 代码确认：`canUseTool` 总是安装；无 renderer 订阅；超时 120s 后 deny。
- 推断：Claude 工具调用会被逐次卡 120s 再拒，runNode 实际不可用。
- 必须先真机跑一轮 Claude（含 Bash/Edit）确认 SDK 是否调用 `canUseTool`；在补最小审批 UI 或明确的自动放行策略之前，不应把 D4 的“pre-exec 审批”当作可用能力。

### P2 级

- **事件非增量落库**：归一化事件在 turn 结束后才 append；崩溃丢失全部 backend 事件（代码确认）。
- **`onEvent.seq` 语义不一致**：广播 run 级 seq，类型契约是 turn 级（代码确认）。
- **Claude 首块 delta+completed 重复**：消费者按 delta 拼接会重复首段文本；“三后端同形”未被测试（代码确认）。
- **C2 `unknown` 未落库**：无 `turn.completed` 时 `tool.failed` → step `failed`，`unknown` 状态从未使用（代码确认）。
- **欺骗性 ConfirmationDialog**：post-hoc 确认，拒绝不能撤销文件修改；与新的 approval 语义并存会误导用户（实测 + 代码确认）。
- **Codex health 缓存失效**：`new CodexHealthChecker()` 放在每 turn 执行路径，缓存不跨 turn；每轮都跑 `codex doctor`（代码确认）。
- **Codex `finalResponse` 广播被删**：旧路径一次输出语义变化；测试缺口较小但应补断言（代码确认）。

### P3 级

- `decide` 不校验 `expires_at`，计时器滞后时迟到 allow 可被接受（代码确认）。
- `executorPattern` 默认 `/.*/`，长尾驱动启用后是灾难（代码确认，M0 未触发）。
- `sweepExpired` 在生产路径未定时调用（死代码）。
- 成本准入是 check-then-act，无预留/事务，多节点并发可超额（代码确认，D-D 范围外）。

---

## 3. 被推翻 / 需要降级的声明

| 报告声明 | 复核结论 | 依据 |
|---|---|---|
| D2 完成 | **部分成立**：Runtime 路径成立，旧路径同会话不互斥 | 探针 A |
| D3 旧 `AgentOutput` 路径未改语义 | **部分成立**：Codex `finalResponse` 广播被移除 | diff + codex 测试 |
| D3 三后端“同一 canonical shape” | **未证实**：只测了 OpenCode；Claude 首块重复 | normalizers 测试 |
| D3 C2 标 `aborted/unknown` | **部分成立**：`aborted` 成立，`unknown` 未落库 | 代码 |
| D5 完成（有已知边界） | **部分成立，不可标完成**：无 stepOutcomes / test_disposition / 五行；启动杀残留不杀；真实 SIGKILL 未验 | 代码 + grep + 单测范围 |
| “取消后残留 0” | **生产路径下不可成立**：marker/registered 只在测试里存在 | 代码 |
| Renderer 不存在伪装成审批的界面 | **不成立**：`ConfirmationDialog` 是 post-hoc“确认” | 代码 + 截图级组件阅读 |
| 进程回收风险仅在取消路径 | **不成立**：正常完成也 reap | runtime L331 + 探针 B |

以下声明**成立**，不推翻：D1 全部表结构；Runtime 锁语义；Codex `turn.completed` 完成判定；审批后端/IPC/preload/argsHash/超时/幂等/重放；173 个失败全 ABI；无 commit、无越界改动。

---

## 4. 建议的下一步（进 M1 前必须完成）

1. **重做进程回收（P0）**
   - spawn 时注入 turn 级 env marker 并落库 pid/pgid；
   - 只按登记句柄杀；删除 pattern/baseline 启发式；
   - 正常完成不 reap；
   - 增加两会话并发同厂商回归测试。
2. **补齐恢复口径（P0/P1）**
   - `RecoveryPlan` 增加 step 级 `stepOutcomes`；
   - 写 `test_disposition`，实现 V2 五行判定与 hash 快照；
   - 启动残留扫描命中后必须 kill；
   - 事件改为增量落库（至少 `tool.requested/result/approval/run.completed`）；
   - 用真实子进程 `SIGKILL` 做集成测试。
3. **修复 step 归因（P1）**：step id 加 turn 命名空间，补多 turn 测试。
4. **修复旧锁（P1）**：owner 改为 per-send 唯一 id，补同会话并发测试。
5. **D4 收口**：先真机验证 Claude `canUseTool` 行为；补最小审批 UI（或显式 auto-allow 策略）；同时把 `ConfirmationDialog` 改名为“事后提示”或接入真正的前置审批，消除欺骗性。
6. **归一化修正**：去掉 Claude 重复 delta；`unknown` 落到 `unknown`；补三后端同形测试。
7. **测试基建**：把 `better-sqlite3` ABI 问题修掉或隔离，否则每次全量测试都要人工排除 173 个噪声。

---

## 5. 复核边界（未验证事项）

- 未在真实 Claude Code CLI 上跑一轮带工具的 `runNode`（P1-4 为推断）。
- 未对真实 Electron 进程做 `kill -9` 后的启动恢复（D5 的 OS 层结论来自代码 + 逻辑）。
- 未在真实用户旧库上跑 v17→v18 迁移（只验证了 DDL 与迁移代码）。
- 未独立复现报告中的测试基线（27 文件/174 用例）；当前实测为 26 文件/173 用例。

---

# 第二轮复核（2026-11-04 晚）

> 复核对象：[agent-m0-report.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-m0-report.md) §6.5「复核修复记录」。
> 原则与第一轮相同：**只认实测，不认声明**。本章节追加，不改写第一轮结论。

## 6. 结论先行（第二轮）

**M0 仍不可验收，需再修。** 第一轮点名的 5 个 P0/P1 缺陷中，4 个确有修复（P0-1 跨会话误杀、P0-3 step 主键、P1-4 锁 owner、P1-5 unknown、P1-6 Claude 文本重复、P1-7 弹窗语义）；但 P0-2 的“跨重启回收”在 macOS 上实际命中率为 0，且第二轮的修法**新引入一个可误杀任意进程的安全缺陷**（见 P0-A）。这属于“修一个、埋一个”，不能带着进 M1。

| 重点项 | 判定 | 依据类型 |
|---|---|---|
| P0-1 两会话同厂商并发，A 完成/取消/异常时 B 是否受影响 | **通过**（B 三场景均存活） | 实测 |
| P0-2 跨重启 `reclaimResidual(marker)` 命中率 | **未通过**（env-only marker 命中 0） | 实测 |
| P0-2 stepOutcomes / `test_disposition` 落库 | **通过** | 实测（测试全绿）+ 代码 |
| P0-3 连续两轮同节点 step 行不覆盖 | **通过** | 实测 |
| P1-4 同会话第二个并发必须 `SESSION_BUSY` | **通过** | 实测 |
| P1-5 `unknown` 不再落成 `failed` | **通过** | 实测 |
| P1-6 Claude 首块文本事件恰好 1 条 | **通过** | 实测 |
| P1-7 `ConfirmationDialog` 不再暗示执行前拦截 | **通过** | 代码 + i18n |
| P1-7 `ApprovalRequestDialog` 只在写前拦截时展示 | **通过**（但有同屏共存路径，见 §10） | 代码 |
| 回归面：旧 `AgentOutput` / 12 适配器 | **未通过（Codex 旧路径语义已变）** | diff + 测试改写 |
| 回归面：`spikes/` 断言未被改 | **通过（间接）** | mtime + 第一轮基线 |
| 回归面：schema v19 迁移可重复执行 | **通过** | 实测（同一路径跑两次） |
| tsc / lint / 全量 vitest | **通过**（失败仍全是 ABI 噪声） | 实测 |

---

## 7. 我跑的命令与结果

### 7.1 静态与全量回归

```bash
npx tsc --noEmit                      # exit 0
npx eslint src --ext ts,tsx --max-warnings 0   # exit 0
npx vitest run                        # exit 1（仅 ABI 噪声）
```

全量 vitest 结果：`Test Files 26 failed | 228 passed (254)`，`Tests 173 failed | 2857 passed | 90 skipped (3120)`。失败归因统计（去 ANSI 后）：

- `NODE_MODULE_VERSION 130 → 115`（根 `better-sqlite3` 为 Electron ABI）：95 个错误块；
- 由 init 失败派生的 `Cannot read properties of undefined (reading 'close')`：5 个；
- `AssertionError`：**0**。

即：**没有新增业务断言失败**，173 个失败与第一轮基线同源。

Agent 相关定向回归（run-node / reaper / recovery / normalizers / approval / agent-manager / 三适配器）：

```bash
npx vitest run src/main/agent/runtime/__tests__ src/main/__tests__/agent-manager.test.ts \
  src/main/__tests__/codex.test.ts src/main/__tests__/claude-code.test.ts src/main/__tests__/opencode.test.ts
# Test Files 13 passed (13) / Tests 141 passed (141)
```

### 7.2 自建探针（跑完已删除，未留源码）

> 探针均为临时文件，取证后已从 `src/main/agent/runtime/__tests__/zz-round2-probe*.test.ts` 删除，不在交付物内。

| 探针 | 场景 | 实测结果 |
|---|---|---|
| A | 两会话同厂商并发，A **正常完成** | A 子进程存活、B 子进程存活；B 事件继续增长 |
| B | A **取消** | A 子进程被杀、B 存活；`residualCount(A marker)=0` |
| C | A **异常退出**（driver throw） | A 子进程**仍存活**、B 存活（B 不受影响，但 A 自身泄漏） |
| E | 重启后按 env marker 扫描 | 只带 `BIZGRAPH_TURN_MARKER` 的子进程：`scanResidual=0`；把 marker 放进 argv 才 `=1` |
| F | 连续两轮同节点 | 产生两条独立行 `turn-1:step-codex-1`、`turn-2:step-codex-1`；turn-1 仍 `running`，内容不串 |
| G | schema v19 迁移跑两次 | 第一次/第二次均无异常；9 张表 + `ux_agent_turns_active`、`ux_agent_steps_turn_id` 稳定存在 |
| H | 重启时按“落库 pid”回收 | **杀死了与本应用无关的进程**（详见 P0-A） |

探针 H 细节：造一个无任何 marker 的独立子进程，把它的 pid 写进 `agent_sessions.executor_pid`（模拟 PID 在崩溃窗口内被系统复用），再调用 `runtime.reconcileOnStartup()`。日志为
`startup reclaim: marker=none pids=19618 groups=-`，随后该进程 `alive=false`。

---

## 8. P0-1 重攻：A 的三种结束方式下 B 是否受影响

**结论：B 不受影响，第一轮的跨会话误杀已修复。** 三种时序均实测（探针 A/B/C）：

1. **A 正常完成**：`finally` 只 `reaper.forget(turn.id)`，不再全量 reap；B 的 pid 不在 A 的登记表，`discover` 也不会用厂商正则认领 → B 存活。
2. **A 取消**：`cancelTurn` 只按 `turnId` 登记 + 该 session 持久化的 pid/pgid/marker 回收；A 死、B 活；`residualCount(A marker)=0`。
3. **A 异常退出**：不 reap，B 活。

**但有两个新窗口，必须记录：**

- **窗口 1（自身泄漏）**：异常退出时 A 自己 spawn 的子进程不会被回收（探针 C：A 仍存活）。这对“取消后残留为 0”的承诺是反例；`finally` 只有在 `finalStatus !== 'completed'` 时才 `abortOpenSteps`，并不覆盖“driver 抛错但子进程还在”的情况。建议：异常退出路径至少 `reap` 本轮**已登记**的 pid/pgid（这与“正常完成不 reap”并不冲突）。
- **窗口 2（陈旧 pid）**：[repository.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L285-L300) 的 `COALESCE` 使 `executor_pid/pgid` 在后续 turn 永远不被清空。于是：
  - 同会话第 2 轮 `cancelTurn` 会拿第 1 轮的 pid 去杀；
  - 重启时 [runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L400-L411) 会拿旧 pid 直接杀。
  两者都没有“这个 pid 现在还是不是我的”校验。macOS 崩溃窗口内 PID 复用完全可能，探针 H 已证明会误杀无关进程。

时序（窗口 2 的具体触发条件）：
`turn-1 登记 pid=P → 正常完成，只 forget，DB 仍留 P → 进程退出 → 系统把 P 复用于任意进程 Q → 应用重启或 turn-2 取消 → killRegistered([P]) → Q 被 SIGTERM/SIGKILL`。

判定：**P0-1 的“误杀另一个会话”已通过；“不误杀无关进程”未通过**（新 P0-A）。

---

## 9. P0-2 恢复承诺的真实性

### 9.1 实测命中率

- [reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L161-L164) 的 `scanResidual(marker)` 只匹配 `ps` 的 `command` 字段；macOS 的 `ps -axo command` **不含环境变量**。
- 三个后端的 marker 都只进 env：Claude/Codex 走 `buildSessionEnv`，OpenCode 只 `emitProcessSpawn` 上报 pid（无 marker）。
- 探针 E：env-only 子进程 `scanResidual=0`；仅把 marker 放进 argv 才 `=1`。
- 施工方的 `startup reclaim kills residual ... (P0-2)` 用例之所以能过，是因为 [run-node.test.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/__tests__/run-node.test.ts#L55-L63) 把 marker 作为**第三个命令行参数**传给子进程，而不是只放在 env。
- 报告 §6.5“未验证项”自己也承认这一点，但表格仍把 P0-2 记为“完成（有已知边界）”。

**实测结论：生产形态下（marker 仅在 env），macOS 跨重启 `reclaimResidual(marker)` 命中率 = 0。** 在 Windows/Linux 的 `/proc/<pid>/environ` 下可能可读，但当前只验证了 macOS。

### 9.2 真正会在启动时“杀东西”的是不安全的那条路径

[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L403-L411) 在 marker 为 `none` 时依然执行 `killRegistered(persistedPid, persistedPgid)`；[reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L189-L209) 不做任何身份校验（无命令、无启动时间、无父进程校验）。这直接违反设计文档 [agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L615-L619) 第 3 条“归属无法确认时只告警不杀”。

### 9.3 设计文档措辞是否过度承诺

**是，属于过度承诺。** 至少这三句需要改：

| 位置 | 现状 | 问题 | 建议改法 |
|---|---|---|---|
| [§6.5 第 1 条](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L615) | “SDK 后端拿不到 PID 时，至少注入 `BIZGRAPH_TURN_ID` 环境变量，并把该值写入 `executor_env_marker`” | 暗示 env marker 可支撑跨重启认领；macOS 不可读 env | 改为：“env marker 仅用于**同进程内**的轮次关联/日志；**不用于跨重启认领**。能落库的只有宿主自 spawn 的 pid/pgid。” |
| [§6.5 第 3 条](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L617) | “按 `ps` 扫描，只杀 marker 命中、且能确认属于本应用的进程” | 实现里“可确认”没有定义，实际是“无条件相信持久化 pid” | 改为：“只杀**可证明归属**的残留：宿主 spawn 且 (命令行含 marker 或 pid+启动时间匹配)。**SDK 内部子进程跨重启无法证明归属 → 只记录 `recovery_note/residualRisk` 并告警，不杀**。” |
| [§6.5 验收第 5 条](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L619) | “取消后 2s 内 marker 进程数必须为 0” | 对 SDK 后端不可达（marker 不可见） | 改为：“仅对**宿主自 spawn 的适配器（OpenCode）**承诺 2s 内残留为 0；SDK 后端只承诺‘不再新增残留 + 取消请求 2s 内返回 + 残留写入 `residualRisk`’，不承诺 0。” |

另外建议在 §9（恢复）显式加一句边界：“进程回收不是恢复的一部分；恢复只保证 turn/step 的状态对账，不保证操作系统进程一定被回收。”

---

## 10. P0-3 / P1 四项逐条验收

### P0-3 step 主键：**通过**

- [runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L609) 的 `scopeStepId(turnId, stepId)` 统一包住事件、`context.step.*`、审批三处入口；主键形如 `<turnId>:<localStepId>`。
- 探针 F：两轮同节点各自一行，`turn-1` 的 step 仍 `running`，内容不串；[schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L239) 的 `ux_agent_steps_turn_id(turn_id,id)` 兜底存在（与主键冗余，但无害）。
- 施工方用例 `keeps step rows from two consecutive turns of the same node (P0-3)` 通过（141 用例中）。

### P1-4 锁 owner：**通过**

- [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L574-L592) 改为 `dispatch:${randomUUID()}`，第二次并发 `tryAcquire` 返回 null → `SessionBusyError`。
- 施工方用例 `fails fast when the same session is dispatched twice concurrently (P1-4)` 实测通过，且释放后 `isBusy=false`。

### P1-5 `unknown` 不落 `failed`：**通过**

- `tool.unknown` → step `status='unknown'`；`tool.aborted` → `aborted` + `unknown-needs-rerun`；`tool.failed` 才 `failed`。
- 用例 `maps unresolved tool existence to unknown, not failed (C2)` 通过；Codex normalizer 断言“有 `tool.unknown`、无 `tool.failed`”通过。
- 注意：失败 turn 收尾时 `abortOpenSteps` 会把 `unknown` 改成 `aborted`（不是 `failed`），`test_disposition` 仍写 `unknown-needs-rerun`，语义正确。

### P1-6 Claude 首块文本 1 条：**通过**

- `normalizers.test.ts` 断言 `message.delta|message.completed` 合计 `toHaveLength(1)`，类型序列为 `run.started/message.completed/tool.requested/tool.result/usage.updated/run.completed`；全绿。

### P1-7 两个弹窗：**通过，但有共存路径**

- [ConfirmationDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ConfirmationDialog.tsx#L1-L7) 顶部注释明确“事后提示（不是审批）”，只保留“知道了”；i18n 为“已修改，仅提示 / 该操作已在 Agent 侧执行…无法撤销”。点击仅本地移除 `pendingConfirmations` 并 emit `CONFIRMATION_RESPONDED`，该事件**无任何监听者**，不会触发执行，诚实。
- [ApprovalRequestDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ApprovalRequestDialog.tsx#L20-L62) 数据源为 `agent:getPendingApprovals` + `onApprovalRequest/onApprovalResolved`，仅 `ApprovalGateway` 的 pending 会展示；Codex/OpenCode 不产生该事件。
- [AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L500-L501) **同时挂载两个组件**。同一动作不会“审批+确认”同时出现（Claude 是先审批、执行后才有 file_change 提示，时间上串行）；但**不同动作可以同屏共存**（动作 1 待审批、动作 2 的事后提示同时渲染）。这不算欺骗，但视觉上会让人分不清哪个是拦截。建议给两者不同层级/标题前缀（P3 级）。

---

## 11. 回归面

| 回归项 | 结果 | 证据 |
|---|---|---|
| 旧 `AgentOutput` 路径 | **Codex 已变语义** | [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts) 由 `thread.run()` 改为 `runStreamed()`；不再广播 `result.finalResponse`；错误改为 `type:'error'`；完成信号改为 `turn.completed`。施工方同时**改写了** [codex.test.ts](file:///Users/zhumingchen/tiangong/src/main/__tests__/codex.test.ts) 的断言（“All done” 不再出现）。这与报告 §7「仅接入 spawn 上报与 marker env，未改既有输出行为」自相矛盾（该行只写在“修改：适配器”清单，但 codex 明确改了输出）。 |
| 12 个适配器 | **其余为加性改动** | `base.ts` 只加订阅/回调；`claude-code.ts` 的 `PreToolUse`/`canUseTool` 仅在 Runtime 注入时生效；`opencode.ts` 只加 `emitRawEvent`/`emitProcessSpawn`。旧路径不订阅时不改变输出。 |
| `spikes/` 断言 | **未被改（间接）** | `spikes/agent-core/tests/*.test.ts` mtime 均为 18:12–18:16，早于第一轮报告落盘时间 21:03，也早于施工方第二轮修复（21:39）；`spikes/` 整个目录未纳入 git，无法用 diff 直接证明。 |
| schema v19 迁移可重复执行 | **通过** | 探针 G：同一 `rebuildTableIfNeeded + AGENT_INDEX_SQLS` 路径连跑两次无异常；所有 DDL 均 `IF NOT EXISTS` 或先存在性检查。真实 `migrate()` 仍被 `better-sqlite3` ABI 阻断，未在 Electron 内实测。 |
| 无 git commit / 无越界改动 | **通过（继承第一轮）** | `git log` 仍停在 `2c00453`；改动面与第一轮清单一致。 |

**版本号小问题（P2）**：`CURRENT_SCHEMA_VERSION` 从 17 直接跳到 19，但注释都写“v18”。功能上无影响（新表由慢路径创建），但版本叙事不一致，建议改注释或补齐 v18 的语义。

---

## 12. 第二轮新发现 / 仍存在的问题（按严重度）

| 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P0-A（新）** | 启动对账/取消按**持久化 pid/pgid** 回收，却不校验归属；PID 复用会误杀与本应用无关的进程。违反设计 §6.5.3 的“归属无法确认时只告警不杀”。 | 探针 H：`marker=none pids=19618`，无关进程被杀死；[reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L189-L209) 无身份校验 | 启动路径**禁止**按裸 pid 杀；要么记录 pid+启动时间并比对 `ps -o lstart=`，要么只做告警并写 `recovery_note`。取消路径使用内存登记（同进程内）即可，不需要回读 DB 的陈旧 pid。 |
| **P1-A** | 异常退出（driver throw）不回收本轮已登记的子进程；正常完成也只 `forget`，A 的子进程成为孤儿。 | 探针 C：A 异常后仍 alive | 异常路径 `reap(turnId)`（仅登记对象）；正常完成继续 `forget`（符合约定）。 |
| **P1-B** | Codex 旧 `AgentOutput` 路径语义被改变（无 `finalResponse`、错误形态变化、完成时机变化），并通过改写测试断言来“适配”。 | [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts) diff + [codex.test.ts](file:///Users/zhumingchen/tiangong/src/main/__tests__/codex.test.ts) diff | 需要产品/兼容性签字：要么在 M0 明确“Codex 旧路径按 C1–C7 升级”，要么为旧路径保留 `finalResponse` 聚合输出。 |
| **P1-C** | 跨重启回收承诺与实际能力不符：env marker 在 macOS 不可读，`reclaimResidual` 命中 0；真正生效的是不安全的 pid 路径。 | 探针 E；报告 §6.5 未验证项自认 | 按 §9.3 改写架构文档措辞与验收口径。 |
| **P2** | `updateSessionProc` 的 `COALESCE` 永不清理 `executor_pid/pgid/env_marker`，陈旧句柄会跨 turn/跨重启保留。 | [repository.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/repository.ts#L285-L300) | turn 结束时显式 `clearProc`（或新 turn 开始时清空），避免用上一轮的句柄杀进程。 |
| **P2** | `ux_agent_steps_turn_id(turn_id,id)` 与主键 `id` 冗余。 | [schema.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/db/schema.ts#L239) | 可保留（防回归），但注释说明它只是“作用域断言”而非性能索引。 |
| **P3** | 两个弹窗同屏可共存（不同动作），层级未区分。 | [AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L500-L501) | 给审批弹窗加“阻塞中”视觉层级，事后提示放消息流内。 |

---

## 13. 第二轮结论

**M0 仍不可验收，需要再修。** 判定依据不是“还有 P2/P3”，而是 **P0-A**：启动对账可能误杀用户机器上任意一个恰好复用了 PID 的进程。这是安全边界问题，且与设计文档“归属无法确认时只告警不杀”直接冲突。修复 P0-A、P1-A、P1-B（Codex 旧路径语义需签字）并改写 P0-2 的承诺措辞后，可再送第三轮复核；其余项（P0-1/P0-3/P1-4/P1-5/P1-6/P1-7、schema 幂等、全量回归）本轮已实测通过。

---

## 14. 附：在 SDK 不暴露 PID 的前提下，跨重启回收应写成什么承诺？

不应承诺“回收”，应承诺“**可观测的尽力而为，且绝不误杀**”。具体可以写成：

> **同进程内**：宿主通过适配器真正拿到的 pid/pgid 才用于取消回收；拿不到句柄的 SDK 后端，取消只保证“abort 已发出、turn 在 N 秒内收口”，不保证子进程已退出。取消后 UI 带 `residualRisk=true`，文案为“已请求取消，可能有残留进程”。
>
> **跨重启**：宿主对 SDK 内部子进程**没有可靠身份**（PID 不暴露、env marker 在 macOS 不可读），因此**不承诺回收**。启动时只对“可证明归属”的残留执行清理（宿主 spawn 且命令行含本轮 marker，或 pid 与启动时间同时匹配）；无法证明归属的，只写 `agent_sessions.recovery_note` / `residualRisk` 并告警，交由用户或操作系统处理。绝不按裸持久化 pid 直接 kill。
>
> **验收口径**：仅对宿主自 spawn 的适配器（OpenCode）断言“取消后 2s 残留为 0”；对 Claude/Codex SDK 后端，断言“取消请求 2s 内返回、不新增残留、`residualRisk` 已写入、无悬空 turn/step”。

对应到文档的最小改法就是 §9.3 的三行：§6.5.1 把 env marker 降级为“同进程关联”，§6.5.3 明确“无法证明归属只告警”，§6.5.5 把“2s 内 marker 数为 0”限定到宿主自 spawn 的适配器。这样既诚实，也不会把“回收”写成做不到的承诺。

---

# 第三轮复核（2026-11-04 深夜）

> 复核对象：施工方第三轮送验（声称“裸 PID 杀已彻底根除”）。**不采信其 grep 清单**，以下全部为本人独立 grep 与自建探针。

## 15. 结论先行（第三轮）

**P0 裸 PID 杀：已根除。M0 可验收，但验收范围有明确边界（见 §21）。**

判定依据：`src/main`（排除测试）中真正能发出信号的 `process.kill` 只有两处，都在 [reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L314-L322) 的 `terminatePid` 内，且其唯一入口 `reclaim` 先过 `proveOwnership`（≥2 项证据）。取消路径已改为只读**内存登记**，启动路径必须带 `started_at`/`cmd`。三个负向场景实测 kill 调用数 = 0；正对照与 OpenCode 真机树回收均成功。

| 核查项 | 判定 | 依据 |
|---|---|---|
| 1. 是否存在绕过归属证明的 kill 路径 | **通过（无绕过）** | 独立 grep + 代码逐点 |
| 2a. 无法证明归属时 kill 调用数 = 0 | **通过（实测 0）** | 探针 T1（spy 计数） |
| 2b. OpenCode 取消后 2s 残留 = 0 | **通过（实测 0）** | 探针 T5（真实 spawn，后代树 2 个） |
| 2c. Claude/Codex 只承诺收敛 + `residual_risk=unconfirmed` | **通过** | 探针 T3 + 既有用例断言，无用例宣称“残留 0” |
| 3. 陈旧句柄 | **通过** | 探针 T4：两轮取消后 pid/pgid 均 NULL，第二轮不读旧句柄 |
| 4. driver 抛错后本轮登记进程被回收 | **通过** | 探针 T3：failed 后 2s 内 owner 已死 |
| 5. 双路径回归 | **通过** | 旧 `thread.run()` + `finalResponse` 断言恢复并通过；Runtime 才 `runStreamed()` |
| 6. `residual_risk` 真实性 | **通过（UI 未在真实 Electron 窗口验证）** | DDL CHECK / preload / IPC / ChatHeader 投影均实测或代码确认 |
| 7. 与 §6.5 三层承诺一致 | **基本一致（2 处措辞漂移）** | 见 §20 |

## 16. 独立 grep 原始输出（排除 `__tests__`）

```text
$ grep -rn "process\.kill|killRegistered|terminateTree|reclaimResidual|scanResidual|residualCount" src/main --include="*.ts" | grep -v "__tests__"
src/main/agent/runtime/runtime.ts:461:  const report = expected.length > 0 ? this.reaper.killRegistered(expected, { marker: marker ?? undefined }) : null
src/main/agent/runtime/process/reaper.ts:107:    process.kill(pid, 0)
src/main/agent/runtime/process/reaper.ts:194:  killRegistered(expected: ProcIdentity[], options: { marker?: string } = {}): ReapReport
src/main/agent/runtime/process/reaper.ts:199:  residualCount(marker: string): number
src/main/agent/runtime/process/reaper.ts:205:  scanResidual(marker: string): ProcInfo[]
src/main/agent/runtime/process/reaper.ts:231:  if (this.terminateTree(...))
src/main/agent/runtime/process/reaper.ts:273:  private terminateTree(rootPid: number, killed: number[]): boolean
src/main/agent/runtime/process/reaper.ts:314:    process.kill(pid, 'SIGTERM')
src/main/agent/runtime/process/reaper.ts:322:    process.kill(pid, 'SIGKILL')
```

（`reaper.ts:107` 是 `kill(pid, 0)` 存活探测，不发信号；`residualCount/scanResidual` 仅诊断。）

调用图（逐点确认）：

- `runtime.ts:461` 的 `killRegistered(expected, ...)` 是启动唯一入口；`expected` 来自 `executor_pid` + `executor_cmd` + `executor_started_at`（[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L449-L460)），且 `ProveOwnership` 要求 ≥2 项。
- `runtime.ts:417` 的取消路径是 `reaper.reap(turnId)`，只遍历**内存** `state.registered`（[reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L183-L187)），不查 DB。
- `terminatePid` 只被 `reclaim` 调用；`reclaim` 对每个 identity 先 `proveOwnership`，`insufficient-proof` 直接进 `unresolved`，不会进入 `terminateTree`。
- `scanResidual` / `residualCount` 不参与任何 kill 决策（注释与调用点均已确认）。
- 适配器层的 `proc.kill()` 只作用于自己持有的 `ChildProcess` 句柄，不存在“拿裸 pid 杀”的路径。

## 17. 可数指标实测值（自建探针，跑完已删除）

| 探针 | 场景 | 实测值 |
|---|---|---|
| T1 | bare persisted pid（无 cmd/startedAt） | `killed=0`，`killSignals=0`，进程存活 |
| T1 | marker-only（命令行含 marker，无 cmd/startedAt） | `killed=0`，`killSignals=0`，进程存活 |
| T1 | PID 复用（pid 真实存在，但 cmd/startedAt 是旧进程的） | `killed=0`，`killSignals=0`，进程存活 |
| T2 | 正对照：`startedAt + command` 同时匹配 | `killed=1`，目标进程 2s 内消失 |
| T3 | driver 抛错（异常路径） | turn `failed`；owner 2s 内被回收；`residual_risk='none'`（宿主句柄成功回收，属正确值） |
| T4 | 连续两轮取消 | 两轮子进程均死亡；`executor_pid/pgid` 在两次终态后均为 `NULL` |
| T5 | OpenCode 真实 spawn（stub 再 spawn 孙进程） | 取消前后代树 2 个；`reap.killed=2`；2s 后残留 **0** |
| T6 | `residual_risk` CHECK | 三值可写；非法值 `UPDATE` 抛错 |

> T5 说明：本机未安装 `opencode`，我用一个真实可执行 stub（`/bin/sh` + `sleep 300 &`）通过 `PATH` 让 [opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts) 走真实 `spawn` 路径，并用真实 `ProcessReaper` 回收整棵后代树。这验证的是“宿主自 spawn 的进程树可被回收”，不是 OpenCode 二进制本身的行为。

## 18. 逐项细节

### 18.1 陈旧句柄（P2 已修复）

[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L383-L384) 在每个 turn 的 `finally` 调用 `repo.clearSessionProcess(session.id)`；`cancelTurn` 不再读取落库 pid（[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L415-L417)）。T4 实测两轮终态后 `executor_pid/pgid` 均为 `NULL`。

### 18.2 异常路径

`finally` 中 `finalStatus !== 'completed'` 时执行 `reap(turnId)`（[runtime.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/runtime.ts#L374-L381)），T3 证明 driver 抛错后本轮登记的 owner 被回收。

### 18.3 双路径回归

- 旧路径：[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts) 默认走 `thread.run()` 并广播 `result.finalResponse`；[codex.test.ts](file:///Users/zhumingchen/tiangong/src/main/__tests__/codex.test.ts) 中旧的 `'All done'` 断言恢复并通过。
- Runtime 路径：`AdapterBackendDriver` 对**该 session** 调用 `setRawStreamMode(true)` 后才走 `runStreamed()`；`rawStreamSessions` 是按 `sessionId` 的 Set，旧/新路径互不污染。
- 定向实测：`codex.test.ts / process-reaper.test.ts / run-node.test.ts / recovery.test.ts / db-schema.test.ts` 共 **48 passed**。

### 18.4 `residual_risk` 全链路

- DDL：`CHECK (residual_risk IN ('none','possible','unconfirmed'))`，T6 用非法值 `UPDATE` 实测抛错。
- IPC：`agent:getSessionRecovery` 在 [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L87) 白名单内；handler 在 [ipc/agent.ts](file:///Users/zhumingchen/tiangong/src/main/ipc/agent.ts#L50-L53) 直读 `repo.getSessionRecovery`。
- UI：[ChatHeader.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ChatHeader.tsx#L140-L148) 仅在 `!= 'none'` 时展示徽标，文案为“可能有残留进程 / 残留无法确认”，`title` 用真实 `recoveryNote`。
- **未覆盖**：没有启动真实 Electron 窗口做视觉/刷新验证；且 [AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L85-L101) 的取数 effect 只依赖 `currentSessionId`，同一会话内取消后徽标不会自动刷新，需切换会话或重开面板才会更新（P3）。

## 19. 回归与静态检查

```bash
npx tsc --noEmit                 # exit 0
npx eslint src --ext ts,tsx --max-warnings 0   # exit 0
npx vitest run                   # 26 failed files / 228 passed; 173 failed tests / 2865 passed
```

全量失败仍全部为 `better-sqlite3` Electron ABI 噪声（`NODE_MODULE_VERSION 130 → 115` 95 处 + 派生 5 处），`AssertionError = 0`；通过数比第二轮多 8（第三轮新增用例）。无 git commit（仍停在 `2c00453`）。

## 20. 文档一致性（§6.5 三层承诺）

| 条款 | 代码行为 | 偏差 |
|---|---|---|
| a) 同进程内按真实句柄回收 | `reap(turnId)` 用内存登记，异常路径也回收 | 文档写“按内存中的 `pid/pgid`”，实际 `pgid` 从不被杀（`killedGroups` 恒为 `[]`），仅按 pid 树走。属措辞漂移，不影响安全。 |
| b) 跨重启 ≥2 项证据 | `proveOwnership` 要求 `startedAt`/`command`/`marker` 至少 2 项 | 一致 |
| c) 禁止裸 pid kill；终态清空句柄 | 启动只接受完整 identity；`clearSessionProcess` 每轮执行 | 一致 |

另：`commandMatches` 在整串不相等时会退化为“仅比较可执行文件名”（[reaper.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/process/reaper.ts#L119-L126)）。与 `ps` 秒级 `lstart` 组合，理论上存在“同一秒启动、同一可执行文件、PID 又被复用”时凑齐 2 项证据的极小概率；建议把 command 改为精确匹配或要求 `startedAt + 完整 command`（P3，不阻塞）。

## 21. 最终结论（第三轮）

**M0 可验收。** 前两轮的 P0 均已关闭：跨会话误杀（P0-1）、step 主键（P0-3）、裸 PID 误杀（第三轮新增 P0-A）均已实测修复；P0-2 的承诺已按“同进程尽力回收 + 跨重启只回收可证明归属者”改写并与代码对齐。

**验收覆盖了什么**：源码级 kill 调用面、归属证明逻辑、取消/异常/启动三条回收路径、陈旧句柄清理、OpenCode 真实进程树 2s 残留、`residual_risk` 三值 DDL 与 IPC/UI 投影、双路径隔离、tsc/lint/全量测试。

**没覆盖什么**（必须在验收记录中保留）：

1. 真实 Electron 窗口下的徽标展示与刷新（只做了组件/数据链路核对）；
2. 真实 Claude/Codex SDK 子进程的跨重启行为（SDK 不暴露 PID，只能按设计标注 `unconfirmed`）；
3. Windows/Linux 的 marker 可见性（本轮只在 macOS 实测）；
4. `better-sqlite3` 在 Electron 内的真实 v19 迁移执行（Node 侧同路径跑两次通过，ABI 阻断真实 `migrate()`）；
5. `pgid` 组回收从未被执行（当前只有 pid 树回收）。

以上 1–5 不构成 M0 阻塞项，但应作为 M1 前的前置验证清单。
