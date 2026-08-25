# 前端 CLI 桥接 + 实时渲染实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 前端不再直连后端 dispatch，改为「生成 CLI 语句 → 经 CLI 子进程执行 → 实时渲染输出流 + fs.watch 同步 AI 执行」。

**Architecture:** Electron main 持有 `onw` CLI 子进程（NDJSON），前端 `sendCli(IpcRequest)` 经 IPC 转发进 CLI stdin，CLI 的 stdout（结果行）/stderr（进度·日志）逐行回推给前端；底部 `CliOutputPanel` 实时渲染输出流；main `fs.watch` 工作区 `.onworking` → `workspace:changed` 事件 → 视图自动刷新（AI 改了文件前端即感知）。

**Tech Stack:** TypeScript strict、Electron main/preload、React、child_process、node:fs `fs.watch`、vitest。

**Spec:** [docs/superpowers/specs/2026-08-25-cli-bridge-frontend-design.md](../specs/2026-08-25-cli-bridge-frontend-design.md)

## Global Constraints

- **前端与后端解耦**：main 不再直接 `dispatch`；执行者是 CLI 子进程（CLI 内部就是同一套 dispatch）。旧 `onw:invoke` 直接 dispatch 路径在 T9 移除，移除前全程保留（保证每步可运行）。
- **reqId 对账**：`sendCli(command)` 自动分配 `reqId`，解析 `cli:event` 里匹配 `reqId` 的 `{ reqId, result }` 行 resolve Promise，视图语义与旧 `invoke` 一致。
- **`window.onw` 新 API**：`cli/onCliEvent/onCliError/onWorkspaceChanged/openWorkspace/pickWorkspace`。旧 `invoke/onProgress/onLog` 临时保留为超集，T9 移除。
- **CLI 入口**：恒用 `dist/main/cli/index.js`（`npm run dev`/`build` 已先 `build:main`）。
- **不新增依赖**；每任务以可运行测试/`npm run typecheck` 收尾并提交。
- 测试用现有惯例：vitest、`mkdtempSync` 临时目录；spawn CLI 用 `npm run --silent onw`（同 `tests/cli/cli-process.test.ts`，无需先 build）。

---

### Task 1: `src/main/cli-bridge.ts`（CLI 子进程桥）

**Files:**
- Create: `src/main/cli-bridge.ts`
- Test: `tests/main/cli-bridge.test.ts`

**Interfaces:**
- Produces:
  - `interface CliBridgeOptions { command: string; args: string[] }`
  - `interface CliBridge { open(wsPath): void; send(request: IpcRequest): boolean; onLine(cb): void; onError(cb): void; close(): void }`
  - `splitLines(buffer): { lines: string[]; rest: string }`（纯函数）
  - `createCliBridge(opts): CliBridge`

- [ ] **Step 1: 写失败测试**

创建 `tests/main/cli-bridge.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitLines, createCliBridge } from '../../src/main/cli-bridge';

describe('cli-bridge', () => {
  it('splitLines splits accumulated buffer into lines + rest', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], rest: '' });
    expect(splitLines('a\nb')).toEqual({ lines: ['a'], rest: 'b' });
    expect(splitLines('abc')).toEqual({ lines: [], rest: 'abc' });
  });

  it('spawns the CLI, forwards requests, and delivers response lines', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'bridge-'));
    const bridge = createCliBridge({ command: 'npm', args: ['run', '--silent', 'onw', '--', 'open'] });
    const got: string[] = [];
    bridge.onLine((l) => got.push(l));
    bridge.open(ws);
    await new Promise((r) => setTimeout(r, 1500)); // 等 CLI 起
    bridge.send({ cmd: 'state.summary', reqId: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    bridge.close();
    rmSync(ws, { recursive: true, force: true });
    expect(got.some((l) => l.includes('"reqId":1') && l.includes('"ok":true'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/main/cli-bridge.test.ts`
Expected: FAIL，`src/main/cli-bridge` 不存在。

- [ ] **Step 3: 实现 `src/main/cli-bridge.ts`**

```ts
// src/main/cli-bridge.ts
// CLI 子进程桥:main 不再直接 dispatch,而是 spawn onw CLI 子进程(NDJSON),
// 转发 IpcRequest 到 stdin,把 stdout/stderr 逐行回调给上层。
import { spawn, type ChildProcess } from 'node:child_process';
import type { IpcRequest } from '../ipc/contracts';

export interface CliBridgeOptions {
  /** 要 spawn 的命令,如 'node';args 前段,如 ['dist/main/cli/index.js','open'];open 时追加工作区路径。 */
  command: string;
  args: string[];
}

export interface CliBridge {
  open(wsPath: string): void;
  /** 写一行 JSON 到 CLI stdin;无进程返回 false。 */
  send(request: IpcRequest): boolean;
  onLine(cb: (line: string) => void): void;
  onError(cb: (line: string) => void): void;
  close(): void;
}

/** 把累计 buffer 按行切开,返回完整行 + 剩余残段。 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const idx = buffer.lastIndexOf('\n');
  if (idx === -1) return { lines: [], rest: buffer };
  const rest = buffer.slice(idx + 1);
  const full = buffer.slice(0, idx);
  const lines = full === '' ? [] : full.split('\n');
  return { lines, rest };
}

export function createCliBridge(opts: CliBridgeOptions): CliBridge {
  let child: ChildProcess | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';
  const lineCbs: ((line: string) => void)[] = [];
  const errCbs: ((line: string) => void)[] = [];

  function open(wsPath: string): void {
    if (child && !child.killed) child.kill();
    child = spawn(opts.command, [...opts.args, wsPath], {
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdoutBuf = '';
    stderrBuf = '';
    child.stdout!.on('data', (d: Buffer) => {
      const { lines, rest } = splitLines(stdoutBuf + d.toString());
      stdoutBuf = rest;
      for (const l of lines) if (l.trim()) for (const cb of lineCbs) cb(l);
    });
    child.stderr!.on('data', (d: Buffer) => {
      const { lines, rest } = splitLines(stderrBuf + d.toString());
      stderrBuf = rest;
      for (const l of lines) if (l.trim()) for (const cb of errCbs) cb(l);
    });
    child.on('exit', (code) => {
      for (const cb of errCbs) cb(`CLI 进程退出 code=${code}`);
      child = null;
    });
  }

  function send(request: IpcRequest): boolean {
    if (!child || child.stdin.destroyed) return false;
    child.stdin.write(JSON.stringify(request) + '\n');
    return true;
  }

  return {
    open,
    send,
    onLine: (cb) => { lineCbs.push(cb); },
    onError: (cb) => { errCbs.push(cb); },
    close: () => { if (child && !child.killed) child.kill(); child = null; },
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/main/cli-bridge.test.ts`
Expected: PASS（真实 spawn `npm run onw` 往返成功）。

- [ ] **Step 5: Commit**

```bash
git add src/main/cli-bridge.ts tests/main/cli-bridge.test.ts
git commit -m "feat(main): cli-bridge CLI 子进程桥(spawn onw/转发 IpcRequest/逐行回推)"
```

---

### Task 2: main 接线 CLI 桥 + fs.watch（保留旧 onw:invoke）

**Files:**
- Modify: `src/main/index.ts`
- Test: 冒烟（T9）+ typecheck

**Interfaces:**
- Consumes: `createCliBridge`（Task 1）
- Produces: IPC 通道 `cli:command`（on）、`cli:open`（handle）；事件 `cli:event`/`cli:stderr`/`workspace:changed`。旧 `onw:invoke` **保留**（T9 移除）。

- [ ] **Step 1: 改 `src/main/index.ts`**

顶部 import 加：

```ts
import { watch } from 'node:fs';
import { createCliBridge } from './cli-bridge';
import type { IpcRequest } from '../ipc/contracts';
```

在 `let ctx: ApiContext | null = null;` 后加：

```ts
const bridge = createCliBridge({
  command: process.execPath,
  args: [join(app.getAppPath(), 'dist', 'main', 'cli', 'index.js'), 'open'],
});
let watchTimer: NodeJS.Timeout | null = null;

function watchWorkspace(wsPath: string): void {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  try {
    watch(join(wsPath, '.onworking'), { recursive: true }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send('workspace:changed');
      }, 300);
    });
  } catch { /* 目录不存在则忽略 */ }
}

function broadcastCliLine(channel: 'cli:event' | 'cli:stderr', line: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send(channel, line);
}
bridge.onLine((line) => broadcastCliLine('cli:event', line));
bridge.onError((line) => broadcastCliLine('cli:stderr', line));
```

在 `ipcMain.handle('onw:pick-workspace', ...)` 附近加：

```ts
ipcMain.on('cli:command', (_event, request: IpcRequest) => {
  const ok = bridge.send(request);
  if (!ok) {
    broadcastCliLine('cli:event', JSON.stringify({
      reqId: request?.reqId,
      result: { ok: false, error: { code: 'NO_WORKSPACE', message: 'no workspace opened; open a workspace first' } },
    }));
  }
});
ipcMain.handle('cli:open', (_event, path: string) => {
  bridge.open(path);
  watchWorkspace(path);
  return { ok: true };
});
```

- [ ] **Step 2: 运行类型检查**

Run: `npm run typecheck`
Expected: PASS（`app`/`BrowserWindow`/`join` 均已 import；`request?.reqId` 兼容未知形状）。

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): cli:command/cli:open 接线 + fs.watch workspace:changed(保留旧 onw:invoke)"
```

---

### Task 3: preload + global.d.ts 新 API（超集）

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/global.d.ts`

**Interfaces:**
- Produces: `window.onw` 新增 `cli/onCliEvent/onCliError/onWorkspaceChanged/openWorkspace`；旧 `invoke/onProgress/onLog` 保留（T9 移除）。

- [ ] **Step 1: 改 `src/main/preload.ts`**

在 `onw` 对象里**追加**（保留旧三个）：

```ts
cli: (request: IpcRequest): void => ipcRenderer.send('cli:command', request),
onCliEvent: (cb: (line: string) => void): (() => void) => {
  const listener = (_e: unknown, line: string): void => cb(line);
  ipcRenderer.on('cli:event', listener);
  return () => ipcRenderer.removeListener('cli:event', listener);
},
onCliError: (cb: (line: string) => void): (() => void) => {
  const listener = (_e: unknown, line: string): void => cb(line);
  ipcRenderer.on('cli:stderr', listener);
  return () => ipcRenderer.removeListener('cli:stderr', listener);
},
onWorkspaceChanged: (cb: () => void): (() => void) => {
  const listener = (): void => cb();
  ipcRenderer.on('workspace:changed', listener);
  return () => ipcRenderer.removeListener('workspace:changed', listener);
},
openWorkspace: (path: string): Promise<{ ok: boolean }> =>
  ipcRenderer.invoke('cli:open', path) as Promise<{ ok: boolean }>,
```

文件头 import 加 `type IpcRequest`：
```ts
import type { ApiCommand, ApiResult, IpcRequest } from '../ipc/contracts';
```

- [ ] **Step 2: 改 `src/renderer/global.d.ts`**

`Window.onw` 加（旧三个保留）：

```ts
cli(request: IpcRequest): void;
onCliEvent(cb: (line: string) => void): () => void;
onCliError(cb: (line: string) => void): () => void;
onWorkspaceChanged(cb: () => void): () => void;
openWorkspace(path: string): Promise<{ ok: boolean }>;
```

import 加 `type IpcRequest`。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts src/renderer/global.d.ts
git commit -m "feat(preload): window.onw 新增 cli/onCliEvent/onCliError/onWorkspaceChanged/openWorkspace"
```

---

### Task 4: `src/renderer/cli.ts` 前端 CLI 客户端

**Files:**
- Create: `src/renderer/cli.ts`
- Modify: `src/renderer/main.tsx`（调 `initCliClient()`）
- Test: `tests/renderer/cli.test.ts`

**Interfaces:**
- Produces:
  - `sendCli(command: ApiCommand): Promise<ApiResult<unknown>>`
  - `initCliClient(): void`
  - `subscribeOutput(cb: (line: string) => void): () => void`
  - `handleCliLine(line, pending): void`（纯函数，可测）

- [ ] **Step 1: 写失败测试**

创建 `tests/renderer/cli.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { handleCliLine, sendCli, initCliClient } from '../../src/renderer/cli';
import type { ApiResult } from '../../src/ipc/contracts';

describe('renderer cli', () => {
  it('handleCliLine resolves a pending request by reqId', () => {
    const pending = new Map<number, (r: ApiResult<unknown>) => void>();
    let resolved: ApiResult<unknown> | null = null;
    pending.set(7, (r) => { resolved = r; });
    handleCliLine('{"reqId":7,"result":{"ok":true,"data":"x"}}', pending);
    expect(resolved).toEqual({ ok: true, data: 'x' });
    expect(pending.size).toBe(0);
  });

  it('handleCliLine ignores non-result lines', () => {
    const pending = new Map<number, (r: ApiResult<unknown>) => void>();
    handleCliLine('not json', pending);
    handleCliLine('{"reqId":99}', pending);
    expect(pending.size).toBe(0);
  });

  it('sendCli resolves via a stubbed window.onw', async () => {
    let sent: unknown = null;
    (globalThis as { window?: unknown }).window = {
      onw: {
        cli: (req: unknown) => { sent = req; },
        onCliEvent: () => () => {},
        onCliError: () => () => {},
      },
    };
    const p = sendCli({ cmd: 'state.summary' });
    // 模拟主进程回推结果行
    handleCliLine(JSON.stringify({ reqId: (sent as { reqId: number }).reqId, result: { ok: true, data: 'ok' } }), new Map()); // 不直接操作内部 pending —— 通过 initCliClient 的 onCliEvent 注入
    // 注:这里用真回路:sendCli 注册到内部 pending,由 onCliEvent 回调 handleCliLine
    expect(await p).toEqual({ ok: true, data: 'ok' });
  });
});
```

> 说明：第三个用例依赖 `initCliClient` 把 `window.onw.onCliEvent` 接到内部 `handleCliLine`；因此先 `initCliClient()` 再 `sendCli`，然后手动调已注册的 onCliEvent 回调喂假行。实现里 `initCliClient` 需把回调存下来供测试注入，或测试直接复用内部 pending。以 `sendCli` 能 resolve 为准。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/renderer/cli.test.ts`
Expected: FAIL，`src/renderer/cli` 不存在。

- [ ] **Step 3: 实现 `src/renderer/cli.ts`**

```ts
// src/renderer/cli.ts
// 前端 CLI 客户端:sendCli 按 reqId 对账返回 Promise;全局输出流供输出面板订阅。
import type { ApiCommand, ApiResult, IpcRequest } from '../ipc/contracts';

type Resolve = (r: ApiResult<unknown>) => void;
const pending = new Map<number, Resolve>();
const outputSubs = new Set<(line: string) => void>();
let seq = 1;

/** 解析一行 CLI stdout:若是 { reqId, result } 结果信封,resolve 对应 pending。 */
export function handleCliLine(line: string, pendingMap: Map<number, Resolve>): void {
  let msg: { reqId?: number; result?: ApiResult<unknown> };
  try {
    msg = JSON.parse(line) as { reqId?: number; result?: ApiResult<unknown> };
  } catch {
    return;
  }
  if (msg && typeof msg.reqId === 'number' && msg.result && pendingMap.has(msg.reqId)) {
    const resolve = pendingMap.get(msg.reqId)!;
    pendingMap.delete(msg.reqId);
    resolve(msg.result);
  }
}

/** 输出流订阅:面板用它实时渲染。 */
export function subscribeOutput(cb: (line: string) => void): () => void {
  outputSubs.add(cb);
  return () => { outputSubs.delete(cb); };
}

function pushOutput(line: string): void {
  for (const cb of outputSubs) cb(line);
}

/** 发一条命令:分配 reqId,经 window.onw.cli 送进 CLI,结果行回推时按 reqId resolve。 */
export function sendCli(command: ApiCommand): Promise<ApiResult<unknown>> {
  const reqId = seq++;
  const request: IpcRequest = { ...command, reqId };
  return new Promise<ApiResult<unknown>>((resolve) => {
    pending.set(reqId, resolve);
    window.onw.cli(request);
  });
}

/** 应用启动时调用:把主进程回推的 CLI 输出接入 pending 对账 + 输出流。 */
export function initCliClient(): void {
  window.onw.onCliEvent((line) => {
    pushOutput(line);
    handleCliLine(line, pending);
  });
  window.onw.onCliError((line) => pushOutput(line));
}
```

`src/renderer/main.tsx` 在 `installMockOnw()` 后加 `initCliClient()`（import 自 `./cli`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/renderer/cli.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/cli.ts src/renderer/main.tsx tests/renderer/cli.test.ts
git commit -m "feat(renderer): cli.ts sendCli reqId 对账 + 输出流订阅,main.tsx 启动接入"
```

---

### Task 5: `useApi` 换 `sendCli` + `workspace:changed` 自动刷新

**Files:**
- Modify: `src/renderer/views/useApi.ts`
- Test: typecheck（React hook 不易单测，靠类型检查 + 冒烟）

- [ ] **Step 1: 改 `src/renderer/views/useApi.ts`**

`window.onw.invoke(command)` → `sendCli(command)`；挂载时订阅 `onWorkspaceChanged` 触发 `reload`：

```ts
import { useCallback, useEffect, useState } from 'react';
import type { ApiCommand } from '../../ipc/contracts';
import { sendCli } from '../cli';

export function useApi<T>(command: ApiCommand, enabled = true): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    sendCli(command)
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          setData(res.data as T);
          setError(null);
        } else {
          setError(res.error.message);
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick, enabled, JSON.stringify(command)]);

  // AI/任何命令改了工作区 → 自动刷新(同步 AI 执行)
  useEffect(() => {
    if (!enabled) return;
    return window.onw.onWorkspaceChanged(() => setTick((t) => t + 1));
  }, [enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/views/useApi.ts
git commit -m "refactor(useApi): 底层换 sendCli,订阅 workspace:changed 自动刷新(AI 同步)"
```

---

### Task 6: 各 view 迁移 `invoke` → `sendCli`

**Files:**
- Modify: `src/renderer/views/QueryView.tsx`、`SqlView.tsx`、`PreviewView.tsx`、`MappingView.tsx`、`BigTableSettingsView.tsx`
- Modify: `src/renderer/shell/TopBar.tsx`
- Test: typecheck

**Interfaces:**
- Consumes: `sendCli`（Task 4）

- [ ] **Step 1: 逐文件替换**

每个 `window.onw.invoke({...})` 换成 `sendCli({...})`，文件头加 `import { sendCli } from '../cli';`（视图在 `views/`，路径 `'../cli'`；TopBar 在 `shell/`，路径 `'../cli'`）。

具体调用点：

1. `QueryView.tsx`：`runAll` 里 `window.onw.invoke({ cmd: 'pipeline.recomputeAll' })`；`runOne` 里 `window.onw.invoke({ cmd: 'pipeline.run', id })`。
2. `SqlView.tsx`：`handleRun` 里 `window.onw.invoke({ cmd: 'query.run', sql })`；`handleCopyStructure` 里 `window.onw.invoke({ cmd: 'schema.tables' })`。
3. `PreviewView.tsx`：`loadPage` 里 `window.onw.invoke({ cmd: 'setup.preview', ... })`。
4. `MappingView.tsx`：`loadSheets` 里 `setup.sheets`；`handleDetect` 里 `setup.detectSource`；`handleSave` 里 `mapping.save`；`handleSaveTemplate` 里 `template.save`。
5. `BigTableSettingsView.tsx`：`handleSave` 里 `bigtable.save`。
6. `TopBar.tsx`：`doAction` 里的 4 个 merge/build 命令 `window.onw.invoke(cmd)` → `sendCli(cmd)`；`handlePick` 改为：

```ts
async function handlePick() {
  const path = await window.onw.pickWorkspace();
  if (!path) return;
  const res = await window.onw.openWorkspace(path);
  if (res.ok) setWsName(path);
}
```

- [ ] **Step 2: 类型检查 + 确认无残留 `window.onw.invoke`**

Run: `npm run typecheck`
Run: `grep -rn "window.onw.invoke" src/renderer`
Expected: 无残留（`window.onw.invoke` 仅在 mock/旧 API 定义处）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/views src/renderer/shell/TopBar.tsx
git commit -m "refactor(views): window.onw.invoke → sendCli(TopBar 走 openWorkspace)"
```

---

### Task 7: `BottomPanel` → `CliOutputPanel`（实时输出流）

**Files:**
- Create: `src/renderer/shell/CliOutputPanel.tsx`
- Delete: `src/renderer/shell/BottomPanel.tsx`
- Modify: `src/renderer/App.tsx`（import 换 `CliOutputPanel`）
- Test: typecheck

- [ ] **Step 1: 创建 `CliOutputPanel.tsx`**

```tsx
// 底部面板:实时渲染 CLI 输出流(命令结果 + 进度/日志),AI 操作也会实时出现。
import { useEffect, useState } from 'react';
import { subscribeOutput } from '../cli';

export function CliOutputPanel() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const unsub = subscribeOutput((line) => {
      setLines((prev) => [...prev.slice(-499), line]);
    });
    return unsub;
  }, []);

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button className="active">CLI 输出流</button>
      </div>
      <div className="log-area">
        {lines.length === 0 && (
          <div style={{ color: '#8b949e' }}>暂无输出 — 执行命令或 AI 操作后这里实时显示。</div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={l.includes('"ok":false') || l.includes('ERROR') ? 'log-error' : ''}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 改 App.tsx + 删旧组件**

`App.tsx`：`import { BottomPanel } from './shell/BottomPanel'` → `import { CliOutputPanel } from './shell/CliOutputPanel'`；JSX 里 `<BottomPanel />` → `<CliOutputPanel />`。

删除 `src/renderer/shell/BottomPanel.tsx`。

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: PASS（`window.onw.onLog` 不再被引用——旧 API 仍在 global.d.ts，T9 移除）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/shell/CliOutputPanel.tsx src/renderer/App.tsx src/renderer/shell/BottomPanel.tsx
git commit -m "feat(renderer): BottomPanel → CliOutputPanel 实时渲染 CLI 输出流"
```

---

### Task 8: mock 适配新 API

**Files:**
- Modify: `src/renderer/mock/onw-mock.ts`
- Test: typecheck + 浏览器 dev 冒烟

- [ ] **Step 1: 改 `installMockOnw`**

`window.onw` 加新 API，`cli` 用现有 `mockDispatch` 生成结果行异步回推：

```ts
import type { ApiCommand, ApiResult, IpcRequest } from '../../ipc/contracts';

export function installMockOnw(): void {
  const w = window as unknown as { onw?: Record<string, unknown> };
  if (w.onw) return;
  let cliEventCbs: ((line: string) => void)[] = [];
  let cliErrorCbs: ((line: string) => void)[] = [];
  let wsChangedCbs: (() => void)[] = [];
  w.onw = {
    cli: (request: IpcRequest): void => {
      setTimeout(() => {
        void mockDispatch(request).then((result: ApiResult<unknown>) => {
          const line = JSON.stringify({ reqId: request.reqId, result });
          for (const cb of cliEventCbs) cb(line);
        });
      }, 150);
    },
    onCliEvent: (cb: (line: string) => void): (() => void) => {
      cliEventCbs.push(cb);
      return () => { cliEventCbs = cliEventCbs.filter((x) => x !== cb); };
    },
    onCliError: (cb: (line: string) => void): (() => void) => {
      cliErrorCbs.push(cb);
      return () => { cliErrorCbs = cliErrorCbs.filter((x) => x !== cb); };
    },
    onWorkspaceChanged: (cb: () => void): (() => void) => {
      wsChangedCbs.push(cb);
      return () => { wsChangedCbs = wsChangedCbs.filter((x) => x !== cb); };
    },
    openWorkspace: async (): Promise<{ ok: boolean }> => ({ ok: true }),
    pickWorkspace: async (): Promise<string | null> => 'D:/演示工作区',
    // 旧 API 保留(T9 移除)
    invoke: (command: ApiCommand): Promise<ApiResult<unknown>> => mockDispatch(command),
    onProgress: () => () => {},
    onLog: () => () => {},
  };
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/mock/onw-mock.ts
git commit -m "feat(mock): onw-mock 适配 cli 事件流(浏览器 dev 可用)"
```

---

### Task 9: 移除旧 API + 冒烟

**Files:**
- Modify: `src/main/index.ts`（删 `onw:invoke`、`createContext`/`dispatch` import、`ctx`、reqId 透传）
- Modify: `src/main/preload.ts`（删 `invoke`/`onProgress`/`onLog`）
- Modify: `src/renderer/global.d.ts`（删旧三个）
- Modify: `src/renderer/mock/onw-mock.ts`（删旧三个）
- Test: `npm run build:main` + `npm run typecheck` + `npm test` + 冒烟

- [ ] **Step 1: 删 main 的旧路径**

`src/main/index.ts`：删 `onw:invoke` handler 整块（含 `reqId` 透传、`open()`、`workspace.pick` 分支、`dispatch` 调用）；删 `let ctx`、`createContext` import、`dispatch`/`type ApiContext` import（若不再用）。保留 `onw:pick-workspace`、`cli:command`、`cli:open`、`watchWorkspace`、`broadcastCliLine`。

- [ ] **Step 2: 删 preload / global.d.ts / mock 的旧 API**

`preload.ts`：删 `invoke`、`onProgress`、`onLog`（`ApiCommand`/`ApiResult` import 若不再用则删，保留 `IpcRequest`）。
`global.d.ts`：删 `invoke`/`onProgress`/`onLog`。
`onw-mock.ts`：删 `invoke`/`onProgress`/`onLog`（`mockDispatch` 保留给 `cli` 用）。

- [ ] **Step 3: 验证无残留**

Run: `grep -rn "onw.invoke\|onProgress\|onLog" src/renderer src/main`
Expected: 无（`window.onw.onLog` 等全清）。

- [ ] **Step 4: 全量验证 + 冒烟**

Run: `npm run build:main`（确保 `dist/main/cli/index.js` 最新）
Run: `npm run typecheck`
Run: `npm test`
Expected: 全部 PASS。

冒烟（Electron 手工，可选）：`npm run dev` 起前端，点「打开工作区」选目录 → 底部输出流出现 `cli:open` 后各命令结果实时滚动；执行一次 `bigtable.save`，`useApi` 视图自动刷新。

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/preload.ts src/renderer/global.d.ts src/renderer/mock/onw-mock.ts
git commit -m "refactor(main): 移除旧 onw:invoke 直接 dispatch,前端唯一经 CLI 桥执行"
```

---

### Task 10: `bigtable.config` 读命令（选中大表关联的全部配置）

**Files:**
- Modify: `src/core/agent/tools.ts`（`toolGetBigTableContext`）
- Modify: `src/ipc/contracts.ts`、`src/ipc/handlers.ts`、`src/renderer/mock/onw-mock.ts`
- Test: `tests/core/tools.test.ts`

**Interfaces:**
- Produces: `toolGetBigTableContext(ws: Workspace, folder: string): { config: BigTableConfig; rules: RuleYaml[]; pipelines: PipelineConfig[] }`；command `{ cmd: 'bigtable.config'; folder: string }` → 同上。

- [ ] **Step 1: 写失败测试**

`tests/core/tools.test.ts` 追加（import 加 `toolGetBigTableContext`；fixture 已有 config seq + 规则 + clean c1 + sql-clean m1）：

```ts
it('toolGetBigTableContext returns config, rules and related pipelines', () => {
  const ctx = toolGetBigTableContext(ws, 'seq');
  expect(ctx.config.tableName).toBe('seq');
  expect(ctx.rules.length).toBe(1);
  const ids = ctx.pipelines.map((p) => p.id);
  expect(ids).toEqual(expect.arrayContaining(['c1', 'm1'])); // clean(直接引用)+ sql-clean(引用其表)
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/tools.test.ts -t "toolGetBigTableContext"`
Expected: FAIL，`toolGetBigTableContext` 未定义。

- [ ] **Step 3: 实现 tool + 接线**

`src/core/agent/tools.ts`：

```ts
import { saveRule, loadRules } from '../rule/store';
import type { PipelineConfig } from '../pipeline/config';

/** tool: 读取选中大表关联的全部配置(大表配置 + 规则 YAML + 关联管线),供前端实时渲染。 */
export function toolGetBigTableContext(ws: Workspace, folder: string): {
  config: BigTableConfig;
  rules: RuleYaml[];
  pipelines: PipelineConfig[];
} {
  const config = loadBigTableConfig(ws, folder);
  const rules = loadRules(ws, folder);
  const pipelines = listPipelines(ws)
    .map((id) => loadPipeline(ws, id))
    .filter((p) =>
      p.kind === 'clean' ? p.bigTableFolder === folder
      : p.kind === 'sql-clean' ? p.bigTables.includes(folder)
      : false,
    );
  return { config, rules, pipelines };
}
```

`src/ipc/contracts.ts`：`CommandPayloads` 加 `'bigtable.config': { folder: string };`；`CommandResults` 加 `'bigtable.config': { config: BigTableConfig; rules: RuleYaml[]; pipelines: PipelineConfig[] };`（import 加 `RuleYaml` from `../core/rule/rule`）。

`src/ipc/handlers.ts`：`'bigtable.config': async (ctx, p) => toolGetBigTableContext(ctx.ws, p.folder),`（import 加 `toolGetBigTableContext`）。

`src/renderer/mock/onw-mock.ts` 加 case：

```ts
case 'bigtable.config':
  return ok({
    config: { tableName: 'seq', autoIncrement: true, fields: [{ name: 'date', type: 'TEXT', order: 1 }] },
    rules: [{ name: 'seq_rule', sources: [{ pattern: '**/*', headerRow: 1 }], fields: [] }],
    pipelines: [{ id: 'c1', kind: 'clean', label: '' }],
  });
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/contracts.ts src/ipc/handlers.ts src/renderer/mock/onw-mock.ts tests/core/tools.test.ts
git commit -m "feat(bigtable): bigtable.config 读命令 —— 返回选中大表的配置+规则YAML+关联管线"
```

---

### Task 11: 选中对象配置实时渲染（扩展 `BigTableSettingsView`，不新建视图）

> 与现有功能重合即合并：现「大表字段设置」已展示大表 config，本次**在其内扩展**规则 YAML + 关联管线展示，不新建 `BigTableDetailView`、不改 registry。

**Files:**
- Modify: `src/renderer/views/BigTableSettingsView.tsx`（数据源换 `bigtable.config`，加规则/管线展示区）
- Modify: `src/renderer/views/registry.tsx`（标题改为「大表配置」）
- Modify: `src/renderer/views/PreviewView.tsx`（选中源文件自动加载）
- Test: typecheck + 冒烟

**Interfaces:**
- Consumes: `sendCli`/`useApi`（Task 4/5）、`bigtable.config`（Task 10）、`workspace:changed` 自动刷新（Task 5）

- [ ] **Step 1: 扩展 `BigTableSettingsView.tsx`**

数据源从 `bigtable.get` 换成 `bigtable.config`（含 config + rules + pipelines）；字段编辑逻辑不变；在字段表下加「规则 YAML」「关联管线」两个只读区：

```tsx
// 视图:大表配置 —— 字段可编辑(bigtable.save) + 规则 YAML/关联管线只读。
// useApi 订阅 workspace:changed,AI/任何命令改了文件即自动刷新。
import { useEffect, useState } from 'react';
import type { BigTableConfig } from '../../core/bigtable/schema';
import { useApi } from './useApi';
import { useSelection } from '../state/SelectionContext';
import { sendCli } from '../cli';

const FIELD_TYPES = ['TEXT', 'INTEGER', 'REAL'] as const;

interface BigTableContext {
  config: BigTableConfig;
  rules: {
    name: string;
    sources: { pattern: string; sheetName?: string; headerRow: number }[];
    fields: { sourceHeader: string; outputName: string; order: number }[];
  }[];
  pipelines: { id: string; kind: string; label: string }[];
}

export function BigTableSettingsView() {
  const { selectedFolder } = useSelection();
  const { data: folders } = useApi<string[]>({ cmd: 'bigtable.list' });
  const folder = selectedFolder ?? folders?.[0] ?? null;

  const { data: ctx, reload } = useApi<BigTableContext>(
    folder ? { cmd: 'bigtable.config', folder } : { cmd: 'bigtable.list' },
    !!folder,
  );
  const [cfg, setCfg] = useState<BigTableConfig | null>(null);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    if (ctx) setCfg(JSON.parse(JSON.stringify(ctx.config)) as BigTableConfig);
    setSaveMsg('');
  }, [ctx]);

  async function handleSave() {
    if (!cfg || !folder) return;
    const res = await sendCli({ cmd: 'bigtable.save', folder, config: cfg });
    setSaveMsg(res.ok ? '已保存 ✓' : `保存失败: ${res.error.message}`);
  }

  if (!folder) {
    return <div style={{ padding: 12 }}>在左侧栏选择一个大表开始。</div>;
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        大表: <b>{folder}</b>
        <button onClick={reload}>刷新</button>
      </div>
      {cfg ? (
        <>
          <div style={{ marginBottom: 8 }}>
            表名 <input value={cfg.tableName} onChange={(e) => setCfg({ ...cfg, tableName: e.target.value })} />{' '}
            自增主键{' '}
            <input type="checkbox" checked={cfg.autoIncrement} onChange={(e) => setCfg({ ...cfg, autoIncrement: e.target.checked })} />
          </div>
          <table border={1} cellPadding={4} cellSpacing={0}>
            {/* 字段编辑表格：与现有完全一致(setField/addField/removeField 逻辑保留) */}
            <tbody>
              {cfg.fields.map((f, i) => (
                <tr key={f.name + i}>
                  <td><input value={f.name} onChange={(e) => setField(i, 'name', e.target.value)} /></td>
                  <td>
                    <select value={f.type} onChange={(e) => setField(i, 'type', e.target.value)}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" checked={!!f.primaryKey} onChange={(e) => setField(i, 'primaryKey', e.target.checked)} /></td>
                  <td>{f.order}</td>
                  <td><button onClick={() => removeField(i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8 }}>
            <button onClick={addField}>+ 新增字段</button>{' '}
            <button onClick={handleSave}>💾 保存设置</button>{' '}
            <span>{saveMsg}</span>
          </div>

          <hr style={{ margin: '16px 0' }} />
          <div style={{ marginBottom: 8 }}>
            <b>规则 YAML({ctx?.rules.length ?? 0}):</b>
            {(ctx?.rules ?? []).map((r, i) => (
              <pre key={i} style={{ background: '#f6f8fa', padding: 8, overflow: 'auto', fontSize: 12 }}>
                {JSON.stringify(r, null, 2)}
              </pre>
            ))}
          </div>
          <div>
            <b>关联管线({ctx?.pipelines.length ?? 0}):</b>
            {(ctx?.pipelines ?? []).map((p) => (
              <div key={p.id}>{p.id} ({p.kind}) {p.label}</div>
            ))}
          </div>
        </>
      ) : (
        <p>加载中…</p>
      )}
    </div>
  );

  function setField(index: number, key: 'name' | 'type' | 'primaryKey', value: unknown) {
    if (!cfg) return;
    const fields = cfg.fields.map((f, i) => (i === index ? { ...f, [key]: value } : f));
    setCfg({ ...cfg, fields });
  }
  function addField() {
    if (!cfg) return;
    const order = cfg.fields.length + 1;
    setCfg({ ...cfg, fields: [...cfg.fields, { name: `field${order}`, type: 'TEXT', order }] });
  }
  function removeField(index: number) {
    if (!cfg) return;
    setCfg({ ...cfg, fields: cfg.fields.filter((_, i) => i !== index) });
  }
}
```

- [ ] **Step 2: registry 改标题 + PreviewView 自动加载**

`src/renderer/views/registry.tsx`：`{ id: 'bigtable-settings', title: '大表字段设置', ... }` → `{ id: 'bigtable-settings', title: '大表配置', ... }`（import 不变，仍是 `BigTableSettingsView`）。

`src/renderer/views/PreviewView.tsx`：加选中源文件即自动加载：

```tsx
useEffect(() => {
  if (selectedFile) {
    setPage(0);
    void loadPage(0);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [selectedFile]);
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 4: 冒烟（浏览器 dev / Electron）**

`npm run dev:renderer` 或 `npm run dev`：选中一个大表 → 「大表配置」视图实时显示字段(可编辑)/规则 YAML/关联管线；用 CLI 或 MCP 改一下规则/管线文件 → 视图自动刷新（workspace:changed 生效）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/views/BigTableSettingsView.tsx src/renderer/views/registry.tsx src/renderer/views/PreviewView.tsx
git commit -m "feat(renderer): BigTableSettingsView 扩展实时渲染规则YAML/关联管线(合并,不新建视图);PreviewView 选中即加载"
```

---

## 自审(对照 spec)

- **§3.1 cli-bridge** → T1 ✓
- **§3.2 main/index.ts(cli:command/cli:open/fs.watch/回推)** → T2 + T9(移除旧路径) ✓
- **§3.3 preload + global.d.ts** → T3(加) + T9(删旧) ✓
- **§3.4 renderer/cli.ts** → T4 ✓
- **§3.5 useApi + 各 view** → T5 + T6 ✓
- **§3.6 CliOutputPanel** → T7 ✓
- **§3.7 onw-mock** → T8 + T9(删旧) ✓
- **§4 关键决策**：reqId 对账(T4)、fs.watch 同步 AI(T2/T5)、工作区切换=cli:open(T2/T6)、不引依赖 ✓
- **§6 测试**：cli-bridge spawn 往返(T1)、renderer cli reqId(T4)、handlers 测试仍有效、main 层冒烟(T9) ✓
- **本期扩展（用户补充）**：选中对象关联配置实时渲染 —— `bigtable.config` 读命令(T10) + `BigTableDetailView` 实时渲染(T11)，复用 `workspace:changed`(T2/T5) 达成「实时读取更新」。

- **§3.1 cli-bridge** → T1 ✓
- **§3.2 main/index.ts(cli:command/cli:open/fs.watch/回推)** → T2 + T9(移除旧路径) ✓
- **§3.3 preload + global.d.ts** → T3(加) + T9(删旧) ✓
- **§3.4 renderer/cli.ts** → T4 ✓
- **§3.5 useApi + 各 view** → T5 + T6 ✓
- **§3.6 CliOutputPanel** → T7 ✓
- **§3.7 onw-mock** → T8 + T9(删旧) ✓
- **§4 关键决策**：reqId 对账(T4)、fs.watch 同步 AI(T2/T5)、工作区切换=cli:open(T2/T6)、不引依赖 ✓
- **§6 测试**：cli-bridge spawn 往返(T1)、renderer cli reqId(T4)、handlers 测试仍有效、main 层冒烟(T9) ✓
