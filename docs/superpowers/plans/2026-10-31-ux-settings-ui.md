# 界面默认值接线与静默失败归零 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「有数据没界面」的设置项接上 UI，砍掉每轮都要重来的重复步骤，并让所有用户可触发的失败路径都给出明确提示而不是静默无反应。

**Architecture:** 分两层——**主进程层**（`src/main/settings.ts`）先修「设置字段被静默丢弃」的地基，再补齐默认值与按适配器拆分的模型字段；**渲染层**（`src/renderer/`）新增一个「默认值」设置页签、把重复选择改成自适应/带默认值、并把所有失败路径接到全局 toast。**本计划不涉及数据库 schema 变更**（schema v18 与只读会话模式属于计划二 `docs/superpowers/plans/2026-10-31-ux-readonly-scope.md`）。

**Tech Stack:** Electron + React + TypeScript（strict）+ Zustand + Tailwind/shadcn-ui + Vitest（`// @vitest-environment jsdom` + @testing-library/react 16.3.2）+ better-sqlite3（本计划不碰 schema）

**Spec:** `docs/superpowers/specs/2026-10-31-ux-defaults-design.md`（§二 裂缝 A/B/C/D、§三 决定 D2/D4、§四 A/B/C/D）

---

## Global Constraints

以下约束对**每个任务**都生效，不需要在任务里重复：

- **TypeScript strict，全局禁止 `any`**：`@typescript-eslint/no-explicit-any` 在 `src/shared/**` 是 `error`、其余目录是 `warn`，而 `npm run lint` 带 `--max-warnings 0`——**实际全局禁止 `any`**，测试代码里的类型标注同样算。
- **Toast 唯一实现**在 `src/renderer/lib/toast.tsx`，导出 `pushToast` / `toastSuccess` / `toastError` / `toastInfo` / `ToastContainer` / `useToastStore`。**不要**新建 `src/renderer/lib/toast.ts` 或 `src/renderer/components/ui/ToastContainer.tsx`——同路径下 `.ts` 会先于 `.tsx` 被解析并遮蔽实现。
- **所有新文案走 `t()`**，i18n 资源加在 `src/shared/i18n/resources/domains/` 下对应域文件（settings / canvas / agent 等），中英两份都要加。查表用 `Record<NodeType, TranslationKey>` 静态映射，**禁止模板拼接 key**。
- **`BizGraphSettings` 新增字段必须同时登记到 `src/main/settings.ts` 的 `mergeSettings`**，否则被静默丢弃（见 Task 1）。
- **节点状态变更必须走 `NodeRepository.update()`**（内部强制 `validateNodeTypeTransition`）；**不要**在别处直接 `UPDATE nodes SET status = ...`。
- **不改 `graph_type` 语义**（`2026-10-27` spec §4.4.1 已定：`graph_type` = 节点语义类别，不是图归属）。不要加 `graphType === graphs.type` 的校验，不要迁移存量 `graph_type`。
- **不改 Agent CLI 行为、不改适配器协议**（CLAUDE.md《与 Agent CLI 的边界》）。
- **命令**：
  - 单个测试文件：`npx vitest run src/path/to/file.test.ts`
  - 类型检查：`npx tsc --noEmit`
  - Lint：`npm run lint`
  - 全部测试：`npm run test`
- **提交信息**沿用仓库风格：`<type>(<scope>): <中文描述>`，type ∈ `feat` / `fix` / `refactor` / `test` / `docs`。示例：`fix(settings): mergeSettings 保留未登记的设置字段`。
- **测试文件位置**：主进程放 `src/main/__tests__/`；渲染层放被测文件同级的 `__tests__/`（如 `src/renderer/panels/__tests__/`）。渲染层组件测试文件头必须写 `// @vitest-environment jsdom`。

---

## Review Focus

以下五类输入/失败模式是 spec 暗示、但**任何单个任务的测试都不会自然覆盖**的。每条都已指定归属任务，在该任务的步骤里补上对应测试。

1. **用户在设置里只点了「保存」没改任何东西，API key 却没了** —— 当前 `saveApiKey` 读的是输入框 state（保存后被清空），`setApiKey` 无条件写入，于是把已存的 key 覆盖成空串。合理行为：空输入**不应**调用保存，必须提示；显式清除要走单独的「删除」动作。
   → **Task 5**
2. **用户改了设置后重启应用，改动消失** —— `mergeSettings` 逐字段列举，漏登记的字段每次 `readSettings()` 都被丢掉，UI 显示"保存成功"。合理行为：重启后设置仍在。
   → **Task 1**
3. **用户把节点标题改成空字符串** —— 当前静默丢弃输入并退出编辑态，用户会以为改好了。合理行为：明确提示"标题不能为空"，输入内容保留在编辑框里。
   → **Task 8**
4. **用户只有一个适配器，却还要点开一个下拉去选它** —— 合理行为：下拉不出现，直接显示该适配器名。
   → **Task 4**
5. **用户在有多个项目时新建一张图，选错了项目归属** —— 绑定 `project_path` 之后，图与会话的 `workingDirectory` 由它决定，选错会让 Agent 在别的项目里干活。合理行为：多项目时必须显式选，且当前项目是预选项。
   → **Task 6**

---

## File Structure

**新建：**

| 路径 | 职责 |
|---|---|
| `src/renderer/panels/DefaultsTab.tsx` | 「默认值」设置页签的全部 UI：默认适配器、回退顺序、按适配器分开的默认模型、压缩模型 |
| `src/renderer/panels/__tests__/DefaultsTab.test.tsx` | 上述组件的渲染层测试 |
| `src/shared/adapter-defaults.ts` | 跨进程共享的适配器相关常量：`DEFAULT_ADAPTER_PREFERENCES` 的唯一副本、`ALLOWED_PROVIDERS` 的唯一副本、只读支持的适配器名单 |

**修改：**

| 路径 | 改动性质 |
|---|---|
| `src/main/settings.ts` | `DEFAULT_SETTINGS` 补字段、`mergeSettings` 改通用合并、`mergeCliTools` 保留未知项、`DEFAULT_SETTINGS.cliTools` 补全 |
| `src/shared/types/agent.ts` | `BizGraphSettings` 加 `defaultModels` / `compactModel` / `contextWaterline` 字段 |
| `src/shared/types/ipc.ts` | `settings:*` 通道签名、`graph:create` 参数 |
| `src/main/adapters/claude-code.ts` | 读新的按适配器模型字段 |
| `src/main/adapters/mcp-adapter.ts` | 读新的 mcp 模型字段 |
| `src/main/adapters/codex.ts` | 读新的 codex 模型字段 |
| `src/main/ipc/settings.ts` | `settings:setApiKey` 空值语义 |
| `src/main/ipc/graph.ts` / `src/main/services/graph-service.ts` | `graph:create` 接受 `projectPath` |
| `src/shared/state-machine.ts` / `src/shared/types/graph.ts` | 导出 per-type 转换判定 |
| `src/renderer/store/adapterStore.ts` / `src/renderer/store/agentStore.ts` | 初始态读真设置，去掉硬编码副本 |
| `src/renderer/panels/SettingsPanel.tsx` | 新增页签、general 页签改造 |
| `src/renderer/components/agent/ChatHeader.tsx` | 适配器下拉自适应 |
| `src/renderer/components/GraphTabs.tsx` | 新建图收敛 + 绑定项目 |
| `src/renderer/canvas/NodeContextMenu.tsx` | 状态格子按 per-type 过滤 |
| `src/renderer/panels/NodeEditor.tsx` | 状态药丸按 per-type 过滤 + 补 placeholder + 静默失败 toast |
| `src/renderer/store/graphStore.ts` | `canTransition` 换 per-type 版 |
| `src/renderer/panels/LeftPanel.tsx` | 扫描按钮常显 + 引导态 |
| `src/renderer/panels/SubagentTypesTab.tsx` | scope 策略默认值 |
| `src/renderer/canvas/hooks/useNodeOperations.ts` | 建节点/建边失败 toast |

---

## Task 1: 修 `mergeSettings` 静默丢字段 + 补齐设置默认值

**Files:**
- Modify: `src/main/settings.ts:66-113`（`DEFAULT_SETTINGS`）、`src/main/settings.ts:556-592`（`mergeSettings` / `mergeCliTools`）
- Test: `src/main/__tests__/settings.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `DEFAULT_SETTINGS` 新增 `compactModel: undefined` 之外的三项水位默认值；`mergeSettings(defaults, saved)` 改为**通用合并**——除 `userIdentity` / `a2aServer` / `a2a` 三个刻意例外外的所有字段都被保留。

- [ ] **Step 1: 写失败的测试**

在 `src/main/__tests__/settings.test.ts` 追加：

```ts
it('mergeSettings 保留 saved 里未登记到 defaults 的字段（compactModel 不再被丢弃）', async () => {
  const { writeSettings, readSettings } = await import('../settings')
  const settingsPath = join(tmpDir, 'settings.json')
  await writeSettings({ compactModel: 'claude-haiku-4-5' } as never, settingsPath)
  const loaded = await readSettings(settingsPath)
  expect(loaded.compactModel).toBe('claude-haiku-4-5')
})

it('contextWaterline 未保存过时也有默认值', async () => {
  const { readSettings } = await import('../settings')
  const loaded = await readSettings(join(tmpDir, 'settings.json'))
  expect(loaded.contextWaterline).toEqual({
    autoCompactEnabled: true,
    autoCompactThreshold: 0.75,
    minCompactInterval: 60_000,
  })
})
```

（`writeSettings` / `readSettings` 的路径参数与测试文件里既有调用方式保持一致——先读该文件确认现有签名再写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/__tests__/settings.test.ts`
Expected: FAIL —— `compactModel` 为 `undefined`（被 `mergeSettings` 丢弃），`contextWaterline` 为 `undefined`。

- [ ] **Step 3: 改 `mergeSettings` 为通用合并**

在 `src/main/settings.ts` 里，把 `mergeSettings` 的逐字段列举改成：

```ts
function mergeSettings(
  defaults: BizGraphSettings,
  saved: Partial<BizGraphSettings>,
): BizGraphSettings {
  const merged: BizGraphSettings = { ...defaults, ...saved }
  // 三个刻意例外，不能被通用合并覆盖：
  // userIdentity 不在默认值里（settings.ts:108-110，避免重装复用旧 userId）
  merged.userIdentity = saved.userIdentity
  // a2aServer / a2a 整体替换、不深合并
  merged.a2aServer = saved.a2aServer ?? defaults.a2aServer
  merged.a2a = saved.a2a ?? defaults.a2a
  // locale 必须过 resolveLocale 归一化
  merged.locale = resolveLocale(saved.locale ?? defaults.locale)
  return merged
}
```

> 注意 `saved` 里可能有 `undefined` 值（`{...defaults, ...saved}` 会用 `undefined` 覆盖默认值）。改用 `Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined))` 过滤后再展开，避免 `undefined` 覆盖掉 `defaults` 的真实默认值。

- [ ] **Step 4: 给 `DEFAULT_SETTINGS` 补水位默认值**

在 `src/main/settings.ts` 的 `DEFAULT_SETTINGS` 里加：

```ts
contextWaterline: {
  autoCompactEnabled: true,
  autoCompactThreshold: 0.75,
  minCompactInterval: 60_000,
},
```

（与 `src/renderer/panels/ContextWaterlineTab.tsx:17-21` 的兜底值一致。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/main/__tests__/settings.test.ts`
Expected: PASS。

- [ ] **Step 6: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/main/settings.ts src/main/__tests__/settings.test.ts
git commit -m "fix(settings): mergeSettings 改为通用合并，不再静默丢弃未登记字段"
```

---

## Task 2: 默认模型按适配器拆分

**Files:**
- Modify: `src/shared/types/agent.ts:519-569`（`BizGraphSettings`）、`src/main/settings.ts`、`src/main/adapters/claude-code.ts:227`、`src/main/adapters/mcp-adapter.ts:412-458`、`src/main/adapters/codex.ts`
- Test: `src/main/__tests__/settings.test.ts`、`src/main/__tests__/claude-code.test.ts`

**Interfaces:**
- Consumes: Task 1 的通用合并。
- Produces: `BizGraphSettings.defaultModels?: { claudeCode?: string; codex?: string; mcp?: string }`。旧的 `defaultModel` **保留**（向后兼容 + 回落）。新增纯函数：

  ```ts
  // src/main/adapters/model-selection.ts（新建）
  export function resolveModelForAdapter(
    settings: Pick<BizGraphSettings, 'defaultModels' | 'defaultModel'>,
    adapter: 'claude-code' | 'codex' | 'mcp',
  ): string | undefined
  ```
  语义：先取 `defaultModels[adapter]`；该档为空时，`claude-code` 回落到旧的 `defaultModel`，`codex` 与 `mcp` 回落到 `undefined`（各自用自己的默认）。**`mcp` 档不得回落到 `defaultModel`**——`defaultModel` 可能是 claude 模型名，回落会让 `resolveApiKey` 按前缀误判 provider。

- [ ] **Step 1: 写失败的测试**

新建 `src/main/adapters/__tests__/model-selection.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { resolveModelForAdapter } from '../model-selection'

describe('resolveModelForAdapter', () => {
  it('优先取按适配器分开的档位', () => {
    const s = { defaultModels: { claudeCode: 'sonnet-4-5', codex: 'gpt-5' }, defaultModel: 'legacy' }
    expect(resolveModelForAdapter(s, 'claude-code')).toBe('sonnet-4-5')
    expect(resolveModelForAdapter(s, 'codex')).toBe('gpt-5')
  })

  it('claude-code 档位为空时回落到旧的 defaultModel', () => {
    expect(resolveModelForAdapter({ defaultModel: 'legacy' }, 'claude-code')).toBe('legacy')
  })

  it('mcp 档位为空时不回落到 defaultModel（避免 provider 误判）', () => {
    expect(resolveModelForAdapter({ defaultModel: 'claude-3-7-sonnet-20250219' }, 'mcp')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/adapters/__tests__/model-selection.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `resolveModelForAdapter`**

新建 `src/main/adapters/model-selection.ts`，内容为上面的签名 + 语义（普通 `if` 即可，无算法复杂度）。

- [ ] **Step 4: 给 `BizGraphSettings` 加 `defaultModels` 字段**

`src/shared/types/agent.ts` 的 `BizGraphSettings` 加：

```ts
  /** 按适配器分开的默认模型；缺档时各自回落（见 resolveModelForAdapter） */
  defaultModels?: {
    claudeCode?: string
    codex?: string
    mcp?: string
  }
```

同时在 `src/main/settings.ts` 的 `DEFAULT_SETTINGS` 里加 `defaultModels: {}`（空对象 = 全部走各自回落）。

- [ ] **Step 5: claude-code 读自己那一档**

`src/main/adapters/claude-code.ts:227`：`model: settings.defaultModel || 'sonnet'` 改为 `model: resolveModelForAdapter(settings, 'claude-code') || 'sonnet'`。

- [ ] **Step 6: mcp 读自己那一档**

`src/main/adapters/mcp-adapter.ts`：`resolveApiKey(settings.apiKeys, settings.defaultModel)`（`:644`）与 `resolveModel(provider, defaultModel, ...)`（`:729`、`:762`、`:1019`、`:1067`）的模型入参改为 `resolveModelForAdapter(settings, 'mcp')`。

- [ ] **Step 7: codex 读自己那一档（若 SDK 支持）**

`src/main/adapters/codex.ts` 当前**完全不读** `defaultModel`。先读该文件里构造 codex SDK 参数的位置，确认 SDK 有没有模型入参：
- **有** → 传 `resolveModelForAdapter(settings, 'codex')`。
- **没有** → **保持现状**，在该处留一行注释说明「codex SDK 不接受模型入参，codex 档位暂不生效」，并在 Task 3 的 DefaultsTab 里对该档位注明同样的话。

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/main/adapters/__tests__/model-selection.test.ts src/main/__tests__/claude-code.test.ts src/main/__tests__/settings.test.ts`
Expected: PASS。

- [ ] **Step 9: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/shared/types/agent.ts src/main/settings.ts src/main/adapters/model-selection.ts src/main/adapters/claude-code.ts src/main/adapters/mcp-adapter.ts src/main/adapters/codex.ts src/main/adapters/__tests__/model-selection.test.ts
git commit -m "feat(settings): 默认模型按适配器拆分，mcp 档不再误用 claude 模型名"
```

---

## Task 3: 设置面板「默认值」页签 + 清掉 renderer 的硬编码副本

**Files:**
- Create: `src/renderer/panels/DefaultsTab.tsx`、`src/renderer/panels/__tests__/DefaultsTab.test.tsx`
- Create: `src/shared/adapter-defaults.ts`
- Modify: `src/renderer/panels/SettingsPanel.tsx:143-150`（页签列表）、`src/renderer/store/adapterStore.ts:23`、`src/renderer/store/agentStore.ts:132`
- Modify: `src/shared/i18n/resources/domains/settings.ts`（及对应的 en 资源文件）
- Test: `src/renderer/panels/__tests__/DefaultsTab.test.tsx`、`src/renderer/store/__tests__/adapterStore.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `BizGraphSettings.defaultModels`。
- Produces:
  - `src/shared/adapter-defaults.ts` 导出：
    ```ts
    export const DEFAULT_ADAPTER_PREFERENCES: AdapterPreferences
    export const ALLOWED_API_PROVIDERS: readonly ApiKeyConfig['provider'][]
    ```
    （内容从 `src/main/settings.ts:53-56` 与 `settings.ts:775` 搬过来，`src/main/settings.ts` 改为从这里 import，保证单一真相源。类型从 `@shared/types/agent` import：`AdapterPreferences` 在 `:589`，`ApiKeyConfig` 在 `:498`。）
  - `src/renderer/panels/DefaultsTab.tsx` 导出：
    ```ts
    export function DefaultsTab(props: {
      settings: BizGraphSettings
      installedAdapters: string[]
      onSave: (patch: Partial<BizGraphSettings>) => Promise<void>
    }): JSX.Element
    ```
    （`installedAdapters` 由调用方传入——组件自己不查 IPC。）

- [ ] **Step 1: 写失败的测试**

新建 `src/renderer/panels/__tests__/DefaultsTab.test.tsx`，文件头 `// @vitest-environment jsdom`。参照 `src/renderer/panels/__tests__/A2ASettingsTab.test.tsx` 的写法（`render` + `screen` + `fireEvent` + `waitFor`，需要 toast 时挂 `<ToastContainer />`）。

至少覆盖四条：
1. 渲染出「默认适配器」下拉，选项**只有** `installedAdapters` 里的适配器（传 `installedAdapters={['claude-code']}`，断言 `screen.queryByText('codex')` 为 `null`）。
2. 改「回退顺序」后调用 `onSave` 时传出的 patch 含 `adapterPreferences`。
3. 改「claude-code 默认模型」输入框后调用 `onSave`，patch 含 `defaultModels: { claudeCode: 'xxx' }`。
4. 保存失败时通过 toast 报错（`useToastStore.getState().toasts` 里出现 error）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/panels/__tests__/DefaultsTab.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 建 `src/shared/adapter-defaults.ts`**

把 `src/main/settings.ts:53-56` 的 `DEFAULT_ADAPTER_PREFERENCES` 与 `settings.ts:775` 的 `ALLOWED_PROVIDERS` 搬进这个新文件并 `export`；`src/main/settings.ts` 改为 `import { DEFAULT_ADAPTER_PREFERENCES, ALLOWED_API_PROVIDERS } from '@shared/adapter-defaults'`（`ALLOWED_PROVIDERS` 的本地名字保留为 `ALLOWED_PROVIDERS`，用 `export const ALLOWED_PROVIDERS = ALLOWED_API_PROVIDERS` 或直接改名并更新引用点——保持 `src/main/settings.ts` 内既有用法不破坏）。

- [ ] **Step 4: 实现 `DefaultsTab.tsx`**

四个区块，每块一个受控表单 + 一个「保存」按钮（保存粒度按区块，不要整页一个大保存按钮）：
1. **默认适配器**：下拉，选项 = `installedAdapters`；一个都没装时禁用并显示提示文案。
2. **回退顺序**：可上下移动的列表（用现成 list 组件；仓库无现成拖拽组件就**不要引新依赖**，用上移/下移按钮）。
3. **按适配器分开的默认模型**：三个输入框（claude-code / codex / mcp），各自允许自由文本（代码库里没有模型名清单，不做枚举下拉）；**每个输入框旁注明该档影响哪个适配器**。
4. **压缩模型**：一个输入框 + 一句注明「仅对 MCP 兜底适配器生效；Claude Code 走 SDK 自身压缩机制」。

保存走 `props.onSave(patch)`；`onSave` 内部调 `window.electronAPI['settings:write']({...settings, ...patch})`，**必须**同时把 `compactModel` / `defaultModels` 放进 patch——Task 1 已保证 `mergeSettings` 不再丢它们。

- [ ] **Step 5: 接进 `SettingsPanel.tsx`**

- 在 `SettingsPanel.tsx:143-150` 的页签数组里加一项 `{ id: 'defaults', label: t('settings.tab.defaults') }`。
- 渲染 `<DefaultsTab settings={settings} installedAdapters={installedNames} onSave={...} />`。
- `installedNames` 从已有的 CLI 工具列表（`SettingsPanel.tsx` 里 `cliTools` state）里取 `installed === true` 的 `name`。
- i18n：`src/shared/i18n/resources/domains/settings.ts` 加 `settings.tab.defaults` 及本页全部文案（中文），英文资源文件同步加。

- [ ] **Step 6: 清掉 renderer 的两份硬编码 `adapterPreferences` 副本**

- `src/renderer/store/adapterStore.ts:23`：把字面量换成 `DEFAULT_ADAPTER_PREFERENCES`（从 `@shared/adapter-defaults` import）。
- `src/renderer/store/agentStore.ts:132`：同样换成 import 来的常量。
- 两者都**只作初始占位**；`adapterStore.loadAdapterPreferences()`（已存在，`agentStore.ts:282` 调用）负责把真值灌进来。补一条测试：`src/renderer/store/__tests__/adapterStore.test.ts` 里断言 `loadAdapterPreferences()` 返回后 state 里的 `adapterPreferences` 等于后端返回值，而不是默认字面量。

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run src/renderer/panels/__tests__/DefaultsTab.test.tsx src/renderer/store/__tests__/adapterStore.test.ts`
Expected: PASS。

- [ ] **Step 8: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/shared/adapter-defaults.ts src/renderer/panels/DefaultsTab.tsx src/renderer/panels/__tests__/DefaultsTab.test.tsx src/renderer/panels/SettingsPanel.tsx src/renderer/store/adapterStore.ts src/renderer/store/agentStore.ts src/shared/i18n/resources/domains/settings.ts
git commit -m "feat(settings): 新增「默认值」页签，接上适配器/回退顺序/按适配器模型"
```

---

## Task 4: 适配器下拉按已装数量自适应

**Files:**
- Modify: `src/renderer/components/agent/ChatHeader.tsx:64-123`
- Test: `src/renderer/components/agent/__tests__/ChatHeader.test.tsx`（新建）

**Interfaces:**
- Consumes: `ChatHeader` 现有的 adapters props（先读该文件确认 props 形状）。
- Produces: `ChatHeader` 在 `installed` 数量为 0 / 1 / ≥2 时分别渲染三种形态，**不新增导出**。

- [ ] **Step 1: 写失败的测试**

新建 `src/renderer/components/agent/__tests__/ChatHeader.test.tsx`（文件头 `// @vitest-environment jsdom`）。三条用例：
1. 传入两个已安装适配器 → 渲染出下拉，**下拉里没有**未安装的那个（断言 `screen.queryByText('cline')` 为 `null`）。
2. 传入**一个**已安装适配器 → **不渲染下拉**，只渲染一个静态标签显示该适配器名（断言 `screen.queryByRole('combobox')` 为 `null`，且适配器名可见）。
3. 传入零个已安装适配器 → 渲染现有的 `AdapterSetupGuide` 空态入口（`AgentChatPanel.tsx:409-427` 那一套，或本组件内既有的空态）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/components/agent/__tests__/ChatHeader.test.tsx`
Expected: FAIL —— 现在三个用例都不满足（未安装项仍在列表里；单个已装时仍有下拉）。

- [ ] **Step 3: 实现三种形态**

在 `ChatHeader.tsx` 里：
- 过滤出 `installed = adapters.filter(a => a.installed)`。
- `installed.length === 0` → 保留现有行为（引导去设置页）。
- `installed.length === 1` → 用一个不可点的 `<span>`/badge 展示该适配器名，**不渲染 `<select>`**。
- `installed.length >= 2` → 渲染 `<select>`，选项只有已安装的；列表底部加一项「安装更多适配器…」，点击走现有跳设置页的路径（`ChatHeader.tsx:100-103` 那条）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/components/agent/__tests__/ChatHeader.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit
git add src/renderer/components/agent/ChatHeader.tsx src/renderer/components/agent/__tests__/ChatHeader.test.tsx
git commit -m "feat(agent): 适配器下拉只列已安装项，只装一个时不再显示下拉"
```

---

## Task 5: 设置面板 general 页签改造（CLI 工具清单、API key provider、清空 key 不误删）

**Files:**
- Modify: `src/main/settings.ts:68-87`（`DEFAULT_SETTINGS.cliTools`）、`src/main/settings.ts:582-592`（`mergeCliTools`）、`src/main/ipc/settings.ts`（`settings:setApiKey` 语义）
- Modify: `src/renderer/panels/SettingsPanel.tsx:168-212`（CLI 工具列表）、`src/renderer/panels/SettingsPanel.tsx:83-89`（`saveApiKey`）、`src/renderer/panels/SettingsPanel.tsx:219`（provider 硬编码数组）
- Test: `src/main/__tests__/settings.test.ts`、`src/renderer/panels/__tests__/SettingsPanel.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 3 的 `ALLOWED_API_PROVIDERS`。
- Produces: `DEFAULT_SETTINGS.cliTools` 覆盖**全部 10 个真 CLI 适配器**（`claude-code` / `codex` / `opencode` / `cline` / `kilo-code` / `kimi-code` / `codebuddy` / `qoder` / `qwen-code` / `cursor`；**不含** `mcp` 与 `mindmap-internal`——它们没有 CLI 二进制，`src/main/ipc/settings.ts:71-81` 的 `assertSafeCommand` 要求非空裸可执行名）。

- [ ] **Step 1: 写失败的测试（主进程侧）**

在 `src/main/__tests__/settings.test.ts` 追加：

```ts
it('DEFAULT_SETTINGS.cliTools 覆盖全部真 CLI 适配器', async () => {
  const { readSettings } = await import('../settings')
  const s = await readSettings(join(tmpDir, 'settings.json'))
  const names = s.cliTools.map(c => c.name)
  for (const n of ['claude-code','codex','opencode','cline','kilo-code','kimi-code','codebuddy','qoder','qwen-code','cursor']) {
    expect(names).toContain(n)
  }
  expect(names).not.toContain('mcp')
  expect(names).not.toContain('mindmap-internal')
})

it('mergeCliTools 保留 defaults 里没有但用户装过的条目', async () => {
  const { mergeCliToolsForTest } = await import('../settings')  // 若未导出，改为通过 readSettings 间接验证
  // ...
})
```

> `mergeCliTools` 目前是模块内私有函数。**优先**通过 `readSettings` 的公开行为间接验证（写入一个含未知条目的 settings.json，读回来该条目还在）；只有在确实无法间接验证时，才导出为 `export function mergeCliTools(...)` 供测试直接调用。

- [ ] **Step 2: 写失败的测试（渲染侧，含 Review Focus 第 1 条）**

新建 `src/renderer/panels/__tests__/SettingsPanel.test.tsx`（`// @vitest-environment jsdom`；同目录已有 `SettingsPanel.locale.test.tsx`，**不要改动它**）。三条用例：
1. API key 输入框留空时点「保存」→ **不调用** `settings:setApiKey`，且出现错误 toast。
2. 输入框有内容时点「保存」→ 调用 `settings:setApiKey(provider, 'sk-xxx')`。
3. provider 列表包含 `gemini`（来自 `ALLOWED_API_PROVIDERS`）。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/main/__tests__/settings.test.ts src/renderer/panels/__tests__/SettingsPanel.test.tsx`
Expected: FAIL —— CLI 清单只有 3 个；空输入会照常调用 `setApiKey`；provider 只有 3 个。

- [ ] **Step 4: 补 `DEFAULT_SETTINGS.cliTools` 到 10 个**

在 `src/main/settings.ts` 里把 `cliTools` 数组补全到上面 10 个，每个条目形状沿用现有 `{ name, npmPackage, command, installed: false }`；`npmPackage` / `command` 从 `src/main/adapters/registry.ts` 的 `ADAPTER_REGISTRY` 对应描述符里取真实值（先读该文件确认每项的 `detectCommand` / 包名字段，不要臆造）。

- [ ] **Step 5: 修 `mergeCliTools` 丢弃未知条目**

`src/main/settings.ts:582-592` 现在只遍历 `defaults`。改成：**先按 `defaults` 补全已知的，再把 `saved` 里 `defaults` 没有的条目原样追加**（用户装了 marketplace 里才出现的 CLI 时不能被吞掉）。

- [ ] **Step 6: 修 API key 的空值语义**

- `src/renderer/panels/SettingsPanel.tsx:83-89` 的 `saveApiKey`：输入框为空时**直接 toast 报错并 return**，不调 IPC。
- 真正的"删除该 key"另给一个明确动作（每行加一个「删除」按钮，点了二次确认后调 `settings:setApiKey(provider, '')` 并让主进程删除该条目而不是写入空串）。
- `src/main/ipc/settings.ts` / `src/main/settings.ts:777` 的 `setApiKey`：`key` 为空串时**从 `apiKeys` 里移除该 provider 的条目**（而不是 push 一个 `{provider, key: ''}`）。

- [ ] **Step 7: provider 列表对齐后端**

`src/renderer/panels/SettingsPanel.tsx:219` 的 `['anthropic','openai','deepseek']` 换成从 `@shared/adapter-defaults` import 的 `ALLOWED_API_PROVIDERS`。

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run src/main/__tests__/settings.test.ts src/renderer/panels/__tests__/SettingsPanel.test.tsx`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
npx tsc --noEmit
git add src/main/settings.ts src/main/ipc/settings.ts src/renderer/panels/SettingsPanel.tsx src/renderer/panels/__tests__/SettingsPanel.test.tsx src/main/__tests__/settings.test.ts
git commit -m "fix(settings): CLI 工具清单补全到全部真 CLI，API key 空值不再误删"
```

---

## Task 6: 新建图收敛为「新建空工作图」并绑定 project_path

**Files:**
- Modify: `src/shared/types/ipc.ts:57`（`graph:create` 参数）、`src/main/ipc/graph.ts:224`、`src/main/services/graph-service.ts:58-63`、`src/main/repositories/graph-repository.ts:38-47`（`create` 已接受 `projectPath?`，可能无需改）
- Modify: `src/renderer/components/GraphTabs.tsx:75-152`
- Test: `src/main/__tests__/graph-service.test.ts`（已存在）、**新建** `src/renderer/components/__tests__/GraphTabs.test.tsx`

**Interfaces:**
- Consumes: `useFileTreeStore.projects`（形状 `{ id, name, path, root, loading }[]`，`src/renderer/store/fileTreeStore.ts:148-168`）。
- Produces: `graph:create` 的参数类型改为
  ```ts
  'graph:create': (data: { name: string; type: GraphType; projectPath?: string }) => Promise<Graph>
  ```
  （`GraphRepository.create` 已经接受 `projectPath?`，只需把它从 IPC 透传到 service 再到 repo。）

- [ ] **Step 1: 写失败的测试（主进程侧）**

`graph:create` 传 `projectPath` 后，图落库必须带上它：

```ts
it('graph:create 带 projectPath 时落库保留该路径', async () => {
  // 建库 → 调 service.createGraph({ name: 'g', type: 'dev', projectPath: '/tmp/proj' })
  // → graphRepo.get(id).projectPath === '/tmp/proj'
})
```

- [ ] **Step 2: 写失败的测试（渲染侧）**

新建 `src/renderer/components/__tests__/GraphTabs.test.tsx`（`// @vitest-environment jsdom`）。两条用例：
1. 打开新建图面板 → **没有**「类型」选择（online / dev 二选一），只有名称输入 + 项目选择。
2. 名称留空点保存 → 出现错误 toast，**面板不关闭**（Review Focus 第 3 条同源：静默失败必须变提示）。
3. 多个项目时，项目选择器列出全部项目，且当前项目是默认选中项。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/renderer/components/__tests__/GraphTabs.test.tsx`
Expected: FAIL —— 现在有类型选择、空名静默返回。

- [ ] **Step 4: 主进程透传 `projectPath`**

- `src/shared/types/ipc.ts:57`：`'graph:create': (data: { name: string; type: GraphType; projectPath?: string }) => Promise<Graph>`。
- `src/main/ipc/graph.ts:224` 的 handler：把 `data.projectPath` 传下去。
- `src/main/services/graph-service.ts:58-63`：`createGraph(data: { name: string; type: GraphType; projectPath?: string })`，把 `projectPath` 交给 `this.graphRepo.create(data)`。

- [ ] **Step 5: 改造新建图 UI**

`src/renderer/components/GraphTabs.tsx:75-152`：
- 删掉 online/dev 的类型选择控件。
- 类型固定为 `'dev'`。
- 加「项目」选择器：选项来自 `useFileTreeStore.getState().projects`；**单项目时自动选中且不显示选择器**（或显示为只读标签）；多项目时显示下拉，默认选中当前打开图所属的项目。
- 名称默认值预填（如 `新工作图 2`）。
- 空名点保存 → `toastError` + **不关面板**。
- "从产品蓝图派生开发场景"的入口保留（`GraphTabs.tsx:136-150`），但它派生出来的图**必须带 `projectPath`**（从源图继承）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/renderer/components/__tests__/GraphTabs.test.tsx src/main/__tests__/graph-service.test.ts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
npx tsc --noEmit
git add src/shared/types/ipc.ts src/main/ipc/graph.ts src/main/services/graph-service.ts src/renderer/components/GraphTabs.tsx src/renderer/components/__tests__/GraphTabs.test.tsx
git commit -m "feat(graph): 新建图收敛为工作图并绑定 project_path，空名给出提示"
```

---

## Task 7: 状态转换改用 per-type 矩阵

**Files:**
- Modify: `src/shared/state-machine.ts`（导出 per-type 判定）、`src/shared/types/graph.ts:420`（`NODE_STATUS_TRANSITIONS`）
- Modify: `src/renderer/store/graphStore.ts:279`（`canTransition`）、`src/renderer/canvas/NodeContextMenu.tsx:33-41`、`src/renderer/panels/NodeEditor.tsx:86-126,544-546`
- Test: `src/shared/__tests__/state-machine.test.ts`（若不存在则新建）、`src/renderer/panels/__tests__/NodeEditor.test.tsx`（新建）

**Interfaces:**
- Consumes: `NODE_STATUS_TRANSITIONS`（`src/shared/types/graph.ts:420`，**已存在**，per-NodeType 的 `NodeStatus[]` 矩阵）。
- Produces: `src/shared/state-machine.ts` 新增导出
  ```ts
  export function canTransitionForType(
    nodeType: NodeType,
    from: NodeStatus,
    to: NodeStatus,
  ): boolean
  ```
  语义：按 `NODE_STATUS_TRANSITIONS[nodeType]` 判定，与主进程 `validateNodeTypeTransition(type, from, to)` **同源同义**。

- [ ] **Step 1: 写失败的测试**

在 `src/shared/__tests__/state-machine.test.ts`（或新建）：

```ts
it('canTransitionForType 按节点类型判定，而非只看状态', () => {
  // module 节点的合法迁移以 NODE_STATUS_TRANSITIONS.module 为准
  expect(canTransitionForType('module', 'draft', 'developing')).toBe(
    NODE_STATUS_TRANSITIONS.module.includes('developing')
  )
  expect(canTransitionForType('feature', 'draft', 'developing')).toBe(true)
})
```

再加一条**对照主进程**的一致性断言：对每种 `NodeType` × 每对状态，`canTransitionForType` 的结果必须等于 `validateNodeTypeTransition` 的结果（后者可能抛异常，用 try/catch 转成 false）。这条断言是本任务的核心价值——它把两张表钉在一起。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/shared/__tests__/state-machine.test.ts`
Expected: FAIL —— `canTransitionForType` 不存在。

- [ ] **Step 3: 实现 `canTransitionForType`**

在 `src/shared/state-machine.ts` 里实现，逻辑与同文件 `validateNodeTypeTransition`（`:128`）**共用同一份 per-type 矩阵**，不要另写一套规则。

- [ ] **Step 4: renderer 换用新判定**

- `src/renderer/store/graphStore.ts:279`：`canTransition` 改调 `canTransitionForType(node.type, from, to)`（确认该处能拿到节点类型；若只有状态没有类型，说明这个函数签名需要调整——按实际调用点补上类型参数）。
- `src/renderer/canvas/NodeContextMenu.tsx:33-41`：7 个状态格子按 `canTransitionForType(node.type, currentStatus, candidate)` 过滤，不可达的不渲染。
- `src/renderer/panels/NodeEditor.tsx:86-126` 的 `StatusSelector`（药丸组，**不是下拉**）：同样过滤，并**补上 `placeholder`**——当前只对 feature/bug 渲染且漏了这个状态，而状态机允许 `draft → placeholder`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/shared/__tests__/state-machine.test.ts src/renderer/panels/__tests__/NodeEditor.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
npx tsc --noEmit
git add src/shared/state-machine.ts src/shared/__tests__/state-machine.test.ts src/renderer/store/graphStore.ts src/renderer/canvas/NodeContextMenu.tsx src/renderer/panels/NodeEditor.tsx
git commit -m "fix(graph): 状态转换判定与主进程对齐为 per-type 矩阵，菜单不再给出非法转换"
```

---

## Task 8: 静默失败归零（一）——节点编辑器

**Files:**
- Modify: `src/renderer/panels/NodeEditor.tsx:37-42`（标题）、`:207-208`（业务规则）、`:454-455`（验收标准）、`:427-433`（API/服务/实体）、`:544-546` + `src/renderer/panels/RightPanel.tsx:111`（状态更新）
- Test: `src/renderer/panels/__tests__/NodeEditor.test.tsx`（Task 7 已新建）

**Interfaces:**
- Consumes: Task 7 的 `canTransitionForType`。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

在 `src/renderer/panels/__tests__/NodeEditor.test.tsx` 追加（挂 `<ToastContainer />`，用 `useToastStore.getState().toasts` 断言）：
1. 标题清空后点 ✓ → 出现 error toast，且**输入框里仍保留着编辑态**（Review Focus 第 3 条）。
2. 业务规则空内容点「添加」→ 出现 error toast。
3. 验收标准空内容点「添加」→ 出现 error toast。
4. API/服务/实体空输入点「添加」→ 出现 error toast。
5. 触发一次非法状态转换（mock `updateNode` reject）→ 出现 error toast，且界面不崩。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/panels/__tests__/NodeEditor.test.tsx`
Expected: FAIL —— 现在全部静默。

- [ ] **Step 3: 逐处补 toast**

四处空内容提交：从静默 `return` 改为 `toastError(<对应文案>)` 并 `return`（行为不变，只是多了提示）。标题那处额外改：**空标题时不退出编辑态**，保留用户输入。

状态更新：`src/renderer/panels/RightPanel.tsx:111` 的 `graphStore.updateNode(...)` 补 `.catch()` → `toastError`。

文案加在 `src/shared/i18n/resources/domains/node.ts`（及对应 en 文件），不要硬编码中文字符串。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/panels/__tests__/NodeEditor.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit
git add src/renderer/panels/NodeEditor.tsx src/renderer/panels/RightPanel.tsx src/shared/i18n/resources/domains/node.ts
git commit -m "fix(node): 节点编辑器的静默失败改为明确提示"
```

---

## Task 9: 静默失败归零（二）——建图 / 建节点 / 建边 / 状态更新

**Files:**
- Modify: `src/renderer/components/GraphTabs.tsx`（建图空名）、`src/renderer/canvas/hooks/useNodeOperations.ts:48-53,64-66`（建节点/建边）、`src/renderer/canvas/GraphCanvas.tsx:1503-1511`（右键菜单改状态）
- Test: `src/renderer/components/__tests__/GraphTabs.test.tsx`（Task 6 已新建）、`src/renderer/canvas/hooks/__tests__/useNodeOperations.test.ts`（已存在）

**Interfaces:**
- Consumes: 无新依赖。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

- `useNodeOperations.test.ts` 追加：`createNode` reject → 断言 toast 出现 error，且 `createEdge` **没有被调用**（现有逻辑是对的：建节点失败就不建边，测试要把这条钉住）。
- `GraphTabs.test.tsx` 追加：新建图空名点保存 → error toast + 面板不关（Task 6 已加过则不重复加）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useNodeOperations.test.ts src/renderer/components/__tests__/GraphTabs.test.tsx`
Expected: FAIL —— 建节点失败只 `console.error`。

- [ ] **Step 3: 补 toast**

- `useNodeOperations.ts:48-53`：`console.error` 之后补 `toastError`（保留 `return`，不建边）。
- `useNodeOperations.ts:64-66`：建层级边失败 → `toastError`（节点已建成、边没建成，用户要知道图上少了一根线）。
- `GraphCanvas.tsx:1503-1511`：右键菜单改状态失败 → 从 `console.error` 改为 `toastError`（菜单关闭行为不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/canvas/hooks/__tests__/useNodeOperations.test.ts src/renderer/components/__tests__/GraphTabs.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit
git add src/renderer/canvas/hooks/useNodeOperations.ts src/renderer/canvas/GraphCanvas.tsx
git commit -m "fix(canvas): 建节点/建边/改状态失败改为明确提示"
```

---

## Task 10: 扫描按钮常显 + 引导态

**Files:**
- Modify: `src/renderer/panels/LeftPanel.tsx:262-273`、`:229-235`（空态文案）
- Test: `src/renderer/panels/__tests__/LeftPanel.test.tsx`（新建）

**Interfaces:**
- Consumes: 无。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

新建 `src/renderer/panels/__tests__/LeftPanel.test.tsx`（`// @vitest-environment jsdom`）。两条：
1. 项目已加入但尚未扫描时，「扫描项目生成脑图」的按钮**无需 hover 即可见**（断言按钮元素存在且其计算样式/父级不含 `opacity-0`；最直接的方式是断言按钮节点的 `opacity` 不为 0，或断言它没有 `group-hover:opacity-100` 这个 class）。
2. 该状态下按钮带一段副文案说明会做什么。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/panels/__tests__/LeftPanel.test.tsx`
Expected: FAIL —— 现在是 `opacity-0 group-hover:opacity-100`。

- [ ] **Step 3: 实现常显 + 引导态**

`src/renderer/panels/LeftPanel.tsx:262-273`：
- 去掉 `opacity-0 group-hover:opacity-100`，改为常态可见（hover 时可加强对比，但不是靠 hover 才出现）。
- 项目已导入但尚未扫描时，渲染一个明确的引导块：按钮文案「扫描项目生成脑图」+ 一句副文案说明会检测框架/路由/实体并生成蓝图。
- 文案走 `t()`，加在 `src/shared/i18n/resources/domains/projects.ts`（及 en）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/panels/__tests__/LeftPanel.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit
git add src/renderer/panels/LeftPanel.tsx src/renderer/panels/__tests__/LeftPanel.test.tsx src/shared/i18n/resources/domains/projects.ts
git commit -m "feat(projects): 扫描生成脑图按钮常显，并加首次引导"
```

---

## Task 11: 子代理 scope 策略默认值

**Files:**
- Modify: `src/renderer/panels/SubagentTypesTab.tsx:18,120-129`
- Test: `src/renderer/panels/__tests__/SubagentTypesTab.test.tsx`（新建）

**Interfaces:**
- Consumes: 无。
- Produces: 无新导出。

- [ ] **Step 1: 写失败的测试**

新建 `src/renderer/panels/__tests__/SubagentTypesTab.test.tsx`（`// @vitest-environment jsdom`）。一条：
- 点「+ 新建自定义类型」→ 表单打开时 `scopeStrategy` 已是 `subset`（断言对应 radio 选中）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/panels/__tests__/SubagentTypesTab.test.tsx`
Expected: FAIL —— 现在 scope 策略不预选。

- [ ] **Step 3: 默认选中 `subset`**

`src/renderer/panels/SubagentTypesTab.tsx:120-129`：新建表单打开时把 `scopeStrategy` 预置为 `'subset'`（`EMPTY_TYPE`（`:18`）已经是 `subset`，是 UI 没有把它设进表单 state）。**不删掉这个控件**——用户仍可在创建时改，只是默认已选好。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/panels/__tests__/SubagentTypesTab.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
npx tsc --noEmit
git add src/renderer/panels/SubagentTypesTab.tsx src/renderer/panels/__tests__/SubagentTypesTab.test.tsx
git commit -m "feat(subagent): scope 策略默认选中 subset"
```

---

## 完成判据

全部任务完成后，下面这一串必须为绿：

```bash
npx tsc --noEmit
npm run lint
npm run test
```

外加一条**人工验证**（无法用单测覆盖）：

1. 打开设置 → 新增的「默认值」页签能改默认适配器、回退顺序、三个模型档位、压缩模型 → **重启应用，改动仍在**（验证 Task 1 的 `mergeSettings` 修复真的生效）。
2. 只装一个适配器时，Agent 面板的适配器位置不再出现下拉。
3. 节点标题改空 → 有提示、输入没丢。
4. 项目导入后「扫描项目生成脑图」按钮**不用悬停**就能看见。
5. 新建图 → 没有类型选择；多项目时能选项目；空名有提示。

> 本计划**不含**：只读会话模式、项目级范围记忆、schema v18。它们在 `docs/superpowers/plans/2026-10-31-ux-readonly-scope.md`。
