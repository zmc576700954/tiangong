# File Tree Redesign: Full Rewrite with Context Menu & Agent Integration

**Date**: 2026-05-28
**Status**: Approved
**Scope**: LeftPanel file tree rewrite, context menu, Agent integration from file tree

## Problem

The current `LeftPanel.tsx` manages file tree state locally with `useState`, ignoring the well-built `fileTreeStore` that already implements expand/collapse persistence, clipboard, search, drag & drop, and context menu state. Sub-directory expand doesn't load children. There is no right-click context menu on file tree entries. The file tree and the mind map graph are completely disconnected.

## Approach

Full rewrite of LeftPanel internals. Create a new `TreeView` component that uses `fileTreeStore` as its single state source. Add a `FileTreeContextMenu` component with 11 actions. Create `appStore` to bridge panel switching between file tree and Agent.

## Component Architecture

```
LeftPanel (thin shell - project management, drag-drop to open)
├── ProjectHeader (project name + expand/collapse/scan/remove buttons)
├── TreeView (recursive tree rendering - reads from fileTreeStore)
│   └── TreeNodeItem (single node - click to expand/select, right-click menu trigger)
├── FileTreeContextMenu (floating context menu overlay)
└── StatusBar (toast feedback + search bar)
```

### Data Flow

- **fileTreeStore** — single source of truth for: project list, expand state, selection, clipboard, context menu position
- **graphStore** — receives "create node" operations from context menu actions. Nodes are always created in the current `online` graph. If no graph exists, the user is prompted to create one first or to run project scan.
- **agentStore** — receives "start session" operations from context menu actions
- **appStore** (new) — bridges panel tab switching (node/agent) and agent working directory context

## Context Menu Design

Right-click on any file or directory shows a unified menu with 3 groups:

### Group 1: Agent Operations

| Action | Icon | Behavior |
|--------|------|----------|
| Agent 输入框 | `Terminal` | Switch RightPanel to Agent tab, set `agentWorkingDirectory` to the file/directory path |
| 推演思维导图 | `Sparkles` | Agent analyzes code at path, auto-generates complete node hierarchy (module → process → feature) |

### Group 2: Generate Nodes

| Action | Icon | NodeType | Behavior |
|--------|------|----------|----------|
| 生成业务模块 | `Box` | `module` | Agent analyzes → creates module node(s) with AI-populated title/description/scope |
| 生成业务流程 | `GitBranch` | `process` | Agent analyzes → creates process node(s) scoped to path |
| 生成功能点 | `Code2` | `feature` | Agent analyzes → creates feature node(s) scoped to path |
| 生成 BUG 点 | `Bug` | `bug` | Agent analyzes → creates bug node(s) scoped to path |
| 添加独立节点 | `Plus` | user selects | Creates a blank node (no parent), type picker shown, scope set to path |

### Group 3: File Operations

| Action | Icon | Behavior |
|--------|------|----------|
| 复制 | `Copy` | Add path to clipboard (copy mode) |
| 剪切 | `Scissors` | Add path to clipboard (cut mode) |
| 粘贴 | `Clipboard` | Paste clipboard contents into current directory (only enabled when clipboard has content) |
| 删除 | `Trash2` | Delete file/directory with confirmation dialog |

### Menu Interaction

- Right-click prevents browser default menu, positions at cursor
- Click outside closes menu
- "Generate node" actions show loading spinner during Agent analysis
- Paste is greyed out when clipboard is empty
- Menu items have hover highlighting, destructive items (delete) in red
- Delete triggers a confirmation dialog before execution

## Expand/Collapse Behavior

- Single-click on a directory toggles expand/collapse
- On expand, if `children` is an empty array (`[]`), lazy-load children via `fs:readDirDetail`
- Expand state persisted to localStorage via fileTreeStore's `expandedPaths`
- Directory icon switches between `Folder` and `FolderOpen` based on state
- Chevron icon rotates between `ChevronRight` and `ChevronDown`

## Agent Interaction Flows

### "添加 Agent 输入框"

1. Set `appStore.activeRightPanel = 'agent'`
2. Set `appStore.agentWorkingDirectory = '/path/to/file'`
3. RightPanel switches to Agent tab
4. Agent panel's working directory pre-filled with the path

### "推演思维导图"

1. Check if an `online` graph exists; if not, prompt user to create one first
2. Read the file/directory content via `fs:readFile` (for files) or list all files recursively
3. Create a temporary Agent session with `AgentSessionConfig.workingDirectory` set to the project root, `allowedFiles` set to the target path
4. Send analysis prompt asking Agent to return JSON with this schema:
   ```json
   {
     "modules": [{ "title": "...", "description": "...", "processes": [{ "title": "...", "description": "...", "features": ["..."] }] }]
   }
   ```
5. Parse Agent response, create nodes in the current `online` graph via `graphStore.createNode`
6. Set position using a layout algorithm (e.g., tree layout with spacing)
7. `parentId` is set to establish module → process → feature hierarchy

### "生成 XXX 节点" (single type)

1. Same as "推演思维导图" but prompt specifies a single node type
2. Example for "生成业务模块": prompt asks Agent to identify core business modules at the path, return `[{ "title": "...", "description": "..." }]`
3. Created nodes have `parentId = null` (standalone); user manually arranges hierarchy on canvas
4. Node's `description` includes a note: `"[Scope: /path/to/file]"` so the binding is visible in the UI

### "添加独立节点"

1. No Agent call
2. Show a small type picker popup (module / process / feature / bug)
3. Create node in current `online` graph with default title = file/directory name
4. Node `description` set to `"[Scope: /path/to/file]"`

## New Files

| File | Purpose |
|------|---------|
| `src/renderer/store/appStore.ts` | Panel tab switching, agent working directory |
| `src/renderer/panels/TreeView.tsx` | Recursive tree component using fileTreeStore |
| `src/renderer/panels/TreeNodeItem.tsx` | Single tree node with click/right-click handlers |
| `src/renderer/panels/FileTreeContextMenu.tsx` | Context menu component |

## Modified Files

| File | Changes |
|------|---------|
| `src/renderer/panels/LeftPanel.tsx` | Rewrite: thin shell using TreeView, remove local state |
| `src/renderer/panels/RightPanel.tsx` | Read `appStore.activeRightPanel` to switch tabs externally |
| `src/renderer/store/fileTreeStore.ts` | Minor: ensure `toggleExpand` triggers lazy-load |
| `src/renderer/store/graphStore.ts` | Add `createNodeBatch` helper for multi-node creation |
| `src/shared/types.ts` | Add `appStore`-related types if needed |

## Dependencies

No new npm packages required. All context menu UI built with existing Tailwind + shadcn patterns (matching `NodeContextMenu.tsx` style). Icons from `lucide-react`.

## Testing Strategy

1. Unit test `fileTreeStore` actions (expand, clipboard, context menu)
2. Manual test: right-click file → each menu item produces correct result
3. Manual test: "推演思维导图" creates nodes on canvas with correct scope
4. Manual test: expand/collapse persists across page reload
5. Manual test: "添加 Agent 输入框" switches RightPanel to Agent tab with correct working directory
