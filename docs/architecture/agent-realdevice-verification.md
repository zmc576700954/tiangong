# M0 真实 Electron 窗口端到端验收报告

- 执行时间：2026-11-04 23:52 – 2026-11-05 01:22（UTC+8）
- 环境：macOS arm64 / Electron（项目内 `node_modules/electron`）/ `@anthropic-ai/claude-agent-sdk` 0.3.286 / 真实 Claude CLI（本机可用凭据）
- 构建：`npx vite build`（生产构建产物 `dist/` + `dist-electron/`，非 mock）
- 运行方式：Playwright `_electron.launch` 启动**真实 Electron 主进程**；每次测试使用独立 `userData` 目录（`/tmp/bizgraph-realdevice/ud-*`），真实 SQLite（`userData/data/bizgraph.db`）
- 证据目录：`docs/architecture/evidence/`
- 测试脚本：`/tmp/bizgraph-realdevice/*.cjs`（仓库外临时脚本，不进入提交）

> 重要说明：本次验收发现 **AgentChatPanel 的正常 UI 不会调用 `agent:runNode`**。因此所有“新 runtime”测试都是通过 renderer 中已暴露的 preload IPC（`window.electronAPI['agent:runNode']`）注入触发，属于**受控入口**，不是普通用户路径。没有使用任何 mock、没有手工插库、没有伪造数据。
>
> 审批组件验证使用过一处**临时最小补丁**（`claude-code.ts` 的 `permissionMode` 在安装审批钩子时改为 `default`）。该补丁用于证明“弹窗组件本身可用”，测试完成后**已回滚**，最终 `src` 中该行为 `permissionMode: transparent ? 'default' : 'acceptEdits'`，`tsc --noEmit` 为 0。默认构建（无补丁）的真实行为见 §2.1。

---

## 结论先行

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 新 Kernel 路径是否可从 UI 触发 | **未通过（P0）** | `src/renderer` 中没有任何 `agent:runNode` 调用；正常 UI 只走旧 `AgentOutput` 路径。新能力在真实窗口里只能从 preload IPC 注入触发。 |
| 2 | 审批弹窗（写前拦截） | **默认构建失效（P0）；弹窗组件本身已验证** | 默认构建下 `acceptEdits` 使 `canUseTool` 永不触发，没有弹窗，`deny`/`timeout` 预期下文件仍被写入。临时改为 `permissionMode=default` 后，弹窗真实出现，allow/deny/timeout 全部符合预期，**拒绝时文件 hash 未变（文件不存在）**。 |
| 3 | `residual_risk` 徽标 | **已验证渲染；刷新 bug 仍在（P1）** | 徽标真实渲染为「残留无法确认」，数据来自 `agent:getSessionRecovery`。同一会话内 turn 结束后徽标不出现；切到别的会话再切回来才出现，bug 可稳定复现。 |
| 4 | 真实会话下的进程回收 | **已验证** | 真实 turn 进行中 `kill -9` 主进程 → 重启应用后，登记 PID/进程组被回收（`process.reclaimed`，reason=`startup-reclaim`），子进程确认死亡，残留扫描为空。 |
| 5 | 正常完成反向对照 | **已验证** | 正常结束不触发回收、无 `process.reclaimed` 事件、`residual_risk=none`。 |

---

## 1. 第一步：新 Kernel 是否可从 UI 触发

**结论：否（P0）。**

静态证据：

- preload 暴露了 `agent:runNode`：[preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L82)
- renderer 中**没有任何** `agent:runNode` 引用；实际发送路径仍为旧通道：
  - [agentStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/agentStore.ts#L158) → `agent:sendCommand`
  - [sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L326-L333) → `agent:resolveAndSendCommand` / `agent:sendCommand`
- 没有任何菜单、按钮、快捷键或设置项切换 Kernel/runtime。

真机验证：

- 正常启动真实应用并打开 Agent 面板后，`agent_turns` 为空（只有页面启动，没有任何 `runNode` 链路）。
- 本次全部 4 类真机测试都必须从 `window.electronAPI['agent:runNode']` 注入，否则无法进入 `runNode + ApprovalBridge + agent_events` 路径。

**最小可行接入建议（不改现有默认行为）**：在 `agentStore.sendMessage` 加一个仅开发构建可见的 `useKernelRuntime` 开关（设置项或 `localStorage`），开启时改走 `agent:runNode`，关闭时保持旧 `agent:sendCommand`；或提供仅 dev 菜单可用的“Kernel 调试会话”入口。不要直接把默认发送路径切到 Kernel，避免未验收前影响既有用户。

---

## 2. 审批弹窗（写前拦截）

### 2.1 默认构建真实行为：没有弹窗，写前拦截失效（P0）

复现步骤（`/tmp/bizgraph-realdevice/stage2d.cjs`）：

1. 隔离 `userData` 启动真实应用，`agent:startSession('claude-code')`，工作目录为临时空目录。
2. 通过受控入口 `agent:runNode` 发送：`Use only the Bash tool to run exactly: printf 'WRITTEN-WITHOUT-APPROVAL' > <ws>/written-without-approval.txt`。
3. 等待 20 秒，观察是否出现「写前审批」弹窗；随后等待 turn 完成。

实测结果（turn 01:19:49.606–01:19:58.790，`turn_adb9ceef-cff2-48fd-a057-ed95ccf36e65`）：

- `dialogSeen = false`，**没有弹窗**。
- 文件已写入，内容 `WRITTEN-WITHOUT-APPROVAL`。
- `agent_approvals` 为空（0 行）。
- `agent_steps.status = done`，但 `approved_at = null`，`executing_at` 已有值。
- turn 正常完成，事件序列包含 `tool.requested` / `tool.result`，说明工具确实执行了。

补充：在另一轮更早的默认构建测试中，三个本应“允许 / 拒绝 / 超时”的任务全部没有弹窗，三个文件都被写入（`ALLOW-TOKEN-7788`、`DENY-TOKEN-7788`、`TIMEOUT-TOKEN-7788`），`agent_approvals` 仍为空。

证据：

- 截图：[approval-default-no-prompt.png](evidence/approval-default-no-prompt.png)
- DB（`ud-stage2-clean`）：
  - `agent_approvals`：`[]`
  - `agent_steps`：`status=done, approved_at=null, executing_at=1793812795739`
  - `agent_turns`：`status=completed`
  - `agent_events`：`seq=4 tool.requested`、`seq=5 tool.result`

根因：

- [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L260) 固定使用 `permissionMode: 'acceptEdits'`。
- 用同一 SDK 的独立探针复现：`permissionMode='acceptEdits'` 时 `canUseTool` 调用次数为 **0**；`permissionMode='default'` 时 `canUseTool` 被调用。说明 `acceptEdits` 会直接放行工具（至少在本机 SDK/CLI 版本下，Bash 也被放行），审批回调被绕过。
- 这不是“弹窗没显示”，而是**根本没有产生审批请求**，属于语义级失效。

### 2.2 弹窗组件本身验证（临时补丁，已回滚）

为验证“如果审批请求真的产生，真实窗口能否正确弹窗/放行/拒绝/超时”，临时将 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts#L260) 改为：安装审批钩子时 `permissionMode='default'`。**该改动只用于本轮验证，已回滚，未提交。**

实测（会话 `claude-...`，工作目录 `/tmp/bizgraph-realdevice/ws-stage2b`）：

| 场景 | 弹窗 | 操作 | 文件结果 | DB（`agent_approvals`） |
|------|------|------|----------|-------------------------|
| 允许 | 出现（写前审批 · Bash，显示命令参数与风险） | 点击「允许」00:55:35.941 | `allow.txt` 写入，内容 `ALLOW-TOKEN-7788`，sha256 `cf6d90e3ade166c3fc41c2b386b3c48ed2a6165911b71a8458801d73a6286c9a` | `status=allowed, decided_by=user, timeout_ms=120000, created_at=1793811335695, decided_at=1793811335941` |
| 拒绝 | 出现（同样显示 Bash 命令） | 点击「拒绝」00:55:50.283 | `deny.txt` **不存在（ABSENT）**，hash 未变 | `status=denied, decided_by=user, created_at=1793811350029, decided_at=1793811350283` |
| 超时 | 出现，不点击 | 等待超时 | `timeout.txt` **不存在（ABSENT）** | `status=denied, decided_by=timeout, timeout_ms=120000, created_at=1793811493955, decided_at=1793811613961`（实际 120.006s） |

**核心证明：拒绝路径文件 hash 未变（文件根本未创建），这是写前拦截，不是“执行后提示”。**

截图：

- 允许弹窗：[approval-allow-dialog-1.png](evidence/approval-allow-dialog-1.png)
- 拒绝弹窗：[approval-deny-dialog-1.png](evidence/approval-deny-dialog-1.png)
- 超时弹窗：[approval-timeout-dialog.png](evidence/approval-timeout-dialog.png)
- 执行后：[approval-allow-after.png](evidence/approval-allow-after.png)、[approval-deny-after.png](evidence/approval-deny-after.png)、[approval-timeout-after.png](evidence/approval-timeout-after.png)

### 2.3 审批链路的附加风险

- `canUseTool` 可能被用户 `~/.claude/settings.json` 中的 allow 规则遮蔽（SDK 自身在代码里有该警告）。Kernel 会话若承诺“写前必拦截”，需要确认是否应隔离 settings 来源（例如 Kernel 会话固定 `settingSources`/权限规则），否则即使用 `default` 也可能被用户规则绕过。本次未做该专项验证，列为待验证风险。

---

## 3. `residual_risk` 徽标

### 3.1 徽标真实渲染：已验证

复现步骤（`/tmp/bizgraph-realdevice/stage3f.cjs`，最终回滚后的构建）：

1. 新建真实会话与两个线程：`Badge-A`（绑定该 sessionId）、`Badge-B`（不绑定）。
2. 刷新页面并打开 Agent 面板，选中 `Badge-A`；此时徽标数量为 0。
3. 触发一个**真实异常路径**：会话启动后删除工作目录，使 SDK 无法 spawn，产生无任何登记句柄的失败 turn。
4. 同一会话内 turn 结束后：徽标数量仍为 **0**（未刷新，bug 复现）。
5. 切到 `Badge-B` 再切回 `Badge-A`：徽标数量变为 **1**，显示「残留无法确认」。

证据：

- 会话恢复行（`ud-stage3f`）：`residual_risk="unconfirmed"`, `recovery_kills=0`, `recovery_note` 含异常说明，`turn_id` 为失败 turn。
- turn：`status=failed`。
- 徽标截图：[badge-01-before-turn.png](evidence/badge-01-before-turn.png)（切换前无徽标）、[badge-02-after-turn-same-thread.png](evidence/badge-02-after-turn-same-thread.png)（同会话结束后仍无徽标）、[badge-03-after-switch-back.png](evidence/badge-03-after-switch-back.png)（切回后出现「残留无法确认」）。
- 徽标数据来自 `agent:getSessionRecovery` 投影，不是前端伪造。

### 3.2 刷新 bug 是否仍在：**仍在**

- [AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L83-L101) 的恢复查询 effect 依赖只有 `currentSessionId`；turn 结束、取消、审批结束都不会触发重新拉取。
- 实测：同会话内 turn 结束后徽标仍为 0；只有 `currentSessionId` 变化（切会话再切回）才出现。
- 复现步骤即上面的 3–5 步。

### 3.3 残留语义的重要修正（实测结论）

- D5 重写后，Claude 走受控 spawn + 自有进程组，**有真实句柄**。因此多数真实取消/异常路径的 `residual_risk` 是 `none`（并且 `recovery_kills>0`、有 `process.reclaimed`），而不是任务背景里假设的 SDK 固定 `unconfirmed`。
- 实测 `unconfirmed` 出现在**没有登记句柄**的路径：
  - 在 CLI 进程 spawn 之前取消（`ud-stage3` 第一次尝试：`residual_risk=unconfirmed, recovery_kills=0`，turn 仅 58ms）；
  - 启动后工作目录被删导致 spawn 失败（§3.1）。
- 因此“SDK 会话下应显示 unconfirmed”这一描述**已与当前实现不符**，文档需要更新：Claude 有句柄时按 `none/possible` 判定；无句柄时才 `unconfirmed`。
- 另一个审计缺口：`unconfirmed` 场景（`killed=0, unresolved=0`）**不会写 `process.reclaimed` 事件**，审计上无法解释“为什么无法确认”。

---

## 4. 真实会话下的进程回收

### 4.1 turn 进行中 `kill -9` → 重启回收（已验证）

复现步骤（`/tmp/bizgraph-realdevice/stage4.cjs`，最终回滚后的构建）：

1. 隔离 `userData` 启动真实应用，启动 Claude 会话，创建线程并选中。
2. 通过受控入口发起真实长文本 turn。
3. 轮询 DB 等到 `agent_sessions.executor_pid` 落库（证明真实子进程已登记），记录 PID/PGID/命令/env marker；再等待 turn 处于运行中。
4. `kill -9` Electron 主进程，确认登记子进程成为孤儿（`ppid=1`）且仍存活。
5. 用同一 `userData` 重启应用；等待启动对账完成。
6. 查询 DB、进程表，并在 UI 中查看会话头部徽标。

实测结果：

- 回收前（`ud-stage4`）：
  - session `claude-84c5b7ad76a44a26be4365e37b35d33b`
  - `executor_pid=91972`, `executor_pgid=91972`
  - `executor_cmd` 含 `--permission-mode acceptEdits`（证明是回滚后的最终构建）
  - `executor_env_marker=bizgraph-turn:turn_3e7699b0-78e7-49f2-b0d1-62719fecb543`
  - turn `turn_3e7699b0-78e7-49f2-b0d1-62719fecb543`，`status=running`
- 重启后：
  - `agent_sessions.status=orphaned`, `residual_risk=none`, `recovery_kills=1`
  - `recovery_note = "startup reclaim: marker=bizgraph-turn:turn_3e7699b0-78e7-49f2-b0d1-62719fecb543 pids=91972 groups=91972 missing=- unresolved=- residualRisk=none"`
  - `agent_turns.status=orphaned`, `failure_class=crash`
  - `agent_events`：`seq=1 turn.started`（kernel）→ `seq=2 process.reclaimed`（kernel, reason=`startup-reclaim`）
  - 子进程 91972：**DEAD**
  - 按 `bizgraph-turn:turn_...` marker 扫描进程表：**NONE**
  - 会话头部徽标：0（因为 `residual_risk=none`，符合预期）

证据：

- 截图：[reclaim-01-turn-running.png](evidence/reclaim-01-turn-running.png)（kill 前 turn 运行中）、[reclaim-02-after-restart.png](evidence/reclaim-02-after-restart.png)（重启后）
- 关键 DB 行见上。

### 4.2 正常完成反向对照（已验证）

- `ud-stage1`：真实 Claude turn 正常完成。
- `agent_sessions.residual_risk=none`，`recovery_kills=0`，`recovery_note=null`。
- `agent_events` 中没有 `process.reclaimed`。
- 说明正常完成路径不会触发回收，也不会误写回收事件。
- 截图：[02-trivial-turn.png](evidence/02-trivial-turn.png)。

### 4.3 取消路径的对照

- 多数真实取消（`ud-stage3b` / `ud-stage3e`）在 CLI 已 spawn 后发生：`recovery_kills=1`，`process.reclaimed` 事件存在，`residual_risk=none`。
- 个别在 spawn 前的取消（`ud-stage3`）：`unconfirmed`，`kills=0`，没有 `process.reclaimed`（见 §3.3）。

---

## 5. 新发现的问题（按严重度排序）

### P0

1. **Kernel/runtime 未接入 renderer 会话入口**
   - `src/renderer` 无任何 `agent:runNode` 调用；正常 UI 仍走旧 `AgentOutput` 路径。
   - 影响：审批、`agent_events`、新回收路径在普通用户路径不可达；本轮验证依赖 devtools/preload 注入。
2. **默认构建的写前审批被 `permissionMode=acceptEdits` 绕过**
   - 实测 `deny`/`timeout` 预期下文件仍被写入，`agent_approvals` 为空。
   - 影响：M0 对外承诺的“写前拦截”在真实窗口不成立。
   - 建议修复：安装审批钩子时使用 `permissionMode='default'`（或为 Kernel 会话引入专用权限模式），并确认 settings allow 规则是否应隔离；修复后必须重跑本报告 §2 的 allow/deny/timeout 全流程。

### P1

3. **`residual_risk` 徽标不随 turn 结束刷新**
   - 仅 `currentSessionId` 变化时重新查询；turn 结束/取消/审批结束不触发。
   - 影响：用户看不到当前会话最新残留状态，必须切会话才会刷新。
4. **backend 归一化事件时间戳被固定为 `1760000000xxx`**
   - 实测 `agent_events` 中所有 `source=backend` 事件 `created_at` 为 1760000000001–0008，而 kernel 事件是真实时间。
   - 根因：[sink.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/normalize/sink.ts#L38) 的 `baseTimestamp` 缺省值；adapter-driver 构建 NormalizeMeta 时没有传真实基准时间。
   - 影响：审计时间线、按时间查询/排序、外部对账全部失真。
5. **审批事件顺序错乱**
   - 实测 `approval.required/resolved` 的 seq 追加在 `run.completed` 之后（如 allow turn：`run.completed seq=9`，`approval.required seq=10`，`approval.resolved seq=11`），但 wall-clock 上审批发生在工具执行之前。
   - 影响：按 seq 回放会把审批误认为发生在 turn 完成后；审计顺序不可信。

### P2

6. **审批倒计时初始值偏大**
   - 弹窗刚出现时显示「126 秒后自动拒绝」「141 秒后自动拒绝」，而 DB `timeout_ms=120000`。
   - 根因：`ApprovalRequestDialog` 的 `now` 状态在面板挂载时初始化，弹窗出现后的第一帧用旧 `now` 计算剩余时间；实际网关仍在 120s 超时（实测 120.006s）。
7. **`agent_steps.executing_at` 在审批创建时即写入**
   - 被拒绝的 Bash 步骤 `status=denied`，但 `executing_at` 已有值（`1793811350017`），`approved_at=null`。
   - 影响：审计上“已开始执行”的步骤其实从未获准执行，语义误导。
8. **`unconfirmed` 无 `process.reclaimed` 审计事件**
   - `killed=0, unresolved=0` 时只更新 session 字段，事件流里没有回收记录，无法解释“为什么残留无法确认”。

### P3

9. 用户 `~/.claude/settings.json` 的 allow 规则可能遮蔽 `canUseTool`（SDK 有内建警告）；Kernel 会话的审批是否需要隔离 settings 未验证。
10. 文档中“SDK 会话固定显示 `unconfirmed`”的表述已过时，应按“有无真实句柄”更新。

---

## 6. M0 在真实窗口下还差什么

1. **接入 UI**：至少提供一个开发用 Kernel 入口（开关/隐藏入口），让 `runNode`、审批、`agent_events` 不再只能从 preload 注入。
2. **修复审批权限模式**：安装审批钩子时不要用 `acceptEdits`；确认 settings allow 规则不会绕过写前拦截；修复后重跑 allow/deny/timeout 真机验证。
3. **修复徽标刷新**：订阅 turn/恢复/审批完成事件，或在 `runNode` 结束回调后主动刷新 `agent:getSessionRecovery`，不要只依赖 `currentSessionId`。
4. **修复审计**：backend 事件注入真实 `baseTimestamp`；保证 `approval.*` 按真实发生顺序写入；`executing_at` 只在审批放行后写；`unconfirmed` 路径补审计事件。
5. **修复倒计时 UI**：弹窗出现时重置 `now`，避免首帧显示大于实际超时的秒数。
6. **文档修订**：`residual_risk` 语义改为“Claude 有句柄时按 none/possible；无句柄才 unconfirmed”；删除或标注过时描述。
7. **平台覆盖**：本次仅 macOS arm64；Windows/Linux 的进程组回收与 marker 仍为未验证面。

---

## 7. 证据索引

| 证据 | 路径 / DB |
|------|-----------|
| 默认构建无审批弹窗 | `evidence/approval-default-no-prompt.png`；`ud-stage2-clean`：`agent_approvals=[]`、`agent_steps.approved_at=null`、文件已写入 |
| 允许弹窗 | `evidence/approval-allow-dialog-1.png`；`ud-stage2b`：`appr_e467c27f... status=allowed decided_by=user` |
| 拒绝弹窗 + 文件未变 | `evidence/approval-deny-dialog-1.png`、`evidence/approval-deny-after.png`；`appr_dd7b3eb0... status=denied`；`deny.txt=ABSENT` |
| 超时 | `evidence/approval-timeout-dialog.png`、`evidence/approval-timeout-after.png`；`appr_fbcb5bfd... decided_by=timeout, timeout_ms=120000, 实测 120.006s`；`timeout.txt=ABSENT` |
| 徽标渲染 + 刷新 bug | `evidence/badge-01-before-turn.png`、`badge-02-after-turn-same-thread.png`、`badge-03-after-switch-back.png`；`ud-stage3f`：`residual_risk=unconfirmed`，同会话 0 徽标，切回 1 徽标 |
| kill -9 回收 | `evidence/reclaim-01-turn-running.png`、`evidence/reclaim-02-after-restart.png`；`ud-stage4`：`pids=91972 groups=91972`，`process.reclaimed reason=startup-reclaim`，`recovery_kills=1`，子进程 DEAD |
| 正常完成反向对照 | `ud-stage1`：`residual_risk=none`、`recovery_kills=0`、无 `process.reclaimed` |

---

## 8. 清理与工作区状态

- 所有测试应用进程、Claude 子进程已退出；`ps` 扫描无 `bizgraph-realdevice`、无测试遗留 Claude SDK 子进程。
- 临时审批验证补丁已回滚；`src/main/adapters/claude-code.ts` 恢复为 `permissionMode: transparent ? 'default' : 'acceptEdits'`。
- `npx tsc --noEmit` 通过（0 错误）。
- 未 commit；未修改 `~/.codex`、未修改 `spikes/` 断言。
- 本次新增文件仅：本报告、`docs/architecture/evidence/` 下截图；测试脚本与隔离 `userData` 均在 `/tmp`（仓库外）。

---

# 第二轮：接线与修复复核（2026-11-05）

> 本节对应 §5 的 P0/P1/P2 修复结果。上一轮结论保留为历史记录；本轮只描述修复后的事实。
> 环境：macOS arm64 / Electron（项目内 `node_modules/electron`）/ 真实 Claude CLI；Playwright `_electron.launch` 启动真实主进程，真实 SQLite。

## 9. A1：Kernel 路径接入真实 UI（带开关，默认关）

### 9.1 开关名与开关方式

- 开关：环境变量 **`BIZGRAPH_AGENT_KERNEL`**，默认**关闭**（未设置即关闭）。
- 实现：[feature-flags.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/feature-flags.ts#L13-L21)，truthy 仅 `1 / true / yes / on`（大小写不敏感）。
- 打开：

```bash
BIZGRAPH_AGENT_KERNEL=1 npm run dev
# 打包后的应用：启动进程前设置同名环境变量即可
```

- 关闭：删除该环境变量，或显式设为 `0`。
- 关闭时行为：`AgentManager.sendCommand` 完全走原来的 `adapter.sendCommand`（旧 `AgentOutput` 路径），[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L581-L586) 的 Kernel 分支不会进入。
- **回退是一行改什么**：把 [feature-flags.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/feature-flags.ts#L17-L21) 的 `isAgentKernelEnabled()` 实现改成 `return false` 即可永久回退（等价于强制关闭，不需要改调用点）。

### 9.2 打开后 UI 消费能力保持不变

Kernel 接管后，本轮仍由同一个适配器实例执行（`runtime.runNode` 驱动内部调用 `adapter.sendCommand`），因此旧路径的 `AgentOutput` 广播不变：

- 流式消息：可见（`message.delta` → 气泡逐字更新）；
- 工具时间线：可见（`tool.requested` / `tool.result` → 折叠的工具卡片）；
- 审批弹窗：可见（`agent:onApprovalRequest` → 面板内弹窗）。

证据：`evidence/a3-01-first-write-dialog.png`、`a3-03-second-write-no-dialog.png` 中同时存在消息气泡与 `file_create` 工具卡片，没有出现「新路径跑起来但界面空白」。

### 9.3 路由可验证性（单元测试）

| 场景 | 测试名 | 文件 |
|------|--------|------|
| 关闭时零行为变化 | `A1 回归：Kernel 开关关闭时，sendCommand 仍走旧适配器路径（runNode 零调用）` | [agent-manager.test.ts](file:///Users/zhumingchen/tiangong/src/main/__tests__/agent-manager.test.ts) |
| 打开时改走 runNode | `A1：Kernel 开关打开时，sendCommand 改走 runNode（适配器不再被 manager 直接调用）` | 同上 |

## 10. A2：审批（首次弹窗 + 本次会话记住）

### 10.1 权限模式

安装 `canUseTool` 审批钩子时，Claude 适配器的 `permissionMode` 从 `acceptEdits` 改为 **`default`**，[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts)；未安装钩子的旧路径仍为 `acceptEdits`。

### 10.2 交互

- 首次写操作弹窗，三个选项：**拒绝 / 允许一次 / 允许本次会话**（[ApprovalRequestDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ApprovalRequestDialog.tsx)）。
- 选「允许本次会话」后，同一 session 内后续同类写操作不再弹窗，**但每次仍落一条审批行留痕**。
- 「拒绝」只作用于当前这一次，不记忆。

### 10.3 会话级授权的存储、范围、失效与撤销

| 维度 | 约定 |
|------|------|
| 存储位置 | `ApprovalGateway` 进程内存 `Map<sessionId, SessionGrantInfo>`，**不落库**；DB 只在**每次自动放行**时落一条 `agent_approvals` 行：`policy_decision='allow'`、`decided_by='policy'`、`grant_source=<首次授权 approval id>`、`cwd=<会话工作目录>`。 |
| 来源审计 | `agent_approvals.grant_source` 指回「哪一次用户授权覆盖了本次操作」，`agent_events` 的 `approval.resolved` 同时携带 `grantSourceApprovalId / autoGranted / scope`。 |
| 工具范围 | 仅写类工具（`toolScope='write'`：Write / Edit / MultiEdit 等）；**Bash 不覆盖**，每次仍需弹窗。 |
| 路径范围 | 仅允许会话工作目录内的路径；比较时对 root 与目标做 `realpath` 归一（见 10.4）。 |
| 会话结束 | 失效。`agent:terminateSession` → `runtime.endSession(sessionId)` → `gateway.endSession` 删除该授权。 |
| 重启 | **不继承**。内存态随进程消失；重启后即使 DB 有历史 `allowed` 行，也不会重建授权。 |
| 手动撤销 | UI 顶部绿色徽标「本次会话已授权（写操作）」右侧的「撤销授权」按钮 → `agent:revokeSessionGrant`；撤销后下一次写操作会重新弹窗。 |

### 10.4 真机自测暴露并修复的路径别名问题

首轮真机自测第二个写操作被重新弹窗并超时。根因：Claude 传入的绝对路径是 `/private/tmp/...`，而授权记录的 `cwd` 是 `/tmp/...`（macOS `/tmp → /private/tmp` symlink 别名），纯词法前缀比较判定为「目录外」。

修复：[gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L81-L116) 的 `isPathInside` 改为 realpath 归一：

- root 与目标能 `realpath` 时直接用真实路径；
- 目标尚不存在时，若目标在词法 root 内，把相对后缀映射到 real root；否则解析父目录（可识别 root 内 symlink 逃逸）；
- 都失败才退回词法绝对路径（只会误拒，不会误放）。

新增测试：`A2: 工作目录存在 symlink 别名（如 /tmp → /private/tmp）时仍能命中授权`。

### 10.5 真机证据（开关打开）

脚本：仓库外临时脚本（不提交），真实 Electron + 真实 Claude。流程全部通过 UI 操作完成：选中已有图 → 新建会话 → 输入消息 → 弹窗 → 点「允许本次会话」→ 第二次写 → 新建会话再写。

| 步骤 | 结果 | 证据 |
|------|------|------|
| 首次写弹窗 | 出现，卡片标题「写前审批 - Write」，三选项齐备，倒计时首帧 **120 秒** | `evidence/a3-01-first-write-dialog.png` |
| 允许本次会话 | 文件 `a3-first.txt` 创建；顶部徽标「本次会话已授权（写操作） / 撤销授权」即时出现，无需切换会话 | `evidence/a3-02-after-session-grant.png` |
| 同会话第二次写 | **无弹窗**（MutationObserver 全程未观察到审批卡片），文件 `a3-second.txt` 创建，徽标保持 | `evidence/a3-03-second-write-no-dialog.png` |
| 新会话再写 | 重新弹窗（卡片指向 `a3-newsession.txt`，倒计时 120 秒），允许后文件创建 | `evidence/a3-04-new-session-dialog.png` |

DB 行摘要（真实 Electron `userData`：`~/Library/Application Support/Electron/data/bizgraph.db`，完整转储见 `evidence/a3-db-rows.txt`）：

```
tool_name|status |decided_by|grant_source                       |cwd
Write    |allowed|user      |-                                  |/tmp/bizgraph-e2e-a3   <- 首次授权 appr_8cd90583-22d6-4fed-9019-46fb459b2ce5
Write    |allowed|policy    |appr_8cd90583-22d6-4fed-9019-...   |/tmp/bizgraph-e2e-a3   <- 同会话第二次写，自动放行但留痕
Write    |allowed|user      |-                                  |/tmp/bizgraph-e2e-a3   <- 新会话首次授权 appr_cfa9d69b-5f3b-4d1a-9025-5ee88fe5cf2e
```

内存授权（`agent:getSessionGrants`）：

```
{ sessionId: claude-f54c771d..., approvalId: appr_8cd90583..., toolScope: 'write', cwd: '/tmp/bizgraph-e2e-a3' }
{ sessionId: claude-3719596e..., approvalId: appr_cfa9d69b..., toolScope: 'write', cwd: '/tmp/bizgraph-e2e-a3' }
```

事件顺序（`agent_events`，同一 turn 内 seq 连续）：

```
turn_9cd333bc（首次，用户放行）  approval.required seq=2 → approval.resolved seq=3 → run.completed seq=12
turn_d10c9c9a（同会话第二次）    无 approval.required；approval.resolved seq=2 → run.completed seq=10
turn_2caa6de9（新会话首次）      approval.required seq=2 → approval.resolved seq=3 → run.completed seq=11
```

## 11. B：四项 bug 修复

| # | 问题 | 改法（一句） | 测试 |
|---|------|--------------|------|
| B1 | 徽标不刷新 | `AgentChatPanel` 增加 `sessionRevision`，订阅 `onAgentEvent`（turn/run 收口、审批解决、进程回收等）与 `onApprovalResolved` 后自增，并把它加入 sessionRecovery / sessionGrant 两个 effect 的依赖（[AgentChatPanel.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/AgentChatPanel.tsx#L87-L118)）；收口事件集合收口在 [sessionRefresh.ts](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/sessionRefresh.ts)。 | `turn 收口与审批解决事件触发刷新` / `流式增量事件不触发无意义的重复查询`（[sessionRefresh.test.ts](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/__tests__/sessionRefresh.test.ts)） |
| B2 | 时间戳被钉死为 `1760000000xxx` | [sink.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/normalize/sink.ts#L35-L45) 的 `baseTs` 缺省值改为 `null`，未注入基准时间时使用 `Date.now()`；仅测试显式注入时才用 `baseTs + seq`（生产不注入）。 | `B2: 未注入 baseTimestamp 时使用真实时钟，而不是 1_760_000_000_000 常量`（[normalizers.test.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/__tests__/normalizers.test.ts)） |
| B3 | 审批事件 seq 排在 `run.completed` 之后 | 删除驱动内批量 `auditEvents` 缓冲，`emitAudit` 在语义发生点直接 `context.record(...)`，由 `Runtime.record` 统一分配连续 seq（[adapter-driver.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts)）。 | `approval.required 与 approval.resolved 发生在 run.completed 之前，seq 连续`、`会话级授权命中时不产生 approval.required，resolved 事件携带 grantSourceApprovalId`、`拒绝时审批事件仍在工具结果事件之前`（[adapter-driver-approval.test.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/__tests__/adapter-driver-approval.test.ts)） |
| B4 | 倒计时首帧 126/141 秒 | 新增纯函数 `computeRemainingSeconds(expires_at - now)`，上界 clamp 到 `timeoutMs`、下界 0；弹窗在请求到达与首次 pending 加载时重置 `now`（[approvalCountdown.ts](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/approvalCountdown.ts)、[ApprovalRequestDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ApprovalRequestDialog.tsx)）。 | `倒计时以 expires_at - now 计算，首帧不会超过 timeout（陈旧 now 场景）`、`请求到达后首帧显示真实剩余秒数`、`过期后 clamp 到 0，不被负数击穿`、`payload 缺少 timeoutMs 时退化为 createdAt→expiresAt 区间`（[approvalCountdown.test.ts](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/__tests__/approvalCountdown.test.ts)） |

真机复核：B2/B3/B4 均在本轮 A3 运行中同步验证（事件时间为真实毫秒、审批事件在 `run.completed` 前且 seq 连续、弹窗首帧 120 秒）。

## 12. 验收报数（2026-11-05 第二轮）

| 项 | 结果 |
|----|------|
| `npx tsc --noEmit` | 0 错误 |
| `npx eslint src --ext ts,tsx --max-warnings 0` | 0 error / 0 warning |
| `npx vitest run` | **235 passed / 26 failed（文件）**；**2908 passed / 173 failed / 93 skipped（用例）** |

失败归因：**全部为既有 better-sqlite3 ABI 不匹配**（`NODE_MODULE_VERSION 130` vs 本机 Node 20 需要 `115`），共 26 个文件 / 173 条用例，与上一轮基线一致；**本次改动引入的失败为 0**。`registry-hardening.test.ts` 本轮通过（12 tests），上一轮记录的偶发 flaky 未复现。

本次新增/修改测试全部通过：

```
✓ src/main/agent/runtime/__tests__/approval-gateway.test.ts (13 tests)
✓ src/main/agent/runtime/__tests__/adapter-driver-approval.test.ts (3 tests)
✓ src/main/agent/runtime/__tests__/normalizers.test.ts (9 tests)
✓ src/main/__tests__/agent-manager.test.ts (43 tests)
✓ src/renderer/components/agent/__tests__/approvalCountdown.test.ts (4 tests)
✓ src/renderer/components/agent/__tests__/sessionRefresh.test.ts (2 tests)
✓ src/renderer/components/agent/__tests__/ChatHeader.sessionGrant.test.tsx (2 tests)
```

## 13. 开关关闭时的零变化证明

- 单测：`A1 回归：Kernel 开关关闭时，sendCommand 仍走旧适配器路径（runNode 零调用）`（断言 `runtime.runNode` 调用次数为 0，旧适配器仍收到 prompt）。
- 代码：关闭时 [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L581-L586) 直接落到原有 `sendCommandInner`；`agent:cancelSessionTurn` 等新通道在关闭时返回 `false`，`sessionStore.stopCurrentSession` 即使调用也没有副作用。
- 审批：`permissionMode` 只在安装 `canUseTool` 钩子时改为 `default`；未装钩子的旧路径仍是 `acceptEdits`。

---

## 14. 第三轮真机复核（Kernel 开关 + 会话级授权）

- 执行时间：2026-11-05 13:30 – 13:42（UTC+8）
- 开关：`BIZGRAPH_AGENT_KERNEL`（关闭组从启动环境中显式删除；开启组注入 `=1`）
- 入口：**全部通过真实 UI 输入框发送**（`sessionStore.sendMessage → agent:sendCommand → main`）。控制组/实验组都不再注入 `agent:runNode`；会话由 UI 首次发送创建（拒绝路径与徽标路径的会话准备见各条说明）。
- 环境：macOS arm64 / 项目内 Electron / 真实 Claude CLI；隔离 `userData`（`ud-k0` / `ud-k1a`）、真实 SQLite；构建产物为 13:10 的 `npx vite build`，本轮**未改任何业务源码**。
- 测试脚本（仓库外）：`/tmp/bizgraph-realdevice/stageK0.cjs`、`stageK1a.cjs`、`stageK1b.cjs`、`stageK1neg.cjs`。

### 14.1 逐项状态

| # | 验收项 | 状态 | 一句话结论 |
|---|--------|------|------------|
| 1 | 开关关闭对照 | **通过** | UI 正常回复；无审批弹窗；`agent_turns / agent_events / agent_approvals / agent_sessions` 全部 0 行。 |
| 2 | 开关打开 + 授权 / 二次写 / 撤销 | **通过** | 首写弹窗并「允许本次会话」→ 徽标立刻出现；同会话第二次写 0 弹窗；撤销后下一写**重新弹窗**。 |
| 3 | Bash 不继承 grant | **通过** | 授权后 Bash 仍弹窗；拒绝后目标文件 **ABSENT**（命令未执行）。 |
| 4 | 新会话首写拒绝 | **通过** | 拒绝后文件 hash 前后一致（ABSENT→ABSENT）。 |
| 5 | 重启不继承授权 | **未验证（受阻）** | 重启后 `getSessionGrants() = []`（授权确实是内存态，这一半已证实）；但**同会话 UI 发送直接失败**（见 14.6 新问题 P1），无法在 UI 上观察“同会话重新弹窗”；新会话首写仍正常弹窗。 |
| 6 | 徽标即时刷新 | **通过（bug 已修）** | 失败 turn 结束 2.5s 内徽标 0→1，**未切换会话**；正常会话徽标保持 0。 |
| 7 | 事件序与时间戳 | **通过** | 时间戳为真实时钟（`17938568xxxxx`，即 2026-11-05 13:33+08）；每 turn `seq` 连续；`approval.*` 均在 `run.completed` 之前。 |

### 14.2 第 1 项：开关关闭对照（零回归）

步骤：不设 `BIZGRAPH_AGENT_KERNEL` 启动 → 创建图（`projectPath=/tmp/bizgraph-realdevice/ws-k0`）与线程 → UI 输入 `Respond with exactly KERNEL-OFF-OK...` 并回车。

实测（13:30:49.545 发送，13:32:19 页面已出现回复）：

- 页面出现 `KERNEL-OFF-OK`，为真实 Claude 回复（旧 `AgentOutput` 流式路径）。
- 全流程 `dialogSeen = false`（无「写前审批」）。
- DB 前后对比完全相同：

```
agent_turns=0  agent_events=0  agent_approvals=0  agent_sessions=0
```

- 说明：关闭时完全没有进入 Kernel（否则至少会有 `turn.started` / `agent_sessions` 行）。
- 证据：[k0-01-before-send.png](evidence/k0-01-before-send.png)、[k0-02-after-send.png](evidence/k0-02-after-send.png)。

### 14.3 第 2 项：授权链路 + 撤销

同一 `ud-k1a`，`agent:getRuntimeFlags()` 返回 `{"kernelPath": true}`，UI 首写走 Kernel。

| 步骤 | 时间（UTC+8） | 弹窗 | 操作 | 结果 |
|------|---------------|------|------|------|
| A 首写 `k1-grant.txt` | turn 13:33:28.319 起 | 是（Write，`approval.required` seq=2 @13:33:34.895） | 「允许本次会话」@13:33:35.12 | 文件存在，sha256 `b47f46b5…3756eb`；徽标立即出现；`getSessionGrants()` 长度 1 |
| B 同会话第二次写 `k1-second.txt` | turn 13:33:38.435 起 | **否**（maxDialogSeen=0） | — | 文件存在，sha256 `d84bfe60…242f9f`；`agent_approvals` 行 `status=allowed, decided_by=policy, grant_source=appr_dec1846d…` |
| C 撤销授权 | 13:33:53.805 | — | 点击徽标内「撤销授权」 | 徽标数量 0；`getSessionGrants()=[]` |
| D 撤销后写 `k1-after-revoke.txt` | turn 13:33:53.906 起 | **是**（重新弹窗，seq=2 @13:33:57.843） | 「允许一次」@13:33:57.853 | 文件存在，sha256 `4bc6dbc4…e830804` |

**撤销授权实测结论：生效。** 撤销后内存授权立即归零、徽标消失，下一次写在真实窗口重新弹出审批，而不是静默放行。

事件（`agent_events`，同一 turn 内 seq 连续）：

```
turn_00e0bb0a  1 turn.started  2 approval.required(Write)  3 approval.resolved(allow,@13:33:35.201) … 11 run.completed
turn_73027ed6  1 turn.started  2 approval.resolved(allow, grantSource=appr_dec1846d) … 10 run.completed（无 approval.required）
turn_c9f2de07  1 turn.started  2 approval.required(Write)  3 approval.resolved(allow) … 10 run.completed
```

证据：[k1-grant-dialog-1.png](evidence/k1-grant-dialog-1.png)、[k1-02-after-session-grant.png](evidence/k1-02-after-session-grant.png)、[k1-03-second-write-no-dialog.png](evidence/k1-03-second-write-no-dialog.png)、[k1-05-after-revoke.png](evidence/k1-05-after-revoke.png)、[k1-after-revoke-dialog-1.png](evidence/k1-after-revoke-dialog-1.png)。

### 14.4 第 3 项：Bash 不继承 grant

- 13:33:45.504 起 `turn_20cb46ec`；13:33:49.325 弹出「写前审批 · Bash」（`{"command":"printf 'BASH-DENIED-TOKEN' > …/k1-bash-denied.txt","risk":"critical"}`）。
- 13:33:49.45 点「拒绝」；`agent_approvals` 行 `tool_name=Bash, status=denied, decided_by=user`。
- 目标文件 `/tmp/bizgraph-realdevice/ws-k1a/k1-bash-denied.txt` = **ABSENT**（hash 不存在），说明 Bash 命令**没有执行**，不是“执行后提示”。
- 此时写授权仍然有效（后续写不弹窗），证明 Bash 被排除在写授权作用域外，而不是 grant 被清空。
- 证据：[k1-bash-dialog-1.png](evidence/k1-bash-dialog-1.png)、[k1-04-bash-denied-after.png](evidence/k1-04-bash-denied-after.png)。

### 14.5 第 4 项：新会话首写拒绝（hash 取证）

- 新线程 `K1-Deny-Thread` → 新会话 `claude-38c0d130a254428da6602bc462c06149`；`turn_9402b28b` 13:34:07.008 起。
- 首次写即弹窗（Write `k1-deny.txt`），13:34:12.084 点「拒绝」。
- `hashBefore = ABSENT`，`hashAfter = ABSENT`；`agent_approvals` 行 `status=denied, decided_by=user`。
- 证据：[k1-deny-dialog-1.png](evidence/k1-deny-dialog-1.png)、[k1-07-deny-after.png](evidence/k1-07-deny-after.png)。

### 14.6 第 5 项：重启不继承授权（含新问题）

复现：

1. 用同一 `ud-k1a` 重启真实应用（`BIZGRAPH_AGENT_KERNEL=1`）。
2. `agent:getRuntimeFlags()` → `{"kernelPath": true}`；`agent:getSessionGrants()` → **`[]`**；`agent:getPendingApprovals()` → `[]`。
3. 选中原来已授权的线程 `K1-Grant-Thread`（会话 `claude-c7266d4c…`），UI 发送写 `k1-after-restart.txt`。

实测结果：

- **没有弹窗**，也**没有新建 turn**（`agent_turns` 无新行）；文件 ABSENT。
- UI 返回错误气泡：「无法启动 Agent 会话，请检查适配器是否可用。」（[k1-11-restart-same-session-result.png](evidence/k1-11-restart-same-session-result.png)）。
- 根因（静态证据）：[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L581-L586) 在 Kernel 分支先做 `this.router.resolve(sessionId)`；`SessionRouter` 是**内存态**，进程重启后不包含旧 session，直接抛 `SessionNotFoundError`，而 `sessionStore.sendMessage` 对已有 `thread.sessionId` **不会**重新 `startSession`（[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L275-L290)），于是整条会话不可用。
- 对照：重启后**新线程首次发送**仍正常创建会话并弹审批（`turn_54a3f295`，13:37:26 `approval.required`；拒绝后文件 ABSENT，[k1-12-restart-fresh-dialog.png](evidence/k1-12-restart-fresh-dialog.png)、[k1-13-restart-fresh-after.png](evidence/k1-13-restart-fresh-after.png)）。

**结论：**

- “授权是内存态、不跨重启继承”——**已验证**：重启后 grant 列表为空，且新会话首写必须弹窗。
- “同会话继续写必须重新弹窗”——**未能在 UI 上验证**：同会话在 Kernel 模式下重启后直接不可用（新发现的问题 P1-1）。因此这一条不能算通过，需要修复会话恢复/重放后重跑。

### 14.7 第 6 项：徽标即时刷新（正反确认）

- 正：准备一个工作目录在启动后被删除的会话 `claude-994b2a53…`（`agent:startSession` 后删除 `ws-k1a-badge`），选中该线程后徽标数量 **0**（[k1-14-badge-before-turn.png](evidence/k1-14-badge-before-turn.png)）。
- UI 发送后 turn 失败（`turn_1d1f3d1c`，13:37:34.931–13:37:34.935，`failure_class=runtime`）；2.5s 后**未切换任何会话**，徽标变为 **1**，文案「残留无法确认」（[k1-15-badge-after-turn-same-session.png](evidence/k1-15-badge-after-turn-same-session.png)）。
- DB：`agent_sessions.residual_risk=unconfirmed, recovery_kills=0`；`recovery_note="turn failed reclaim: killed=0 unresolved=- missing=- durationMs=76 residualRisk=unconfirmed"`；`agent:getSessionRecovery` 返回同一投影。
- 反：正常会话 `K1-Grant-Thread`（`residual_risk=none`）徽标数量 **0**（[k1-16-badge-negative-normal-session.png](evidence/k1-16-badge-negative-normal-session.png)）。
- **上一轮“必须切会话才刷新”的 bug 已修复**：本轮同会话收口即刷新，无切换动作。

### 14.8 第 7 项：事件序与时间戳

- 时间戳：本轮所有 `agent_events.created_at` 均为真实毫秒（如 `1793856808319` = 2026-11-05 13:33:28.319 +08），**全库未再出现 `1760000000xxx`**。
- `seq`：每个 turn 从 1 连续递增（示例 turn_00e0bb0a 1..11、turn_3d6cea05 1..19）。
- 顺序：`approval.required / approval.resolved` 的 seq 均小于 `run.completed`（示例 2/3 < 11）。
- 轻微残留（P2，不影响判定）：
  - backend 归一化事件（`run.started / tool.* / message.completed / run.completed`）在同一批 flush 时共享同一个 `created_at`（毫秒相同），真实发生顺序只能靠 `seq` 还原。
  - 授权复用时会出现一条额外的 `approval.resolved`（`turn_3d6cea05` seq=3 与 seq=4 都指向同一 `grant_source`），属于审计噪声。

### 14.9 Bash 弹窗频率（主观感受）

- 实测“典型任务”（两次 Write + 一次 `node --check` Bash）：**2 次弹窗**——首个 Write 一次（选「允许本次会话」），Bash 一次；第二个 Write **0 次**（[k1-typical-dialog-1.png](evidence/k1-typical-dialog-1.png)、[k1-typical-dialog-2.png](evidence/k1-typical-dialog-2.png)）。
- 结论：授权只覆盖**写操作**；只要 Agent 调 Bash，就**每次命令弹一次**。一个真实编码任务通常有多次 `ls / test / git / 构建`，按经验会在 **3–6 次/任务**，明显比只在“首次写”弹一次更打断心流；纯写任务则只有首次 1 次。

### 14.10 新发现的问题（按严重度）

| 级别 | 问题 | 证据 |
|------|------|------|
| **P1** | **Kernel 模式下重启后旧会话不可继续**：`SessionRouter` 内存态 + `sendCommand` 先 `resolve` 抛 `SessionNotFoundError`，UI 直接报“无法启动 Agent 会话”，该线程此后不可用（不会自动重建/恢复）。 | [k1-11-restart-same-session-result.png](evidence/k1-11-restart-same-session-result.png)；代码 [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L581-L586)、[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L275-L290) |
| P2 | backend 归一化事件时间戳在 flush 时统一取值，无法反映真实毫秒级发生顺序（需靠 seq）。 | turn_3d6cea05 seq 7..19 的 `created_at` 全部为 `1793856868019` |
| P2 | 授权复用会重复落一条 `approval.resolved`（同一 grant_source），审计上略噪声。 | turn_3d6cea05 seq=3/4 |
| P2 | 拒绝 Bash 后 turn 仍继续（`run.completed` 正常），审批拒绝只阻断该工具，不终止 turn；若用户预期“拒绝即中止”会产生误解。 | turn_20cb46ec：拒绝后仍有 `run.started…run.completed` |

> 本轮未改变业务源码，未 commit，未改 `~/.codex`；测试结束已确认无 Electron / `bizgraph-turn:` 标记的残留进程。

### 14.11 是否够格把开关翻成默认开启

**结论：还不够格。** 正面证据：开关关闭零回归、审批/授权/撤销、Bash 拒绝不执行、拒绝 hash 不变、徽标即时刷新、事件时间戳与顺序全部达标。但在默认开启前至少还差三件事：

1. **先修 P1 重启会话连续性**：否则用户重启应用后，Kernel 模式下的历史线程全部变成“无法启动 Agent 会话”，这是阻断级回归。
2. **明确 Bash 的授权策略**：当前“写授权”不覆盖 Bash，实测典型任务 3–6 次弹窗。默认开启需要提供“只读/安全命令”分级或批量授权，否则交互成本过高。
3. **补做 settings allow 规则隔离验证**：`canUseTool` 可能被用户 `~/.claude/settings.json` 的 allow 规则遮蔽（上一轮已列为风险，本轮未专项验证）；默认开启前需证明写前拦截不会被用户配置绕过。

满足上述 3 项并重跑本表 7 项后，才建议把 `BIZGRAPH_AGENT_KERNEL` 翻成默认开启。

---

## 15. 第四轮真机复核（重启续接）

- 执行时间：2026-11-05 14:10 – 14:19（UTC+8）
- 构建：`npx vite build`（14:08 产物）；本轮**未改任何业务源码**。
- 入口：全部通过真实 UI 输入框发送；会话由 UI 首次发送创建。
- 测试脚本（仓库外）：`stageR4a.cjs`（正常续接）、`stageR4c.cjs`（崩溃残留）、`stageR4d.cjs`（僵尸审批）、`stageR4e.cjs`（错误对象探针）。

### 15.1 逐项状态

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 重启续接（正常收尾） | **通过** | 重启后同一 thread 直接发写请求：弹窗出现、新 turn 正常完成、不再报「无法启动 Agent 会话」。 |
| 2 | 不继承授权 | **通过** | 重启前 `getSessionGrants()=1` 且徽标为 1；重启后为 `[]`，首次写必须弹窗（`decided_by=user`）。 |
| 3 | 无重复行 + recovery_note | **通过** | `agent_sessions` 行数 1→1→1，id 不变；note 含 `restore: rebuilt handle from agent_sessions`。 |
| 4 | 在途 turn 不复活 + 提示可读 | **失败（后半项）** | 旧 turn 不重放、旧工具不执行（含僵尸审批点击也不执行）；但**崩溃后新请求无法续接**，UI 只显示原始 CLI 错误，无可读提示。 |
| 5 | 不支持续接的可读提示 | **未通过** | Cursor/opencode 未触发（CLI 不可用，未验证）；低成本代理路径只显示通用「无法启动 Agent 会话」，可读文案实际到不了 UI（见 15.4）。 |
| 6 | 回归抽查（徽标 / 事件） | **通过** | 失败 turn 后徽标 0→1 且不切会话；时间戳真实、seq 连续、`approval.*` 在 `run.completed` 前。 |

### 15.2 第 1–3 项：正常重启续接（主项）

复现（`ud-r4a`，`BIZGRAPH_AGENT_KERNEL=1`）：

1. 新建会话 `claude-c96224d4fb874ef384b52a898f5cd4b2`，首轮写 `r4-a.txt` → 弹窗 → 「允许本次会话」。
   - turn `turn_e6d15ebb-2c39-4fd1-ad19-10455a183927`，14:11:34.125 → 14:11:47.254；
   - 徽标 1，`getSessionGrants()` 长度 1；`run.started` 落库 `backendSessionId=4feb9e43-b36c-4302-ac3c-2138d2a08cc4`。
2. 关闭应用（`app.close()`），1.5s 后用同一 `userData` 重启。
3. 同一 thread 直接发写 `r4-b.txt`：
   - **弹窗出现**（Write，[r4-post-restart-write-dialog-1.png](evidence/r4-post-restart-write-dialog-1.png)），点「允许一次」；
   - 新 turn `turn_76ce32da-ec49-42c8-a508-a4f736cbdf30`，14:11:57.673 → 14:12:15.504，`status=completed`；
   - 文件存在 `sha256=cef9d198…4f21bb`；**无“无法启动/无法恢复”错误**。

DB（第 3 项）：

```
agent_sessions 行数：重启前 1 → 重启后（未发送前）1 → 续接后 1
id 完全一致：claude-c96224d4fb874ef384b52a898f5cd4b2（重复行 = false）
recovery_note =
"startup reclaim: marker=none pids=- groups=- missing=- unresolved=- residualRisk=none |
 restore: rebuilt handle from agent_sessions; resumeMode=native
 backendSessionId=4feb9e43-b36c-4302-ac3c-2138d2a08cc4;
 scope constraints are not persisted → every write still requires approval"
```

重启后 `getSessionGrants()=[]`、`getPendingApprovals()=[]`；首次写仍弹窗（第 2 项通过）。

证据：[r4-01-before-restart.png](evidence/r4-01-before-restart.png)、[r4-02-first-turn-granted.png](evidence/r4-02-first-turn-granted.png)、[r4-03-after-restart-before-send.png](evidence/r4-03-after-restart-before-send.png)、[r4-04-post-restart-after.png](evidence/r4-04-post-restart-after.png)。

### 15.3 第 4 项：崩溃残留在途 turn

复现（`ud-r4c`）：

1. 发起 Bash 写命令，审批弹窗挂起（turn `turn_1d29589b-c9c3-4814-8a8d-bac6114af723`，14:16:29.391 `approval.required`，`agent_approvals.status=pending`）；
2. `kill -9` 主进程；DB 中 turn 仍 `running`，session `active`，登记 `executor_pid=93406`；
3. 重启应用：
   - 旧 turn → `orphaned, failure_class=crash`（14:16:33.071）；
   - session → `orphaned, recovery_kills=1, residual_risk=none`，note=`startup reclaim: marker=bizgraph-turn:... pids=93406 groups=93406 ...`；进程 93406 已死；
   - 旧 turn 的 `agent_events` 只有 3 条（`turn.started / approval.required / turn.orphaned`），**没有重放工具**；`crash.txt` 不存在；旧 approval 行仍 `pending`。

**但后续请求失败：**

- 重启后发 `Respond with exactly AFTER-CRASH2-OK...`，新 turn `turn_f94d63a9-6325-4c3e-9610-e09d81d5e317` 立即 `failed`；
- `turn.failed` 事件原文：

```
Error: --resume requires a valid session ID or session title when used with --print.
Usage: claude -p --resume <session-id|title>.
Provided value "claude-57956f9a8d544949b32b4c2c3ebcc325" is not a UUID and does not match any session title.
```

- 根因：崩溃发生在 backend `run.started` 之前（审批阶段），该 turn 没有 `backendSessionId` 快照；恢复时回退到 `row.runtime_session_id`（本项目内部 id `claude-5795…`，不是 Claude UUID），CLI 拒绝 resume。
- UI 未做可读转换：聊天区直接显示原始英文 CLI/SDK 错误（[r4-13-crash2-after-new-request.png](evidence/r4-13-crash2-after-new-request.png)），不是「无法恢复会话…新建会话可继续」。
- 补充：重启后旧审批弹窗仍会显示（倒计时重启，112s），点击「允许一次」后 DB 变为 `status=allowed`，但 `crash.txt` **仍未创建**、无新 turn——属于“僵尸审批”：视觉上批准成功，实际什么也没执行，审计状态失真（[r4-14-zombie-approval-before.png](evidence/r4-14-zombie-approval-before.png)、[r4-15-zombie-approval-after.png](evidence/r4-15-zombie-approval-after.png)）。

证据：[r4-11-crash2-turn-pending.png](evidence/r4-11-crash2-turn-pending.png)、[r4-12-crash2-after-restart.png](evidence/r4-12-crash2-after-restart.png)、[r4-13-crash2-after-new-request.png](evidence/r4-13-crash2-after-new-request.png)。

### 15.4 第 5 项：不支持续接的可读提示

- Cursor/opencode 路径未触发（本机 CLI 不可用；用 `agent:startSession` 也起不来），**该项未验证**。
- 低成本代理路径（thread 指向不存在的会话 `opencode-fake-session-id`）：UI 只显示「无法启动 Agent 会话，请检查适配器是否可用。」（[r4-08-unresumable-message.png](evidence/r4-08-unresumable-message.png)），没有「无法恢复会话…新建会话可继续」。
- IPC 探针（`stageR4e`）确认：renderer 收到的不是结构化错误对象，而是一个普通 `Error`：

```
name: "Error"
message: "Error invoking remote method 'agent:sendCommand': [object Object]"
code: undefined  reason: undefined  canStartNewSession: undefined
```

因此 [sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L346-L377) 里的 `AGENT_SESSION_RESTORE_FAILED / 新建会话可继续` 分支永远不会命中，所有恢复失败都会退化成通用文案。

### 15.5 第 6 项：回归抽查

- 徽标即时刷新：工作目录删除导致的失败 turn（`recovery=unconfirmed, kills=0`）结束后 2.5s，同会话徽标 **0→1**（「残留无法确认」），未切换会话（[r4-09-badge-before.png](evidence/r4-09-badge-before.png)、[r4-10-badge-after.png](evidence/r4-10-badge-after.png)）。
- 事件序/时间戳：`turn_76ce32da…` 的 `created_at` 为 `1793859…`（14:11–14:12 +08，真实时钟），`seq=1..9` 连续，`approval.required(seq2)/resolved(seq3)` 在 `run.completed(seq9)` 之前。

### 15.6 新发现的问题

| 级别 | 问题 | 证据 |
|------|------|------|
| **P1** | **崩溃残留在途 turn 后无法续接**：无 backendSessionId 时回退到内部 session id，CLI resume 失败，线程进入持续报错状态。 | `turn_f94d63a9…` 的 `turn.failed` 原文；15.3 |
| **P1** | **恢复失败的 IPC 错误序列化丢失结构**：renderer 只收到 `[object Object]`，可读文案`无法恢复会话…新建会话可继续`分支不可达。 | `stageR4e` 探针；[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L346-L377) |
| **P1** | **僵尸审批**：重启后旧 pending 审批会重新弹窗并可点「允许」，DB 记为 allowed，但工具不执行、不产生新事件。 | [r4-14](evidence/r4-14-zombie-approval-before.png)、[r4-15](evidence/r4-15-zombie-approval-after.png) |
| P2 | 启动清扫会给已正常收尾的会话追加 `startup reclaim: marker=none...` note（噪声）。 | 15.2 note 前半段 |
| P2 | Bash 命令并非一律弹窗：本轮 `sleep 30` 未弹窗直接执行，`printf > file` 才弹窗——上一轮“每条 Bash 都弹”的表述需按命令风险分级修正。 | `ud-r4b` 首个 turn 无 approval 行；`ud-r4c` Bash 写命令有 approval |

> 本轮未改变业务源码，未 commit，未改 `~/.codex`；结束已确认无 Electron / `bizgraph-turn:` 残留进程。

### 15.7 阻断问题是否关闭 / 是否够格翻默认

- **正常收尾后的重启续接：已关闭。** 同一 thread 可直接继续，弹窗、授权不继承、无重复行、note 留痕均达标。
- **崩溃残留场景：未关闭。** 新请求会因 `--resume` 拿到内部 id 而失败，且提示不可读；僵尸审批还会让审批审计与实际执行不一致。
- **默认开启结论：仍不够格。** 需要先修：
  1. 崩溃场景的 backendSessionId 选择（没有快照时应放弃 native resume 并给出可读的「无法恢复会话…新建会话可继续」，而不是拿内部 id 去 `--resume`）；
  2. IPC 错误结构化透传（让 `SessionRestoreError.code/message` 到达 renderer）；
  3. 重启时清理/失效旧的 pending 审批，避免僵尸弹窗与假 allowed。
- Bash 逐条/分级弹窗问题**仍会阻塞默认开启的交互体验**（与上述正确性问题独立）：写类命令仍逐条弹；本轮补充了 `sleep` 这类低风险命令会被放行的证据，说明策略是分级的，但用户侧仍缺少“安全命令批量授权”的预期管理。

---

## 16. 第五轮真机复核（第四轮三条 P1）

- 执行时间：2026-11-05 14:47 – 15:02（UTC+8）
- 构建：施工方改动后 `npx vite build` **默认配置失败**（preload 缺 `@shared` alias，见 16.7）；为跑真机用仓库外临时配置补 alias 出包，临时配置已删除，`vite.config.ts` 与业务源码均未改。
- 入口：真实 UI 输入框发送 + 真实窗口 `window.electronAPI` 直调；隔离 userData（`ud-r5a` … `ud-r5d`）。
- 脚本（仓库外）：`stageR5a.cjs`（崩溃残留 + IPC 探针）、`stageR5b.cjs`（活 turn 批准 / 陈旧审批）、`stageR5c.cjs`（僵尸审批）、`stageR5d.cjs`（回归）以及 `quitprobe2.cjs`（退出耗时复测）。

### 16.1 逐项状态

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 崩溃残留在途 turn → 重启 → 同 thread 发请求 | **通过**（上轮失败项已修复） | 不再拿内部 id 去 resume；UI 显示「记录到的是内部会话 id（不可作为原生 id）…新建会话可继续」，无原始 CLI 报错。 |
| 2 | IPC 错误可读（端到端） | **通过** | 探针精确返回 `{ok:false,error:{code:'APPROVAL_NOT_FOUND',message:'Approval not found: nope'}}`；真实恢复失败在 UI 显示人话，无 `[object Object]`。 |
| 3 | 僵尸审批（弹窗后直接退出） | **通过** | 重启后卡片不再出现；DB 为 `denied / startup / startup reconcile: …`。 |
| 4 | 陈旧审批实时路径 | **通过**（附 UI 提示缺陷） | 停止后允许 → `APPROVAL_STALE`，行转 `denied / system`，无「记 allowed 但无执行」；但该错误横幅被组件提前 `return null` 吞掉（见 16.7）。 |
| 5 | 活 turn 批准要真执行 | **通过** | 允许一次后命令确实执行（文件写入），事件 `approval.resolved → run.started → tool.requested → tool.result → run.completed` 完整。 |
| 6 | 回归抽查 | **通过** | 重启续接（同一 backendSessionId）、会话行 1 条无重复、授权不继承、徽标 0→1 即时刷新。 |

### 16.2 第 1 项：崩溃残留在途 turn（上轮失败项）

复现（`ud-r5a`，`BIZGRAPH_AGENT_KERNEL=1`）：

1. 首轮 turn `turn_2e801ead-8af0-43c5-abe5-96ddb168d5dc`：
   - 14:50:48.763 `turn.started`；
   - 14:50:55.125 `approval.required`（Bash 写命令，`argsHash=6698be…2908`）；
   - **`run.started` 计数 = 0**（后端尚未建立原生会话），此时对主进程 `kill -9`。
   - 截图：[r5-02-residual-before-kill.png](evidence/r5-02-residual-before-kill.png)。
2. 重启（14:51:07 窗口就绪）：
   - 旧 turn → `orphaned / failure_class=crash`；
   - session `claude-981bd4cd9cc247dc836af3c5526fe024` → `orphaned, residual_risk=none, recovery_kills=0`（登记 pid 已随进程消失）；
   - 旧 approval → `denied / decided_by=startup / decision_note="startup reconcile: previous process ended; no waiter can execute this approval"`；
   - `getPendingApprovals()=[]`，审批卡片数 0；`agent_events` 仅 3 条（`turn.started / approval.required / turn.orphaned`）。
   - 截图：[r5-03-residual-after-restart.png](evidence/r5-03-residual-after-restart.png)。
3. 同一 thread 再发写请求：
   - **不创建新 turn**（`newTurns=0`），也不再把内部 id 传给 CLI；
   - UI（14:51:15）显示：

```
无法恢复会话 claude-981bd4cd9cc247dc836af3c5526fe024：
记录到的是内部会话 id（不可作为原生 id），没有可续接的底层会话。新建会话可继续。
```

   - `recovery_note` 追加 `restore degraded: rejected internal session id "claude-981bd4cd9cc247dc836af3c5526fe024" as native resume id (no run.started session_id)`；
   - 全文检索：`--resume` 原始报错 **0 次**，`[object Object]` **0 次**（`stageR5a` 断言 `hasRawCliError=false`）。
   - 截图：[r5-04-residual-readable-error.png](evidence/r5-04-residual-readable-error.png)。

结论：上轮「回退内部 id → CLI `--resume` 失败」的路径已被 [native-session-id.ts](file:///Users/zhumingchen/tiangong/src/shared/native-session-id.ts) 与 [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L715-L756) 的 `rejectedInternalId` 分支切断，且提示可读。

### 16.3 第 2 项：IPC 错误可读（端到端）

真实窗口 DevTools 等价调用：

```js
await window.electronAPI['agent:resolveApproval']({ approvalId: 'nope', decision: 'allow', argsHash: 'h' })
// => {"ok":false,"error":{"code":"APPROVAL_NOT_FOUND","message":"Approval not found: nope"}}
```

- 返回值是**普通对象**（不再 reject 后丢自定义字段），`error.code/message` 完整。
- 真实恢复失败（16.2 第 3 步）经 `agent:sendCommand` → [preload/index.ts](file:///Users/zhumingchen/tiangong/src/preload/index.ts#L236-L244) → [ipcResult.ts](file:///Users/zhumingchen/tiangong/src/renderer/lib/ipcResult.ts) `unwrapIpcResult` 后，UI 显示上面那段中文人话；无 `[object Object]`。
- 证据：[r5-01-approval-not-found-probe.png](evidence/r5-01-approval-not-found-probe.png)、[r5-04-residual-readable-error.png](evidence/r5-04-residual-readable-error.png)。

### 16.4 第 3 项：僵尸审批

复现（`ud-r5c`）：

1. Bash 写命令触发审批，**不点任何按钮**；退出前（14:57:09）`agent_approvals.status=pending`，`run.started=0`（截图 [r5-10-zombie-dialog-before-quit.png](evidence/r5-10-zombie-dialog-before-quit.png)）。
2. 调用 `app.quit()`（macOS `Cmd+Q` 同一路径）：
   - `close` 事件正常返回，进程实际退出（独立探针 `quitprobe2` 测得当刻挂起审批时进程 259ms 退出；无审批基线约 5.6s）。
   - 退出前 DB 仍为 `pending`（优雅退出不会“顺手”批准或结算）。
3. 重启（14:57:10.595 启动对账）：
   - 卡片数 **0**，`getPendingApprovals()=[]`；
   - 旧 turn → `orphaned / crash`；
   - 该行：

```
status=denied
decided_by=startup
decision_note="startup reconcile: previous process ended; no waiter can execute this approval"
```

   - 截图：[r5-11-zombie-after-restart.png](evidence/r5-11-zombie-after-restart.png)。

结论：上轮「重启后旧审批仍可点、DB 记 allowed 但无执行」已被 [gateway.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/approval/gateway.ts#L372-L392) 的 `reconcileStartup` 关闭。

### 16.5 第 5 / 4 项：活 turn 批准真执行 + 陈旧审批

**第 5 项（`ud-r5b` / R5-Live）**：

- Write 审批（`argsHash=a5fec1…ff90`）→ 点「允许一次」；
- turn `turn_d62c26b6-e2b4-4ebf-a72f-3bf76a9f9533`：14:54:57.319 → 14:55:05.957，`completed`；
- 文件 `live.txt` = `LIVE-R5`（`sha256=fbe28b16…8e29`）；
- approval 行 `allowed / decided_by=user`；
- 事件序：`turn.started(1) → approval.required(2) → approval.resolved(3) → run.started(4) → message.completed(5) → tool.requested(6) → tool.result(7) → run.completed(10)`。
- 截图：[r5-05-live-approval-dialog.png](evidence/r5-05-live-approval-dialog.png)、[r5-06-live-approved-executed.png](evidence/r5-06-live-approved-executed.png)。

**第 4 项 A（停止后控制台允许，`R5-Stale`，Bash 写）**：

- 14:55:12.303 turn started；14:55:18.005 `approval.required`；点「停止」→ 14:55:18.945 `cancelled`（`failure_class=aborted`，`process.reclaimed` 已落库）；
- 停止后 pending 仍在（UI 弹窗仍在，供本次验证）；
- 调 `resolveApproval`：

```js
{"ok":false,"error":{"code":"APPROVAL_STALE","message":"该审批所属轮次已结束，批准不会执行（已自动置为 denied）。请重新发送命令以触发新的审批。"}}
```

- DB 该行：`denied / decided_by=system / decision_note="turn … is not live; an allow decision could never execute (auto-denied)"`；
- `stale.txt` 不存在、`tool.result` 计数 0；**不存在“allowed 但无执行”行**。
- 截图：[r5-07-stale-before-stop.png](evidence/r5-07-stale-before-stop.png)、[r5-08-stale-after-allow.png](evidence/r5-08-stale-after-allow.png)。

**第 4 项 B（停止后点「允许一次」按钮，`R5-StaleBtn`，Write）**：

- 停止 → `cancelled`；弹窗仍在；点击「允许一次」→ 行转 `denied / system`，`tool.result=0`，文件不存在。
- **但 UI 上没有出现这条 `APPROVAL_STALE` 文案**：错误横幅被 [ApprovalRequestDialog.tsx](file:///Users/zhumingchen/tiangong/src/renderer/components/agent/ApprovalRequestDialog.tsx#L69-L95) 的 `if (pending.length === 0) return null` 提前返回吞掉；聊天区留下的是停止时 SDK 的原文 `SDK error: Claude Code process exited with code 143`（[r5-09-stale-ui-click.png](evidence/r5-09-stale-ui-click.png)）。正确性达标，可观测性有缺口，见 16.7。

### 16.6 第 6 项：回归抽查（`ud-r5d`）

- **徽标即时刷新**：允许本次会话前 `[data-testid="session-grant-badge"]` 不存在；点击后 0.9s 内出现「本次会话已授权（写操作）/撤销授权」，`getSessionGrants()` 从 `[]` → 1 条（`approvalId=appr_88557f3a…`，`toolScope=write`，`cwd=/private/tmp/bizgraph-realdevice/ws-r5d`）。
  证据：[r5-12-reg-badge-before.png](evidence/r5-12-reg-badge-before.png)、[r5-13-reg-badge-after.png](evidence/r5-13-reg-badge-after.png)。
- **正常重启续接**：重启后同一 thread 发第二轮写：
  - `turn.started`：`resumeMode=native`；
  - `run.started` 的 `backendSessionId=8284b42f-88c6-461b-bbe1-81ac060b3ed4` 与第一轮**完全一致**；
  - 第二轮 `completed`，`reg2.txt`=`REG-2`。
- **无重复会话行**：`agent_sessions` 行数始终 1，`GROUP BY id HAVING count>1` 为空。
- **授权不继承**：重启后徽标消失、`getSessionGrants()=[]`；第二轮 Write **再次弹审批**（`pending` 1 条），点「允许一次」后完成。
  证据：[r5-14-reg-after-restart.png](evidence/r5-14-reg-after-restart.png)、[r5-15-reg-second-approval.png](evidence/r5-15-reg-second-approval.png)、[r5-16-reg-second-done.png](evidence/r5-16-reg-second-done.png)。

### 16.7 新发现的问题

| 级别 | 问题 | 证据 |
|------|------|------|
| **P1（构建）** | **默认构建被阻断**：preload 新增 `@shared/ipc-error` import，但 [vite.config.ts](file:///Users/zhumingchen/tiangong/vite.config.ts#L45-L66) 的 preload 子配置未声明 `resolve.alias`，`npx vite build` 报 `Rollup failed to resolve import "@shared/ipc-error" from src/preload/index.ts`（exit 1）。本轮仅用仓库外临时配置出包。 | `/tmp/r5-build.log`；16 顶部构建说明 |
| P2 | `APPROVAL_STALE` 的 UI 错误横幅不可见：`ApprovalRequestDialog` 在 `pending` 清空后提前 `return null`，`error` 状态没有机会渲染；用户只看到弹窗消失。 | [r5-09](evidence/r5-09-stale-ui-click.png)；16.5-B |
| P2 | 停止轮次后聊天区显示原始 `SDK error: Claude Code process exited with code 143`，不是「已停止」类人话。 | [r5-09](evidence/r5-09-stale-ui-click.png) |
| P3 | `turn.started.resumeMode=native` 与 `run.started.resumeMode=fresh` 字段含义不一致（同一 backendSessionId 实际为续接）；排查续接问题时容易误读。 | `stageR5d` 两轮 payload |
| P3 | 启动清扫仍会给正常收尾的会话追加 `startup reclaim: marker=none …` note（与第四轮同）。 | `ud-r5d` `recovery_note` |

> 本轮未改业务源码、未改 `~/.codex`、未 commit；结束已清理 Electron 与 `bizgraph-turn:` 残留进程（含历史轮次遗留的 `fake-codex-pidfile` 进程）。

### 16.8 三条 P1 是否关闭 / 是否够格翻默认开启

- **P1-1（崩溃残留回退内部 id → CLI resume 失败）：已关闭。** 不再调用 `--resume`，提示可读，note 留痕。
- **P1-2（IPC 错误丢结构，UI 只显示 `[object Object]`）：已关闭。** 探针信封与真实恢复失败 UI 均达标。
- **P1-3（僵尸审批）：已关闭。** 重启对账 `deny/startup`，卡片不再出现；陈旧审批实时路径也转为 `denied/system`，无假 allowed。
- **排除 Bash 授权策略后，是否够格默认开启：尚不够格，但只差 3 个非 Bash 前置项：**
  1. **构建必须先恢复**：当前 `npx vite build` 直接失败，默认开启意味着无法出可发布包（P1）。
  2. **`~/.claude/settings.json` allow 规则是否会绕过 `canUseTool` 写前拦截**仍未验证（第四轮遗留风险，直接决定“默认开启后拦截是否可信”）。
  3. **`APPROVAL_STALE` 的 UI 提示需要可见**（P2，一行 early-return 的问题），否则用户会看到“点了允许、弹窗消失、什么也没发生”。
  上述 1–3 修完后，从续接、审批对账、授权隔离、事件序这四类正确性看，**可以翻默认开启**。

- **Bash 单独列（不影响上述结论）**：Bash 仍是“按命令风险分级、并非一律弹窗”；写类命令逐条弹、缺少“安全命令批量授权”的预期管理，默认开启后的交互体验仍需单独评估。

# 第六轮：翻默认前三项（2026-11-05）

## 17. 构建、权限绕过与审批错误可见性

### 17.1 构建失败（P1）：已修复

根因：`@shared/ipc-error` 是 preload 的**运行时** import（`encode/decode`），但 [vite.config.ts](file:///Users/zhumingchen/tiangong/vite.config.ts) 的 preload 子配置没有 `resolve.alias`，Rollup 无法解析。
改法：preload 子配置补齐与 main 同口径的 `@main` / `@shared` alias。preload 全量扫描后只有 `@shared/*` 这一处隐式依赖，无 `@renderer/*`。
实测：`npx vite build` exit 0（renderer + main + preload 三段全部产出），产物 `dist/index.html`、`dist-electron/main/index.js`、`dist-electron/preload/index.js` 齐全。`vite build` 已列入例行验收项。
打包：`npx electron-builder --mac --dir -c.electronDist=node_modules/electron/dist` exit 0，`app.asar` 内含上述产物；直接跑 `electron-builder` 仅卡在从 GitHub 下载 Electron 二进制（`EOF`，本机网络限制，与代码无关）。打包产物冷启动冒烟：主进程初始化、DB 迁移到 v20、preload 无加载错误，9s 后正常退出、无残留进程。

### 17.2 用户配置能否绕过写前审批：**会绕过**，已封堵

实测方法（受控临时配置，未触碰真实 `~/.claude`）：`CLAUDE_CONFIG_DIR=/tmp/claude-perm-test/config-*`，用 SDK `query()` + `settingSources:['user']` + `permissionMode:'default'`，prompt 让模型写 `canary.txt`，`canUseTool` 记录是否被调用。

| 场景 | 临时 settings.json | canUseTool 被调用 | canary.txt 落盘 |
|------|-------------------|------------------|----------------|
| 对照（无 allow） | `{}` | ✅ `Write` | ✅ |
| **allow 规则** | `permissions.allow:["Write"]` | ❌ **未调用** | ✅ **直接落盘** |
| allow + 我们的 PreToolUse 返回 `ask` | 同上 + hook | ✅ `Write` | ✅（网关放行后才写） |
| allow + `disableAllHooks:true` + hook `ask` | 同上 | ✅ `Write` | ✅ |

结论：`permissions.allow` 会让 CLI 短路权限检查、**不回调 `canUseTool`**，我们原来的写前网关被完全绕过；`disableAllHooks` 不会禁用 SDK 代码里传入的 hook。
证据日志：[control](evidence/r6-permission-control.log)（无 allow，`canUseTool` 被调用）、[allow](evidence/r6-permission-allow.log)（`calls: []` 且文件落盘）、[allow + hook ask](evidence/r6-permission-hookask.log)（`canUseTool` 重新被调用）、[allow + disableAllHooks + hook ask](evidence/r6-permission-hookask-disableallhooks.log)（hook 仍生效）。

改法：[claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts) 的 PreToolUse hook 对**写类工具**（`isWriteScopedTool`）一律返回 `permissionDecision:'ask'`。`ask` 不受 allow 规则短路，强制 CLI 回到 `canUseTool`，由网关（含会话级授权）做出最终决定。

**优先级（由低到高）**：用户本地配置 < 我们的强制策略（写类强制 ask）< 会话级授权（内存 grant，命中即免弹窗）。
- **能影响审批的用户侧配置**：`permissions.deny`（仍可阻止执行，fail-closed）；`permissions.allow`（对写类工具**不再能**跳过审批）。
- **不能影响审批的配置**：`permissions.defaultMode`（适配器显式传 `permissionMode:'default'`，覆盖 settings 默认）；`disableAllHooks`（不会停用代码内 hook）；`additionalDirectories`（只改路径可见范围，不改审批）。
- **仍需单独声明的边界**：Bash 工具的分级仍来自 SDK/CLI（用户 `allow` 可让某些 Bash 命令免弹），本轮的强制 ask 只覆盖写类工具。

### 17.3 `APPROVAL_STALE` 不可见 + 原始错误码：已修复

根因：`ApprovalRequestDialog` 在 `pending.length === 0` 时提前 `return null`，`error` 横幅没有渲染机会；适配器把 `SDK error: ... code 143` 原样写进聊天区。
改法：
1. 弹窗仅在「无 pending 且无 error」时隐藏；失败后卡片关闭但错误横幅（`role="alert"`）继续显示，`APPROVAL_STALE` 额外加前缀「该审批已失效，本次操作没有执行。」；新审批请求到达时清空旧错误。
2. 新增 [agent-error-text.ts](file:///Users/zhumingchen/tiangong/src/shared/agent-error-text.ts)：143/SIGTERM、137/SIGKILL 映射为「本轮被终止/强制终止，操作没有执行，请重新发送命令」，其余 `SDK error: …` 保留原因并补解释；claude/codex 的 error 输出统一经过它。

测试：`ApprovalRequestDialog 错误可见性`（陈旧审批卡片关闭后横幅仍在 / 正常审批成功无横幅）、`humanizeAgentErrorText`（3 条）、`PreToolUse 对写类工具强制 ask：用户 settings allow(Write) 不能绕过审批`。

### 17.4 报数（本轮）

- `tsc --noEmit`：0 error
- `eslint src --ext ts,tsx --max-warnings 0`：0 error / 0 warning
- `npx vite build`：exit 0
- `vitest run`：2937 passed / 173 failed（全部既有 better-sqlite3 ABI，26 文件，与基线一致）/ 93 skipped；新增用例全绿，无新增失败

### 17.5 是否可开第六轮真机复核

可开。三项前置均有可验证证据：默认 `npm run build` 出包、allow 规则绕过已实测并封堵、陈旧审批提示可见。复核重点建议：(1) 带 `permissions.allow:["Write"]` 的真实 `~/.claude` 下首写仍弹窗；(2) 陈旧审批点「允许」的错误横幅；(3) 取消轮次后聊天区不再出现裸 `code 143`。

---

## 18. 第六轮真机复核（构建 + 权限绕过 + 陈旧提示）

- 执行时间：2026-11-05 15:23 – 15:32（UTC+8）
- 构建：`npx vite build` exit 0，renderer/main/preload 三段全部产出（`dist/`、`dist-electron/main/index.js`、`dist-electron/preload/index.js`，15:23）；本轮所有真机会话都跑该产物，页面 URL 为 `file:///Users/zhumingchen/tiangong/dist/index.html`，非 dev server。
- `~/.claude/settings.json` 全程备份在仓库外；测试期间临时加 `permissions.allow:["Write"]` / `permissions.deny:["Bash"]`，测试后已按字节还原（见 18.6）。
- 脚本（仓库外）：`stageR6a`（权限绕过 + 构建产物）、`stageR6b`（陈旧审批 + 取消文案）、`stageR6c`（授权/撤销/续接）、`stageR6d`（僵尸审批）。

### 18.1 逐项状态

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 用户配置 `allow:["Write"]` 不得绕过写前审批 | **通过（安全项）** | 带真实 `~/.claude` allow 规则仍弹窗；拒绝后文件 hash 不变。`deny:["Bash"]` 仍能挡住执行。 |
| 2 | 陈旧审批提示可见 | **通过** | 停止后点「允许」显示红色横幅：「该审批已失效，本次操作没有执行。」+「批准不会执行（已自动置为 denied）」。 |
| 3 | 取消后错误文案 | **通过** | 聊天区显示「本轮已被终止（退出码 143 / SIGTERM）…本次操作没有执行；请重新发送命令」，无裸 `SDK error`。 |
| 4 | 构建产物真机跑 | **通过** | `file://` 产物启动正常、无白屏；`window.electronAPI` 可用；审批弹窗、允许/拒绝链路正常。 |
| 5 | 回归抽查 | **通过** | 首次弹窗→允许本次会话→第二次写免弹（policy 放行）→撤销后重弹；重启续接同一 backendSessionId、单会话行；徽标 0→1→0；僵尸审批重启后不弹。 |

### 18.2 第 1 项：`permissions.allow` 绕过（安全项）

**测试前**：`~/.claude/settings.json` 备份为 `settings.original.json`，hash `c59975a3…9625`，与源文件字节一致；原始配置无 `permissions` 字段。
**测试中**：临时写入 `permissions.allow=["Write"]`（hash `82a2f3a7…f8cc`），随后再写入 `permissions.deny=["Bash"]`（hash `9900cebf…6ba9`）。

| 子项 | 结果 | 证据 |
|------|------|------|
| allow(Write) 下首次 Write | **仍然弹窗**：`pending=[{tool:'Write', hash:'958e3d22…ff71'}]`；`approval.required` 事件正常落库 | [r6-02-allow-write-still-asks.png](evidence/r6-02-allow-write-still-asks.png) |
| 点「拒绝」后 | turn `completed`；文件 hash `0749a887…8b27` **前后完全一致**，内容仍为 `ORIGINAL-R6`；审批行 `denied/user` | [r6-03-deny-write-unchanged.png](evidence/r6-03-deny-write-unchanged.png) |
| deny(Bash) 下执行 `printf … > bash-denied.txt` | **无弹窗、未执行**：文件不存在；tool 结果 `Error: No such tool available: Bash. Bash is disabled for this session…` | [r6-04-deny-bash-blocked.png](evidence/r6-04-deny-bash-blocked.png) |

- 说明：`allow` 规则确实被 CLI 读到（同一份配置里的 `deny(Bash)` 立即生效），但写类工具被 [claude-code.ts](file:///Users/zhumingchen/tiangong/src/main/adapters/claude-code.ts) 的 `PreToolUse → permissionDecision:'ask'` 强制拉回 `canUseTool`，因此没有再出现“allow 直接落盘”。
- 拒绝时的文件只读保护也顺带验证：模型先因“File has not been read yet”失败，读文件后重试 Write 才进入审批。

### 18.3 第 2 / 3 项：陈旧审批横幅 + 取消文案

同一轮次（Bash 写命令 `printf 'R6-STALE' > stale.txt`）：

1. 弹窗（`pending appr_5286990d…`，`argsHash=c60fa01b…1a6a`）→ 点「停止」→ turn `cancelled / aborted`（07:27:33.113）。
2. 取消后聊天区（07:27:33.120）立即出现人话：

```
本轮已被终止（退出码 143 / SIGTERM）。通常是审批失效或会话取消后 CLI 被回收，
本次操作没有执行；请重新发送命令。
```

   - 断言：`hasRawSdkError=false`、`hasRaw143Line=false`、`hasObjectObject=false`；不再出现 `SDK error: … process exited with code 143`。
3. 再点「允许一次」→ 红色横幅可见（`[data-testid="approval-error"]`，`visible=true`）：

```
该审批已失效，本次操作没有执行。
该审批所属轮次已结束，批准不会执行（已自动置为 denied）。请重新发送命令以触发新的审批。
```

   - DB：`denied / decided_by=system / decision_note="turn … is not live; an allow decision could never execute (auto-denied)"`；
   - `stale.txt` 不存在，`tool.result` 计数 0。

证据：[r6-05-stale-dialog.png](evidence/r6-05-stale-dialog.png)、[r6-06-cancel-humanized.png](evidence/r6-06-cancel-humanized.png)、[r6-07-stale-banner.png](evidence/r6-07-stale-banner.png)。

### 18.4 第 4 项：构建产物真机跑

- `npx vite build`：exit 0，三段产物齐全（日志 [r6-build.log](evidence/r6-build.log)）。
- 启动后：`href=file:///Users/zhumingchen/tiangong/dist/index.html`、`isFileUrl=true`、`hasApi=true`（`window.electronAPI['agent:resolveApproval']` 为函数）、初始空状态正常渲染，无白屏（[r6-01-build-product-loaded.png](evidence/r6-01-build-product-loaded.png)）。
- 审批链路在产物下可用：allow(Write) 场景弹窗、拒绝、DB 落库、文件保护均正常（18.2）。preload 的 `@shared/ipc-error` 已随 alias 修复正常加载，无加载错误。

### 18.5 第 5 项：回归抽查

- **授权 → 免弹 → 撤销 → 重弹**：
  - 首次 Write 弹窗，点「允许本次会话」后 0.9s 内徽标出现「本次会话已授权（写操作）/撤销授权」，`getSessionGrants()` 1 条（`toolScope=write`，`cwd=/tmp/bizgraph-realdevice/ws-r6c`）；
  - 第二次 Write **无弹窗**，审批行 `allowed / decided_by=policy / grant_source=appr_692f…`，`reg2.txt=REG-2`；
  - 点「撤销授权」→ 徽标消失、grants `[]`；第三次 Write **再次弹窗**，允许后 `reg3.txt=REG-3`。
  - 证据：[r6-08-badge-before.png](evidence/r6-08-badge-before.png)、[r6-09-badge-after-grant.png](evidence/r6-09-badge-after-grant.png)、[r6-10-second-write-no-dialog.png](evidence/r6-10-second-write-no-dialog.png)、[r6-11-after-revoke-dialog.png](evidence/r6-11-after-revoke-dialog.png)。
- **重启续接 + 无重复会话行**：重启后 `agent_sessions` 行数 1（id `claude-2f1d53…0697`），无重复 id；第四轮 Write 的 `turn.started.resumeMode=native`，`run.started.backendSessionId=7fe9e7cc-300c-4571-a09e-23911ee7ae97` 与首轮一致；`reg4.txt=REG-4`。
  - 证据：[r6-12-after-restart-resume.png](evidence/r6-12-after-restart-resume.png)。
- **僵尸审批**：弹窗后不点按钮 `app.quit()`（Cmd+Q 路径），进程 260ms 退出；重启后卡片 0 个、pending `[]`，行 `denied / startup / startup reconcile: …`，turn `orphaned/crash`，文件未创建。
  - 证据：[r6-13-zombie-dialog.png](evidence/r6-13-zombie-dialog.png)、[r6-14-zombie-after-restart.png](evidence/r6-14-zombie-after-restart.png)。

### 18.6 `settings.json` 备份 / 还原证据

- 测试前备份与源文件：`c59975a30637e1d02bd64c086da3b7b492f9254ac2c8ef30625868ff9b249625`（两者一致，`cmp: identical`）。
- 测试期间临时 hash：allow(Write)=`82a2f3a7…f8cc`；allow(Write)+deny(Bash)=`9900cebf…6ba9`（对应 `permissions: allow ["Write"] ; deny ["Bash"]`）。
- 测试后还原：再次 `cp` 备份 → `cmp: identical`，还原后 hash 仍为 `c59975a3…9625`，`permissions` 字段为 `undefined`。
- 证据：[r6-settings-restore.log](evidence/r6-settings-restore.log)（只记录 hash 与 permissions 片段，不含用户配置文件内容）。
- 本轮 `settings.original.json` 仅保留在仓库外 `/tmp/bizgraph-realdevice/`，未写入证据目录、未提交。

### 18.7 新发现 / 观察（无新增阻断）

| 级别 | 观察 | 处置建议 |
|------|------|----------|
| 观察 | `deny(Bash)` 的报错是 CLI 原文 `No such tool available: Bash. Bash is disabled for this session…`，不是产品化文案 | 可接受（fail-closed）；是否翻译属体验优化 |
| 观察 | 首屏 `body.innerText` 长度仅 148（空项目欢迎页），属正常初始态 | 无 |
| 观察 | Write 首次调用可能因“读前写”被 CLI 拒绝一次并自动重试，会多产生一次 `tool.requested/result` | 无（属模型行为，审批仍在真正写入前触发） |
| P3（既有） | `turn.started.resumeMode=native` 与 `run.started.resumeMode=fresh` 仍不一致 | 属字段语义问题，不影响续接 |

### 18.8 现在是否够格把 `BIZGRAPH_AGENT_KERNEL` 默认开启

**YES，可以翻默认开启。** 第六轮 5 项全部通过：构建产物可跑、allow 绕过已封堵、deny 仍 fail-closed、陈旧审批提示可见、取消文案人话化，且第五轮的续接/授权/徽标/僵尸审批回归全部保持。

剩余风险（按影响排序，均不构成本轮的阻断项）：

1. **Bash 授权策略仍是 SDK/CLI 原生行为**：写类的强制 `ask` 只覆盖 write 类工具；用户 `permissions.allow` 仍可能让部分 Bash 命令免弹。需要单独的产品策略（分级/批量授权），不影响开关本身的正确性。
2. **非写类工具的 `allow` 仍可短路**：如网络/MCP 类工具若未来被纳入审批范围，需要扩展 `PreToolUse` 强制 `ask` 的工具集合。
3. **Codex / OpenCode 的写前拦截覆盖缺口**：kernel 驱动注册了 `claude-code / codex / opencode` 三个适配器（[ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L293-L298)），但只有 Claude 适配器安装了写类强制 `ask` 的 hook。默认开启后这两个适配器仍不会弹写前审批（与关闭前行为一致，但不要误以为已被覆盖）；`~/.codex` 被本机配置阻塞，本轮未真机复验。
4. **打包链路**：本轮只验 `vite build` 产物；`electron-builder --dir` 由施工方冒烟过，但未在本轮重复。
5. **长跑/超时策略**（120s 交互、30s 无人值守）本轮未压测，维持既有结论。

> 纪律：本轮未改业务源码、未 commit；`~/.claude/settings.json` 已字节级还原（18.6）；`~/.codex` 未改；结束已清理全部 Electron / `bizgraph-turn:` 残留进程（REMAIN=0）。

## 19. 翻默认最小闭环（2026-11-05）

- 构建：`npx vite build` exit 0（renderer/main/preload 三段产出）；真机跑 `file:///Users/zhumingchen/tiangong/dist/index.html`。
- 配置：**不设任何 `BIZGRAPH_AGENT_KERNEL*`**（脚本显式从子进程环境删除三项，继承值均为 `undefined`）。
- 脚本（仓库外，不提交）：`/tmp/bizgraph-realdevice/stageR7.cjs`（Playwright 真实 Electron）、`logprobe-r7.cjs`（直接 spawn 抓启动首行日志）。

| 检查 | 结果 | 证据 |
|---|---|---|
| 运行时开关 | `kernelPath=true`，`kernelBackends=["claude"]`，`kernelUnsafeOverride=false` | `agent:getRuntimeFlags` |
| 启动日志矩阵 | `claude-code: kernel 路径已启用（写前强制审批）`、`codex: 旧路径（该后端尚未启用写前审批）`、`opencode: 旧路径（该后端尚未启用写前审批）`、`总开关=on 白名单=[claude]` | `stageR7-logs.txt`（直接 spawn 抓取，从进程第一行起） |
| Claude 首写审批 | 弹「写前审批 · Write」（risk=high, mode=interactive）；允许本次会话后 turn `completed`，文件内容 `DEFAULT-KERNEL-OK` | `r7-02/03` 截图 + `agent_approvals` 行（`status=allowed, decided_by=user`） |
| Claude 事件链 | seq 1→10 连续：`turn.started → approval.required → approval.resolved → run.started → … → run.completed` | `agent_events` |
| Codex 路径 | 同一构建、同一进程：未新增 `agent_turns` / `agent_sessions`，无审批弹窗、`pending=0`；`[prompt-orchestrator]` / `SessionLifecycleManager` 旧路径日志出现 | DB before/after + 截图 `r7-04` |
| Codex 真实执行 | **未验（如实标注）**：本机 `~/.codex/config.toml` 的 `model_reasoning_effort = "max"` 不被当前 Codex CLI 接受（`unknown variant max`），Exec exit 1；未改 `~/.codex` | UI 错误原文 |
| 降级标记 | `[kernel-degraded]` 未出现（默认配置不含 UNSAFE，符合预期） | 日志全量 |

结论：**默认已是开启状态，且仅 Claude 受写前审批保护**；Codex / OpenCode 明确停留在旧路径并在启动日志逐条标注。

## 20. 第七轮真机复核（默认状态本身）

- 执行时间：2026-11-05 16:03 – 16:25（UTC+8）。
- 构建：沿用 15:55 `npx vite build` exit 0 的产物（`dist/`、`dist-electron/main/index.js`、`dist-electron/preload/index.js`），真机页面 `file:///Users/zhumingchen/tiangong/dist/index.html`，非 dev server。
- 配置：第 1/2/3 项脚本从子进程环境**显式删除** `BIZGRAPH_AGENT_KERNEL`、`BIZGRAPH_AGENT_KERNEL_BACKENDS`、`BIZGRAPH_AGENT_KERNEL_UNSAFE`（继承值均为 `<unset>`）；仅第 4/5 项按题目要求显式设置对应变量。
- 脚本（仓库外，不提交）：`stageR7a`（第 1/2 项）、`stageR7b`/`stageR7b2`（第 3 项）、`stageR7c`（第 4/5 项）、`stageR7d`（第 3 项复现）、`stageR7e`（纯 legacy 回退对照）、`stageR7f`（默认冷启动日志固化）。
- 测试环境说明（如实披露）：本机 `os.freemem()` 长期只有 77–366MB（物理内存 48GB），而 [agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L500-L502) 硬编码 `os.freemem() < 512MB` 即拒绝建会话。测试 wrapper 只在**测试进程内**把 `os.freemem()` mock 为 4GB（`BIZGRAPH_TEST_MOCK_FREEMEM=1`），未改业务源码；Claude 会话本身仍是真实 CLI。该门限在 macOS 上会误伤真实用户，记为 **P2 可用性问题**。

### 20.1 逐项状态

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 默认状态真机（不设环境变量） | **通过** | 启动日志 4 行与行为一致；Claude 首写弹窗 → 允许 → `DEFAULT-R7` 落盘；Codex/OpenCode 旧路径。 |
| 2 | Codex 旧路径不被污染 | **通过（执行未验）** | 同进程 Codex 未新增任何 `agent_*` 行、无弹窗、无 `[kernel-degraded]`；Codex CLI 因本机 `~/.codex` 配置拒绝启动（未改）。 |
| 3 | 回退有效性（`KERNEL=0` 跑同一会话） | **不通过（关键）** | 回退后**既有 thread 全部无法续接**：`SessionNotFoundError / AGENT_SESSION_NOT_FOUND`，UI「无法启动 Agent 会话…」；新建 thread 可用。 |
| 4 | 白名单不能放宽 | **通过（有副作用）** | `BACKENDS=codex` 时 Codex 仍走旧路径，日志无「codex: kernel 路径已启用」；但 Claude 也被一并剔出 kernel。 |
| 5 | UNSAFE 降级可见 | **通过（写入未验）** | 启动 3 行「降级运行」+ 运行期 `[kernel-degraded]` 带原因；Codex 进 kernel、`agent_approvals=0`、无弹窗（写盘未能发生）。 |
| 6 | 文档与行为一致 | **部分不符** | 5 处偏差（D1–D5），见 20.7。 |

### 20.2 第 1 项：默认状态真机

冷启动（无任何 `BIZGRAPH_AGENT_KERNEL*`）日志（[r7-main-default.log](evidence/r7-main-default.log)）：

```
[kernel] claude-code: kernel 路径已启用（写前强制审批）
[kernel] codex: 旧路径（该后端尚未启用写前审批）
[kernel] opencode: 旧路径（该后端尚未启用写前审批）
[kernel] 总开关=on 白名单=[claude]
```

与 [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L304-L317) 的矩阵一致。Claude 首写：

| 断言 | 结果 |
|---|---|
| 弹窗 | `写前审批 · Write`，`pending=[appr_89940c73…, tool=Write]`（[r7-02-default-approval.png](evidence/r7-02-default-approval.png)） |
| 允许 | `agent_approvals` → `allowed / decided_by=user` |
| turn | `completed`，`failure_class=null` |
| 文件 | `DEFAULT-R7\n` 已落盘（[r7-03-default-file-written.png](evidence/r7-03-default-file-written.png)） |
| 事件序 | seq 1→10：`turn.started → approval.required → approval.resolved → run.started → … → run.completed` |

**OpenCode 未安装**（`opencode CLI not found`），其「旧路径」只能由启动日志证明，未跑会话；如实标注。

### 20.3 第 2 项：Codex 旧路径不被污染

同一进程、同一构建，Claude 会话结束后跑 Codex（[r7-04-codex-legacy.png](evidence/r7-04-codex-legacy.png)）：

- `sawDialog=false`、`pending=[]`；
- `agent_*` 表 before/after **全量 delta = {}**（`agent_turns`、`agent_sessions` 均为 0 新增）；
- 日志无 `[kernel-degraded]`，仍有 `[kernel] codex: 旧路径…`；
- UI 显示 Codex 原始错误 `Error loading config.toml: unknown variant 'max'…`，Codex 真实执行**未验**（本机 `~/.codex` 未被修改）。

### 20.4 第 3 项：回退有效性（本轮最关键的结论）

**测试 A — `KERNEL=0` 重启后跑同一 kernel thread（题目原场景）**：日志 `总开关=off`、三行仍写「旧路径（该后端尚未启用写前审批）」；`sawDialog=false`、文件未生成、`agent_*` delta `{}`；聊天区显示：

```
无法启动 Agent 会话，请检查适配器是否可用。
```

主进程：

```
SessionNotFoundError: Session claude-600d0024bafa4e1fbf6513437822b377 not found
code = AGENT_SESSION_NOT_FOUND
```

（[r7-05-rollback-legacy.png](evidence/r7-05-rollback-legacy.png)、[r7-main-rollback-kernel-thread.log](evidence/r7-main-rollback-kernel-thread.log)）

**测试 B — `KERNEL=0` 新建 thread**：无弹窗、`ROLLBACK-NEW-R7` 正常落盘、正常回复、`agent_*` 零新增（[r7-06-rollback-new-thread.png](evidence/r7-06-rollback-new-thread.png)）。说明**旧路径本身没坏**。

**测试 C — 干净 UD，全程 `KERNEL=0`，两次启动**（排除 kernel 会话干扰）：第一次建 thread 发送成功（`legacy-1.txt` 落盘）；重启后同一 thread 再发送 → 同样 `AGENT_SESSION_NOT_FOUND`，`legacy-2.txt` 未生成（[r7-13-legacy-clean-resume.png](evidence/r7-13-legacy-clean-resume.png)）。

**根因**：渲染层重启后直接复用持久化的 `thread.sessionId`（[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L284-L289)）；主进程 legacy 分支只做内存态 `router.resolve(sessionId)`（[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L863-L871)），**没有**从 `agent_sessions` / thread 恢复的分支；只有 kernel 分支有 `resolveKernelAdapter`（[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L636-L649)）。对照 HEAD（翻默认前）同样是「复用 sessionId + 仅 resolve 内存路由」，因此这是**既有缺陷**，不是本次翻默认引入；但回退会把它暴露给所有用户。

**结论：回退不能「一键退回原样」**。回退后：
- 新建会话：完全可用（无审批、无 `agent_*` 行、UI 正常）；
- **既有会话（无论 kernel 还是 legacy 期间创建）：重启后一律不可继续**，只能新建会话；UI 提示还误导为「适配器不可用」。
所以它是「新会话回退」，不是「原样回退」。

### 20.5 第 4 项：白名单不能放宽

`BIZGRAPH_AGENT_KERNEL_BACKENDS=codex`（不设 `UNSAFE`）启动（[r7-07-whitelist-codex-boot.png](evidence/r7-07-whitelist-codex-boot.png)、[r7-main-whitelist-codex.log](evidence/r7-main-whitelist-codex.log)）：

```
[kernel] claude-code: 旧路径（该后端尚未启用写前审批）
[kernel] codex: 旧路径（该后端尚未启用写前审批）
[kernel] opencode: 旧路径（该后端尚未启用写前审批）
[kernel] 总开关=on 白名单=[codex]
```

- 无 `[kernel] codex: kernel 路径已启用`、无 `[kernel-degraded]`；
- Codex 会话：无弹窗、`agent_*` 全量 delta `{}`、UI 同 20.3 的 config.toml 错误（[r7-08-whitelist-codex-session.png](evidence/r7-08-whitelist-codex-session.png)）。

**通过**：白名单没有把审批能力「加」给 Codex。**副作用**：Claude 也被一键剔出 kernel（白名单是**替换**而非与能力集求交），且日志仍说「尚未启用写前审批」——原因不实。

### 20.6 第 5 项：UNSAFE 降级可见

`BACKENDS=codex` + `UNSAFE=1`（[r7-09-unsafe-codex-boot.png](evidence/r7-09-unsafe-codex-boot.png)、[r7-main-unsafe-codex.log](evidence/r7-main-unsafe-codex.log)）：

启动（3 个后端逐条）：

```
[kernel] claude-code: 已通过 UNSAFE 强制启用 kernel，但该后端尚未启用写前审批（降级运行）
[kernel] codex: 已通过 UNSAFE 强制启用 kernel，但该后端尚未启用写前审批（降级运行）
[kernel] opencode: 已通过 UNSAFE 强制启用 kernel，但该后端尚未启用写前审批（降级运行）
[kernel] 总开关=on 白名单=[codex] UNSAFE=on
```

运行期（Codex 会话）：

```
[kernel-degraded] session=codex-bbdd81b1… backend=codex:
backend "codex" has no forced pre-write approval; forced by BIZGRAPH_AGENT_KERNEL_UNSAFE=1
```

| 断言 | 结果 |
|---|---|
| Codex 确实进了 kernel | `agent_sessions 0→1`、`agent_turns 0→1`、`agent_runs 0→1`、`agent_events 0→2`；turn `failed / runtime` |
| 写前审批 | **无**：`sawDialog=false`、`agent_approvals=0`、无 `approval.*` 事件 |
| 实际写入 | 未发生（`~/.codex` config 错误，CLI 未启动）；**未改 `~/.codex`** |

结论：降级标记与原因**可见且可读**；「降级 = 没有审批门」已被证明（0 审批行 + 0 弹窗），但「降级 = 实际落盘不受保护」因 Codex CLI 本机不可用而**无法用一次真实写入证明**——只能由代码事实（仅 Claude 安装审批 hook，[adapter-driver.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/executors/adapter-driver.ts#L112-L114)）支撑。

另一个实证偏差：UNSAFE 把**具备审批能力的 Claude** 也标成 degraded，理由写「尚未启用写前审批」（不实）。Claude 的 hook 仍会安装，故保护未丢，属「标记失真」。

### 20.7 第 6 项：文档与行为偏差清单

对照 [agent-architecture.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-architecture.md#L935-L967) §17 与 [agent-rollout.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-rollout.md#L41-L70)：

| # | 文档写法 | 真机行为 | 判定 |
|---|----------|----------|------|
| D1 | §17.3(2) / rollout L65：「`KERNEL=0` 重启 → 全部后端恢复旧行为 / 完全恢复旧行为」 | 既有 thread 一律 `AGENT_SESSION_NOT_FOUND`，只有新建会话可用（20.4） | **不符（关键）**：回退丢失重启续接，不是「原样」 |
| D2 | §17.2：「白名单，只能**收窄**能力集」 | 写 `codex` 会**替换**默认列表，Claude 同时失去 kernel；日志仍称「尚未启用写前审批」 | **不符（误导）**：应写「替换」或改成与能力集求交 |
| D3 | §17.2：「`UNSAFE=1` 才允许**未具备审批**的后端强制走 kernel，且标记 degraded」 | 实际把具备审批、仅被白名单排除的 Claude 也强制标 degraded，reason 说它无写前审批 | **不符**：UNSAFE 的作用域大于文档 |
| D4 | §17.4：「UI/日志必须**如实标注**，不能宣称已保护」 | `UNSAFE` 下 Claude 的保护仍在，却标注为「尚未启用写前审批」 | **不符（反向失真）** |
| D5 | §17.2：「`BIZGRAPH_AGENT_KERNEL=0` → 全部回旧路径」 | 行为一致；但启动日志未说明「总开关关闭」，仍逐条写「该后端尚未启用写前审批」 | **日志措辞不符**（原因错误，非矩阵错误） |
| D6 | §17.1 默认矩阵（claude kernel / codex / opencode 旧路径） | 与实测一致（OpenCode 未安装，仅日志证明） | **一致** |

### 20.8 M0 是否可以正式宣布收官

**NO —— 暂不能正式收官。**

- 成立的部分：默认状态本身（第 1/2/4/5 项）达标——Claude 默认受写前强制审批，Codex/OpenCode 默认旧路径且不污染 kernel，白名单不能放宽，UNSAFE 降级可见。
- 不成立的部分：**回退安全阀在既有会话上不可用**（第 3 项），且文档正承诺「完全恢复旧行为」（D1）。M0 的核心承诺之一是「可安全回退」，这一点当前为假；用户从默认开启退回 `KERNEL=0` 后，历史会话会集体报错，必须新建会话。

收官前的最小修复清单（按优先级）：

1. **修回退续接**：legacy 分支在 `router.resolve` 失败时，从 thread 持久化状态重建或新建会话，并在 UI 明确提示「原会话不可续接，已新建会话」；补一条真机/集成回归：`KERNEL=0 + 既有 thread 二次发送`。（对应 D1）
2. **修启动日志 reason**：区分「总开关关闭」「被白名单排除」「后端无审批能力」三种原因；Claude 被排除时不得再写「尚未启用写前审批」。（对应 D2/D5）
3. **修 UNSAFE 作用域**：只对真正无审批能力的后端标 `degraded`，别再误标 Claude；或文档明确 UNSAFE 会连白名单外具备能力的后端一起降级。（对应 D3/D4）
4. **同步文档**：§17.3 / rollout L65 的回退描述改为准确行为，并注明既有会话需新建。

完成 1–4 后可再来一轮短复核（只需覆盖回退续接 + 日志 reason），通过即可宣布 M0 收官。当前更准确的表述是：**「默认开启成立，回退承诺未成立」**。

> 纪律：本轮未改业务源码、未 commit；未写 `~/.claude`、未写 `~/.codex`（Codex 执行失败原样保留）；证据已落 [evidence/](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/)（`r7-*`、`r7-summary.json`）；结束检查本仓库 Electron 进程 `OUR_APP_REMAIN=0`、`bizgraph-turn:` 进程 `0`。

## 21. 第八轮短复核（回退安全阀）

- 执行时间：2026-11-05 16:52 – 16:58（UTC+8）。
- 构建：本轮重新执行 `npx vite build`（exit 0），真机跑新产物（非 dev server）。
- 配置：第 1 项前半 / 第 5 项不设任何 `BIZGRAPH_AGENT_KERNEL*`；第 1 项后半 / 第 2 / 3 / 4 项设 `BIZGRAPH_AGENT_KERNEL=0`。
- 测试环境：**不再 mock `os.freemem()`**。施工方已改为平台感知阈值（[agent-manager.ts](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L102-L111)），第七轮记录的 P2 内存误伤在 64MB 硬下限下不再出现。
- 脚本（仓库外）：`stageR8`（第 1/2/4/5 项）、`stageR8b`/`stageR8c`（第 3 项修正与 UI 侧）。

### 21.1 逐项状态

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | `KERNEL=0` + 既有 kernel 会话续接 | **通过** | 原生续接成功：同一 `backendSessionId`、`agent_sessions` 仍 1 行、无新增 `agent_*` 行、文件落盘 |
| 2 | 旧路径自建会话的不可续接提示 | **通过** | 文案「原会话不可续接…新建会话可继续」可读；下一次发送自动新建并正常落盘 |
| 3 | 完全无记录会话 | **部分通过（错误码不符）** | UI 文案可读、无「适配器不可用」；但错误码是 `AGENT_SESSION_RESTORE_FAILED`，不是约定的 `AGENT_SESSION_NOT_FOUND` |
| 4 | `KERNEL=0` 日志 reason | **通过** | 三行均为「旧路径（BIZGRAPH_AGENT_KERNEL=0 总开关关闭）」，无「尚未启用写前审批」 |
| 5 | 默认主路径回归 | **通过** | Claude 首写弹窗 → 允许 → `DEFAULT-R8` 落盘，审批 `allowed/user`，turn `completed` |

### 21.2 第 1 项：`KERNEL=0` 续接既有 kernel 会话

前半（默认配置）：首写弹窗 `Write` → 允许 → `DEFAULT-R8` 落盘；`agent_sessions 0→1`，最新 `run.started` 的 `backendSessionId = 26cdc170-a841-4de6-856a-fe81c4fc3298`。

关闭应用，`KERNEL=0` 重启，同一 thread 直接发写请求（[r8-03-rollback-continued.png](evidence/r8-03-rollback-continued.png)）：

| 断言 | 结果 |
|---|---|
| 是否报错 / 是否新建 | 无报错，未新建；文件 `ROLLBACK-R8` 正常落盘 |
| 审批弹窗 | 无（回退到旧路径，符合设计） |
| `agent_sessions` 行数 | 1 → 1（`delta=0`，只 UPDATE，不 INSERT） |
| `agent_*` 其他表 | 全量 `delta={}`（旧路径不写 kernel 表） |
| 原生会话 id | `recovery_note` 记录 `resumeMode=native backendSessionId=26cdc170-…`，与前半**一致** |
| 恢复日志 | `[legacy-restore] … found agent_sessions row; trying native resume` → `Restored persisted session … via native resume`（[r8-main-rollback-continue.log](evidence/r8-main-rollback-continue.log)） |

说明：旧路径不写 `run.started`，因此不能用“最新事件里的 backendSessionId”证明续接；本轮改用 `agent_sessions.recovery_note` 的原生 id 留痕作为证据（同一条 id 在前半由 SDK 回报）。**能续就续成立。**

### 21.3 第 2 项：旧路径自建会话不可续接的出路

`KERNEL=0` 新建 thread → 首轮 `legacy-c.txt` 落盘（session `claude-d9b8a8cc…`）→ 关闭重启 → 同一 thread 再发送（[r8-04-legacy-unresumable.png](evidence/r8-04-legacy-unresumable.png)）：

```
无法恢复会话 claude-d9b8a8ccaf1b489897349b84aaed5e63：原会话不可续接：claude-code 的旧路径
未持久化原生会话 ID，重启后无法恢复上下文。新建会话可继续。
```

- 不含「适配器不可用」，也不含 `[object Object]`；`r8-legacy-d.txt` 未生成（没有假装续接）。
- 渲染层识别 `AGENT_SESSION_RESTORE_FAILED` 后解除 thread 绑定（[sessionStore.ts](file:///Users/zhumingchen/tiangong/src/renderer/store/sessionStore.ts#L366-L381)）。
- **下一次发送**：自动新建会话（`claude-ce70c63d…`，`sidChanged=true`），`r8-legacy-e.txt` 正常落盘，UI 正常（[r8-05-legacy-new-session.png](evidence/r8-05-legacy-new-session.png)）。
- 服务端日志 `[legacy-restore] … unresumable: 原会话不可续接…`（[r8-main-legacy-unresumable.log](evidence/r8-main-legacy-unresumable.log)）。

**不能续有明确出路成立。**

### 21.4 第 3 项：完全无持久化记录的会话

- **IPC 直发随机 id**（`agent_sessions=0`、`chat_threads=0`）：实际返回

  ```
  { ok: false, error: { code: 'AGENT_SESSION_RESTORE_FAILED',
    message: '无法恢复会话 session-r8-absent-…：持久化记录里找不到该会话（可能已被清理）。新建会话可继续。' } }
  ```

  期望是 `AGENT_SESSION_NOT_FOUND`，**未命中**。原因：[restoreLegacySession](file:///Users/zhumingchen/tiangong/src/main/agent/agent-manager.ts#L704-L725) 在“既无 `agent_sessions` 也无 `chat_threads`”时抛的是 `SessionRestoreError`；`SessionNotFoundError` 只保留在“完全没有持久化来源”分支（Runtime 装配后该分支不可达）。
- **UI 侧**（新建 thread → 设置 sessionId → 删除 `chat_threads` 行 → 发送）：显示

  ```
  无法恢复会话 session-r8-ui-ghost-…：持久化记录里找不到该会话（可能已被清理）。新建会话可继续。
  ```

  不含「适配器不可用」、不含 `[object Object]`，用户可直接点「重试/新建」（[r8-08-ghost-session-ui.png](evidence/r8-08-ghost-session-ui.png)）。

判定：**UI 文案达标；错误码契约不达标**（P3）。修复只需一行：该分支在无任何记录时抛 `SessionNotFoundError`。

### 21.5 第 4 项：`KERNEL=0` 启动日志

```
[kernel] claude-code: 旧路径（BIZGRAPH_AGENT_KERNEL=0 总开关关闭）
[kernel] codex: 旧路径（BIZGRAPH_AGENT_KERNEL=0 总开关关闭）
[kernel] opencode: 旧路径（BIZGRAPH_AGENT_KERNEL=0 总开关关闭）
[kernel] 总开关=off 白名单=[claude]
```

三行命中「总开关关闭」，全量日志**没有**「尚未启用写前审批」。第七轮 D2/D5 的 reason 文案已在 [ipc-handlers.ts](file:///Users/zhumingchen/tiangong/src/main/ipc-handlers.ts#L310-L320) 修正；白名单排除分支也改用「因 `BIZGRAPH_AGENT_KERNEL_BACKENDS` 未列出而回退（完全指定）」。

### 21.6 第 5 项：默认主路径回归

默认配置冷启动日志不变（Claude `kernel 路径已启用（写前强制审批）`，Codex/OpenCode 旧路径）。首写：

| 断言 | 结果 |
|---|---|
| 弹窗 | `写前审批 · Write`，`pending=[appr_1b7ff5eb…, tool=Write]`（[r8-01-default-approval.png](evidence/r8-01-default-approval.png)） |
| 允许 | `allowed / decided_by=user` |
| 文件 | `DEFAULT-R8` 落盘 |
| turn | `completed`，`failure_class=null` |

本轮改动未破坏主路径。

### 21.7 第七轮偏差的关闭情况（静态复核）

| 偏差 | 状态 | 依据 |
|---|---|---|
| D1 回退「完全恢复旧行为」不实 | **已修复并真机验证** | 第 1/2 项；文档 [agent-rollout.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-rollout.md#L75) 已改为「能续则续 / 不能续明确出路」 |
| D2 白名单「收窄」措辞 | **已修复** | [feature-flags.ts](file:///Users/zhumingchen/tiangong/src/main/agent/runtime/feature-flags.ts#L105-L114) 明示「完全指定（替换）」；启动日志对应分支 |
| D3 UNSAFE 误伤 Claude | **已修复** | 能力后端在白名单外时走 `whitelist-excluded`，先于 UNSAFE 分支；UNSAFE 只影响无审批能力后端 |
| D4 日志反向失真 | **已修复** | 同上，Claude 不再被标 degraded |
| D5 `KERNEL=0` 日志原因 | **已修复并真机验证** | 第 4 项 |

D2–D4 本轮只做了代码/文档静态核对，未再跑 UNSAFE 真机场景（题目范围为回退安全阀）。

### 21.8 回退现在能否称为「安全阀」

**可以（是安全阀）。**

- **能续就续**：kernel 期间创建的会话，在 `KERNEL=0` 重启后按 `agent_sessions` + 可信原生 id 续接，不新建、不重复行、文件正常写入（第 1 项）。
- **不能续有明确出路**：legacy 自建会话给出可读原因 +「新建会话可继续」，下发指令解除绑定，下一次发送自动新建并恢复正常（第 2 项）。
- **不会静默坏掉**：两种失败都可见且有下一步动作，没有“没审批也没回复”的静默态。
- **遗留**：完全无记录的 id 错误码为 `AGENT_SESSION_RESTORE_FAILED` 而非 `AGENT_SESSION_NOT_FOUND`（P3，仅影响内部契约；UI 已可读）。

需要明确的一点：回退后旧路径**没有写前审批**，这是回退语义本身（不是缺陷）；因此“安全阀”指“可恢复可用性”，不是“保留审批保护”。

### 21.9 M0 是否正式收官

**可以正式宣布 M0 收官。**

理由：

1. 第七轮唯一阻塞项（回退后既有会话全坏）已修复，并在真机上验证了「续接 / 不可续接出路 / 新会话可用」三条路径。
2. 第七轮 5 条文档偏差已关闭 4 条并验证 2 条；UNSAFE 误标 Claude 已在代码层修正。
3. 默认路径（Claude 审批弹窗、允许落盘、Codex/OpenCode 旧路径）回归通过。
4. 唯一遗留为 P3 错误码语义（第 3 项），不影响用户可见行为，登记进 M1 首个迭代即可；建议顺手改为 `SessionNotFoundError` 并补一条断言。

M0 收官的准确表述：**默认开启成立、回退安全阀成立；遗留一个 P3 错误码契约偏差与既定风险（Bash 不继承授权、非写工具未逐项覆盖、Codex/OpenCode 无审批能力、打包链路未压测）。**

> 纪律：本轮未改业务源码、未 commit；未写 `~/.claude`/`~/.codex`；证据已落 `evidence/r8-*` 与 [r8-summary.json](evidence/r8-summary.json)；结束检查本仓库 Electron 进程 `OUR_APP_REMAIN=0`、`bizgraph-turn:` 进程 `0`。

## 22. 第九轮真机复核（Bash 两档策略）

- 执行时间：2026-11-05 20:08 – 20:11（UTC+8）。
- 构建：本轮重新执行 `npx vite build`（exit 0），真机跑新产物。
- 配置：默认配置，未设任何 `BIZGRAPH_AGENT_KERNEL*`；真实 Claude，同一 thread 顺序执行 9 个 prompt。
- 策略：白名单只读 `allow`；其余 `ask`；空命令 `blocked-empty`。
- 脚本（仓库外）：`stageR9.cjs`；原始结果 [r9-summary.json](evidence/r9-summary.json)，主进程日志 [r9-main.log](evidence/r9-main.log)。

### 22.1 逐项状态

| # | 验收项 | 状态 | 结论 |
|---|--------|------|------|
| 1 | 白名单只读免弹 | **通过** | `ls -la` 直接执行、0 弹窗、0 审批行；`bash.policy: allow / rule=ls` |
| 2 | 危险重定向转审批 | **通过** | 卡片显示 `redirect` + 完整命令；允许后 `canary.txt=X` |
| 3 | `sudo` / `rm -rf` 必须弹 | **通过** | 两条均弹卡：`shell-escape:sudo` / `write-command:rm`，风险「严重」；未被直接拒绝 |
| 4 | `&&` 链整条审批 | **通过** | 卡片含完整两段；允许后 `canary2.txt=Y`；拒绝后 `canary3.txt` 不存在 |
| 5 | 空命令例外 | **通过（受控提示注入）** | Bash 收到两个空格 → 直接拦截，无卡片；`bash.policy: blocked-empty / rule=empty-command / command=""` |
| 6 | 审计可串 | **通过（附 P3 备注）** | 同一 turn/step 的 `bash.policy(rule)` 与 `approval.resolved(decision)` 按 `command` 对齐；`command` 保留原文。但 `agent_events` 表**没有 `step_id` 列**，只能借 `agent_approvals.step_id + turn_id + 相邻 seq` 对齐 |
| 7 | 主路径回归 | **通过** | 首写弹窗→允许本次会话→二次写免弹（policy 授权行，`grant_source` 指向首次审批）；徽标「本次会话已授权（可撤销）」；重启续接成功、`agent_sessions` 1→1 |

### 22.2 第 1 项：白名单只读免弹

`ls -la`（[r9-01-ls-no-dialog.png](evidence/r9-01-ls-no-dialog.png)）：

```
bash.policy: { command: "ls -la", decision: "allow", rule: "ls", reason: "只读白名单命中", risk: "low" }
```

- `sawDialog=false`、`approvalsAdded=0`；Claude 正常拿到目录输出并总结。**该放的放了。**

### 22.3 第 2 项：重定向 → 审批 + 命中规则 + 完整原文

`printf 'X' > /tmp/…/canary.txt`（[r9-02-redirect-approval.png](evidence/r9-02-redirect-approval.png)）：

| 卡片字段 | 值 |
|---|---|
| 命中规则 | `redirect · 含 shell 元字符（redirect），整条命令需一并审批` |
| 命令原文（`pre`） | `printf 'X' > /tmp/bizgraph-realdevice/ws-r9/canary.txt`（未截断，含重定向） |
| 风险 | 高 |
| 结果 | 允许 → `canary.txt` 内容 `X`；approvals `status=allowed / decided_by=user` |

**该弹的弹了，且看得懂在批什么。**

### 22.4 第 3 项：`sudo` / `rm -rf` 弹而不拦

| 命令 | 命中规则 | 风险 | 结果 |
|---|---|---|---|
| `sudo -n true` | `shell-escape:sudo · sudo 可绕过白名单执行任意命令，需人工确认` | 严重（critical） | 弹卡；允许后**执行**，返回 `Exit code 1 · sudo: a password is required`（是 sudo 自身失败，不是策略拦截）（[r9-03-sudo-critical.png](evidence/r9-03-sudo-critical.png)） |
| `rm -rf /tmp/r9-rm-target` | `write-command:rm · rm 是写类命令，需人工确认` | 严重（critical） | 弹卡；允许后目录被删除（`dirRemoved=true`）（[r9-04-rm-critical.png](evidence/r9-04-rm-critical.png)） |

两条均**未出现“直接拒绝”**，危险决策确实交给了用户。

### 22.5 第 4 项：`&&` 链整条审批

- 允许：`ls && printf 'Y' > …/canary2.txt`（[r9-05-and-chain-approval.png](evidence/r9-05-and-chain-approval.png)）
  - 卡片命中规则 `and-chain`，`pre` 为**完整一条**（含 `&&` 与后半段重定向），无截断；
  - 允许后 `canary2.txt=Y`，两段都执行。
- 拒绝：`ls && printf 'Z' > …/canary3.txt`（[r9-06-and-chain-deny.png](evidence/r9-06-and-chain-deny.png)）
  - 同样显示整条；`decision=deny`；`canary3.txt` 不存在。

### 22.6 第 5 项：空命令例外

方式：受控提示注入——要求 Claude “把 Bash 的 command 参数设为恰好两个空格”。Claude 照做，hook 在工具执行前拦截：

```
bash.policy: { command: "", decision: "blocked-empty", rule: "empty-command",
               reason: "空命令不放行：没有可审批的内容", risk: "low" }
```

- `sawDialog=false`、`approvalsAdded=0`、没有执行任何命令；
- Claude 回复明确说明“被 BizGraph bash-policy 拦截”（[r9-07-empty-command.png](evidence/r9-07-empty-command.png)）。
- 审计记录的是 trim 后的空串，符合“无内容命令不放行”。

### 22.7 第 6 项：审计可串

原始关联见 [r9-audit-correlation.json](evidence/r9-audit-correlation.json)。示例（重定向那轮）：

| stepId（来自 `agent_approvals`） | command | bash.policy | approval.resolved |
|---|---|---|---|
| `turn_973d…:step-chatcmpl-tool-a3a5…` | `printf 'X' > …/canary.txt` | seq 2 · `redirect / ask / high` | seq 4 · `allow / user` |

- 5 条 Bash 审批均能在同一 `turn_id` 上按**完全相同**的 `command` 对齐 `bash.policy` 与 `approval.resolved`；
- `command` 原文完整保留（含 `&&`、重定向、`sudo`、`rm -rf` 全段）；
- 会话授权产生的第二条 Write 审批也有行：`status=allowed / decided_by=policy / policy_decision=allow / grant_source=<首次审批 id>`。

**P3 备注**：`agent_events` 的列是 `id/run_id/turn_id/seq/turn_seq/type/source/fidelity/payload_json/created_at`，**没有 `step_id`**。因此“按 stepId 直接 JOIN”做不到，只能通过 `agent_approvals.step_id` + `turn_id` + `seq` 邻接对齐。若审计契约要求直接按 stepId 查询事件，需要补一列。

### 22.8 第 7 项：回归

- **首写审批**：Write 卡片（无 policy 规则，风险高）→「允许本次会话」→ `r9-write-1.txt=WRITE-ONE`。
- **二次写免弹**：`sawDialog=false`，文件 `WRITE-TWO` 正常；但**仍落一条审计行** `decided_by=policy / grant_source=首次审批 id`（不是静默跳过审计）。
- **徽标**：截图可见「本次会话已授权（可撤销）」，审批卡片消失，`agent:getPendingApprovals` 返回 0（[r9-08-regression-session-grant.png](evidence/r9-08-regression-session-grant.png)）。
- **重启续接**：关闭重启，同一 thread 发 `pwd` → 直接执行（白名单）、无弹窗、turn `completed`、`agent_sessions` 1→1（[r9-09-restart-continue.png](evidence/r9-09-restart-continue.png)）。

### 22.9 关键结论

**「该弹的都弹了、该放的都放了、弹窗让人看得懂在批什么」成立。**

| 标准 | 证据 |
|---|---|
| 该弹的都弹了 | 重定向、`sudo`、`rm -rf`、`&&` 链、Write 首写均弹卡；`sudo`/`rm` 风险标「严重」，未被直接拒绝 |
| 该放的都放了 | `ls -la` 无弹窗、`bash.policy=allow/rule=ls`；会话授权后二次写免弹且审计留痕 |
| 弹窗看得懂 | 卡片显示命中规则（`redirect` / `shell-escape:sudo` / `write-command:rm` / `and-chain`）、风险等级、**完整命令原文**（含重定向/`&&` 后半段），无截断 |

没有功能断点。唯一断点是审计字段：`agent_events` 缺 `step_id` 列，导致“按 stepId 直接关联”需要借助 `agent_approvals.step_id + turn_id + seq` 间接对齐（P3，不影响用户可见行为）。

> 纪律：本轮未改业务源码、未 commit；未写 `~/.claude`/`~/.codex`（未改任何用户配置）；证据已落 [evidence/r9-*](file:///Users/zhumingchen/tiangong/docs/architecture/evidence/) 与 [r9-summary.json](evidence/r9-summary.json)；结束检查本仓库 Electron 进程 `OUR_APP_REMAIN=0`、`bizgraph-turn:` 进程 `0`，临时目录 `/tmp/r9-rm-target` 已清理。
