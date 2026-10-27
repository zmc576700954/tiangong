# BizGraph 框架硬伤修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复六子系统调研确认的九处框架级缺陷——让 BizGraph 注入给 Agent CLI 的内容符合 CLAUDE.md 边界（用户请求走 user turn、system 跨轮稳定）、消除「建好但没接上」的能力断层、让 schema 迁移与状态枚举在数据层与类型层一致、给 JSON 列加运行时校验。

**Architecture:** Prompt 装配拆成「稳定前缀 / 每轮上下文」两段并排除用户请求；scope 段标题收敛为单一常量源；claude-code 补齐 `sessionEnded` 发射与原生恢复重发契约；schema 迁移慢路径无条件重建并比对列类型；`chat_messages.status` CHECK 扩容；JSON 列统一走 `safeJsonParse` 的 validator 参数。

**Tech Stack:** TypeScript（strict）、Electron 33、better-sqlite3 12、Vitest（node 环境）、零新增第三方依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-framework-hardening-design.md` —— 实施前先读该设计文档；计划与 spec 冲突时以 spec 为准。

## Global Constraints

- **CLAUDE.md 边界（硬约束）**——不修改 Agent CLI 的 system prompt / user request / model request headers / tool schema / provider routing / approval context；A2A 透明转发会话（`transparentForward`）不下发任何 BizGraph 内部状态。
- **KV-cache 前缀不可污染**——stable 段必须跨轮逐字节一致；任何每轮变化的内容（水位线、代码上下文、会话历史记忆、用户请求）不得进入 stable 段。
- **状态流转**——节点状态变更必须走 `NodeRepository.update()`（内部强制 `validateNodeTypeTransition`）；禁止在 `node-repository.ts` 之外直接 `UPDATE nodes SET status`。
- **schema 变更**——必须 bump `CURRENT_SCHEMA_VERSION`（`src/main/database.ts`）。
- **原生 ABI 冲突**——`better-sqlite3` 同一时刻只能服务一种 ABI：跑 Vitest 前 `npm rebuild better-sqlite3`（Node ABI 115），跑 Electron 应用前 `npx electron-builder install-app-deps`（Electron ABI 130）。**每个任务跑完测试后都要切回 Electron ABI**，否则后续 `npm run dev` 会崩。
- **真实数据库验证**——涉及 DB 字段 / CHECK / 迁移的用例必须用真实 better-sqlite3（`src/main/__tests__/database-migration.test.ts` 已是此模式）。内存 fake repo 会掩盖字段丢失与约束违例（历史教训，见 `docs/tasks/2026-07-26-wiki-graph-compute.md`）。
- **零新增依赖**——不得引入任何 npm 包。
- **每个 commit 前必过**——`npx tsc --noEmit` + `npm run test` + `npm run lint`。

## Review Focus

以下五类是 spec 隐含、但没有哪条任务的自带用例直接覆盖、最可能真正咬人的输入。每个任务必须补上对应测试。

1. **A2A 透明转发会话**——`transparentForward: true` 的会话，stable 段与 turn 段必须**同时为空**，远端 LLM 看不到任何 BizGraph 内部状态（scope / memory / 水位线）。→ Task 3 补测试
2. **同一个 CLI 会话连发两条不同命令**——第一条命令的原文不得出现在第二条命令的 system 段里；stable 段两条命令之间必须完全相同。→ Task 3 补测试
3. **scope 压缩到 Level 1 时黑名单必须存活**——「禁止修改的文件（黑名单）」是安全约束，任何预算压力下都不得被丢弃（现有压缩阶梯只处理不变量 / 上下游 / 白名单）。→ Task 1 补测试
4. **老库升级到新 schema**——v15 的真实库（`chat_messages.status` 含 'success'）升级到 v16 后行数不变、status 值不变、CHECK 已含 'queued'。→ Task 7 补测试
5. **JSON 列被写成非法形状**——`chat_messages.context_refs` 被写成 `'{"a":1}'`（对象而非数组）时，读取必须退化为 `[]` 而不是让下游 `.map` 崩溃。→ Task 8 补测试

---

## File Structure

| 文件 | 职责 | 任务 |
|------|------|------|
| `src/main/adapters/scope-prompt-builder.ts` | scope 段标题的唯一字面量来源 + scope 文本生产 | 1 |
| `src/main/memory/prompt-orchestrator.ts` | 五层预算分配、压缩阶梯、stable/turn 切分 | 1, 2 |
| `src/shared/types/agent.ts` | `PromptContext` 类型、`AgentSession` / `AgentAdapter` 契约 | 2, 3 |
| `src/main/agent/context-assembler.ts` | 解析各类上下文，产出 segments | 2, 4 |
| `src/main/agent/agent-manager.ts` | 把 segments 投递给适配器 | 3 |
| `src/main/adapters/base.ts` | `setPromptContext` / `buildScopePromptForSession` / `buildTurnContext` / `buildFullPrompt` | 3 |
| `src/main/adapters/{cursor,cline,codebuddy,qwen-code,kimi-code,kilo-code,qoder,mindmap-adapter,codex}.ts` | CLI/thread 类适配器改用 `buildFullPrompt` | 3 |
| `src/main/adapters/claude-code.ts` | system 走 stable、user 走 turn+command；SDK 错误时发射 `sessionEnded` | 3, 5 |
| `src/main/adapters/mcp-adapter.ts` | system 消息走 stable、user 消息走 turn+userPrompt | 3 |
| `src/main/agent/session-recovery.ts` | claude-code 恢复策略改用 `resumeSessionId` 判定 | 5 |
| `src/main/agent/recovery-orchestrator.ts` | native 分支重发上一条命令 | 5 |
| `src/main/database.ts` | 迁移门禁、列类型比对、`chat_messages` CHECK 扩容 | 6, 7 |
| `src/shared/type-guards.ts` | JSON 列运行时守卫 | 8 |
| `src/main/services/chat-service.ts`、`src/main/repositories/agent-log-repository.ts`、`src/main/repositories/graph-repository.ts` | JSON 列解析处传 validator | 8 |

---

### Task 1: scope 段标题单一来源，修复压缩分级

**Files:**
- Modify: `src/main/adapters/scope-prompt-builder.ts`
- Modify: `src/main/memory/prompt-orchestrator.ts:129-136`（`classify` 函数）
- Test: `src/main/adapters/__tests__/scope-prompt-builder.test.ts`
- Test: `src/main/memory/__tests__/prompt-orchestrator.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `src/main/adapters/scope-prompt-builder.ts`：`export const SCOPE_SECTION_HEADINGS` —— 类型 `{ readonly acceptance: string; readonly allowedFiles: string; readonly forbiddenFiles: string; readonly invariants: string; readonly upstream: string; readonly downstream: string; readonly bugs: string; readonly additionalContexts: string; readonly projectMemory: string }`，值为 `'## 验收标准'` / `'## 允许修改的文件（白名单）'` / `'## 禁止修改的文件（黑名单）'` / `'## 业务不变量'` / `'## 上游契约'` / `'## 下游契约'` / `'## 待修复 Bug'` / `'## 附加上下文'` / `'## 项目记忆'`
  - `buildScopePrompt(config, resolvedContexts?)` —— **删去第三个形参 `codeContext`**（Task 2 会调用点更新，本任务先改生产者侧签名与现有两个测试）

- [ ] **Step 1: 写失败测试**

在 `src/main/adapters/__tests__/scope-prompt-builder.test.ts` 追加：

```ts
describe('SCOPE_SECTION_HEADINGS', () => {
  it('每个段标题都以 "## " 开头且互不相同', () => {
    const values = Object.values(SCOPE_SECTION_HEADINGS)
    expect(values.every((v) => v.startsWith('## '))).toBe(true)
    expect(new Set(values).size).toBe(values.length)
  })

  it('buildScopePrompt 产出的段标题全部来自常量表', () => {
    const prompt = buildScopePrompt({
      nodeTitle: 'N',
      acceptanceCriteria: ['a'],
      allowedFiles: ['src/a.ts'],
      forbiddenFiles: ['src/b.ts'],
      invariantRules: ['r'],
      upstreamContext: 'up',
      downstreamContext: 'down',
      bugContext: [],
    } as never, [{ label: 'L', type: 'note', content: 'c' } as never])
    const headings = Object.values(SCOPE_SECTION_HEADINGS)
    for (const line of prompt.split('\n')) {
      if (line.startsWith('## ')) expect(headings).toContain(line)
    }
  })
})
```

在 `src/main/memory/__tests__/prompt-orchestrator.test.ts` 顶部 import 增加：

```ts
import { compressScopeByPriority as compressScopeByPriorityForTest } from '../prompt-orchestrator'
```

并追加：

```ts
it('scope 压缩分级按中文标题生效：Level 1 移除业务不变量但保留黑名单', async () => {
  const scope = [
    '## 业务不变量', '- 恒等约束', '',
    '## 禁止修改的文件（黑名单）', '- src/secret.ts', '',
    '## 上游契约', 'up', '',
    '## 下游契约', 'down', '',
  ].join('\n')
  const result = compressScopeByPriorityForTest(scope, 20)
  expect(result.compressionLevel).toBeGreaterThanOrEqual(1)
  expect(result.text).not.toContain('恒等约束')
  expect(result.text).toContain('src/secret.ts')
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/adapters/__tests__/scope-prompt-builder.test.ts src/main/memory/__tests__/prompt-orchestrator.test.ts
```

Expected: FAIL —— `SCOPE_SECTION_HEADINGS` 未导出；`compressScopeByPriorityForTest` 未导出。

- [ ] **Step 3: 导出常量表并让生产者使用它**

在 `src/main/adapters/scope-prompt-builder.ts` 顶部（`MAX_USER_INPUT_LENGTH` 之后）加：

```ts
/**
 * scope 段标题的唯一字面量来源。
 * 生产者（buildScopePrompt）与消费者（PromptOrchestrator 的压缩分级）必须共用这份常量——
 * 历史上生产者输出中文标题、消费者按英文标题匹配，导致所有段落都落进 'other'，
 * 分级压缩形同虚设。
 */
export const SCOPE_SECTION_HEADINGS = {
  acceptance: '## 验收标准',
  allowedFiles: '## 允许修改的文件（白名单）',
  forbiddenFiles: '## 禁止修改的文件（黑名单）',
  invariants: '## 业务不变量',
  upstream: '## 上游契约',
  downstream: '## 下游契约',
  bugs: '## 待修复 Bug',
  additionalContexts: '## 附加上下文',
  projectMemory: '## 项目记忆',
} as const
```

把 `buildScopePrompt` 里所有 `lines.push('## 验收标准')` 一类字面量换成 `lines.push(SCOPE_SECTION_HEADINGS.acceptance)`（逐个替换，共 8 处），并**删去 `codeContext` 形参及其注入块**（原 `scope-prompt-builder.ts:42` 与 `106-110`）。同步更新函数上方的 JSDoc `@param` 列表。

- [ ] **Step 4: 让消费者按常量表分类**

在 `src/main/memory/prompt-orchestrator.ts`：

- 顶部 import 增加 `SCOPE_SECTION_HEADINGS`（从 `'../adapters/scope-prompt-builder'`）。
- 把 `classify` 改为：

```ts
const classify = (s: string): SectionClass => {
  const trimmed = s.trim()
  if (trimmed.startsWith(SCOPE_SECTION_HEADINGS.invariants))    return 'invariant'
  if (trimmed.startsWith(SCOPE_SECTION_HEADINGS.upstream))      return 'upstream'
  if (trimmed.startsWith(SCOPE_SECTION_HEADINGS.downstream))    return 'downstream'
  if (trimmed.startsWith(SCOPE_SECTION_HEADINGS.allowedFiles))  return 'allowed-files'
  return 'other'
}
```

- 把 `compressScopeByPriority` 改为 `export function compressScopeByPriority(...)`（加 `export` 关键字），并在测试文件里用 `import { compressScopeByPriority as compressScopeByPriorityForTest }` 引入。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/main/adapters/__tests__/scope-prompt-builder.test.ts src/main/memory/__tests__/prompt-orchestrator.test.ts
```

Expected: PASS。

- [ ] **Step 6: 修掉因签名变化而编译不过的调用点**

```bash
npx tsc --noEmit
```

Expected: 报错集中在 `scope-prompt-builder.ts` 的 `codeContext` 形参与 `prompt-orchestrator.ts:229` 的 `buildScopePrompt(sessionConfig, resolvedContexts, codeContext)`。改法：
- `prompt-orchestrator.ts:229` 改为 `buildScopePrompt(sessionConfig, resolvedContexts)`；把 `codeContext` 从 scope 层移出，改并入 context 层（Task 2 会做，这里先只保证编译通过：把 `codeContext` 暂存到 `contextText` 的初始值 `let contextText = codeContext ?? ''`）。

- [ ] **Step 7: 删除 code-intelligence 里与 scope-prompt-builder 重复的 PromptAssembler**

`src/main/code-intelligence/prompt-assembler.ts` 的 `PromptAssembler` 类**零生产消费者**（只有自身测试与 barrel 导出引用它），而它的 `buildScopeSection` 复制了一份 scope 构造，段标题还与 `scope-prompt-builder.ts` **不一致**（`## 允许修改的文件` vs `## 允许修改的文件（白名单）`）——正是 Task 1 要根治的那类漂移。留着它就是留一个随时会被误用的第二实现。

删除：

```bash
rm src/main/code-intelligence/prompt-assembler.ts
rm src/main/code-intelligence/__tests__/prompt-assembler.test.ts
```

并从 `src/main/code-intelligence/index.ts` 移除两行：

```ts
export { PromptAssembler } from './prompt-assembler'
export type { PromptAssemblyOptions } from './prompt-assembler'
```

`ResolvedCodeContext`（`smart-context-resolver.ts` 导出）保留——它被 `ContextAssembler` 使用。

- [ ] **Step 8: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(prompt): scope 段标题收敛为单一常量源，修复压缩分级失效"
```

---

### Task 2: PromptOrchestrator 输出 stable / turn 两段

**Files:**
- Modify: `src/shared/types/agent.ts`（新增 `PromptContext`）
- Modify: `src/main/memory/prompt-orchestrator.ts`
- Test: `src/main/memory/__tests__/prompt-orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SCOPE_SECTION_HEADINGS`
- Produces:
  - `src/shared/types/agent.ts`：
    ```ts
    /** Prompt 注入上下文：稳定前缀与每轮上下文的分离 */
    export interface PromptContext {
      /** 稳定前缀：系统指令 + 会话摘要 + scope 约束 + 项目记忆。跨轮不变，可被 KV-cache 复用。 */
      stable: string
      /** 每轮上下文：代码上下文 + 编译上下文 + 水位线 + 会话历史记忆。每轮随请求变化。 */
      turn: string
    }
    ```
  - `src/main/memory/prompt-orchestrator.ts`：
    - `AssembleOptions` 新增 `projectMemory?: string`、`sessionHistory?: string`
    - `AssembleResult` 新增 `context: PromptContext`
    - stable 段 = `system` + `sessionConfig.contextSummary` + `scope`（scope 含项目记忆）
    - turn 段 = `context`（代码上下文 + 编译上下文 + 会话历史记忆）+ `waterline`

- [ ] **Step 1: 写失败测试**

在 `src/main/memory/__tests__/prompt-orchestrator.test.ts` 追加：

```ts
it('stable 段跨轮逐字节一致，turn 段随请求变化', async () => {
  const base = { sessionId: 's1', adapterName: 'claude-code', totalBudget: 8000,
                 sessionConfig: { nodeTitle: 'N', acceptanceCriteria: [], allowedFiles: [],
                                  forbiddenFiles: [], invariantRules: [], upstreamContext: '',
                                  downstreamContext: '', bugContext: [] } as never }
  const a = await new PromptOrchestrator().assemble({ ...base, userCommand: '第一条命令' })
  const b = await new PromptOrchestrator().assemble({ ...base, userCommand: '第二条命令' })
  expect(a.context.stable).toBe(b.context.stable)
  expect(a.context.turn).not.toBe(b.context.turn)
})

it('stable 段不含用户请求原文，turn 段也不含', async () => {
  const r = await new PromptOrchestrator().assemble({
    sessionId: 's1', adapterName: 'claude-code', totalBudget: 8000, userCommand: '绝密指令XYZ',
    sessionConfig: { nodeTitle: 'N', acceptanceCriteria: [], allowedFiles: [], forbiddenFiles: [],
                     invariantRules: [], upstreamContext: '', downstreamContext: '', bugContext: [] } as never,
  })
  expect(r.context.stable).not.toContain('绝密指令XYZ')
  expect(r.context.turn).not.toContain('绝密指令XYZ')
})

it('项目记忆进 stable 段，会话历史记忆进 turn 段', async () => {
  const r = await new PromptOrchestrator().assemble({
    sessionId: 's1', adapterName: 'claude-code', totalBudget: 8000, userCommand: 'cmd',
    projectMemory: '项目记忆内容AAA', sessionHistory: '历史记忆内容BBB',
    sessionConfig: { nodeTitle: 'N', acceptanceCriteria: [], allowedFiles: [], forbiddenFiles: [],
                     invariantRules: [], upstreamContext: '', downstreamContext: '', bugContext: [] } as never,
  })
  expect(r.context.stable).toContain('项目记忆内容AAA')
  expect(r.context.turn).toContain('历史记忆内容BBB')
  expect(r.context.stable).not.toContain('历史记忆内容BBB')
})

it('waterline 超预算时截断自身，不减少 context 层的预算', async () => {
  const r = await new PromptOrchestrator().assemble({
    sessionId: 's1', adapterName: 'claude-code', totalBudget: 1000, userCommand: 'cmd',
    projectId: '/tmp/x', sessionConfig: { nodeTitle: 'N', acceptanceCriteria: [], allowedFiles: [],
      forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', bugContext: [] } as never,
  })
  const contextLayer = r.layerBreakdown.find((l) => l.name === 'context')
  const waterlineLayer = r.layerBreakdown.find((l) => l.name === 'waterline')
  expect(contextLayer?.tokens).toBeLessThanOrEqual(Math.floor(1000 * 0.35))
  expect(waterlineLayer?.tokens).toBeLessThanOrEqual(Math.floor(1000 * 0.05))
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/memory/__tests__/prompt-orchestrator.test.ts
```

Expected: FAIL —— `r.context` 为 undefined。

- [ ] **Step 3: 定义 `PromptContext` 类型**

在 `src/shared/types/agent.ts` 中（`AgentSession` 定义之前）加入上面的 `PromptContext` 接口，并从 `src/shared/types.ts` 的 barrel 导出（该 barrel 已 re-export `types/agent.ts`，确认 `export * from './types/agent'` 存在即可）。

- [ ] **Step 4: 实现 segments 切分**

在 `src/main/memory/prompt-orchestrator.ts`：

1. `AssembleOptions` 增加 `projectMemory?: string`、`sessionHistory?: string`。
2. `AssembleResult` 增加 `context: PromptContext`。
3. scope 层：把 `projectMemory` 追加进 `scopeText`，追加时用 `SCOPE_SECTION_HEADINGS.projectMemory` 作标题：

```ts
if (projectMemory) {
  scopeText = scopeText ? `${scopeText}\n${SCOPE_SECTION_HEADINGS.projectMemory}\n${projectMemory}` : `${SCOPE_SECTION_HEADINGS.projectMemory}\n${projectMemory}`
  scopeTokens = estimateTokens(scopeText)
}
```

（追加发生在 scope 压缩**之前**，让压缩阶梯能处理超预算。）

4. context 层：把代码上下文与会话历史记忆并入 `contextText`：

```ts
let contextText = codeContext ?? ''
if (sessionHistory) {
  contextText = contextText ? `${contextText}\n\n${sessionHistory}` : sessionHistory
}
```

保留 Task 1 Step 6 里对 `ContextCompiler` 编译结果的追加逻辑（在 `contextText` 已有内容时，编译结果追加在其后）。

5. waterline 层：删除「向 context 借预算」的整段（当前 `prompt-orchestrator.ts:288-298`），改为超预算时截断自身：

```ts
if (waterlineTokens > budgets[3]) {
  const charBudget = budgets[3] * 4
  waterlineText = waterlineText.slice(0, charBudget)
  waterlineTokens = estimateTokens(waterlineText)
  logger.info(`Waterline exceeded budget: truncated to ${waterlineTokens} tokens`)
}
```

6. 删除「scope 为空则把预算转给 context」的整段（当前 `prompt-orchestrator.ts:283-287`）——它会让 scope 层的 `layerBreakdown` 失真。

7. 构造 `context`：

```ts
const stableParts = [systemText, sessionConfig?.contextSummary, scopeText].filter((s): s is string => !!s && s.length > 0)
const turnParts = [contextText, waterlineText].filter((s): s is string => !!s && s.length > 0)
const context: PromptContext = {
  stable: stableParts.join('\n\n'),
  turn: turnParts.join('\n\n'),
}
```

8. `AssembleResult` 返回时带上 `context`。`text` 字段保持为全量拼接（`[systemText, scopeText, contextText, waterlineText, userText].join('\n\n')`），仅用于 token 统计与 `layerBreakdown`，不再被投递给模型。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/main/memory/__tests__/prompt-orchestrator.test.ts
```

Expected: PASS。

- [ ] **Step 6: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "feat(prompt): 装配结果拆为 stable/turn 两段，水位线超预算改为截断自身"
```

---

### Task 3: 适配器按 stable / turn 分离投递

**Files:**
- Modify: `src/shared/types/agent.ts`（`AgentSession` / `AgentAdapter` 契约）
- Modify: `src/main/adapters/base.ts`
- Modify: `src/main/agent/agent-manager.ts:615-634`
- Modify: `src/main/adapters/{cursor,cline,codebuddy,qwen-code,kimi-code,kilo-code,qoder,mindmap-adapter,codex}.ts`
- Modify: `src/main/adapters/claude-code.ts:116-117,213`
- Modify: `src/main/adapters/mcp-adapter.ts:671,717-718,750-752`
- Test: `src/main/adapters/__tests__/claude-code.test.ts`
- Test: `src/main/__tests__/agent-manager.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PromptContext`、`AssembleResult.context`
- Produces:
  - `src/shared/types/agent.ts`：
    - `AgentSession`：`memoryContext?: string` **删除**；`codeContext?: string` **删除**；`resolvedContexts?: ResolvedContext[]` **删除**；新增 `promptContext?: PromptContext`
    - `AgentAdapter`：`setMemoryContext(...)` **删除**；`setCodeContext(...)` **删除**；`setResolvedContexts(...)` **删除**；新增 `setPromptContext(sessionId: string, ctx: PromptContext): void`
  - `src/main/adapters/base.ts`（`protected`）：
    - `buildScopePromptForSession(session: AgentSession): string` —— 返回 `session.promptContext?.stable ?? ''`；`transparentForward` 时返回 `''`
    - `buildTurnContext(session: AgentSession): string` —— 返回 `session.promptContext?.turn ?? ''`；`transparentForward` 时返回 `''`
    - `buildFullPrompt(session: AgentSession, command: AgentCommand): string` —— `[buildScopePromptForSession(session), buildTurnContext(session), buildCommandPromptForSession(session, command)].filter(Boolean).join('\n\n')`
    - `setPromptContext(sessionId: string, ctx: PromptContext): void`
  - `src/main/adapters/base.ts:1155-1161` 的 `buildScopePrompt(config, resolvedContexts, codeContext)` 包装方法：签名改为 `buildScopePrompt(config: AgentSessionConfig, resolvedContexts?: ResolvedContext[]): string`

- [ ] **Step 1: 写失败测试**

在 `src/main/__tests__/claude-code.test.ts`（**注意是 `src/main/__tests__/` 这份**，它已有 SDK mock 骨架 `mockQuery` / `mockMessages`）追加：

```ts
it('systemPrompt 只含 stable，user turn 含 turn + 命令原文，命令原文只出现一次', async () => {
  const session = await adapter.startSession(makeConfig())
  adapter.setPromptContext(session.id, { stable: 'STABLE-TEXT', turn: 'TURN-TEXT' })

  mockQuery.mockReturnValue(mockMessages([
    { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' },
    { type: 'result', subtype: 'success', result: 'Done', is_error: false },
  ]))

  await adapter.sendCommand(session.id, { type: 'implement', description: 'USER-REQ-UNIQUE', targetNodeId: 'n1' })

  const callArgs = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
  expect(callArgs.options.systemPrompt).toBe('STABLE-TEXT')
  expect(String(callArgs.options.systemPrompt)).not.toContain('USER-REQ-UNIQUE')
  expect(callArgs.prompt).toContain('TURN-TEXT')
  expect(callArgs.prompt).toContain('USER-REQ-UNIQUE')
  expect(callArgs.prompt.split('USER-REQ-UNIQUE').length - 1).toBe(1)
})

it('透明转发会话不下发任何 BizGraph 上下文', async () => {
  const session = await adapter.startSession(makeConfig({ transparentForward: true }))
  adapter.setPromptContext(session.id, { stable: 'STABLE-TEXT', turn: 'TURN-TEXT' })

  mockQuery.mockReturnValue(mockMessages([{ type: 'result', subtype: 'success', result: 'Done', is_error: false }]))

  await adapter.sendCommand(session.id, { type: 'implement', description: 'USER-REQ-UNIQUE', targetNodeId: 'n1' })

  const callArgs = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
  expect(callArgs.options.systemPrompt).toBeUndefined()
  expect(callArgs.prompt).not.toContain('STABLE-TEXT')
  expect(callArgs.prompt).not.toContain('TURN-TEXT')
  expect(callArgs.prompt).toContain('USER-REQ-UNIQUE')
})
```

**同时必须改写**已有的 `'doSendCommand calls SDK query with scope prompt as systemPrompt'`（该文件第 78 行起）——Task 3 之后适配器不再自行构造 scope，而是消费编排器投递的 `promptContext`。改写为：

```ts
it('doSendCommand 把 promptContext.stable 作为 systemPrompt 下发', async () => {
  const session = await adapter.startSession(makeConfig())
  adapter.setPromptContext(session.id, {
    stable: '# 业务节点：<node-title>Auth Module</node-title>\n## 允许修改的文件（白名单）\n- src/auth.ts\n<criteria>Users can login</criteria>',
    turn: '',
  })

  mockQuery.mockReturnValue(mockMessages([
    { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' },
    { type: 'result', subtype: 'success', result: 'Done', is_error: false },
  ]))

  await adapter.sendCommand(session.id, command)

  const callArgs = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
  expect(callArgs.prompt).toContain('Add login form')
  expect(callArgs.options.systemPrompt).toContain('<node-title>Auth Module</node-title>')
  expect(callArgs.options.systemPrompt).toContain('src/auth.ts')
  expect(callArgs.options.cwd).toBe('/project')

  const completeOutputs = outputs.filter((o) => o.type === 'complete')
  expect(completeOutputs.length).toBe(1)
})
```

在 `src/main/__tests__/agent-manager.test.ts` 追加：

```ts
it('resolveAndSendCommand 通过 setPromptContext 投递 stable/turn', async () => {
  // 沿用该文件既有的 mock adapter 手法，断言 setPromptContext 被调用一次，
  // 入参为 { stable: expect.any(String), turn: expect.any(String) } 且两段都非空
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/__tests__/claude-code.test.ts src/main/__tests__/agent-manager.test.ts
```

Expected: FAIL —— `setPromptContext` 不存在；`systemPrompt` 仍是适配器自建的 scope（含命令原文）。

- [ ] **Step 3: 改共享类型契约**

在 `src/shared/types/agent.ts`：

- `AgentSession`：删 `memoryContext?`、`codeContext?`、`resolvedContexts?` 三行，加 `promptContext?: PromptContext`。
- `AgentAdapter`：删 `setMemoryContext`、`setCodeContext`、`setResolvedContexts` 三个方法声明，加：

```ts
/** 注入 prompt 上下文：stable 进 system 通道，turn 进 user turn */
setPromptContext(sessionId: string, ctx: PromptContext): void
```

- [ ] **Step 4: 改 BaseAdapter**

在 `src/main/adapters/base.ts`：

- `setMemoryContext`（约 440 行）替换为：

```ts
setPromptContext(sessionId: string, ctx: PromptContext): void {
  const session = this.sessions.get(sessionId)
  if (session) session.promptContext = ctx
}
```

- 删除 `setCodeContext`（约 429 行）与 `setResolvedContexts`（约 418 行）。
- `buildScopePromptForSession`（约 918 行）整体替换为：

```ts
protected buildScopePromptForSession(session: AgentSession): string {
  if (session.config.transparentForward) return ''
  return session.promptContext?.stable ?? ''
}

/** 每轮上下文：代码上下文 + 编译上下文 + 水位线 + 会话历史记忆。放在 user turn。 */
protected buildTurnContext(session: AgentSession): string {
  if (session.config.transparentForward) return ''
  return session.promptContext?.turn ?? ''
}

/** CLI / thread 类适配器的单串 prompt：稳定前缀 → 每轮上下文 → 用户请求。 */
protected buildFullPrompt(session: AgentSession, command: AgentCommand): string {
  return [
    this.buildScopePromptForSession(session),
    this.buildTurnContext(session),
    this.buildCommandPromptForSession(session, command),
  ].filter((s) => !!s && s.length > 0).join('\n\n')
}
```

- `buildScopePrompt` 包装方法（约 1155 行）签名改为 `buildScopePrompt(config: AgentSessionConfig, resolvedContexts?: ResolvedContext[]): string`，实现改为 `return buildScopePrompt(config, resolvedContexts)`。
- `runToolAwareLoop`（约 1056 行）的 `basePrompt` 改为：

```ts
const basePrompt = `${this.buildScopePromptForSession(session)}\n${toolPrompt}\n${this.buildTurnContext(session)}\n${this.buildCommandPromptForSession(session, command)}`
```

- `src/main/adapters/mcp-adapter.ts:620` 的 `this.buildScopePrompt(config)` 调用保持不变（签名兼容）。

- [ ] **Step 5: 改 AgentManager 投递**

在 `src/main/agent/agent-manager.ts:625-634`，把

```ts
const adapter = this.router.resolve(sessionId)
if (adapter) {
  if (resolvedContexts.length > 0) {
    adapter.setResolvedContexts(sessionId, resolvedContexts)
  }
  if (codeContext) {
    adapter.setCodeContext(sessionId, codeContext)
  }
  adapter.setMemoryContext(sessionId, assembled.text)
}
```

改为

```ts
const adapter = this.router.resolve(sessionId)
if (adapter) {
  adapter.setPromptContext(sessionId, assembled.context)
}
```

`resolvedContexts` / `codeContext` 局部变量仍被 `state.contextCount` 与编排器使用，保留解构。

- [ ] **Step 6: 改 CLI / thread 类适配器**

以下八个文件用**完全相同**的三行模式（已逐个核对，`scopePrompt` / `commandPrompt` 变量在这三个文件之外均无其他引用）：

`cursor.ts`、`cline.ts`、`codebuddy.ts`、`qwen-code.ts`、`kimi-code.ts`、`kilo-code.ts`、`qoder.ts`、`codex.ts`

把

```ts
const scopePrompt = this.buildScopePromptForSession(session)
const commandPrompt = this.buildCommandPromptForSession(session, command)
const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`
```

三行统一替换为

```ts
const fullPrompt = this.buildFullPrompt(session, command)
```

**`mindmap-adapter.ts` 单独处理**（它的模式不同：直接用 `command.description` 原文、以 `---` 分隔、不走 `buildCommandPromptForSession`）：

```ts
const scopePrompt = this.buildScopePromptForSession(session)
const turnContext = this.buildTurnContext(session)
const fullPrompt = scopePrompt
  ? `${scopePrompt}\n\n---\n\n${turnContext}\n\n---\n\n${command.description}`
  : `${turnContext}\n\n---\n\n${command.description}`
```

（`turnContext` 为空时不得留下多余的 `\n\n---\n\n`；实现时按段过滤后再 join。）

- [ ] **Step 7: 改 claude-code**

在 `src/main/adapters/claude-code.ts`：

```ts
const scopePrompt = this.buildScopePromptForSession(session)
const turnContext = this.buildTurnContext(session)
const commandPrompt = this.buildCommandPromptForSession(session, command)
```

并把 `query({ prompt: commandPrompt, ... })` 改为

```ts
const queryIter = query({
  prompt: [turnContext, commandPrompt].filter((s) => !!s && s.length > 0).join('\n\n'),
  options: { ... }
})
```

`systemPrompt: scopePrompt` 保持不变（此时 scopePrompt 已是 stable 段）。

- [ ] **Step 8: 改 mcp-adapter**

在 `src/main/adapters/mcp-adapter.ts`：

```ts
const systemPrompt = this.buildScopePromptForSession(session)
const turnContext = this.buildTurnContext(session)
```

把两处 user 消息构造改为：

```ts
const userContent = [turnContext, userPrompt].filter((s) => !!s && s.length > 0).join('\n\n')
```

- `messages.push({ role: 'user', content: userContent })`（结构化 Tool Use 路径，约 718 行）
- `plainMessages.push({ role: 'user', content: userContent })`（纯文本路径，约 752 行）

- [ ] **Step 9: 跑测试确认通过**

```bash
npx vitest run src/main/__tests__/claude-code.test.ts src/main/__tests__/agent-manager.test.ts src/main/adapters/__tests__/cli-adapters.test.ts
```

Expected: PASS。

- [ ] **Step 10: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(prompt): 适配器按 stable/turn 分离投递，用户请求不再进入 system 通道"
```

---

### Task 4: 项目记忆与会话历史记忆接入 prompt

**Files:**
- Modify: `src/main/agent/context-assembler.ts`
- Test: `src/main/__tests__/agent-manager.test.ts`
- Test: `src/main/memory/__tests__/prompt-orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AssembleOptions.projectMemory` / `AssembleOptions.sessionHistory`
- Produces: `ContextAssembler.assemble()` 的返回结构不变（`{ resolvedContexts, codeContext, assembled }`），但内部把原先被丢弃的 `_memoryContext` / `_sessionHistoryContext` 传给编排器。

- [ ] **Step 1: 写失败测试**

在 `src/main/__tests__/agent-manager.test.ts` 追加：

```ts
it('resolveAndSendCommand 把项目记忆与会话历史记忆送进 prompt 上下文', async () => {
  // 在工作目录写入 .bizgraph/memory.json = { notes: '项目记忆标记XYZ' }
  // 断言 adapter.setPromptContext 的入参 stable 含 '项目记忆标记XYZ'
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/__tests__/agent-manager.test.ts
```

Expected: FAIL —— stable 段不含项目记忆。

- [ ] **Step 3: 把丢弃的上下文接回编排器**

在 `src/main/agent/context-assembler.ts:76`，把解构里的 `_memoryContext` / `_sessionHistoryContext` 改名为 `memoryContext` / `sessionHistoryContext`（去掉下划线），并在 `orchestrator.assemble({...})` 的入参里补上：

```ts
projectMemory: memoryContext,
sessionHistory: sessionHistoryContext,
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/main/__tests__/agent-manager.test.ts src/main/memory/__tests__/prompt-orchestrator.test.ts
```

Expected: PASS。

- [ ] **Step 5: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(memory): 项目记忆与会话历史记忆接入 prompt 分段"
```

---

### Task 5: claude-code 会话终止与原生恢复契约

**Files:**
- Modify: `src/main/adapters/claude-code.ts`（SDK 错误分支，约 312-330 行）
- Modify: `src/main/adapters/base.ts`（新增 `getResumeSessionId`）
- Modify: `src/shared/types/agent.ts`（`AgentAdapter` 增加可选方法）
- Modify: `src/main/agent/session-recovery.ts`（`RecoveryContext` + claude-code 策略）
- Modify: `src/main/agent/recovery-orchestrator.ts`（native 分支重发命令）
- Test: `src/main/__tests__/claude-code.test.ts`
- Test: `src/main/agent/__tests__/session-recovery.test.ts`
- Test: `src/main/agent/__tests__/recovery-orchestrator.test.ts`

**Interfaces:**
- Consumes: 无（与 Task 1-4 独立）
- Produces:
  - `src/shared/types/agent.ts`：`AgentAdapter` 新增 `getResumeSessionId?(sessionId: string): string | undefined`
  - `src/main/adapters/base.ts`：`public getResumeSessionId(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.config.resumeSessionId }`
  - `src/main/agent/session-recovery.ts`：`RecoveryContext` 新增 `resumeSessionId?: string`
  - `src/main/agent/recovery-orchestrator.ts`：`handleSessionExit` 的 native 分支额外调用 `resumeLastCommand(sessionId, state.lastCommand)`

- [ ] **Step 1: 写失败测试**

在 `src/main/agent/__tests__/session-recovery.test.ts` 追加：

```ts
it('claude-code 策略：有 resumeSessionId 时返回原 sessionId（原生恢复）', async () => {
  const r = await mgr.attemptRecovery({ sessionId: 's1', adapterName: 'claude-code', lastOutputs: [], resumeSessionId: 'cli-conv-1' })
  expect(r).toBe('s1')
})

it('claude-code 策略：无 resumeSessionId 时返回 null（不具备原生恢复条件）', async () => {
  const r = await mgr.attemptRecovery({ sessionId: 's1', adapterName: 'claude-code', lastOutputs: [] })
  expect(r).toBeNull()
})
```

在 `src/main/agent/__tests__/recovery-orchestrator.test.ts` 追加：

```ts
it('native 恢复分支会重发上一条命令', async () => {
  // mock sessionRecovery.attemptRecovery 返回与入参相同的 sessionId
  // 断言 resumeLastCommand 被调用，且入参 command 是上一条命令
})
```

在 `src/main/__tests__/claude-code.test.ts` 追加：

```ts
it('SDK 错误时发射 sessionEnded(error)，AbortError 时不发射', async () => {
  const session = await adapter.startSession(makeConfig())
  const ended: Array<[string, string, number | null]> = []
  adapter.on('sessionEnded', (id: string, reason: string, code: number | null) => ended.push([id, reason, code]))

  mockQuery.mockReturnValue((async function* () { throw new Error('boom') })())
  await adapter.sendCommand(session.id, command)
  expect(ended).toHaveLength(1)
  expect(ended[0][1]).toBe('error')

  const session2 = await adapter.startSession(makeConfig())
  mockQuery.mockReturnValue((async function* () {
    const e = new Error('aborted'); e.name = 'AbortError'; throw e
  })())
  await adapter.sendCommand(session2.id, command)
  expect(ended).toHaveLength(1)   // AbortError 不新增
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/agent/__tests__/session-recovery.test.ts src/main/agent/__tests__/recovery-orchestrator.test.ts src/main/__tests__/claude-code.test.ts
```

Expected: FAIL —— `resumeSessionId` 未被识别；native 分支未重发命令；无 `sessionEnded` 事件。

- [ ] **Step 3: claude-code 发射 sessionEnded**

在 `src/main/adapters/claude-code.ts` 的 catch 块（约 312-327 行），把 `else` 分支改为：

```ts
} else {
  this.emitOutputForSession(sessionId, {
    type: 'error',
    data: `SDK error: ${msg}`,
    timestamp: Date.now(),
    errorCode: 'AGENT_CRASH',
  })
  // SDK 错误 = 会话异常终止。必须发 sessionEnded，否则恢复 / 回退 / Phase B 记忆管线整条链路不可达。
  this.emit('sessionEnded', sessionId, 'error', null)
}
```

AbortError 分支（用户主动取消）**不发** `sessionEnded`。

- [ ] **Step 4: 暴露 resumeSessionId**

- `src/shared/types/agent.ts` 的 `AgentAdapter` 接口加：`getResumeSessionId?(sessionId: string): string | undefined`
- `src/main/adapters/base.ts` 加：

```ts
/** 返回适配器侧持有的 CLI 级会话 id（Claude Code 的 conversation id 等），供崩溃恢复时原生续接。 */
getResumeSessionId(sessionId: string): string | undefined {
  return this.sessions.get(sessionId)?.config.resumeSessionId
}
```

- `src/main/agent/session-recovery.ts` 的 `RecoveryContext` 加 `resumeSessionId?: string`；claude-code 策略改为：

```ts
resume: async (ctx) => {
  if (!ctx.resumeSessionId) {
    logger.info(`Claude Code native resume unavailable for session ${ctx.sessionId}: no CLI conversation id`)
    return null
  }
  return ctx.sessionId
},
```

- `src/main/agent/recovery-orchestrator.ts` 的 `attemptRecovery` 调用处补 `resumeSessionId: state.config.resumeSessionId ?? adapterResumeId`，其中 `adapterResumeId` 通过注入的适配器解析器取得（该类已有适配器访问路径；若没有，新增一个可选的 `resolveAdapter?: (name: string) => AgentAdapter | undefined` 构造参数）。

- [ ] **Step 5: native 分支重发命令**

在 `src/main/agent/recovery-orchestrator.ts` 的 `handleSessionExit`，native 分支（`newSessionId === sessionId`，约 181-195 行）在 `return 'native'` 之前补：

```ts
if (state.lastCommand) {
  await this.resumeLastCommand(sessionId, state.lastCommand)
} else {
  logger.info(`Native resume for session ${sessionId}: no previous command to resend`)
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
npx vitest run src/main/agent/__tests__/session-recovery.test.ts src/main/agent/__tests__/recovery-orchestrator.test.ts src/main/__tests__/claude-code.test.ts
```

Expected: PASS。

- [ ] **Step 7: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(session): claude-code 补齐 sessionEnded 发射与原生恢复重发契约"
```

---

### Task 6: schema 迁移慢路径无条件重建 + 列类型比对

**Files:**
- Modify: `src/main/database.ts`（`migrate()` 约 659 行、`rebuildTableIfNeeded` 约 145-210 行）
- Test: `src/main/__tests__/database-migration.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 无对外接口变化（内部函数行为变化）

- [ ] **Step 1: 写失败测试**

在 `src/main/__tests__/database-migration.test.ts` 追加：

```ts
it('改了 createSql 但没 bump 版本时，schema 变更仍然生效', () => {
  // 建一个真实库 → 手工改 CREATE TABLE 把某列类型从 TEXT 改成 INTEGER
  // 重新 initDatabase()（版本号不变）
  // 断言该列类型已变为 INTEGER
})

it('列类型变更会触发重建（列名不变、类型变）', () => {
  // 直接驱动 rebuildTableIfNeeded 的判定逻辑
  // 断言重建发生且数据行数不变
})
```

> 实现提示：本文件用真实 better-sqlite3（`:memory:` 或临时文件）。构造「老库」时直接 `db.exec` 建一张带旧定义的表，再调用被测函数。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/__tests__/database-migration.test.ts
```

Expected: FAIL —— 慢路径因版本号未变而跳过重建。

- [ ] **Step 3: 慢路径无条件重建**

在 `src/main/database.ts` 的 `migrate()`，把

```ts
if (currentVersion < CURRENT_SCHEMA_VERSION) {
  // Full rebuild path: table definitions may have changed.
  for (const schema of TABLE_SCHEMAS) {
    rebuildTableIfNeeded(db, schema.name, schema.createSql, schema.requiredColumns)
  }
}
```

改为

```ts
// 慢路径（版本落后 **或** checksum 失配）一律尝试重建。
// 只按版本号门禁会让「改了 createSql 但忘了 bump CURRENT_SCHEMA_VERSION」的
// schema 变更静默失效：checksum 已经失配，却因为版本号没变而跳过重建。
// rebuildTableIfNeeded 内部只在列集合 / 列类型 / CHECK 变化时才真正重建，
// 无变化时仅做两次 pragma 查询，代价可忽略。
for (const schema of TABLE_SCHEMAS) {
  rebuildTableIfNeeded(db, schema.name, schema.createSql, schema.requiredColumns)
}
```

- [ ] **Step 4: 比对列类型**

在 `rebuildTableIfNeeded` 里，把「列名齐全」的判定从「名字都在」扩展到「名字 + 类型都在」。做法：从 `createSql` 中解析出 `列名 -> 声明类型` 的映射（只解析顶层括号外的、以逗号分隔的片段，跳过 `PRIMARY KEY (...)` / `FOREIGN KEY (...)` / `CHECK (...)` 这类表级约束），再与 `pragma table_info` 的 `name` / `type` 逐列比对；类型比较忽略大小写与首尾空白。

同时把 `requiredColumns` 判定保留为「缺列则重建」的兜底。

> 实现提示：`pragma table_info` 返回的 `type` 形如 `TEXT` / `INTEGER`。`createSql` 里声明的类型需归一化（去掉 `NOT NULL` / `PRIMARY KEY` / `DEFAULT ...` 等修饰）。若解析器无法确定某列的声明类型（复杂声明），跳过该列的类型比对，只比对列名——不得因解析失败而误判重建。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/main/__tests__/database-migration.test.ts
```

Expected: PASS。

- [ ] **Step 6: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(db): 迁移慢路径无条件重建，比对列类型防 schema 变更静默失效"
```

---

### Task 7: MessageStatus 与 chat_messages CHECK 对齐

**Files:**
- Modify: `src/main/database.ts`（`chat_messages` 的 `createSql` + `CURRENT_SCHEMA_VERSION`）
- Test: `src/main/__tests__/database-migration.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `chat_messages.status` 的 CHECK 集合为 `('success','error','pending','streaming','aborted','queued','sending','permanently_failed')`；`CURRENT_SCHEMA_VERSION` 15 → 16。

- [ ] **Step 1: 写失败测试**

在 `src/main/__tests__/database-migration.test.ts` 追加：

```ts
it('chat_messages.status 接受 queued / sending / permanently_failed', () => {
  for (const status of ['queued', 'sending', 'permanently_failed']) {
    expect(() => db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(`m-${status}`, 't1', 'assistant', 'x', status, Date.now())).not.toThrow()
  }
})

it('schema_version 升级到 16', () => {
  expect(version).toBeGreaterThanOrEqual(16)
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/__tests__/database-migration.test.ts
```

Expected: FAIL —— CHECK 约束拒绝这三个值。

- [ ] **Step 3: 扩容 CHECK 并 bump 版本**

在 `src/main/database.ts`：

- `chat_messages` 的 `createSql` 里，把
  `status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'pending', 'streaming', 'aborted'))`
  改为
  `status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error', 'pending', 'streaming', 'aborted', 'queued', 'sending', 'permanently_failed'))`
- `CURRENT_SCHEMA_VERSION` 由 `15` 改为 `16`。
- `chat_messages` 的 `requiredColumns` 保持不变（列集合未变）。

存量行的 status 值全部落在新集合内，重建无损（Task 6 的重建逻辑负责）。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/main/__tests__/database-migration.test.ts
```

Expected: PASS。

- [ ] **Step 5: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(db): chat_messages.status CHECK 扩容以覆盖 MessageStatus 全集（schema v16）"
```

---

### Task 8: JSON 列运行时校验

**Files:**
- Modify: `src/shared/type-guards.ts`
- Modify: `src/main/services/chat-service.ts:182-185`
- Modify: `src/main/repositories/agent-log-repository.ts:60,72`
- Modify: `src/main/repositories/graph-repository.ts:116-118`
- Test: `src/main/__tests__/db-utils.test.ts`
- Test: `src/main/__tests__/chat-service.test.ts`
- Test: `src/main/__tests__/agent-log-repository.test.ts`
- Test: `src/main/__tests__/graph-repository.test.ts`

**Interfaces:**
- Consumes: `src/main/shared/db-utils.ts` 的 `safeJsonParse<T>(raw, fallback, validator?)`
- Produces: `src/shared/type-guards.ts` 新增
  - `export function isRecord(value: unknown): value is Record<string, unknown>`
  - `export function isStringArray(value: unknown): value is string[]`
  - `export function isUnknownArray(value: unknown): value is unknown[]`
  - `export function isAgentCommand(value: unknown): value is AgentCommand`
  - `export function isAgentOutput(value: unknown): value is AgentOutput`

- [ ] **Step 1: 写失败测试**

在 `src/main/__tests__/db-utils.test.ts` 追加：

```ts
it('safeJsonParse 传 validator 时非法值退化为 fallback', () => {
  expect(safeJsonParse('{"a":1}', [], isStringArray)).toEqual([])
  expect(safeJsonParse('[1,2]', [], isStringArray)).toEqual([])
  expect(safeJsonParse('["a"]', [], isStringArray)).toEqual(['a'])
})
```

在 `src/main/__tests__/chat-service.test.ts` 追加：

```ts
it('context_refs 被写成对象时读取退化为空数组而不是崩溃', () => {
  // 写入 context_refs = '{"a":1}'，再读取，断言 contextRefs 为 []
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/main/__tests__/db-utils.test.ts src/main/__tests__/chat-service.test.ts
```

Expected: FAIL —— 守卫函数不存在；脏数据被原样返回。

- [ ] **Step 3: 增加守卫**

在 `src/shared/type-guards.ts` 追加：

```ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

export function isAgentCommand(value: unknown): value is AgentCommand {
  return isRecord(value) && typeof value.type === 'string' && typeof value.description === 'string'
}

export function isAgentOutput(value: unknown): value is AgentOutput {
  return isRecord(value) && typeof value.type === 'string' && typeof value.data === 'string'
}
```

（`AgentCommand` / `AgentOutput` 从 `@shared/types` import。）

- [ ] **Step 4: 在解析处传 validator**

- `src/main/services/chat-service.ts:182-185`：
  - `error: safeJsonParse(row.error, undefined, isRecord)`
  - `contextRefs: safeJsonParse(row.context_refs, [], isUnknownArray)`
  - `toolCalls: safeJsonParse(row.tool_calls, [], isUnknownArray)`
- `src/main/repositories/agent-log-repository.ts:60`：
  `safeJsonParse(row.command as string, { type: 'implement', description: '', targetNodeId: '' }, isAgentCommand)`
- `src/main/repositories/agent-log-repository.ts:72`：
  `safeJsonParse(row.outputs as string, [], isAgentOutput)`
- `src/main/repositories/graph-repository.ts:116-118`：
  - `rules: safeJsonParse(rowOptStr(row, 'rules'), undefined, isRecord)`
  - `metadata: safeJsonParse(rowOptStr(row, 'metadata'), undefined, isRecord)`
  - `content: safeJsonParse(rowOptStr(row, 'content'), undefined, isString)`

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/main/__tests__/db-utils.test.ts src/main/__tests__/chat-service.test.ts src/main/__tests__/agent-log-repository.test.ts src/main/__tests__/graph-repository.test.ts
```

Expected: PASS。

- [ ] **Step 6: 全量校验并提交**

```bash
npx tsc --noEmit && npm run test && npm run lint
git add -A && git commit -m "fix(db): JSON 列统一走 safeJsonParse 的运行时校验，脏数据退化为默认值"
```

---

## 收尾

全部任务完成后执行：

```bash
npm rebuild better-sqlite3   # 跑测试前
npx tsc --noEmit && npm run test && npm run lint
npx electron-builder install-app-deps   # 切回 Electron ABI
git log --oneline main..HEAD
```

更新 `docs/base/ROADMAP.md` 的 Phase D 表格，新增一行记录本轮修复；并在 `docs/tasks/2026-10-27-framework-hardening.md` 写落地记录（含每项修复前后的行为对比）。
