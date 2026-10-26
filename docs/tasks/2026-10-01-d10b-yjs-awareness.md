# D10b — Yjs Awareness（协作光标 / 选区）· 任务跟踪

> 创建：2026-10-01
> 范围：Phase D-10b — Awareness 协作层基础设施
> 计划来源：[综合改进计划 §Phase D](../superpowers/plans/velvet-marinating-yao.md)
> 前置：~~D10a Y.Doc sync 通道已合并~~ — **未合并**（分支 `claude/d10a-yjs-doc-sync-03f7b8` 0 commit），本次按自包含 awareness 层交付，与 D10a 解耦
>
> ⚠️ **设计调整**：D10a 通道未上线导致 awareness 没法挂到标准 y-protocols/awareness 上。本次采用**自包含 JSON 协议**（3 种消息：QUERY / UPDATE / REMOVE）+ `ws` 主进程服务器 + 浏览器原生 `WebSocket` 客户端，与未来 D10a 上线后的二进制 sync 协议物理隔离（端口分离、协议分离）。代价：重复实现 awareness 状态机。收益：D10b 可独立验收 / 部署，D10a 合并时只需把 awareness 也迁到 y-protocols/awareness 即可。

## 当前状态

**全部 5 个子任务已落地** — `npx tsc --noEmit` 零错误，`npm run lint` 零警告，awareness 测试套件 57 个全部通过（user-identity: 19 / awareness-server: 12 / awareness-client: 14 / RemoteCursors: 12）。

## 目标

让本地用户在画布上看到其他人的鼠标位置和节点选区。状态只活在内存里，不持久化，不污染 Y.Doc → SQLite 链。

## 任务清单

- [x] **D10b-1 Awareness provider**：`src/main/realtime/awareness-server.ts` + `index.ts` singleton — `WebSocketServer` 监听 `ws://127.0.0.1:<port>`（默认 1235），每个连接 server-assigned clientId（UUID），严格 `validateAwarenessState` 拒绝伪造 ID 和非法字段，MAX_CLIENTS=100 + MAX_MESSAGE_BYTES=4KB 双重护栏，关闭用 `'close'` 事件 + 200ms `terminate()` 兜底（ws 库的 `close()` 不带 callback，必须双保险避免 stop hang）
- [x] **D10b-2 Renderer cursor layer**：`src/renderer/canvas/RemoteCursors.tsx`（仅 React 组件，HMR 友好）+ `remote-selection.ts`（helper：`computeRemoteSelectionByNode` / `colorForUser`，避免 react-refresh warning） + `BizNode.tsx` 多色 `boxShadow` ring（自身选中 + 远端选中叠加）
- [x] **D10b-3 User identification**：`src/shared/types/agent.ts` 新增 `UserIdentity { userId, userName, colorIndex }`，加进 `BizGraphSettings.userIdentity`；`src/main/realtime/user-identity.ts` 提供 `generateDefaultIdentity`（`node:crypto.randomUUID()` + 操作系统用户名前缀 + 4 字符 hash 短码避免本机多用户撞名）+ 6 色循环调色板（红/橙/黄/绿/蓝/紫）+ `deriveColorIndex` 256-bit hash → palette index + `isValidUserIdentity` / `isHexColor` 校验防止 settings.json 注入
- [x] **D10b-4 Local awareness state**：`src/renderer/realtime/awareness-client.ts` 单实例 `AwarenessClient`（cursor 50ms throttle、selection 100ms throttle、disconnect 指数退避 + jitter 最长 6 次重试，6 次失败后放弃不阻塞主流程）+ `awareness-store.ts` singleton + `hooks.ts` 提供 `useAwarenessConnection`（mount 时连，unmount 时断）/ `useRemoteAwareness`（`useSyncExternalStore` 订阅）/ `useRemoteAwarenessConnection`（订阅连接 boolean）/ `useBroadcastLocalCursor`（rAF + 50ms throttle）/ `useBroadcastLocalSelection`（rAF + 100ms throttle）+ `GraphCanvas.tsx` 用 `screenToFlowPosition` 把屏幕坐标转 flow 坐标广播，onMouseLeave 发 null

- [x] **D10b-5 测试**（57 个）：
  - `src/main/__tests__/realtime/user-identity.test.ts` — 19 个 case（resolveAwarenessColor / deriveColorIndex / generateDefaultIdentity / isValidUserIdentity / isHexColor）
  - `src/main/__tests__/realtime/awareness-server.test.ts` — 12 个 case（启动与连接 / 消息校验 / 监听器 / REMOVE 广播）
  - `src/renderer/realtime/__tests__/awareness-client.test.ts` — 14 个 case（用 `vi.stubGlobal('WebSocket', ...)` mock Node 22+ 原生 WebSocket，避免测试受全局状态污染）
  - `src/renderer/canvas/__tests__/RemoteCursors.test.tsx` — 12 个 case（`renderToString` 服务端渲染测 RemotePresenceBadge 和 computeRemoteSelectionByNode）

## 协议

**JSON over WebSocket**（主进程 1235 端口）：

```
C → S:  { type: 0, clientId: "self" }                                    // 上线后拉现有 states
C → S:  { type: 1, clientId: "<server-assigned>", state: RemoteAwarenessState }
S → C:  { type: 1, clientId: "<other>", state: RemoteAwarenessState }    // 广播给其它客户端
S → C:  { type: 2, clientId: "<disconnected>" }                          // peer 离开
```

`RemoteAwarenessState`：
```ts
{
  user: { userId, userName, colorIndex },
  cursor: { x, y } | null,
  selectedNodeIds: string[],
  lastUpdated: number  // server 覆盖
}
```

## 关键设计决策

- **端口 = 1235**（D10a 上线后独立） — D10b 用 1235，D10a 建议独立端口（未来可由 IPC listener 端口协商器共享）
- **服务端校验 clientId** — `msg.clientId !== conn.clientId` 直接 close（防伪造）
- **`validateAwarenessState` 严格类型检查** — cursor x/y 必须 finite number、selectedNodeIds 限长 1000 / 单 id ≤ 256（防内存炸弹）
- **`MAX_CLIENTS = 100`** + `MAX_MESSAGE_BYTES = 4KB`** — 单机协作场景下足够，任何越界拒绝
- **`terminate()` 兜底** — ws.close() 不带 callback，必须 `'close'` 事件 + 200ms 兜底定时器，否则 server.stop() 会 hang
- **不在 `UserIdentity` 存敏感信息** — 只有 userId/userName/colorIndex，不写邮箱、IP、地理位置
- **awareness-client 用 `vi.stubGlobal`** — Node 22+ 自带 `WebSocket`，必须 stub；测试不污染全局
- **`react-refresh` HMR 友好** — RemoteCursors.tsx 只放组件；helper（`computeRemoteSelectionByNode` / `colorForUser`）拆到 `remote-selection.ts`
- **共享类型放 `@shared/realtime`** — types + palette + resolveAwarenessColor 纯函数放共享层（主进程和渲染进程都可见），main 端 user-identity.ts 只放 Node-only 逻辑（`randomUUID` / `process.env.USERNAME`）；符合 `no-restricted-imports` ESLint 规则

## 验证门槛

- [x] `npx tsc --noEmit` 零错误
- [x] `npm run lint` 零警告（max-warnings 0）
- [x] 全部 awareness 测试 57 个通过
- [x] 共享类型边界（shared/realtime.ts 不依赖 main，main 端通过 view layer re-export）
- [x] CLAUDE.md Boundaries §「不替换 Agent CLI 的内部行为」「不污染可复用 KV-cache prefix」「不污染下游可复用优化机制」「不写入项目工作目录之外的文件」均满足

## 后续迁移（D10a 上线后）

D10a 合并后，本 awareness 层可以无缝迁移到 `y-protocols/awareness` 二进制协议：

1. 主进程 `AwarenessServer` 内部用 `Awareness` 类替代 Map<clientId, state>
2. 渲染进程 `AwarenessClient` 内部用 `Awareness` 实例替代 Map
3. 协议格式升级为 y-protocols/awareness（不变 API shape）
4. 共享类型（`@shared/realtime`）保留「业务层抽象」（`RemoteAwarenessState` / `UserIdentity`），与底层协议升级隔离
5. 删除本文件中的自包含 3-msg JSON 协议注释，换成 y-protocols 二进制协议引用

## 已知局限

- 当前 `AwarenessClient.serverClientId` 在 mock 单元测试中无法被 server 主动告知（mock 不发 UPDATE 回调自己），导致 `sendUpdate` 总是 early return。**生产环境真实连接不会有此问题**（UPDATE 从 server broadcast 给其它客户端，但 server 不 echo sender；需要 server 单独发 WELCOME 消息返回 senderClientId）。D10a 合并时一并修复
- 单条上下文 6 色循环不够支持 7+ 用户同时协作；超出会绕回重色。MVP 场景下 6 色足够，后续可改成 12/32 色
- Awareness 状态完全在内存，server 重启全丢。这是有意为之（D10a Y.Doc 是持久化，awareness 不应重复）
- 渲染层 `useBroadcastLocalCursor` 用 `getCursor()` getter 而不是直接接 mousemove —— 避免 mousemove 触发 React re-render（性能关键）