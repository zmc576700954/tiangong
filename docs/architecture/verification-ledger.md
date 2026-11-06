# Agent 体系未验证项台账

- 建立日期：2026-11-05（来源：[agent-consistency-audit-2026-11-05.md](file:///Users/zhumingchen/tiangong/docs/architecture/agent-consistency-audit-2026-11-05.md) §3）
- 维护规则：每项只有「已验证 / 已降级为文档承诺 / 明确不做」三种关闭方式；不得以“设计上应该成立”关闭。
- 影响面口径：**用户可见** = 会改变用户看到的行为或安全感受；**内部** = 只影响实现/维护/审计。

| # | 条目 | 当前证据 | 影响面 | 关闭条件 |
|---|---|---|---|---|
| U1 | Codex **官方 provider** 下 `item.updated` / `reasoning` 是否出现 | 第三方 provider 实测 0 次，不能外推 | 用户可见（时间线粒度） | 换官方 key 录一次真实会话，断言事件类型 |
| U2 | OpenCode 是否有结构化工具事件 / 权限协议 | 未验证 | **用户可见**（工具时间线与审批） | 真实 CLI 跑一次，记录原始事件 |
| U3 | `better-sqlite3` 高事件量下主进程阻塞 | 未验证；50ms 批写未实现 | 用户可见（UI 卡顿） | 10k 事件回放，测主进程最长阻塞 |
| U4 | 打包产物里 SDK / CLI 二进制可用性 | 未验证 | **用户可见 / 发布阻塞** | `electron-builder` 产物 smoke |
| U5 | Claude 开 `includePartialMessages` 的 token 增量稳定性 | 未验证 | 用户可见（打字机效果） | 可选实验；不通过则维持 turn 级 |
| U6 | Windows / Linux 进程组回收与孤儿行为 | 仅 macOS 实测；Windows Job Object 未实现 | **用户可见**（跨平台残留进程） | 目标平台跑取消 + kill -9 用例 |
| U7 | 跨重启“可证明归属”证据能否稳定取到 | `ps lstart` + 完整命令行；`startedAtHiRes` 未持久化 | 用户可见（漏杀/残留） | 构造残留进程，断言 kill=0 或命中 |
| U8 | 真实第二 uid 的跨用户攻击 | 只断言 0600/0700 权限位与同 uid 行为 | 内部（安全） | 建测试用户跑伪造/重放 |
| U9 | 真实 Codex 长任务中途崩溃 / 取消后的孤儿回收 | 未验证（仅单元/夹具） | **用户可见**（命令继续跑） | 真实 codex 长任务 + kill -9 |
| U10 | 会话级授权「重启不继承」 | 真机 §14.5 标“未验证（受阻）”：同会话 UI 发送失败 | **用户可见**（以为授权还在） | 修会话恢复 P1 后重跑 |
| U11 | 长尾合成证据 precision / recall ≥95% | 只有单测，无真实会话 ground truth | **用户可见**（diff 误报/漏报） | 每适配器 3 次真实会话对比 `git status` |
| U12 | 用户 `~/.claude/settings.json` 的 allow 规则对非写类工具的影响 | 写类已由强制 `ask` 封堵；非写工具未逐项验证 | 用户可见（审批覆盖范围） | 构造 allow 规则 + 非写工具 |
| U13 | 双路径 supervision（runtime / legacy）并发压测 | 未压测 | 内部（切换稳定性） | 20 turn 两路径混跑 |
| U14 | C13b 同名 symlink 抢占是否已修 | 文档写“修复中”；未见最终结论 | 内部（同 uid 残余面） | 看提交或补测 |
| U15 | 组长先死、组员仍存活 | 明确不承诺，只记 `missing` | 用户可见（残留进程） | 保持“不承诺”文案（已关闭为文档承诺） |
| U16 | 用量账本与供应商账单对账 | 未做 | 内部（成本准确性） | 按周比对 `sum(cost_micros)` |

## 明确不做（不计入待验证）

- 排队（`queueDepth=1`）：Phase 2，产品未定调。
- 额度熔断 / 预算三级：产品决定只记账，不熔断。
- 长尾 CLI 逐 CLI parser：没有稳定结构化事件，只保留合成证据。
- Codex / OpenCode 写前审批：能力缺口，按 §17.4 如实降级。
- better-sqlite3 ABI 测试受阻：环境问题，单独处理。
- 真实 Electron 旧库升级：v21→v23 已在真实构建产物验证（见 `agent-rollout.md` M1 已交付）。
