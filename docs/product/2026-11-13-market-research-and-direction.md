# 市场调研与完善方向（v1.0）

> 文档用途：为 BizGraph（tiangong）的「宣称 vs 交付」差距确定补齐方向与路径。
> 调研时间：**2026-11-13**（全部来源均为当日检索；竞品状态变化极快，结论标注了时效与存疑项）
> 结论口径：本文件只做方向裁决，不产生施工授权；施工项进入 `docs/architecture/session-map-blueprint.md` 状态账。

---

## 一、调研方法与边界

- **样本**：境外 14+ 个同类工具（并行编排器 / 任务板 / 规格层 / 第一方官方 App）+ 3 份 2026 年开发者量化调研 + 2 类方法论（SDD、验收证据）。
- **不采信**：厂商自述的「最好用」类表述；只采信可交叉验证的能力项（是否有 worktree 隔离、是否支持审批、是否开源、是否有移动端）。
- **已知存疑**：Conductor 的归属状态两处来源冲突（一处称 2026-11-04 宣布并入 Meta 并停止新注册、云版 11-20 关停；另一处称 11-12 撤回关停计划继续开发）。本文件按「状态不稳定」处理，不据此做判断。

---

## 二、市场格局：四层，且正在快速出清

| 层 | 代表 | 形态 | 商业状态 |
|---|---|---|---|
| **第一方官方 App**（最大威胁） | Claude Code Desktop（2026-04 改版，并行会话侧栏 + Agent Teams + Routines）、Codex App | 单厂商、并行会话、diff 评审 | 随订阅免费，天然分发 |
| **并行编排器** | Conductor（Melty Labs，YC，$22M A 轮，仅 macOS，闭源，免费）、Crystal（Stravu，MIT，2026-02 停更→Nimbalyst）、Claude Squad（Go TUI，AGPL）、Parallel Code、Sculptor（Docker 隔离） | worktree 隔离 + diff 评审 | 多数免费；Conductor 状态不稳 |
| **任务板 / 工作台** | Vibe Kanban（Bloop 2026-04-10 关停，Apache-2.0 社区维护）、Nimbalyst（Crystal 后继，MIT，三平台 + iOS/Android 伴侣）、Pivio（闭源，1-6 分屏 + 手机伴侣 + 定时）、Instify（story 卡片，macOS）、Omnara（手机优先控制面，$9/月） | 看板 / 分屏 / 远程 | 免费为主，付费点在远程与团队 |
| **规格与验证层** | AWS Kiro（EARS 语法 + 属性测试 + spec drift 检测）、GitHub Spec Kit（MIT，跨 agent）、OpenSpec（brownfield 增量规格） | 规格驱动开发（SDD） | 订阅 / 免费 |

**关键事实**：一年内至少 3 个项目死亡或改名（Crystal、Vibe Kanban、Bloop），Conductor 归属变动。行业观察者的判断是「14 个里还会有更多死掉或转型」（tomrochette.com，2026-09 复核）。

---

## 三、能力对比：我们真正的位置

| 维度 | 第一方 App | 并行编排器 | 任务板 | Kiro/Spec Kit | **BizGraph 现状** |
|---|---|---|---|---|---|
| 多 Agent 覆盖 | 单厂商 | 2–11 个，深度仅 2–4 个 | 10+ | 跨 agent（Spec Kit） | 11 个，深度 4 个 |
| 隔离方式 | worktree/云 | worktree（Sculptor 用 Docker） | worktree | 无 | worktree（已有） |
| 变更评审 | diff 面板 | diff 面板（强项） | diff 面板 | 无（靠 IDE） | diff + 逐文件回滚（强） |
| **业务语义层** | 无 | 无 | 卡片=任务 | 规格=markdown | **思维导图 + 双轨派生（独有）** |
| **写入边界管控** | 权限弹窗 | 无 | 无 | steering/AGENTS.md（软约束） | **ScopeGuard 文件级拦截+回滚（独有）** |
| **验收证据链** | 无 | 无 | 无 | 属性测试（只证代码对规格） | 有 run/step/evidence 原始件，**缺用户侧出口** |
| 远程/移动 | 有 | 部分 | 有 | 有 | 无（A2A 仅本地） |
| 开源 | 否 | 混合 | 多数 | Spec Kit 是 | MIT |

**三条可交叉验证的市场结论**：

1. **并行已是免费商品**。行业复核结论原话：「Parallelism is already the free commodity in this category: the only things anyone pays for are review ergonomics and remote execution」。14 个玩家在抢同一件事，价格锚点已被打到 0（Conductor / Nimbalyst / Pivio / Crystal 全免费）。
2. **第一方正在吞掉「单 agent + 并行会话 + diff」这一层**。Anthropic 与 OpenAI 的官方 App 已内置并行会话与 diff 评审，且随订阅免费。任何以「并行跑 Claude Code」为主卖点的产品，都在跟厂商的免费功能竞争。
3. **付费点已转移到「敢不敢合」**。Paradev 是唯一明确做团队定价的（Pro $20 / Team $60 / Ultra $200 每席每月），卖的是远程与云端工作区；Sonar、Qodo 的企业叙事全部围绕「验证与治理」。**没有人靠「跑得快」收到钱，钱在「可验证、可审计」。**

---

## 四、需求侧证据：真正的痛点是验证，不是并行

| 数据 | 来源 | 对我们的含义 |
|---|---|---|
| AI 生成/辅助的代码占提交量 **65%** | Sonar 2027 State of Code（2026-11-12，n=1,026） | 代码供给已过剩 |
| **76%** 生成速度快于验证速度；**53%** 花在评审上的时间超过写代码（采用 AI 前为 18%） | 同上 | 「评审瓶颈」是主战场 |
| 仅 **39%** 完全同意 AI 代码提交前一定被检查；**94%** 不完全信任 | 同上 | 检查动作缺失，不是意识缺失 |
| 仅 **23%** 有 AI 专属规范或自动检查 | 同上 | 团队侧空白 |
| 「评审与验证」被开发者与管理者同列为**第一瓶颈**（25.8% / 26%）；仅 **3.7%** 认为现有流程够用 | Qodo 2026（n=800） | 需求确证，且是共识 |
| **36.4%** 表示评审耗时没变但认知负荷更高；**34.6%** 说给了上下文 agent 也不遵守 | 同上 | 「给了规则不遵守」= 需要硬边界而非提示词 |
| **38.3%** 的最大缺口是「看不见 agent 改了什么」 | 同上 | 可见性 = 我们的证据面板 |
| 采用率 84%、信任率 29%（较两年前 40% 下降） | Stack Overflow 2026-02 | 信任赤字在扩大 |

**Sonar 给出的四个解法，与我们的架构一一对应**：

| Sonar 建议 | BizGraph 已有资产 | 缺什么 |
|---|---|---|
| Intent：先定义结果再让 agent 动手 | 思维导图节点 + 验收标准 | 验收标准不是可执行字段，只是文本 |
| Guiderails：给规则并治理 | ScopeGuard（文件级拦截 + 回滚） | 黑名单/上下游契约**无 UI 入口** |
| Verification：独立检查每个变更 | run/step/evidence 账本、测试执行器 | 无「验收判定」动作，无证据面板 |
| Evidence：让信心可量化可审计 | agent_events / approvals / 成本账本 | **renderer 零调用**，导不出证据包 |

**这是本次调研最重要的发现**：我们的后端已经长成了市场公认的解法形状，但用户一个都摸不到。问题不是「方向错了」，而是「价值没有出口」。

---

## 五、方向裁决

### 5.1 定位修正（一句话）

> 原定位：**Agent CLI 的桌面指挥塔**（强调并行与管控）
> 新定位：**Agent 交付的验收台** —— 在业务地图上定义「该改什么、改到什么算完成」，对每一次 Agent 交付给出可复核的验收结论与证据。

理由：并行是免费商品、第一方在吞并该层；而「意图→边界→证据」这一层没有第一方做（他们只服务自己的 agent），也没有编排器做（他们只管跑和看 diff）。我们已有的三件独有资产（业务语义图、ScopeGuard、证据账本）恰好拼成这一层。

### 5.2 四个完善方向（按「是否有市场证据」排序）

| 方向 | 内容 | 市场依据 | 与既有差距的关系 |
|---|---|---|---|
| **D1 验收闭环** | 节点=可执行验收契约（验收项/不变量/证据要求）；占位节点一键派发；Bug 节点升级为「验收失败节点」；交付后出验收结论（通过/部分/不通过 + 未覆盖项） | Sonar Intent+Verification；Qodo 47.7% 缺口 | 修 #1 占位承诺、#2 Bug 半闭环 |
| **D2 证据与审计** | 证据面板（改了什么/越界没有/测了没有/没覆盖什么）；证据包导出（MD/JSON）；团队视图 | Sonar Evidence（仅 36% 能度量）；Qodo 38.3% 可见性 | 修 #4/#5「后端有 UI 无」 |
| **D3 能力诚实化** | 适配器能力矩阵（流式/审批/恢复/diff 逐项标绿灰）；README 口径降级；薄适配器不参与「可验收」承诺 | 品类普遍以「支持 N 种」虚标；信任赤字 | 修 #3/#6 |
| **D4 分发与运维** | 最小首启（示例项目 + 3 步）、日志落盘、崩溃报告、诊断包、自动更新、备份导出 | 品类出清期的留存前提；本地优先是差异点 | 修「桌面产品基础能力全缺」 |

> **反向结论（明确不做）**：不做云 VM / 远程工作区（Paradev、Cursor 已占，且与本地优先冲突）；不做手机端（Omnara/Pivio/Nimbalyst 已占）；不追第 12–15 个薄适配器（广度已过剩，深度才是差异）；不做 IDE（Kiro/Cursor 的地盘）；不与 Sonar 抢静态扫描（应消费其输出作为证据源之一）。

### 5.3 与上一轮 P0/P1 的差异（据调研修正）

| 上轮结论 | 调研后修正 | 原因 |
|---|---|---|
| P0：Bug 节点补人工闭环 | **改为「验收失败节点」**，Bug 只是其中一种失败类型 | 缺陷追踪是红海（Jira/Linear 已占）；「验收不通过」才是我们的语义 |
| P1：记忆/代码智能补最小出口 | 保留，但**降为 D2 的附属**（先进证据面板，记忆检索后置） | 用户不会为「记忆」付费，会为「这次改动凭什么能合」付费 |
| 未列 | **新增 D3 能力矩阵**，且升为第一阶段必做 | 团队采购第一件事就是核对能力边界，虚标直接失去信任 |
| 未列 | **新增「证据包导出」**，作为团队版付费雏形 | Paradev Team $60/席 是唯一被验证的付费点形态 |

---

## 六、路径：三个阶段（每阶段有退出条件，不达标不进入下一阶段）

### Stage 1 · 可信交付闭环（约 2 周）

**目标**：让一个 Agent 从「点了就跑」变成「跑完有据、可判通过与否」。

范围（Must）：
1. 占位节点 → 真正一键派发（当前只预填提示词）
2. 节点增加可执行验收字段：验收项（可勾选）、不变量、必需证据（diff/测试/截图）
3. 证据面板 v1：本次 run 改了哪些文件（含越界拦截记录）、跑了哪些测试、哪些验收项未覆盖
4. 验收判定动作：通过 / 部分通过 / 不通过（不通过自动生成「验收失败节点」，带 severity）
5. README 口径修正 + 适配器能力矩阵（静态表先上）
6. CI：`unit` 去掉 `continue-on-error`，真跑一轮并修红

**退出条件（可验收）**：
- 新用户 10 分钟内完成一次「建节点 → 派发 → 看证据 → 判验收」闭环（录屏为证）
- 任一 run 都能回答四问：改了什么 / 越界没有 / 测了没有 / 没覆盖什么
- CI 单测为硬门禁且远端首轮全绿

### Stage 2 · 价值可感知（约 3–4 周）

**目标**：把已投入但用户摸不到的能力接上出口，降低首次使用门槛。

范围（Should）：
1. 记忆检索面板（搜索 + 命中来源 + 采纳/忽略反馈），接上已有 11 个 IPC 通道
2. 相关文件推荐进节点面板（接代码智能 4 通道）
3. 最小首启：内置示例项目 + 3 步向导（选 agent → 打开示例图 → 跑一次派发）
4. i18n 硬编码清扫（NodeMap/PlanDraft/ImportDedup）+ lint 规则防回潮
5. 团队视图 v0：按节点/按人/按时间的验收通过率

**退出条件**：UI 中可点到记忆检索与文件推荐；英文环境下无中文残留（抽查 3 个新面板）；示例项目开箱可跑通 Stage 1 闭环。

### Stage 3 · 可分发（约 2–3 周）

**目标**：从「能跑」到「敢发给别人用」。

范围（Could）：
1. 证据包导出（单次 run / 单节点 / 整图，MD + JSON）
2. 日志落盘 + 崩溃报告（本地，不上传）+ 一键诊断包
3. 自动更新（`electron-updater` + `publish` 配置 + 签名/公证）
4. 备份/导出 UI（接已有 snapshot 通道）
5. `package.json` 去掉 `private: true`，发布 v0.2

**退出条件**：陌生用户可在无指导情况下安装→升级→出问题导出诊断包；一次交付的证据包可交给未参与的人复核并得出相同结论。

---

## 七、指标口径（用来判断方向是否真的有效）

| 指标 | 定义 | 目标（Stage 1 后） |
|---|---|---|
| 闭环时长 | 从派发到给出验收结论的中位时间 | ≤ 15 分钟（含人工复核） |
| 证据覆盖率 | 有完整证据（diff+测试+越界记录）的 run 占比 | ≥ 90% |
| 返工率 | 14 天内被重开的节点 / 已验收节点 | ≤ 15% |
| 人工复核时长 | 单次变更人工阅读耗时 | 相对现状下降 ≥ 30% |
| **反向指标** | 越界写入被拦截后仍被合并的次数 | **必须为 0** |
| **反向指标** | 无证据却被标记「已验收」的节点数 | **必须为 0** |

---

## 八、风险

| 编号 | 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|---|
| RK-M1 | 第一方 App 继续下沉到「验收 + 证据」 | 3 | 5 | 保持 agent-agnostic + 本地优先；第一方只服务自家 agent，跨厂商是我们唯一护城河 |
| RK-M2 | 免费竞品把价格锚定在 0，变现困难 | 4 | 4 | 个体免费，团队按席位卖证据/审计（对齐 Paradev Team $60）；不卖并行 |
| RK-M3 | SDD 教条化导致「规格表演」，用户嫌重 | 4 | 3 | 明确阈值：小改不强制规格；验收项默认 2–3 条，可跳过（但跳过需记录） |
| RK-M4 | 三阶段范围蔓延回工程偏好 | 4 | 3 | 每阶段只做本文列出的项；新增项一律进「后续版本池」，不在阶段内插入 |
| RK-M5 | CI 首次真跑大面积红阻塞阶段 1 | 3 | 3 | Stage 1 第一周先跑一次基线，红灯分诊后再定交付承诺 |

---

## 九、来源清单（检索日 2026-11-13）

1. Sonar《2027 State of Code Developer Survey》新闻稿，2026-11-12：https://www.sonarsource.com/company/press-releases/sonar-releases-2027-developer-survey-report/
2. Qodo《2026 State of AI Code Quality》：https://www.qodo.ai/state-of-ai-code-quality-report/
3. Coder Legion 对 Qodo 报告的解读（含信任悖论与评审负担数据）：https://coderlegion.com/16265/developers-trust-ai-code-they-also-dont-trust-it-both-are-true
4. Innvente《The AI Coding Trust Gap》（引用 Stack Overflow 2026-02 调查）：https://innvente.com/blog/ai-coding-agents-trust-gap-2026
5. Tom Rochette《Orchestration Feature Matrix》（14 工具逐项复核，含「并行是免费商品」判断）：https://tomrochette.com/agents/orchestration-feature-matrix
6. AgentsRoom《Best Tools to Run Multiple Coding Agents in 2026》：https://agentsroom.dev/blog/best-multi-agent-coding-tools
7. Superset《Conductor vs Crystal (2026)》（含 Conductor 并入 Meta 的表述，与来源 8 冲突）：https://superset.sh/compare/conductor-vs-crystal
8. Bage《Crystal alternatives》（称 Conductor 2026-11-12 撤回关停计划）：https://bage.aq.dev/alternatives/crystal
9. Pivio《Vibe Kanban alternatives in 2026》（Bloop 关停时间、竞品对比表）：https://pivio.app/alternatives/vibe-kanban
10. Instify《Vibe Kanban Alternatives (2026)》（Conductor $22M A 轮、story 卡片模型）：https://instify.ai/blog/vibe-kanban-alternatives
11. Kiro 官网与一周年回顾（EARS、属性测试、并行 agent）：https://kiro.dev/ ｜ https://kiro.dev/blog/one-year
12. Dmitry Shirokov《Spec-driven development: Spec Kit, Kiro, and what sticks》（SDD 的收益与四种失败模式）：https://shirokoff.ca/blog/spec-driven-development
13. TuniCyberLabs《Spec-Driven Development Tooling in 2026》（spec drift / spec theater / 过度规格化）：https://tunicyberlabs.com/en/blog/spec-driven-development-tooling-2026-spec-kit-kiro-openspec
14. DevMoment《Spec-Driven Development 一个月实战》（「变更大于脑子才写规格」阈值）：https://www.devmoment.dev/journal/spec-driven-development-field-log-2026

> 声明：本文件为产品方向研究，竞品状态以各来源检索日为准，价格与归属可能随时变化；实施前需二次核对。具体实施请结合公司合规与法务要求确认。
