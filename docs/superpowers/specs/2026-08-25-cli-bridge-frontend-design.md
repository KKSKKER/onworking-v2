# 前端 CLI 桥接 + 实时渲染设计

> 日期：2026-08-25 · 状态：待评审
> 关联：`src/ipc/contracts.ts`（契约）、`src/cli/index.ts`（CLI）、`src/mcp/server.ts`（MCP）、`src/main/*`（Electron 主进程）、`src/renderer/*`（前端）

## 1. 背景与目标

当前前端直接经 `window.onw.invoke({cmd})` → Electron main → `dispatch` 调后端。本次改为：

- 前端**不再直连后端 dispatch**，而是**生成一条 CLI 语句（NDJSON `IpcRequest`）经 CLI 执行**。
- **实时渲染**：CLI 的逐行输出（结果/进度/日志）实时滚动渲染到画面（输出流面板），命令完成后各视图自动刷新。
- **同步 AI 执行**：AI（经 MCP/CLI）改了工作区，前端能感知并刷新。

已确认的三个方向决策：
1. **main 桥接 CLI 子进程**（渲染进程安全限制，不能直接 spawn）。
2. **输出流面板 + 视图自动刷新**。
3. **监听工作区文件变化**（fs.watch `.onworking`）同步 AI。

## 2. 架构与数据流

```
Renderer(React)
  ├─ sendCli(IpcRequest) ──window.onw.cli──▶ preload ──ipcMain('cli:command')──▶ main
  │                                                                    │ spawn onw CLI (open <ws>)
  │                                                                    ▼
  │                                                       onw CLI 子进程(NDJSON)
  │                                                                    │ stdout 结果行 / stderr 进度日志
  │                                                                    ▼
  ├─ onCliEvent(line) ◀──webContents.send('cli:event')── main 读 stdout 逐行推回
  ├─ onCliError(line) ◀──webContents.send('cli:stderr')── main 读 stderr 逐行推回
  ├─ onWorkspaceChanged() ◀──fs.watch(<ws>/.onworking)── main 监听变化(AI 改了文件就触发)
  └─ 输出流面板(CliOutputPanel): cli:event + cli:stderr 逐行滚动渲染
        + 各视图在 sendCli 完成 / workspace:changed 后自动 reload
```

执行者从「main 直接 dispatch」变成「CLI 子进程（内部复用同一套 dispatch）」。main 只做：管理 CLI 子进程、转发命令、回推输出、监听工作区。

## 3. 组件改动

### 3.1 `src/main/cli-bridge.ts`（新）
CLI 子进程管理器：
- `createCliBridge(): CliBridge`
  - `open(wsPath: string)`：杀掉旧进程（若有），`spawn('node', [cliEntry, 'open', wsPath])`。`cliEntry` = `dist/main/cli/index.js`（`npm run dev`/`build` 已先 `build:main`，路径恒定）。
  - `send(request: IpcRequest)`：`child.stdin.write(JSON.stringify(request) + '\n')`。
  - `onLine(cb)`：stdout 数据按 `\n` 切行（保留残段），逐行回调。
  - `onError(cb)`：stderr 逐行回调。
  - `close()`：kill + 清理。
- 崩溃处理：`child.on('exit')` → 上报 `onError`（前端可提示），不自动重启（避免循环）。

### 3.2 `src/main/index.ts`
- 删除/停用旧的 `onw:invoke` 直接 dispatch 路径（前端不再走它；dispatch 仍由 CLI/MCP 内部使用）。
- 新增 IPC：
  - `ipcMain.on('cli:command', (_e, req: IpcRequest) => bridge.send(req))`（fire-and-forget，结果经流回推）。
  - `ipcMain.handle('cli:open', (_e, path: string) => { bridge.open(path); watchWorkspace(path); return { ok: true }; })`。
  - 保留 `onw:pick-workspace`（目录选择对话框）。
- 回推：`bridge.onLine(line => win.webContents.send('cli:event', line))`；`bridge.onError(line => win.webContents.send('cli:stderr', line))`。
- `watchWorkspace(path)`：`fs.watch(join(path, '.onworking'), { recursive: true })` → 300ms debounce → `win.webContents.send('workspace:changed')`。Windows 支持 recursive。

### 3.3 `src/main/preload.ts` + `src/renderer/global.d.ts`
`window.onw` 新 API（替换旧的 `invoke`/`onProgress`/`onLog`）：
- `cli(request: IpcRequest): void`
- `onCliEvent(cb: (line: string) => void): () => void`
- `onCliError(cb: (line: string) => void): () => void`
- `onWorkspaceChanged(cb: () => void): () => void`
- `openWorkspace(path: string): Promise<{ ok: boolean }>`
- `pickWorkspace(): Promise<string | null>`

### 3.4 `src/renderer/cli.ts`（新）
前端 CLI 客户端（模块级单例）：
- `sendCli(command: ApiCommand): Promise<ApiResult<unknown>>`：自动分配 `reqId`，`window.onw.cli({ ...command, reqId })`，解析 `cli:event` 里匹配 `reqId` 的 `{ reqId, result }` 行 resolve。无匹配 reqId 的 JSON 行（如进度类）忽略。
- `initCliClient()`：`main.tsx` 启动时调用；订阅 `onCliEvent`/`onCliError`，把每行追加进全局 `outputLines` 并通知订阅者。
- `subscribeOutput(cb)`：输出流面板订阅实时行。
- `onWorkspaceChanged(cb)`：转发 `window.onw.onWorkspaceChanged`。

### 3.5 `src/renderer/views/useApi.ts` + 各 view
- `useApi` 底层 `window.onw.invoke(command)` → `sendCli(command)`。
- `useApi` 增加：挂载时 `window.onw.onWorkspaceChanged(reload)`，AI/任何命令改了工作区即自动刷新（AI 同步落点）。
- 各 view 直接调用点 `window.onw.invoke({...})` → `sendCli({...})`（`QueryView`/`SqlView`/`PreviewView`/`MappingView`/`BigTableSettingsView`/`TopBar`）。

### 3.6 `CliOutputPanel`（底部面板，将现 `BottomPanel.tsx` 改造并重命名）
- 现 `BottomPanel.tsx` 显示的是 logger 输出；改造成 `CliOutputPanel`：订阅 `outputLines`，滚动容器逐行渲染 CLI 流（自动滚到底部）。
- 行按来源着色：stdout 结果行 / stderr 进度·日志行；`{ok:false}` 标红。
- 位置不变（App.tsx 底部 `ResizablePanel`），仅组件重命名 + 数据源换成 CLI 流。

### 3.7 `src/renderer/mock/onw-mock.ts`
新 API 的浏览器 dev mock：`cli(request)` 用现有 `mockDispatch` 逻辑生成一条假 `{ reqId, result }` 行经 `onCliEvent` 异步回推；`onCliError`/`onWorkspaceChanged` 空实现；`openWorkspace`/`pickWorkspace` 返回固定值。

## 4. 关键决策
- **前端与后端解耦**：main 不再直接 dispatch，执行者是 CLI 子进程（CLI 内部就是 dispatch）。前端、AI（MCP）、手动 CLI 三路都收敛到同一执行链。
- **reqId 对账**：结果行经流回推，`sendCli` 按 reqId resolve Promise，视图侧语义与旧 `invoke` 一致，改动小。
- **AI 同步用 fs.watch**：与 AI 用 MCP 还是 CLI 连接无关，改 `.onworking` 文件即触发前端刷新。
- **工作区切换** = `cli:open` 重启 CLI 子进程（`open <path>`），前端视图随后 reload。
- **不引入新依赖**。

## 5. 边界与注意
- CLI 入口恒用 `dist/main/cli/index.js`（dev 的 `npm run dev` 已先 `build:main`）。
- `fs.watch` 高频（管线写 json/db）→ 300ms debounce，防刷屏。
- CLI 进程崩溃：上报 `cli:stderr`，不自动重启（避免失控）。
- 浏览器 dev（vite）用 mock 顶替，不连真实 CLI 进程。
- 旧 `window.onw.invoke/onProgress/onLog` 移除后，残留引用会导致 typecheck 报错——正好借类型检查清干净。

## 6. 测试策略
- **可单测**：`renderer/cli.ts` 的 reqId 对账（用 mock `window.onw` 喂假行）；CLI 行切分（若抽成纯函数）。
- **仍有效**：`tests/ipc/handlers.test.ts` 等（dispatch 是 CLI 内部，契约未变）。
- **冒烟**：Electron main/preload/fs.watch 层手工验证（`npm run dev` 起前端连真实 CLI）。

## 7. 不做（本期）
- 输出流面板里「AI 发起」标记（后续按需加）。
- 移除 CLI 层的 dispatch（它本就该在 CLI 内部）。
- 工作区切换的历史/多开。
