# Agent 体系五个待决问题：决策梳理

> 只读分析，未改源码。依据：[agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md)、[agent-rollout.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-rollout.md)、[agent-system-design-review.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-system-design-review.md)、`spikes/agent-core/`、`src/main` 源码与已安装 SDK 类型。
>
> 标注：**[实测]** = spike 或本机命令跑过；**[代码]** = 打开文件确认；**[推断]** = 基于已证实事实的推理；**[未验证]** = 没有实测数据，不得当结论用。
>
> 一个前提事实：`agent_runs/agent_turns/agent_sessions/agent_usage` 在 `src/` 中**尚不存在**，DB 仍是 `CURRENT_SCHEMA_VERSION = 17`，M0 尚未开工 `[代码：database.ts L355；全仓无相关建表]`。因此下列决策现在改是零成本，落到 D1 之后再改就要迁移与返工。

---

## 0. 结论速览

| # | 决策 | 推荐默认值 | 是否必须现在定 | 依据强度 |
|---|---|---|---|---|
| D-A | 排队 | **M0 不排队，保持 fail-fast**；保留 `queued` 枚举，但不上线晋升逻辑 | **是**（决定 CHECK 枚举、索引与 busy 契约） | fail-fast [实测]；排队 [未验证] |
| D-B | 审批超时 | **交互 120s / 无人值守 30s**；计时从「推送到可见窗口」开始，重启重推即重计时 | **是**（决定 `expires_at` 语义与 D4 实现） | 30ms 只验证时序 [实测]；120/30s 是 [推断] |
| D-C | Codex `runStreamed()` | **有条件默认开启**：C1–C7 同批交付后默认走流式；任一未达成则用开关回退 `run()` | **部分必须现在定**：取消语义/进程组回收（C3）与 aborted 对账（C2）现在定；默认值随 C3 交付 | 真机 [实测] |
| D-D | 成本上限 | **项目（graph）× 本地日** 双层额度，**准入拦截**；超限拒新 turn，不杀在途 turn，人工审批可单次放行 | **是**（`agent_usage` 必须补 `graph_id/day_key`） | 现状只有估算、权威 usage 未落库 [代码] |
| D-E | 长尾 CLI 工具事件 | **M0 如实声明 `none`；M1 只投「合成文件变更证据」**，不为 7 个 CLI 逐一写 parser | 声明现在定；投入可延后到 M1 | 现状 `parseFileChanges:false` [代码]；CLI 结构化输出 [未验证] |

---

## 1. D-A：是否引入 `queueDepth=1`

### 1.1 问题本质

不是「要不要写一个队列」，而是：**同一执行器/同一节点第二次被派发时，让用户立刻拿到确定答复（fail-fast），还是让系统替用户等待（排队）**。前者买确定性，后者买吞吐与无人值守体验，代价是状态机、锁、预算与 UI 的复杂度全部上升。

### 1.2 影响面

| 层 | 牵动点 | 现状证据 |
|---|---|---|
| 编排 | `AgentManager.sendCommand` 无任何在途保护，直接 `adapter.sendCommand` | `[代码]` [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L562-L613) |
| 适配器 | `BaseAdapter.sendCommand` 只拒绝「正在被 idle reaper 回收」的会话，不拒绝并发 | `[代码]` [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L184-L224) |
| 进程 | CLI 适配器用 `this.processes.set(session.id, proc)`，第二次 send 会覆盖句柄 | `[代码]` [opencode.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/opencode.ts#L70)、[cline.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/cline.ts#L66) |
| 归属 | 非 SDK 路径仍走 `emitOutput` 的栈顶归属 | `[代码]` [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L458-L461) |
| 实例 | 每个 adapter 名全进程单实例，两个会话共享一个实例 | `[代码]` [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L119-L120) |
| DB | `agent_turns.status` 的 CHECK 是否含 `queued`；`ux_turns_active` 与 `ux_turns_queue` 的索引集合 | `[代码]` 设计 §4.3；`[实测]` 两条部分唯一索引可共存 |
| IPC/UI | `SESSION_BUSY` / `NODE_BUSY` 错误码、可重试标记、「停止当前运行」入口 | 现状只有 renderer 输入框 `disabled`，不是运行时约束 `[代码：AgentChatPanel L646]` |

**现在不定、以后返工代价高的**：`queued` 是否进 CHECK（后加要重建表或迁移）、busy 错误契约（后改要同时改 IPC 类型、preload 白名单、renderer 分支）、以及「审批等待是否占锁」——它直接决定 D-B 的可接受超时上限。

### 1.3 选项

| 选项 | 收益 | 代价 | 最坏情况 | 适用 |
|---|---|---|---|---|
| **A1 fail-fast（推荐）** | spike 已验证；状态机最少；错误可解释；无晋升竞态 | 用户需手动重试；自动化批处理会频繁撞 BUSY | 无人值守跑图时大量 turn 被拒，用户以为系统坏了 | 单用户桌面、手动为主 |
| A2 运行时 `queueDepth=1` | 用户无感、适合批量；节点利用率高 | 新增 `queued` 状态、晋升事务、队列超时、取消语义、UI 队列展示；晋升必须与旧 turn 终结同事务 | 晋升竞态导致两个活跃 turn 并发写同一目录；队列饥饿；崩溃后 `queued` 无人接管 | 无人值守批量、多步流水线 |
| A3 renderer/调度端串行（不进运行时） | 不改表、不改状态机；聊天体验「不报错」 | 只对单一窗口有效；多窗口/子代理/定时器可绕过；存在隐藏积压 | UI 显示排队但实际没排队，用户误以为已提交 | 仅聊天面板的体验补丁 |

### 1.4 推荐值与可逆性

**A1：M0 保持 fail-fast。** `queued` 枚举保留（成本为零，避免以后改 CHECK），但**不创建晋升逻辑、不默认创建 `ux_turns_queue`**；第二条索引在真正要排队时再加（加索引比改 CHECK 便宜得多）。

同时把 busy 做成**可操作错误**：`SESSION_BUSY`（同一会话在跑）与 `NODE_BUSY`（同节点有非终态 turn）都带 `retryable: true` 和「停止当前运行 / 稍后重试」两个动作。否则 fail-fast 会退化成「弹个红字」。

**如果错了**：自动化用户会撞 BUSY，但不会产生数据损坏；改回/开启排队 = 一条部分唯一索引 + 一个「旧 turn 置终态 → queued 置 running」的单事务 + U6 spike，**不需要数据回填**。风险等级：低。

### 1.5 验证方式

- 单测：同 session 并发两次 `sendCommand`，恰好一个进入执行，另一个拿到 `SESSION_BUSY`；同 node 第二个非终态 turn 插入失败 → `NODE_BUSY`（复用 spike V4 断言）。
- 归属：并发两个 run 后，每个 `agent_events` 只含自己的 `runId/turnId`（V4 已验）。
- 可观测指标：`busy_reject_rate`（每次派发被拒比例）、`retry_after_busy`（被拒后 30s 内重试次数）、`turn_duration_p95`。若 `retry_after_busy` 很高且集中在同一 node，说明该上 A2；若很低，A1 就是对的。

### 1.6 需要负责人提供

1. 是否存在**无人值守**的批量跑图 / 定时任务 / CI 式调用？
2. 产品是**单用户本机**，还是多人共享同一执行器（多窗口、多人协作）？
3. 用户被 BUSY 拒绝后，是否有可接受的「重试」心智，还是必须「提交即排队」？

---

## 2. D-B：审批超时该多长、按什么维度定

### 2.1 问题本质

fail-closed 的超时，本质是**「人还没看」多久之后被判成「人拒绝」**。权衡的是「人读判断的完整性」与「会话锁被占用、任务空转」；它**不由任务时长决定**，而由**人的决策延迟**决定。

### 2.2 影响面

| 层 | 牵动点 | 现状证据 |
|---|---|---|
| DB | `agent_approvals.expires_at NOT NULL`；超时写 `denied + decided_by='timeout'` | 设计 §4.2/§7.4 |
| 状态机 | `waiting_approval` 期间 turn 是否继续占 session 锁 | 设计 §5.1/§6.1；`[推断]` 若占锁，超时值就是「会话被冻结」的上限 |
| IPC | 审批推送、`onApprovalResolved`、重启重推 | 设计 §7.1/§7.4 |
| 实现参考 | spike 网关**代码默认 60s**，但测试实际只跑过 30ms | `[实测]` [gateway.ts](file:///Users/zhumingchen/tiangong/spikes/agent-core/src/approval/gateway.ts#L53)、V7 |
| UI | 倒计时、窗口销毁时 `deny(system)`、重启后 pending 重推 | 设计 §7.4 |

**现在不定、以后返工的**：`expires_at` 的语义（固定写入 vs 重推时重写）、以及「无可见窗口时是否起表」。这两条一旦按 60s 写死进 D4，后面改成「交互长、无人值守短」要改校验顺序与重推逻辑。

### 2.3 选项

| 选项 | 收益 | 代价 | 最坏情况 | 适用 |
|---|---|---|---|---|
| B1 全局 60s | 实现最简单；占锁时间可控 | 读多文件 diff 时容易误拒；用户切窗口回来已过期 | 用户正在读却被拒，重跑浪费一次完整 turn | 无人值守为主 |
| **B2 交互 120s / 无人值守 30s（推荐）** | 与使用场景匹配；交互误拒率低，批量不空转 | 需要按策略区分；UI 要显示剩余时间 | 交互 120s 占锁更久（但此时用户本来就在等这一项） | 桌面交互 + 少量自动化 |
| B3 交互不超时、只受 turn deadline 约束 | 永不误拒 | 崩溃/走开时锁长期占用；pending 永久挂起 | 会话被一个没人看的审批冻结，用户只能强杀 | 单用户、无并发需求 |

### 2.4 推荐值与可逆性

**B2：交互 120s，无人值守 30s，二者都不得超过 turn 的 `deadline_at`。** 理由：60s 对「打开 diff、滚动、判断」偏紧；而 120s 的额外占锁代价在单用户交互场景里几乎为零——用户此刻本来就被这一项挡住，不会在同一会话里做别的事。对无人值守，30s 足够覆盖脚本轮询，且能快速失败。

**关键实现约束**（现在定）：
- 计时从**审批被推送到可见窗口**开始，而非 row 创建；无可见窗口时保持 `pending`、不起表（重启重推时重写 `expires_at`）。
- 超时只写 `denied + timeout`，不新增 `expired` 状态（沿用 §7.4）。
- 迟到的 `allow` 不执行（V7 已验）。

**如果错了**：超时值是配置项，改值不需要迁移；但「起表时机」如果写错，要改 D4 与重推路径。风险等级：低（值）/ 中（语义）。

### 2.5 验证方式

- 指标：`approval_decision_latency_p50/p95`（`decided_at - created_at`）、`approval_timeout_rate`（目标 < 2%）、`approval_repush_after_restart`。
- 测试：30ms 超时下迟到 allow 不执行（已有 V7）；新增「无窗口不起表」「重启重推后时钟重置」两条。
- 上线后按真实 p95 回调一次默认值；不要用拍脑袋的 60s 直接锁死。

### 2.6 需要负责人提供

1. 审批卡片典型内容是**单文件小改**还是**多文件大 diff**？
2. 用户是否会**离开应用**等待长任务？离开时希望「自动拒绝」还是「保留等他回来」？
3. 可接受的**误拒率**是多少（误拒 = 用户本来会批准，但被判超时）？
4. 是否存在无人值守审批场景（例如脚本跑图时需要人批）？

---

## 3. D-C：Codex 是否默认 `runStreamed()`

> 本节依据真机实测：[spikes/codex-stream/README.md](file:///Users/zhumingchen/tiangong/spikes/codex-stream/README.md) 与 `results/*.json`（`@openai/codex-sdk@0.135.0`、`codex-cli 0.135.0`）。

### 3.1 问题本质

实测把原来的问题改写了一半：流式**不是**「更酷但更贵」的可选项，它是阻塞式的上游——`run()` 本身就消费同一个 generator（`index.js` L95-118），单进程、单 turn、单份 usage、无重复计费 `[实测]`。因此真正的权衡不再是「要不要流」，而是：**用 item 级可见性，换取对取消、孤儿进程、未闭合 item 对账的额外责任**。

### 3.2 影响面

| 层 | 牵动点 | 实测/代码证据 |
|---|---|---|
| 适配器 | `codex.ts` 目前 `thread.run()`；改流式后消费 `AsyncGenerator<ThreadEvent>` | `[代码]` [codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L109-L119)；`runStreamed` d.ts L206 |
| 完成判定 | `turn.completed` 之后迭代器还会空转 **约 10s**（`lastEventToExitMs=10015`），阻塞式同样要等 | `[实测]` `results/01-streamed.json`、`04-cli-overhead.json` |
| 最终消息 | `StreamedTurn` 只有 events，无 `finalResponse`；必须自己聚合 `agent_message` | `[代码]` d.ts L182-186 |
| 工具事件 | item 级而非 token 级：7 事件、`item.updated` 0 次、`item.started/completed` 同时间戳；`aggregated_output` 完成时一次性到达 | `[实测]` `results/01-streamed.json` |
| 命令 | `command_execution.command` 有完整命令行字符串（含 `/bin/zsh -lc`），但**无 argv、无 cwd、无耗时** | `[实测]` `results/01-streamed.json`；d.ts L6-17 |
| 文件变更 | `file_change` 只有 `path + kind`，**无 diff/hunk**；产品要展示 diff 得自己实现 | `[实测]` `results/01b-filechange.json`；d.ts L28-35 |
| usage | 只在 `turn.completed` 出现；流式 21220/106 vs 阻塞 21214/109，1 进程、1 个 `turn.completed` | `[实测]` `results/02-blocking.json` |
| 取消 | `AbortError` 3-4ms；主进程 79-133ms 回收；4/4 次孙子命令变孤儿（`ppid=1`）跑到自然结束；SDK 不暴露 PID、不杀进程组 | `[实测]` `results/03-abort-r1..r4.json` |
| 中断事件 | 中断前 4 条事件可读，但该 item 永远停在 `in_progress`，流里**无中断标记** | `[实测]` 同上 |
| 环境 | `~/.codex/config.toml` 的 `model_reasoning_effort="max"` 让 CLI 直接 exit 1；`--config` 覆盖无效；`codex doctor --json` 能报 `config.load=fail` 且 exit code 仍为 0 | `[实测]` 本机复测 + `README §0` |
| 归一化/恢复 | D3 normalizer 要按 `item.*` 产出；D5 的 `stepOutcomes` 要接收 `aborted/unknown` | 设计 §8.2/§5.5；M0 尚未实现 |

**现在不定、以后返工代价高的**：**取消语义与进程组回收**（会同时改 `AgentManager` 的取消路径、D4 的 IPC、D5 的 stepOutcomes 对账、D6 的崩溃恢复），以及 **item 状态映射**（`in_progress → aborted/unknown`）。capabilities 的 `fidelity/toolEvents` 也要一次写对，UI 才会按 item 粒度而不是 token 粒度渲染。

### 3.3 选项

| 选项 | 收益 | 代价 | 最坏情况 | 适用 |
|---|---|---|---|---|
| O1 保持阻塞 `run()` | 无新增取消/对账逻辑；最终消息现成 | 丢掉过程（`in_progress` 不可见）；**仍要等 10s 收尾**；并未更省 | 用户长时间看不到正在执行的命令，以为卡死 | 只读、非交互的批量调用 |
| **O2 默认 `runStreamed()` + 前提 C1–C7（推荐）** | 信息量严格 ≥ 阻塞式；同一进程同一 usage；可做 item 级进度 | 必须同批交付七条前提，尤其进程组回收与 aborted 对账 | 孤儿进程漏杀：用户以为停了，外部命令仍在跑（资源泄漏 + 安全边界） | 桌面交互、默认路径 |
| O3 绕过 SDK 自建 spawn CLI | 完全掌控 PID/PGID/cwd，回收最可靠 | 要自己组装 argv、解析 `--experimental-json`、跟随 CLI 版本；维护面最大 | CLI 升级导致解析整体失效 | 需要强沙箱/强审计的场景 |

> 「默认流式但只在 UI 弹一句可能有残留进程」不是独立选项，它是选中 O2 却缺前提 C3 时的退化状态，**不允许作为默认**。

### 3.4 推荐值：有条件默认开启 `runStreamed()`

**从 M0/M1 起 `CodexAdapter` 默认走 `runStreamed()`；capabilities 声明 `fidelity: item / toolEvents: derived`；但下列 C1–C7 必须同批交付，任一未达成则通过 `codex.stream=false` 回退 `run()`（回退开关至少保留一个版本）。**

| # | 前提 | 具体要求 | 验收 |
|---|---|---|---|
| **C1** | 以 `turn.completed` 判完成 | 收到 `turn.completed` 立即置 turn 完成并通知 UI；**不 `await` 迭代器结束**，10s 收尾在后台清理 | UI 完成延迟 = `turn.completed` 后 ≤ 200ms，而不是 +10s |
| **C2** | 未闭合 item 入对账 | 只有 `item.started`、没有 `item.completed` 的 item 标 `aborted/unknown`（`exit_code=null`），以 `unknown` 写入 `stepOutcomes`；不得伪造 `failed` 或 `completed` | 中断后 `agent_steps` 无 `completed` 假象；恢复时能指出「该步未知」 |
| **C3** | 自行兜底回收进程组 | SDK 不暴露 PID：用 `codexPathOverride` 指向 launcher shim，在新 PGID 下 `exec` codex，并用 `env.TIANGONG_TURN_ID` 把 PGID 写到 turn 目录；取消时先 `SIGTERM -PGID`，2s 后 `SIGKILL`；只杀本 turn 的 PGID，禁止全局 `pkill` | 取消后 2s 内相关进程全清；漏杀记 `orphan_detected` 并在 UI 标「可能有残留」 |
| **C4** | 不承诺 token 级流 | UI 以 item 为单位；不显示打字机式逐 token；`item.updated` 缺失不是故障 | 文案/组件不出现「逐字输出」 |
| **C5** | 未知事件容错 | 底层是 `--experimental-json`；遇到未识别 `type` 跳过并计数，不抛错、不中断 turn | 注入伪造事件夹具，turn 仍能完成 |
| **C6** | 启动前校验 `CODEX_HOME` 可解析 | 见下方「环境前置校验」；失败给可读错误，不静默失败 | 坏配置下首 turn 不发起，错误码可定位 |
| **C7** | `file_change` diff 自行实现 | 只用 path+kind 不够；turn 起始快照 + 结束时读文件生成 diff，复用 D5 工件 | diff 与 `git diff` 一致；无 diff 时不显示空 hunk |

**环境前置校验（C6 的具体做法，实测）**：启动 adapter 前执行 `codex doctor --json`（本机 `codex-cli 0.135.0` 自带），只读 `checks["config.load"].status` 与 `codexVersion`，**不要用 `overallStatus`**——它包含网络可达性检查，离线/代理环境会误杀。实测该命令在配置损坏时仍 **exit 0**，所以必须解析 JSON，不能看退出码。`doctor` 还包含网络可达性检查，启动路径上应设 3–5s 上限；超时只报「配置未校验」，不得当成配置有效 `[推断]`。失败时映射为 `CODEX_CONFIG_INVALID`，并把 stderr 原文 + `remediation` 透出；**不自动改写用户的 `~/.codex/config.toml`**。另外：SDK 的 `CodexOptions.env` 一旦传入就**不再继承 `process.env`**（d.ts L228-232），传 `CODEX_HOME` 时必须显式拼全量环境。

**最坏情况（写实）**：
- **C3 漏杀**：用户点了取消、UI 显示已中断，但 `sleep 30` 或一条写文件/联网命令仍在后台跑（4/4 次观测到 `ppid=1`）。这不仅是资源泄漏，也是**安全边界问题**——命令已超出用户以为的停止时刻。
- **C3 杀错**：若按名字或全局 PGID 杀，会误杀同机其他 Codex 会话；必须按 turn 记录 PGID 精确回收。
- **C1 用迭代器结束判完成**：每个 turn 凭空多等 ~10s，用户会认为流式「更慢」。
- **C2 漏标**：中断后把 `in_progress` 当成成功，恢复对账会得出错误结论。
- **C6 漏检**：把配置解析失败当成「模型调用失败」，用户会反复重试而不是修配置。

**可逆性**：默认值可一键回退到 `run()`，事件按 `fidelity` 逐条记录、无需回填；但 **C2/C3 是取消与恢复的正确性基础，无论默认开不开都必须做**。风险等级：中（默认开启）/ 低（回退后）。

### 3.5 验证方式

- 回放 `spikes/codex-stream/results/*.json` 做夹具，断言：7 事件序列、最终文本与 `run()` 等价、usage 存在、单进程、`turn.completed` 后 ≤200ms 完成、10s 尾巴异步。
- 取消：4 组 abort 夹具 → `AbortError` 3-4ms、主进程 ≤150ms、**PGID 回收后 2s 内全清**；未闭合 item 状态为 `aborted/unknown`。
- 环境：坏 `config.toml` + 好配置各一组，断言 `CODEX_CONFIG_INVALID` 与可读文案；离线环境不得因 `doctor` 网络检查被误判为配置失败。
- 指标：`codex_complete_latency`、`orphan_detected`、`orphan_killed`、`unknown_events`、`aborted_items`、`config_preflight_fail`、`event_bytes_per_turn`。
- 长跑：20 个 turn、随机时点中断，5s 后 `pgrep` 无本 turn 残留。

### 3.6 需要负责人提供

1. Codex 在目标用户中的占比？是否接受保留一个版本的 `codex.stream=false` 回退开关？
2. 产品是否把「工具时间线」作为卖点？若否，流式只用于进度，不承诺逐工具解释。
3. 是否接受 **item 级（非 token 级）** 进度、以及**命令字符串级**（非 argv 级）审批绑定？
4. 桌面端是否要求「取消后零残留」作为硬承诺？若是，C3 之外是否还要强制沙箱/容器化执行？
5. 配置损坏时只报错、还是允许产品代为修复 `~/.codex/config.toml`？（推荐只报错）

---

## 4. D-D：成本上限的口径与熔断层

### 4.1 问题本质

熔断的本质是**「在哪一层承认自己算不准」**。所有后端都只在 **turn 结束**给 usage，turn 内拿不到精确 token；Codex 真机也确认了这一点（流式与阻塞都只在 `turn.completed` 出现 usage）`[实测]`。因此能做的不是「实时精确硬停」，而是**准入控制（够不够开始）+ 事后记账 + 超限转人工**。

### 4.2 影响面

| 层 | 牵动点 | 现状证据 |
|---|---|---|
| 权威 usage | Claude/Codex/MCP 都调 `reportUsage`，但**生产代码没有任何 `onUsage` 订阅者**，事件是死端 | `[代码]` [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L1343-L1345)、[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L297-L301)、[codex.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codex.ts#L112-L119)；全仓 `onUsage` 仅测试引用 |
| 现有计量 | 只有按消息 `estimateTokens()` 的**线程级上下文占用**，落在 `chat_threads.context_tokens_used` | `[代码]` [chat-service.ts](file:///Users/zhumingchen/tiangong/src/main/services/chat-service.ts#L93-L135)、[chat-repository.ts](file:///Users/zhumingchen/tiangong/src/main/repositories/chat-repository.ts#L322) |
| 设计表 | `agent_usage` 只有 `turn_id/session_id/executor`，**没有 `graph_id`、没有日桶**，无法做项目/日级聚合 | 设计 §4.2 |
| 准入点 | 必须在 turn INSERT 的同一事务里查额度，否则跨节点并发两个 turn 都通过 | `[推断]` 基于 better-sqlite3 同步事务 |
| 排队联动 | 若 D-A 以后开启排队，**晋升时必须重新复核预算**，否则队首一开跑就超预算 | `[推断]` 与 §4.3 晋升事务直接相关 |
| UI | 成本展示、超限提示、单次放行审批 | 设计 §12 M1 |

**现在不定、以后返工代价高的**：`agent_usage` 的维度列（`graph_id/day_key/cost_micros`）。历史数据一旦缺 `graph_id`，就无法补算「某项目用了多少」；这是**不可回填**的。

### 4.3 选项

| 选项 | 收益 | 代价 | 最坏情况 | 适用 |
|---|---|---|---|---|
| D1 只做 turn 级预算 | 最简单；不入库聚合 | 跨 turn 无上限；一次批量能把额度烧穿 | 用户月底收到天价账单 | 早期试用 |
| **D2 项目×日 双层额度 + 准入拦截（推荐）** | 能真正兜底；与「谁会付费」对齐 | 需要价格表、估算标记、日界、超限审批 | 估算偏差导致误拦或漏拦 | 有明确付费方 |
| D3 每次模型调用硬停 | 最细粒度 | 12 个后端里只有 mcp 的宿主调用拿得到中途 usage；其余做不到 | 承诺了做不到的「实时硬停」，实际只能事后追认 | 不推荐 |

### 4.4 推荐值与可逆性

**D2：额度作用域 = 项目（`graph_id`）× 本地日；熔断层 = turn 准入；动作 = 拒绝新 turn + 人工单次放行。**

具体口径：
- **记账**：每次 turn 结束落一行 `agent_usage`，带 `graph_id`、`node_id`、`day_key`（本地时区）、`cost_micros`（整数微美元，避免浮点累计漂移）、`is_estimate`、`source`、`price_version`。**没有真实 usage 时写 `is_estimate=1`，不得用 0 伪造**（沿用 §3.2 `UsageSnapshot` 的口径）。
- **准入**：在 `INSERT agent_turns` 的同一 `BEGIN IMMEDIATE` 内查「项目当日已用 + 本 turn 最坏估算」；超限则拒绝并返回 `BUDGET_EXCEEDED`，不插入 turn。
- **不杀在途**：已运行的 turn 不因超限被杀。原因：杀在中途会留下半写文件，把成本问题变成恢复问题（§5.5 的 `needs-human` 会暴增）。
- **转人工**：超限后，用户可对**单次 turn** 显式放行（写一条审批/策略记录），而不是永久提高额度。
- **覆盖率门槛**：Claude/Codex/MCP 用真实 usage；7 个长尾 CLI 只有估算，UI 要标「估算」。在权威覆盖率上来之前，额度只做**告警**不做硬拦（否则误伤）。

**可逆性**：schema 现在补列是低成本；**以后再加维度几乎不可回填**。额度值、价格表、告警/硬拦开关都可配置。风险等级：低（schema）/ 中（硬拦策略）。

### 4.5 验证方式

- 单测：同一项目当日额度用尽 → 下一次 `INSERT agent_turns` 被拒；跨日 `day_key` 滚动后恢复；`is_estimate` 与真实 usage 分别落库；在途 turn 不被杀。
- 对账：`sum(agent_usage.cost_micros)` vs 供应商账单，按周比对；指标 `usage_estimate_ratio`（估算占比）、`overage_events`、`budget_reject_count`、`cost_variance_p95`。
- 故障注入：价格表缺失 / usage 缺失时不得放行成 0 成本，必须标估算并告警。

### 4.6 需要负责人提供

1. 计费单位是 **USD / credits / tokens** 哪一种？额度由**用户**还是**团队/组织**设置？
2. 日界按**本地时区**还是 UTC？额度按**项目（graph）**还是整个工作区/组织？
3. 输入、输出、缓存 token 是否同价？价格表由谁维护、多久更新？
4. 能否接受「估算」计入额度？若不能，长尾 CLI 是否直接**不参与额度**？
5. 超限后期望「硬停直到手动解除」还是「每次人工放行」？

---

## 5. D-E：长尾 CLI 是否投入工具事件

### 5.1 问题本质

工具事件不只是 UI 装饰，它是**崩溃恢复时区分「执行过 / 没执行」的证据**。对长尾 CLI，真正的选择是：投**宿主可验证的合成证据（文件 diff）**，还是投**厂商事件（要为 7 种不稳定的 stdout 格式各写 parser）**。

### 5.2 影响面

| 层 | 牵动点 | 现状证据 |
|---|---|---|
| 7 个适配器 | cline/kilo/kimi/codebuddy/qoder/qwen 全部 `runOneShot(..., { parseFileChanges: false })`；cursor 用默认 true | `[代码]` [cline.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/cline.ts#L67)、[kilo-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/kilo-code.ts#L67)、[kimi-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/kimi-code.ts#L67)、[codebuddy.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/codebuddy.ts#L63)、[qoder.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/qoder.ts#L57)、[qwen-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/qwen-code.ts#L58)、[cursor.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/cursor.ts#L70) |
| 现有 diff | `parseFileChanges` 是**文本正则**解析，不是厂商事件；存在把回答里提到的路径误判为变更的风险 | `[代码]` [base.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/base.ts#L619-L636)、`file-change-parser.ts` |
| Codex 实测 | 即使到了 item 级，`file_change` 也只有 `path+kind`、**无 diff**；item 级 ≠ diff 级 | `[实测]` `spikes/codex-stream/results/01b-filechange.json` |
| 恢复 | D5 要求「turn 起始快照 + 磁盘 hash 对账」；长尾 CLI 若 scope 为空，快照可能什么都没覆盖 | 设计 §5.5 |
| capabilities | `toolEvents: none` 写入 `agent_sessions.capabilities_json`，UI 只读它决定是否展示时间线 | 设计 §7.5 |
| Claude 现状 | Claude 也只消费 `text` block + `PostToolUse`，工具轨迹同样是 derived；不能只对长尾降级 | `[代码]` [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L281-L290) |

**现在不定、以后返工的**：capabilities 的初始声明（写错会让 UI 长期展示不存在的能力）；以及 **D5 快照的覆盖口径**——如果只快照 `allowedFiles`，长尾适配器（scope 常为空）就没有任何恢复证据。

### 5.3 选项

| 选项 | 收益 | 代价 | 最坏情况 | 适用 |
|---|---|---|---|---|
| E1 保持 `none` | 零成本、不撒谎 | UI 只有消息与少量 diff；恢复证据最薄 | 用户看不到「改了什么」，只能看 git | M0 |
| **E2 只投合成文件变更证据（推荐）** | 复用 D5 快照，7 个适配器零定制；`source=synthetic` 可审计 | 需要 git 工作树基线；非 git 仓库要 mtime/size 兜底；只有「改了哪些文件」没有工具名 | diff 误报/漏报；大仓库快照开销 | M1 |
| E3 为每个 CLI 解析结构化工具事件 | 时间线最完整 | 7 套格式 + 7 套夹具 + 持续跟版本；CLI 改输出就坏 | 维护成本吞掉功能收益；解析出错产生假工具事件 | 有强需求且用量高 |

### 5.4 推荐值与验收

**M0 如实声明 `toolEvents:'none'`；M1 做 E2；E3 只在有真实用量证明后按适配器逐个上。**

- E2 的事件标注必须是 `source=synthetic, fidelity=turn, postHoc=true`，UI 文案只能是「已执行，变更如下」，**禁止**出现工具名或「确认后执行」。
- E2 的快照口径：**turn 起始对 git 工作树做基线**（受 scope 限制的文件 + `git status` 变更集），turn 结束再对账；非 git 仓库退化为 scope 文件的 mtime/size/hash。这一条要写进 D5，否则长尾适配器没有证据。
- E3 的门槛：单适配器连续 4 周请求量进入前列，且有 3 组真实会话夹具能稳定解析；否则不做。

**可逆性**：E2 是增量能力，复用 `agent_artifacts`，关掉只是 capability 翻转；E3 按适配器隔离。风险等级：低（E2）/ 中（E3）。

### 5.5 验证方式

- E2 验收：每个适配器录 3 次真实会话，与 `git status` / `git diff --stat` 做 ground truth 对比，**文件级 precision/recall ≥ 95%**，且无凭空出现的路径。
- 回归：回答文本里「提到但没改」的路径不得被记为变更（针对现有正则 parser 的误报）。
- UI：capability 为 `none` 时时间线必须整块不渲染，不能显示空壳。

### 5.6 需要负责人提供

1. 这 7 个适配器的**实际用户占比/请求量**是多少？有没有数据？
2. 产品是否承诺「所有适配器都有一致的工具时间线」？若是，E3 的成本必须立项。
3. 是否接受**诚实降级**（长尾只显示文件变更，不显示工具名）？
4. 非 git 项目占比多少？决定 E2 的兜底成本。

---

## 6. 决策依赖图

```
                     ┌──────── 现在必须定（D1 建表/接口之前）────────┐
D-A 排队语义 ────────┼─► agent_turns.status='queued' 是否保留（CHECK 难改）
                     ├─► busy 错误契约（SESSION_BUSY / NODE_BUSY + retryable）
                     ├─► D-B：waiting_approval 是否占 session 锁 → 决定超时上限
                     └─► D-D：若将来排队，晋升时必须复核预算 → 准入逻辑要可复用

D-D 成本口径 ────────┼─► agent_usage 补 graph_id / day_key / cost_micros（不可回填）
                     ├─► 熔断层=turn 准入（与 INSERT 同事务）
                     └─► 额度值 / 价格表 / 硬拦开关（值可后调）

D-B 审批超时 ────────┼─► expires_at 起表时机 + 重启重推重计时（语义，现在定）
                     └─► 120s/30s 具体值（配置，可后调）

D-C Codex 流式 ──────┼─► 默认 runStreamed，以 turn.completed 判完成（现在定）
                     ├─► 取消语义 = AbortError + PGID 回收 → D4 取消 / D5 对账 / D6 恢复
                     ├─► 未闭合 item → aborted/unknown 入 stepOutcomes（现在定）
                     ├─► C7 file_change diff 复用 D5 快照
                     └─► capabilities 初始声明（M0 写 item/derived）

D-E 长尾工具事件 ────┼─► capabilities 初始声明（M0 写 none）
                     ├─► D5 快照覆盖 git 工作树（口径，现在定）
                     └─► E2/E3 是否投入（M1 再定）

可独立后置：D-E 的 E3、D-B 的具体秒数、D-D 的额度数值。
不可后置：D-C 的 C2/C3（取消与对账语义），否则流式默认开就是带病上线。
```

| 依赖边 | 类型 | 为什么锁死/可后置 |
|---|---|---|
| D-A → D-B | **锁死** | `waiting_approval` 若占 session 锁，超时值就是会话冻结上限；不先定 A 的锁语义，B 的「120s」没有意义 |
| D-A → D-D | **锁死（若开排队）** | 队首晋升必须重新做预算准入，否则「排队时没超、开跑就超」 |
| D-D → D1 schema | **锁死** | `graph_id/day_key` 缺失后无法补算历史项目成本 |
| D-B → D4 | **锁死** | `expires_at` 语义、重推重计时、无窗口不起表都要进 D4 |
| D-A → D1 schema | **锁死** | `queued` 是否进 CHECK 决定迁移形态；索引可后加 |
| **D-C → D4/D5/D6** | **锁死** | C3 的进程组回收、C2 的 aborted/unknown 对账、C1 的 `turn.completed` 完成判定，会同时改取消 IPC、stepOutcomes 与崩溃恢复；现在不做，默认流式就是带病上线 |
| D-C → D3 | 弱耦合 | 默认流式后 normalizer 直接消费 `item.*`；若回退 `run()`，同一 normalizer 仍兼容 |
| D-C → D5（C7） | **锁死（口径）** | `file_change` 无 diff，要展示 diff 必须复用 D5 的 turn 起始快照；快照口径不定，C7 无法验收 |
| D-E → D5 | **锁死（口径）** | 合成证据依赖 turn 起始快照；快照只覆盖 `allowedFiles` 会让长尾没有证据 |
| D-C ↔ D-E | 中 | 两者共同定义「工具时间线」的语义与 UI；Codex 能到 item，长尾只能到 turn，UI 必须按 capability 降级 |
| D-E → 投入范围 | 可后置 | 先声明 `none`，M1 再决定是否做 E2/E3 |

---

## 7. 建议的决策顺序与时间点

| 时间点 | 必须做的决定 | 推迟的后果 |
|---|---|---|
| **D1 建表前（现在）** | D-A 的 `queued` 枚举去留 + busy 错误契约；D-D 的 `agent_usage` 维度列与熔断层；D-B 的 `expires_at` 语义；**D-C 的取消语义（C3 进程组回收 + C2 aborted/unknown 对账 + C1 完成判定）**；D-E 的初始 capability 与 D5 快照口径 | 改 CHECK 要迁表；成本无法按项目回填；审批重推逻辑返工；**孤儿进程/中断对账要贯穿 D4/D5/D6 返工**；恢复证据缺失 |
| **D3 之前** | D-C 的默认流式分支与 capabilities（`item/derived`）；C6 环境前置校验接入 adapter 启动 | 先写死 `run()` 再改，normalizer 与 UI 能力位会漂移 |
| **M0 期间** | D-A 只做 fail-fast；D-B 只做「交互 120s / 无人值守 30s + 重推重计时」；D-E 只声明 `none`；**D-C 交付 C1–C7（C3 必须在本阶段闭环）** | 不影响 M0 验收，但 C3 不闭环则流式不能默认开 |
| **M1 之前（拿到数据后）** | D-A 是否开启排队（先跑 U6 spike）；D-C 的 20-turn 取消长跑与孤儿回收 soak；D-D 额度数值与硬拦开关；D-E 是否做 E2 | 过早开启 = 未验证的晋升进入生产；流式未 soak 就默认开 = 残留进程进用户机器 |
| **M1 之后** | D-E 的 E3（按适配器用量）；D-C 的 E3（绕过 SDK）仅在强沙箱需求出现时评估 | 不影响主线 |

**一句话**：**现在要定「形状 + 取消边界」**：枚举、表列、错误契约、capability 声明、快照口径，以及 **D-C 的进程组回收与中断对账**。数值（120s/30s、额度）可以等 M1；`graph_id/day_key` 不可回填，必须现在加。**「是否默认流式」已由真机实测回答：默认开，但前提是 C1–C7 同时落地。**

---

## 8. 需要负责人回答的问题清单

按决策分组，均为产品/业务事实，代码无法回答：

**D-A**
1. 是否存在无人值守的批量跑图 / 定时任务 / CI 式调用？
2. 单用户本机，还是多人共享同一执行器？
3. 用户能否接受「提交被拒后手动重试」，还是必须「提交即排队」？

**D-B**
4. 审批卡片典型是单文件小改还是多文件大 diff？
5. 用户是否会离开应用等待长任务？离开时期望自动拒绝还是保留？
6. 可接受的审批误拒率是多少？是否存在无人值守审批？

**D-C**
7. Codex 在目标用户中的占比？是否接受保留一个版本的 `codex.stream=false` 回退开关？
8. 是否接受 **item 级（非 token 级）** 进度，以及**命令字符串级**（非 argv 级）审批绑定？
9. 产品是否把「工具时间线」作为卖点？若否，流式只用于进度、不承诺逐工具解释？
10. 是否要求「取消后零残留」作为硬承诺？若是，C3 之外是否还要强制沙箱/容器化执行？
11. 配置损坏时只报错，还是允许产品代为修复 `~/.codex/config.toml`？（推荐只报错）

**D-D**
12. 计费单位（USD / credits / tokens）？额度由用户还是组织设置？
13. 日界时区？额度按项目（graph）还是工作区/组织？
14. 输入/输出/缓存 token 是否同价？价格表谁维护？
15. 能否接受估算计入额度？长尾 CLI 是否参与额度？
16. 超限后是「硬停直到手动解除」还是「每次人工放行」？

**D-E**
17. 7 个长尾适配器的实际用户占比/请求量？
18. 是否承诺所有适配器一致的工具时间线？
19. 是否接受长尾只显示文件变更、不显示工具名的诚实降级？
20. 非 git 项目占比多少？

---

## 9. 证据强度索引

| 结论 | 强度 | 依据 |
|---|---|---|
| fail-fast 可用、重入不死锁、归属零错误、锁 P99 < 0.03ms | **[实测]** | spike V4；`spikes/agent-core/tests/v4-concurrency.test.ts` |
| 超时 deny、迟到 allow 不执行、重复决定幂等 | **[实测]** | spike V7；`gateway.ts` 默认 60s，测试用 30ms |
| `running + queued` 两条部分唯一索引的当前语义 | **[实测]** | 评审 §0 第 5 条；架构 §4.3 |
| 适配器单实例、栈顶归属、`sendCommand` 无在途保护 | **[代码]** | ipc-handlers L119-120；base.ts L184-224、L458-461 |
| Codex `runStreamed` 存在、`StreamedTurn` 无 finalResponse、`command` 是字符串、`file_change` 只有 path+kind | **[代码]** | codex-sdk `index.d.ts` L6-17、L28-35、L104、L182-186、L206 |
| Codex 流式是 **item 粒度**：7 事件、`item.updated` 0 次、`item.started/completed` 同时间戳、`aggregated_output` 完成时一次性到达 | **[实测]** | `results/01-streamed.json`；本机 MiniMax provider |
| 流式与阻塞**同进程、同 turn、同 usage**，无重复计费（21220/106 vs 21214/109） | **[实测]** | `results/02-blocking.json`；SDK `index.js` L95-118 |
| 取消：`AbortError` 3-4ms、主进程 79-133ms 回收、4/4 次孙子命令变孤儿（`ppid=1`）、流中无中断标记 | **[实测]** | `results/03-abort-r1..r4.json` |
| `turn.completed` 后迭代器仍空转 ~10s（`lastEventToExitMs=10015`），阻塞式同样等 | **[实测]** | `results/01-streamed.json`、`04-cli-overhead.json` |
| 坏 `config.toml` 让 CLI exit 1 且 `--config` 无法覆盖；`codex doctor --json` 报 `config.load=fail` 但 exit 0 | **[实测]** | `README §0` + 本机 `codex doctor --json` 复测 |
| 权威 usage 事件无人订阅、只有线程级估算 | **[代码]** | base.ts L1343-1345；chat-service L93-135；全仓 grep |
| 7 个长尾适配器关闭文件变更解析 | **[代码]** | 各适配器 `runOneShot` 行号见 §5.2 |
| 审批 120s/30s、长尾 E2 的投入产出 | **[推断]** | 基于「交互占锁成本≈0」「合成证据复用 D5」的推理 |
| D-C 的 C2/C3/C6/C7 是正确性要求（而非优化项） | **[推断]** | 由「无中断标记 + 孤儿进程 + 配置解析先于覆盖」的实测事实推出 |
| 官方 OpenAI provider 下的事件集合（`reasoning`/`item.updated` 是否出现） | **[未验证]** | 本机是第三方 provider，结论不外推 |
| 跨平台 PGID 回收（Windows Job Object / macOS launcher） | **[未验证]** | 需在目标平台逐一实测 |
| 长尾 CLI 结构化输出格式、排队晋升并发安全 | **[未验证]** | 对应架构 §16 的 U1/U3/U6 |
| 用户审批决策延迟、实际额度与付费方 | **[未验证]** | 需真实产品数据，见 §8 |
