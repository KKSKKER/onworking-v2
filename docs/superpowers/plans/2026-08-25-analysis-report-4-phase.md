# Onworking V2 Analysis-Report 四阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/analysis-report.md` §7 的顺序把 4 个阶段全部落地：收契约 → 抽 context + CLI → 删冗余 → 补缺口（含 MCP），使「一切操作都是 API」真正成立并跑通 NDJSON 调试闭环。

**Architecture:** 保持「命令总线」架构不变：`ApiCommand`（联合类型）→ `dispatch` → `ApiResult`。本计划把契约收紧为强类型映射表，抽出与 Electron 无关的 `createContext`，新增 NDJSON 命令行前端（CLI）与 MCP stdio 前端，删除合并 3 个执行器 / 4 个批量工具 / cfg 映射双轨，补齐 #13 预览、#9 存模板 tool、#8 多映射追加。

**Tech Stack:** TypeScript strict、vitest、better-sqlite3、js-yaml、tsx（脚本运行）。MCP 用自实现的 JSON-RPC 2.0 stdio 子集（不新增依赖）。

**Spec:** [docs/analysis-report.md](../../analysis-report.md)（4 阶段在 §7，接口清单 §2，缺口 §3，冗余 §4，契约问题 §5，CLI 架构 §6）

## Global Constraints

- **强类型契约**：`src/ipc/contracts.ts` 的 `CommandPayloads`/`CommandResults` 两张映射表是唯一事实来源；`ApiCommand` 由它派生为带类型载荷的联合类型；handlers 表按 `CommandResults[K]` 强类型（handler 内部零 `as never`/`String()`）。`dispatch` 统一收 `ApiCommand`、返回 `ApiResult<unknown>`（CLI/MCP/渲染层都以 JSON 消费结果，类型约束在 handler 层闭环）。禁止新增 `unknown[]`/`as never` 载荷。
- **显式 id**：所有 pipeline id 由调用方显式传入，代码里禁止 `Date.now()` 生成 id（`flow.ts` 的 `m_${Date.now()}`、`toolCreateCleaningPipeline` 的 `c_${Date.now()}` 都要移除）。
- **规则 YAML 是 clean 管线的唯一事实来源**：`CleanPipelineConfig` 不再携带 `headerRow`/`mappings`；源→大表映射一律走 `rules/*.yaml`（`mapping.save` 写入）。
- **CLI/Electron/MCP 共享同一 `dispatch`**：`workspace.open` 是传输层引导命令（建 ctx），不进 handlers 表；其余所有命令都进 handlers 表。CLI 与 Electron 用 `dispatchIpc`（带 `reqId` 对账）返回信封。
- **不新增运行时依赖**：MCP 为自实现 JSON-RPC 2.0 stdio 子集。
- 每任务以可运行测试 / `npm run typecheck` 收尾并提交；测试走 vitest，用 `mkdtempSync` + `initWorkspace` 造临时工作区，用 `XLSX.utils.aoa_to_sheet` 造源文件（见现有测试惯例）。
- 提交信息用现有风格（`feat:`/`fix:`/`refactor:` + 中文说明）。

---

## Part A — 收契约

### Task 1: 强类型 `ApiCommand` / `ApiResult`

**Files:**
- Modify: `src/ipc/contracts.ts`（整文件重写类型部分）
- Modify: `src/ipc/handlers.ts`（handler 表改映射类型，去掉 `as never`/`String()` 强转）
- Test: 复用 `tests/ipc/handlers.test.ts`（不变应通过）+ `npm run typecheck`

**Interfaces:**
- Produces: `CommandPayloads`（命令→载荷）、`CommandResults`（命令→结果）、`ApiCommand`（联合）、`IpcRequest`/`IpcResponse`（保持原有）。

- [ ] **Step 1: 重写 `src/ipc/contracts.ts` 为映射表**

把 `ApiCommand` 的联合类型替换为两张映射表派生的联合类型。替换文件第 13-40 行区间：

```ts
// src/ipc/contracts.ts
// API 契约:渲染层经 window.onw.invoke 发出的命令 + 统一返回。
// 原则:一切操作都是 API —— UI / 插件 / AI 走同一个入口(设计 §2.3)。
import type { BigTableConfig } from '../core/bigtable/schema';
import type { PipelineConfig } from '../core/pipeline/config';
import type { MappingTemplate } from '../core/template/store';
import type { ParsedSheet } from '../core/ingest/parser';
import type { FieldMapping } from '../core/etl/transform';
import type { Workspace } from '../core/workspace/workspace';
import type { RunSummary, QueryOutcome } from '../core/pipeline/engine';
import type { SourceConfig } from '../core/pipeline/setup';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** 命令名 → 载荷。这是契约的唯一事实来源。 */
export interface CommandPayloads {
  'workspace.open': { path: string };
  'bigtable.list': Record<string, never>;
  'bigtable.get': { folder: string };
  'bigtable.save': { folder: string; config: BigTableConfig };
  'bigtable.sourceFiles': { folder: string };
  'mapping.save': { folder: string; headerRow?: number; mappings: FieldMapping[] };
  'pipeline.list': Record<string, never>;
  'pipeline.save': { config: PipelineConfig };
  'pipeline.delete': { id: string };
  'pipeline.run': { id: string };
  'pipeline.mergeBigTable': { folder: string };
  'pipeline.mergeAll': Record<string, never>;
  'pipeline.buildMasterBigTable': { folder: string };
  'pipeline.buildMasterAll': Record<string, never>;
  'pipeline.recomputeAll': Record<string, never>;
  'pipeline.recomputeByDependency': { trigger: string };
  'setup.detectSource': { filePath: string; sheetName?: string };
  'setup.sheets': { filePath: string };
  'setup.preview': { filePath: string; sheetName?: string; headerRow?: number; offset?: number; limit?: number };
  'query.run': { sql: string; limit?: number };
  'template.list': Record<string, never>;
  'template.save': { template: MappingTemplate };
  'template.apply': { name: string; sheet: ParsedSheet };
  'schema.tables': Record<string, never>;
  'state.summary': Record<string, never>;
  'vcs.status': Record<string, never>;
}

/** 命令名 → 成功结果类型。 */
export interface CommandResults {
  'workspace.open': Workspace;
  'bigtable.list': string[];
  'bigtable.get': BigTableConfig;
  'bigtable.save': { saved: string };
  'bigtable.sourceFiles': string[];
  'mapping.save': { ruleFile: string };
  'pipeline.list': string[];
  'pipeline.save': { pipelineId: string };
  'pipeline.delete': { deleted: string };
  'pipeline.run': RunSummary;
  'pipeline.mergeBigTable': RunSummary[];
  'pipeline.mergeAll': RunSummary[];
  'pipeline.buildMasterBigTable': RunSummary[];
  'pipeline.buildMasterAll': RunSummary[];
  'pipeline.recomputeAll': RunSummary[];
  'pipeline.recomputeByDependency': RunSummary[];
  'setup.detectSource': SourceConfig;
  'setup.sheets': string[];
  'setup.preview': { sheetName: string; headerRow: number; headers: string[]; rows: unknown[][]; total: number };
  'query.run': QueryOutcome;
  'template.list': string[];
  'template.save': { saved: string };
  'template.apply': { mappings: FieldMapping[]; matched: number; skipped: string[] };
  'schema.tables': { name: string }[];
  'state.summary': string;
  'vcs.status': { staged: string[]; unstaged: string[]; untracked: string[] };
}

export type ApiCommand = {
  [K in keyof CommandPayloads]: { cmd: K } & CommandPayloads[K];
}[keyof CommandPayloads];

/** IPC 消息信封:请求带 reqId,响应带对应 reqId。 */
export type IpcRequest = ApiCommand & { reqId: number };

export type IpcResponse =
  | { reqId: number; result: ApiResult<unknown> }
  | { reqId: number; event: 'progress' | 'log'; payload: unknown };
```

- [ ] **Step 2: 把 handlers 表改成映射类型并去掉强转**

`src/ipc/handlers.ts` 改 3 处：

1. 把文件顶部的 `type Payload`/`type Handler`/`const handlers: Record<string, Handler>` 替换为：

```ts
type HandlerFor<K extends keyof CommandPayloads> = (
  ctx: ApiContext,
  payload: CommandPayloads[K],
) => Promise<CommandResults[K]> | CommandResults[K];

/** 会话命令(排除传输层引导命令 workspace.open)。 */
type SessionCommands = Exclude<keyof CommandPayloads, 'workspace.open'>;

const handlers: { [K in SessionCommands]: HandlerFor<K> } = {
  // ... 各 handler 保持原有逻辑,但删掉 String()/as never 强转,
  //     载荷字段已由 K 收窄,直接 p.folder / p.id 等。
};
```

2. 逐条清理强转（payload 已被 `CommandPayloads[K]` 收窄，以下 22 个 handler 全部简化，禁止再留 `String()`/`Number()`/`as never`）：

```ts
const handlers: { [K in SessionCommands]: HandlerFor<K> } = {
  'bigtable.list': async (ctx) => listBigTables(ctx.ws),
  'bigtable.get': async (ctx, p) => loadBigTableConfig(ctx.ws, p.folder),
  'bigtable.save': async (ctx, p) => {
    toolCreateBigTable(ctx.ws, p.folder, p.config);
    return { saved: p.folder };
  },
  'bigtable.sourceFiles': async (ctx, p) => {
    const dir = join(ctx.ws.onworkingDir, 'bigtables', p.folder, 'source');
    return existsSync(dir) ? scanSourceDir(dir).map((f) => f.path) : [];
  },

  'pipeline.list': async (ctx) => listPipelines(ctx.ws),
  'pipeline.save': async (ctx, p) => {
    const config = p.config;
    if (config.kind === 'query') {
      return toolCreateQueryPipeline(ctx.ws, config.id, {
        sql: config.sql,
        dependencies: config.dependencies,
        resultTable: config.resultTable,
      });
    }
    if (config.kind === 'sql-clean') {
      return toolCreateSqlCleanPipeline(ctx.ws, config.id, {
        bigTables: config.bigTables,
        sql: config.sql,
        resultTable: config.resultTable,
      });
    }
    return toolCreateCleaningPipeline(ctx.ws, config.id, config.bigTableFolder, config.sourceDir);
  },
  'mapping.save': async (ctx, p) => toolSetMapping(ctx.ws, p.folder, p.headerRow ?? 1, p.mappings),
  'pipeline.delete': async (ctx, p) => {
    deletePipeline(ctx.ws, p.id);
    return { deleted: p.id };
  },
  'pipeline.run': async (ctx, p) => toolRunCleaning(ctx.ws, p.id),
  'pipeline.mergeBigTable': async (ctx, p) => toolMergeBigTable(ctx.ws, p.folder),
  'pipeline.mergeAll': async (ctx) => toolMergeAll(ctx.ws),
  'pipeline.buildMasterBigTable': async (ctx, p) => toolBuildMasterForBigTable(ctx.ws, p.folder),
  'pipeline.buildMasterAll': async (ctx) => toolBuildMasterAll(ctx.ws),
  'pipeline.recomputeAll': async (ctx) => ctx.getEngine().recomputeAll(),
  'pipeline.recomputeByDependency': async (ctx, p) => ctx.getEngine().recomputeByDependency(p.trigger),

  'setup.detectSource': async (_ctx, p) => toolGetFileHeaders(p.filePath).detected,
  'setup.sheets': async (_ctx, p) => {
    const sheets = p.filePath.toLowerCase().endsWith('.csv')
      ? parseCsvFile(p.filePath)
      : parseExcelFile(p.filePath);
    return sheets.map((s) => s.sheetName);
  },
  'setup.preview': async (_ctx, p) => {
    const offset = p.offset ?? 0;
    const limit = p.limit ?? 100;
    const sheets = p.filePath.toLowerCase().endsWith('.csv')
      ? parseCsvFile(p.filePath)
      : parseExcelFile(p.filePath);
    const sheet = (p.sheetName ? sheets.find((s) => s.sheetName === p.sheetName) : undefined) ?? sheets[0];
    const headerRow = p.headerRow ?? 1;
    const full = [sheet.headers, ...sheet.rows];
    const headers = (full[headerRow - 1] ?? []).map((c) => String(c));
    const rows = full.slice(headerRow).slice(offset, offset + limit);
    return { sheetName: sheet.sheetName, headerRow, headers, rows, total: full.length - headerRow };
  },

  'template.list': async (ctx) => listTemplates(ctx.ws),
  'template.save': async (ctx, p) => {
    saveTemplate(ctx.ws, p.template);
    return { saved: p.template.name };
  },
  'template.apply': async (ctx, p) => applyTemplateToSheet(p.sheet, loadTemplate(ctx.ws, p.name)),

  'schema.tables': async (ctx) => ctx.getEngine().schemaTables(),

  'query.run': async (ctx, p) => {
    const sql = p.sql.trim();
    if (!/^(SELECT|WITH)\b/i.test(sql)) {
      throw new AppError({
        module: 'query',
        code: 'QUERY_NOT_SELECT',
        message: 'only SELECT/WITH queries are allowed in the workbench',
        data: { sql },
      });
    }
    return toolQuery(ctx.ws, sql);
  },

  'state.summary': async (ctx) => toolGetProjectState(ctx.ws),

  'vcs.status': async (ctx) => {
    ensureWorkspaceVcs(ctx.ws);
    return gitStatus(ctx.ws);
  },
};
```

> 说明：`'pipeline.run'` 目前仍调 `toolRunCleaning`（T7 会把它换成 `toolRunPipeline`）；`'mapping.save'` 仍缺 `ruleName` 透传（T13 加）。这两处按各自任务补齐，不要在本任务顺手改。

3. 把 `dispatch` 改为收联合 `ApiCommand`（`workspace.open` 在传输层引导、不进 dispatch）：

```ts
/** 分发命令;统一捕获错误为 { ok:false }。返回 ApiResult<unknown>:结果形状由 CommandResults 定义,CLI/MCP/渲染层以 JSON 消费。 */
export async function dispatch(command: ApiCommand, ctx: ApiContext): Promise<ApiResult<unknown>> {
  if (command.cmd === 'workspace.open') {
    // workspace.open 由传输层(Electron main / CLI)建 ctx,不进 handler 表。
    return {
      ok: false,
      error: { code: 'OPEN_AT_TRANSPORT', message: 'workspace.open must be handled by the transport layer' },
    };
  }
  const handler = handlers[command.cmd as SessionCommands];
  if (!handler) {
    return { ok: false, error: { code: 'UNKNOWN_CMD', message: `unknown command: ${command.cmd}` } };
  }
  try {
    const data = await (handler as HandlerFor<SessionCommands>)(ctx, command as never);
    return { ok: true, data };
  } catch (err) {
    const appErr = captureError(err, {
      module: 'ipc',
      code: 'IPC_FAILED',
      message: `command ${command.cmd} failed`,
      data: { cmd: command.cmd },
    });
    return { ok: false, error: { code: appErr.code, message: appErr.message } };
  }
}
```

- [ ] **Step 3: 运行类型检查与测试**

Run: `npm run typecheck`
Expected: PASS（无 `as never` 相关报错；renderer/mock/scripts/tests 的调用点全部通过）

Run: `npm test`
Expected: 全部通过（handlers.test 等现有测试不改即应通过）

- [ ] **Step 4: Commit**

```bash
git add src/ipc/contracts.ts src/ipc/handlers.ts
git commit -m "refactor(contracts): ApiCommand/ApiResult 改为强类型映射表,handler 去 as never 强转"
```

---

### Task 2: `reqId` 对账(`dispatchIpc`)

**Files:**
- Modify: `src/ipc/handlers.ts`（新增 `dispatchIpc`）
- Modify: `src/main/index.ts`（`onw:invoke` 透传可选 `reqId`）
- Test: `tests/ipc/handlers.test.ts`（追加用例）

**Interfaces:**
- Consumes: `IpcRequest`/`IpcResponse`（Task 1 产出）
- Produces: `dispatchIpc(req: IpcRequest, ctx: ApiContext): Promise<IpcResponse>` —— CLI 与 Electron 共用的带信封分发入口。

- [ ] **Step 1: 写失败测试**

在 `tests/ipc/handlers.test.ts` 末尾追加：

```ts
it('dispatchIpc echoes reqId so async requests can be reconciled', async () => {
  const res = await dispatchIpc({ cmd: 'state.summary', reqId: 42 }, ctx);
  expect(res.reqId).toBe(42);
  expect(res.result.ok).toBe(true);
});
```

文件头 import 加 `dispatchIpc`：
```ts
import { dispatch, dispatchIpc, type ApiContext } from '../../src/ipc/handlers';
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/ipc/handlers.test.ts`
Expected: FAIL，`dispatchIpc` 未定义。

- [ ] **Step 3: 实现 `dispatchIpc`**

在 `src/ipc/handlers.ts` 的 `dispatch` 之后追加：

```ts
/** 带 reqId 信封的分发(CLI 与 Electron 传输层共用):请求带 reqId,响应回填同 reqId。 */
export async function dispatchIpc(req: IpcRequest, ctx: ApiContext): Promise<IpcResponse> {
  const result = await dispatch(req, ctx);
  return { reqId: req.reqId, result };
}
```

文件头 import 加 `type IpcRequest, type IpcResponse`。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/ipc/handlers.test.ts`
Expected: PASS。

- [ ] **Step 5: Electron main 透传可选 reqId**

`src/main/index.ts` 的 `onw:invoke` 处理器，在构造返回值前读取可选 reqId：

```ts
ipcMain.handle('onw:invoke', async (_event, command: { cmd: string; [k: string]: unknown }) => {
  const reqId = command && typeof command === 'object' && 'reqId' in command
    ? (command as { reqId?: number }).reqId
    : undefined;
  // ... 原有 workspace.open / NO_WORKSPACE / dispatch 逻辑不变 ...
  const result = await dispatch(command as never, ctx);
  return reqId === undefined ? result : { reqId, result };
});
```

- [ ] **Step 6: Commit**

```bash
git add src/ipc/handlers.ts src/main/index.ts tests/ipc/handlers.test.ts
git commit -m "feat(ipc): dispatchIpc 带 reqId 信封对账,CLI/Electron 共用"
```

---

### Task 3: 显式 pipeline id

**Files:**
- Modify: `src/core/agent/tools.ts`（`toolCreateCleaningPipeline` 加 id 参数）
- Modify: `src/ipc/handlers.ts`（`pipeline.save` clean 分支传 `config.id`）
- Modify: `src/core/agent/flow.ts`（`runInitialSetupFlow` 接受显式 id，去掉 `m_${Date.now()}`）
- Modify: `scripts/agent-task.ts`（传显式 id）
- Test: `tests/ipc/handlers.test.ts`（追加用例）

**Interfaces:**
- Produces: `toolCreateCleaningPipeline(ws: Workspace, id: string, bigTableFolder: string, sourceDir: string): { pipelineId: string }`；`runInitialSetupFlow` 选项新增 `cleaningPipelineId?` / `sqlCleanPipelineId?`（缺省 `'c1'`/`'m1'`，不再用 `Date.now()`）。

- [ ] **Step 1: 写失败测试**

在 `tests/ipc/handlers.test.ts` 追加：

```ts
it('pipeline.save honours the caller-supplied id for clean pipelines', async () => {
  const res = await dispatch(
    {
      cmd: 'pipeline.save',
      config: {
        kind: 'clean',
        id: 'my-clean',
        label: '',
        bigTableFolder: 'seq',
        sourceDir,
        createdAt: '',
      },
    },
    ctx,
  );
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.data).toEqual({ pipelineId: 'my-clean' });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/ipc/handlers.test.ts`
Expected: FAIL，返回 `{ pipelineId: 'c_<timestamp>' }` 而非 `my-clean`。

- [ ] **Step 3: 改 `toolCreateCleaningPipeline` 签名**

`src/core/agent/tools.ts`：

```ts
/** tool: 创建清洗管线(引用大表规则执行,不写规则)。id 由调用方显式传入。 */
export function toolCreateCleaningPipeline(
  ws: Workspace,
  id: string,
  bigTableFolder: string,
  sourceDir: string,
): { pipelineId: string } {
  savePipeline(ws, {
    kind: 'clean',
    id,
    label: `${bigTableFolder}清洗`,
    bigTableFolder,
    sourceDir,
    createdAt: new Date().toISOString(),
  });
  return { pipelineId: id };
}
```

- [ ] **Step 4: 更新调用点**

1. `src/ipc/handlers.ts` `'pipeline.save'` clean 分支：

```ts
return toolCreateCleaningPipeline(ctx.ws, config.id, config.bigTableFolder, config.sourceDir);
```

2. `src/core/agent/flow.ts`：
   - `runInitialSetupFlow` 选项加 `cleaningPipelineId?: string; sqlCleanPipelineId?: string;`
   - 创建清洗管线改为 `toolCreateCleaningPipeline(ws, opts.cleaningPipelineId ?? 'c1', bigTableFolder, sourceDir)`
   - 内联 sql-clean 改为 `const sqlId = opts.sqlCleanPipelineId ?? 'm1';`（删 `const sqlId = \`m_${Date.now()}\`;`）

3. `scripts/agent-task.ts` 第 62 行改为 `toolCreateCleaningPipeline(ws, 'c1', BIG_TABLE, sourceDir)`（`pipelineId` 变量即 `'c1'`）。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run tests/ipc/handlers.test.ts tests/core/agent-flow.test.ts`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/handlers.ts src/core/agent/flow.ts scripts/agent-task.ts tests/ipc/handlers.test.ts
git commit -m "refactor(tools): pipeline id 由调用方显式传入,移除 Date.now() 生成 id"
```

---

## Part B — CLI 先行

### Task 4: 抽 `createContext` 到 `src/app/context.ts`

**Files:**
- Create: `src/app/context.ts`（迁移自 `src/main/context.ts`）
- Modify: `src/main/index.ts`（改 import）
- Modify: `tsconfig.main.json`（include 加 `"src/app"`, `"src/cli"`）
- Test: `tests/cli/context.test.ts`

**Interfaces:**
- Produces: `createContext(workspacePath: string): ApiContext`（零 Electron import，CLI 与 Electron 共用）。

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/context.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../../src/app/context';

describe('createContext', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ctx-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds an ApiContext bound to the workspace path', () => {
    const ctx = createContext(join(dir, 'ws'));
    expect(ctx.ws.onworkingDir).toContain('.onworking');
    expect(ctx.dbPath).toContain('master.db');
    const eng = ctx.getEngine();
    expect(eng.masterDb()).toBe(ctx.dbPath);
    eng.close();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/cli/context.test.ts`
Expected: FAIL，`src/app/context` 不存在。

- [ ] **Step 3: 创建 `src/app/context.ts`**

```ts
// src/app/context.ts
// 构造 ApiContext:打开工作区 + 惰性引擎(单例缓存)。零 Electron 依赖,CLI 与 Electron 共用。
import { openWorkspace, masterDbPath } from '../core/workspace/workspace';
import { PipelineEngine } from '../core/pipeline/engine';
import type { ApiContext } from '../ipc/handlers';

export function createContext(workspacePath: string): ApiContext {
  const ws = openWorkspace(workspacePath);
  const dbPath = masterDbPath(ws);
  let engine: PipelineEngine | null = null;
  return {
    ws,
    dbPath,
    getEngine: () => (engine ??= new PipelineEngine(ws)),
  };
}
```

- [ ] **Step 4: 删除旧文件、改 import、扩 tsconfig**

```bash
git rm src/main/context.ts
```

`src/main/index.ts` 第 6 行改：`import { createContext } from '../app/context';`

`tsconfig.main.json` 的 `"include"` 改为：`["src/main", "src/ipc", "src/core", "src/app", "src/cli"]`

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run tests/cli/context.test.ts`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/app/context.ts src/main/index.ts tsconfig.main.json tests/cli/context.test.ts
git commit -m "refactor(context): createContext 抽到 src/app,零 Electron 依赖,CLI 共用"
```

---

### Task 5: CLI 命令循环(NDJSON)

**Files:**
- Create: `src/cli/index.ts`（`createCliState` + `main` + 入口守卫）
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Produces:
  - `interface CliWriter { stdout(line: string): void; stderr(line: string): void; }`
  - `interface CliState { open(path: string): ApiContext; handleRequest(req: IpcRequest): Promise<void>; close(): void; }`
  - `createCliState(writer: CliWriter): CliState`
  - `main(argv: string[], stdin: AsyncIterable<string>, writer: CliWriter): Promise<number>`

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/cli.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliState, main, type CliWriter } from '../../src/cli/index';

function memWriter(): { writer: CliWriter; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { writer: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) }, stdout, stderr };
}

describe('cli', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a workspace and dispatches commands, echoing reqId', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    state.open(dir);
    await state.handleRequest({ cmd: 'state.summary', reqId: 7 });
    const line = JSON.parse(stdout[stdout.length - 1]);
    expect(line.reqId).toBe(7);
    expect(line.result.ok).toBe(true);
  });

  it('reports NO_WORKSPACE before any open', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    await state.handleRequest({ cmd: 'bigtable.list', reqId: 1 });
    const line = JSON.parse(stdout[0]);
    expect(line.result.ok).toBe(false);
    expect(line.result.error.code).toBe('NO_WORKSPACE');
  });

  it('treats a piped workspace.open line as the bootstrap', async () => {
    const { writer, stdout } = memWriter();
    const state = createCliState(writer);
    await state.handleRequest({ cmd: 'workspace.open', path: dir, reqId: 2 });
    expect(JSON.parse(stdout[0]).result.ok).toBe(true);
    // 现在有 ctx 了,后续命令可执行
    await state.handleRequest({ cmd: 'state.summary', reqId: 3 });
    expect(JSON.parse(stdout[1]).result.ok).toBe(true);
  });

  it('main() reads lines from an async iterable and writes NDJSON responses', async () => {
    const { writer, stdout } = memWriter();
    async function* lines() {
      yield '{"reqId":1,"cmd":"state.summary"}';
    }
    const code = await main(['open', dir], lines(), writer);
    expect(code).toBe(0);
    expect(stdout.some((l) => l.includes('"reqId":1'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: FAIL，`src/cli/index` 不存在。

- [ ] **Step 3: 实现 `src/cli/index.ts`**

```ts
#!/usr/bin/env node
// src/cli/index.ts
// CLI 前端:同一个 dispatch 的 stdio 版本。NDJSON 命令循环。
//   onw open <path>              → 建 ctx(等同 Electron main 持有 ctx)
//   之后 stdin 每行一条 IpcRequest JSON → stdout 一行 IpcResponse JSON;stderr 出错误。
//   例: echo '{"cmd":"bigtable.list"}' | onw open /path/to/ws
import { createInterface } from 'node:readline';
import { createContext, type ApiContext } from '../app/context';
import { dispatchIpc } from '../ipc/handlers';
import type { IpcRequest } from '../ipc/contracts';
import { useConsoleLogging } from '../core/logging';

export interface CliWriter {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliState {
  open(path: string): ApiContext;
  handleRequest(req: IpcRequest): Promise<void>;
  close(): void;
}

export function createCliState(writer: CliWriter): CliState {
  let ctx: ApiContext | null = null;
  return {
    open(path: string): ApiContext {
      ctx = createContext(path);
      ctx.emitProgress = (payload) => writer.stderr(JSON.stringify({ event: 'progress', payload }));
      return ctx;
    },
    async handleRequest(req: IpcRequest): Promise<void> {
      if (req.cmd === 'workspace.open') {
        this.open(req.path);
        writer.stdout(JSON.stringify({ reqId: req.reqId, result: { ok: true, data: ctx!.ws } }));
        return;
      }
      if (!ctx) {
        writer.stdout(
          JSON.stringify({
            reqId: req.reqId,
            result: { ok: false, error: { code: 'NO_WORKSPACE', message: 'no workspace opened; use: onw open <path>' } },
          }),
        );
        return;
      }
      const res = await dispatchIpc(req, ctx);
      writer.stdout(JSON.stringify(res));
    },
    close(): void {},
  };
}

export async function main(
  argv: string[],
  stdin: AsyncIterable<string>,
  writer: CliWriter,
): Promise<number> {
  const state = createCliState(writer);
  const openIdx = argv.indexOf('open');
  if (openIdx >= 0 && argv[openIdx + 1]) state.open(argv[openIdx + 1]);
  for await (const line of stdin) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: IpcRequest;
    try {
      req = JSON.parse(trimmed) as IpcRequest;
    } catch {
      writer.stderr(JSON.stringify({ error: 'invalid JSON', line: trimmed.slice(0, 200) }));
      continue;
    }
    await state.handleRequest(req);
  }
  state.close();
  return 0;
}

// 入口守卫:被直接执行(tsc CommonJS 输出 / tsx)时才启动 stdio 循环;
// vitest import 本模块时 require 未定义或 require.main 非本模块,不触发。
if (typeof require !== 'undefined' && require.main === module) {
  useConsoleLogging('warn');
  const writer: CliWriter = {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  };
  main(process.argv.slice(2), createInterface({ input: process.stdin, crlfDelay: Infinity }), writer)
    .then((code) => { process.exitCode = code; })
    .catch((err: unknown) => { process.stderr.write(String(err) + '\n'); process.exitCode = 1; });
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli/cli.test.ts
git commit -m "feat(cli): NDJSON 命令循环(onw open <path> + stdin/stdout 一行一命令)"
```

---

### Task 6: bin 接入 + 进程级冒烟

**Files:**
- Modify: `package.json`（`bin`、`onw` script）
- Test: `tests/cli/cli-process.test.ts`（spawn 真实 CLI 进程）

**Interfaces:**
- Consumes: `main`（Task 5 产出）
- Produces: `npm run onw -- open <path>` 可直接从 stdin 读命令。

- [ ] **Step 1: 写失败测试**

创建 `tests/cli/cli-process.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cli process smoke', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'clip-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips an NDJSON command over real stdio', async () => {
    const child: ChildProcess = spawn(
      'npm',
      ['run', '--silent', 'onw', '--', 'open', dir],
      { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin!.write('{"reqId":3,"cmd":"state.summary"}\n');
    child.stdin!.end();
    const stdout = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
      child.stdout!.on('end', () => resolve(out));
      child.on('error', reject);
    });
    const parsed = stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed.some((l) => l.reqId === 3 && l.result && l.result.ok === true)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/cli/cli-process.test.ts`
Expected: FAIL，`npm run onw` 脚本不存在。

- [ ] **Step 3: 接 package.json**

`package.json`：
- `scripts` 加：`"onw": "tsx src/cli/index.ts"`
- 顶层加：`"bin": { "onw": "dist/main/cli/index.js" }`

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/cli/cli-process.test.ts`
Expected: PASS（真实 stdin/stdout 往返成功）。

- [ ] **Step 5: 手工冒烟 + Commit**

手工验证（可选）：
```bash
npm run onw -- open D:/tmp/ws
# 交互下逐行粘贴 {"cmd":"state.summary"} 观察响应
```

```bash
git add package.json tests/cli/cli-process.test.ts
git commit -m "feat(cli): bin 接入 npm run onw,进程级 NDJSON 冒烟通过"
```

---

## Part C — 删冗余

### Task 7: 合并 3 个执行器为 `toolRunPipeline`

**Files:**
- Modify: `src/core/agent/tools.ts`（加 `toolRunPipeline`，删 `toolRunCleaning`/`toolBuildMasterTable`/`toolRunQueryPipeline`）
- Modify: `src/ipc/handlers.ts`（`pipeline.run` 单调用）
- Modify: `src/core/agent/flow.ts`、`scripts/agent-task.ts`、`scripts/agent-flow-demo.ts`
- Modify: `tests/core/agent-flow.test.ts`
- Test: Create `tests/core/tools.test.ts`

**Interfaces:**
- Produces: `toolRunPipeline(ws: Workspace, id: string): Promise<RunSummary>` —— 按 kind 交给 `engine.run`。

- [ ] **Step 1: 写失败测试**

创建 `tests/core/tools.test.ts`（同时是本任务与后续 T8/T11/T12/T13 的公共测试台）：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { toolRunPipeline } from '../../src/core/agent/tools';

describe('tools', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tools-'));
    ws = initWorkspace(dir);
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    saveBigTableConfig(ws, 'seq', {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'date', type: 'TEXT', order: 1 },
        { name: 'debit', type: 'INTEGER', order: 2 },
      ],
    });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额'],
      ['2024-01', 100],
      ['2024-02', 200],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
    savePipeline(ws, {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      headerRow: 1,
      mappings: [
        { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
        { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
      ],
      createdAt: '',
    });
    savePipeline(ws, {
      kind: 'sql-clean',
      id: 'm1',
      label: '',
      bigTables: ['seq'],
      sql: 'SELECT date, debit FROM "bt_seq".seq',
      resultTable: 'seq',
      createdAt: '',
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('toolRunPipeline runs any kind by id', async () => {
    const clean = await toolRunPipeline(ws, 'c1');
    expect(clean.ok).toBe(true);
    expect(clean.rows).toBe(2);
    const master = await toolRunPipeline(ws, 'm1');
    expect(master.ok).toBe(true);
  });
});
```

> 注：此测试文件在 T9 完成后会去掉 `headerRow`/`mappings` 改为写规则 YAML（见 Task 9 Step 1）。当前先按 cfg 驱动写。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: FAIL，`toolRunPipeline` 未定义。

- [ ] **Step 3: 实现并删旧函数**

`src/core/agent/tools.ts`：把 `toolRunCleaning`/`toolBuildMasterTable`/`toolRunQueryPipeline` 三个函数体收敛为：

```ts
/** tool: 运行任意管线(按 kind 交给 engine.run:clean→大表 DB,sql-clean/query→总表 DB)。 */
export async function toolRunPipeline(ws: Workspace, id: string): Promise<RunSummary> {
  const eng = new PipelineEngine(ws);
  try {
    return await eng.run(id);
  } finally {
    eng.close();
  }
}
```

删除 `toolRunCleaning`、`toolBuildMasterTable`、`toolRunQueryPipeline` 三个函数。

- [ ] **Step 4: 更新调用点**

1. `src/ipc/handlers.ts` `'pipeline.run'`：

```ts
'pipeline.run': async (ctx, p) => toolRunPipeline(ctx.ws, p.id),
```

（删掉 `loadPipeline` 的 kind 分发；import 里删掉三个旧函数，加 `toolRunPipeline`。）

2. `src/core/agent/flow.ts`：`toolRunCleaning(ws, pipelineId)` → `toolRunPipeline(ws, pipelineId)`；`toolBuildMasterTable(ws, sqlId)` → `toolRunPipeline(ws, sqlId)`；import 对应改。
3. `scripts/agent-task.ts`：`toolRunCleaning` → `toolRunPipeline`、`toolBuildMasterTable` → `toolRunPipeline`、`toolRunQueryPipeline` → `toolRunPipeline`；import 对应改。
4. `scripts/agent-flow-demo.ts`：`toolRunQueryPipeline(ws, 'q_total')` → `toolRunPipeline(ws, 'q_total')`；import 对应改。
5. `tests/core/agent-flow.test.ts`：`toolRunQueryPipeline(ws, 'q1')` → `toolRunPipeline(ws, 'q1')`；import 对应改。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/handlers.ts src/core/agent/flow.ts scripts/agent-task.ts scripts/agent-flow-demo.ts tests/core/tools.test.ts tests/core/agent-flow.test.ts
git commit -m "refactor(tools): 3 个执行器合并为 toolRunPipeline(按 kind 交给 engine)"
```

---

### Task 8: 合并 4 个批量工具为 `toolRunPipelines(ws, filter)`

**Files:**
- Modify: `src/core/agent/tools.ts`（加 `PipelineFilter` + `toolRunPipelines`，删 4 个批量工具）
- Modify: `src/ipc/handlers.ts`（4 个命令改用 filter）
- Test: `tests/core/tools.test.ts`（追加用例）

**Interfaces:**
- Produces:
  - `type PipelineFilter = { kind: 'all' } | { kind: 'clean' } | { kind: 'clean'; bigTableFolder: string } | { kind: 'sql-clean' } | { kind: 'sql-clean'; bigTableFolder: string }`
  - `toolRunPipelines(ws: Workspace, filter: PipelineFilter): Promise<RunSummary[]>`

- [ ] **Step 1: 写失败测试**

`tests/core/tools.test.ts` 追加：

```ts
it('toolRunPipelines filters pipelines by kind and folder', async () => {
  const cleanOnly = await toolRunPipelines(ws, { kind: 'clean' });
  expect(cleanOnly.map((r) => r.pipelineId)).toEqual(['c1']);

  const masterOne = await toolRunPipelines(ws, { kind: 'sql-clean', bigTableFolder: 'seq' });
  expect(masterOne.map((r) => r.pipelineId)).toEqual(['m1']);

  const none = await toolRunPipelines(ws, { kind: 'clean', bigTableFolder: 'other' });
  expect(none).toEqual([]);
});
```

import 加 `toolRunPipelines`。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: FAIL，`toolRunPipelines` 未定义。

- [ ] **Step 3: 实现并删旧函数**

`src/core/agent/tools.ts`：

```ts
/** 批量运行过滤条件:all / 按 kind / 按 kind + 大表。 */
export type PipelineFilter =
  | { kind: 'all' }
  | { kind: 'clean' }
  | { kind: 'clean'; bigTableFolder: string }
  | { kind: 'sql-clean' }
  | { kind: 'sql-clean'; bigTableFolder: string };

/** tool: 按过滤条件跑一批管线(替代 4 个批量合并/构建工具)。 */
export async function toolRunPipelines(ws: Workspace, filter: PipelineFilter): Promise<RunSummary[]> {
  const ids = listPipelines(ws).filter((id) => {
    const cfg = loadPipeline(ws, id);
    if (filter.kind === 'all') return true;
    if (filter.kind === 'clean') {
      if (cfg.kind !== 'clean') return false;
      return 'bigTableFolder' in filter ? cfg.bigTableFolder === filter.bigTableFolder : true;
    }
    // sql-clean
    if (cfg.kind !== 'sql-clean') return false;
    return 'bigTableFolder' in filter ? cfg.bigTables.includes(filter.bigTableFolder) : true;
  });
  const eng = new PipelineEngine(ws);
  try {
    const out: RunSummary[] = [];
    for (const id of ids) out.push(await eng.run(id));
    return out;
  } finally {
    eng.close();
  }
}
```

删除 `toolMergeBigTable`/`toolMergeAll`/`toolBuildMasterForBigTable`/`toolBuildMasterAll` 及私有 `runCleanPipelines`/`runSqlCleanPipelines`。

- [ ] **Step 4: 更新 handlers**

`src/ipc/handlers.ts`：

```ts
'pipeline.mergeBigTable': async (ctx, p) => toolRunPipelines(ctx.ws, { kind: 'clean', bigTableFolder: p.folder }),
'pipeline.mergeAll': async (ctx) => toolRunPipelines(ctx.ws, { kind: 'clean' }),
'pipeline.buildMasterBigTable': async (ctx, p) => toolRunPipelines(ctx.ws, { kind: 'sql-clean', bigTableFolder: p.folder }),
'pipeline.buildMasterAll': async (ctx) => toolRunPipelines(ctx.ws, { kind: 'sql-clean' }),
```

import 里删 4 个旧函数，加 `toolRunPipelines`。（顶层 TopBar 只走 IPC 命令，无需改动。）

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/handlers.ts tests/core/tools.test.ts
git commit -m "refactor(tools): 4 个批量工具合并为 toolRunPipelines(ws, filter)"
```

---

### Task 9: 删 cfg 映射双轨,统一规则 YAML 驱动

**Files:**
- Modify: `src/core/pipeline/config.ts`（`CleanPipelineConfig` 删 `headerRow`/`mappings`）
- Modify: `src/core/pipeline/clean-runner.ts`（删 cfg 驱动分支,无规则即报错）
- Modify: `src/core/pipeline/engine.ts`（`registerMapping` 用规则数）
- Modify: `tests/core/clean-runner.test.ts`、`tests/core/pipeline-integration.test.ts`、`tests/core/pipeline-engine.test.ts`、`tests/ipc/handlers.test.ts`、`tests/core/tools.test.ts`（fixture 改写规则 YAML）

**Interfaces:**
- Produces: clean 管线运行必须依赖 `bigtables/<folder>/rules/*.yaml`；`CleanPipelineConfig` 不再含映射字段。

- [ ] **Step 1: 先改一个测试让它失败**

在 `tests/core/clean-runner.test.ts` 的 `beforeEach` 里去掉 `cfg` 的 `headerRow`/`mappings`，并写规则 YAML（import 加 `saveRule`）：

```ts
import { saveRule } from '../../src/core/rule/store';
// beforeEach 内:
saveRule(workspace, 'seq', {
  name: 'seq_rule',
  display: '规则',
  version: 1,
  sources: [{ pattern: '**/*', headerRow: 1 }],
  fields: [
    { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
    { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
    { sourceHeader: '摘要', outputName: 'note', included: true, order: 3, transforms: [{ kind: 'coerce_string' }] },
  ],
});
cfg = {
  kind: 'clean',
  id: 'c1',
  label: '',
  bigTableFolder: 'seq',
  sourceDir,
  createdAt: '',
};
```

同文件的「re-runs with a different mapping」用例：改成写第二份规则（ruleName 不同）再跑：

```ts
it('re-runs with a different rule rebuilds the table (no schema drift)', async () => {
  await runCleanPipeline(workspace, db, cfg, bigTable); // 首次:date/debit/note
  saveRule(workspace, 'seq', {
    name: 'seq_rule_min',
    display: '精简',
    version: 1,
    sources: [{ pattern: '**/*', headerRow: 1 }],
    fields: [
      { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
    ],
  });
  await runCleanPipeline(workspace, db, cfg, bigTable);
  // ... 断言同原样:含 date、不含 debit/note、行数仍 2 ...
});
```

Run: `npx vitest run tests/core/clean-runner.test.ts`
Expected: FAIL —— 当前实现仍走 cfg.mappings（此时 cfg 已无 mappings，走 `CLEAN_NO_RULE_OR_MAPPING` 报错）。

- [ ] **Step 2: 改 config.ts 与 clean-runner.ts**

`src/core/pipeline/config.ts` `CleanPipelineConfig` 删 `sheetName?`/`headerRow?`/`mappings?` 三字段，只留：

```ts
export interface CleanPipelineConfig {
  kind: 'clean';
  id: string;
  label: string;
  /** 输出目标大表文件夹(血缘节点)。 */
  bigTableFolder: string;
  /** 源文件目录(输入)。 */
  sourceDir: string;
  createdAt: string;
}
```

`src/core/pipeline/clean-runner.ts`：**整体替换**从 `// 确定有效映射与来源(优先规则 YAML,否则 cfg)` 到 `if (!mappings || mappings.length === 0) { throw ... }` 的整段（原第 99-117 行），换成只走规则：

```ts
// 映射与来源唯一来自规则 YAML
const rules = loadRules(ws, cfg.bigTableFolder);
if (rules.length === 0) {
  throw new AppError({
    module: 'pipeline/clean',
    code: 'CLEAN_NO_RULE',
    message: `big table ${cfg.bigTableFolder} has no rule YAML`,
    data: { bigTableFolder: cfg.bigTableFolder },
  });
}
const compiled = compileRule(rules[0]);
const mappings = compiled.mappings;
const sources = compiled.sources;
if (mappings.length === 0) {
  throw new AppError({
    module: 'pipeline/clean',
    code: 'CLEAN_NO_FIELDS',
    message: `rule for ${cfg.bigTableFolder} has no included fields`,
    data: { bigTableFolder: cfg.bigTableFolder },
  });
}
```

并删除整个 cfg 驱动分支（原第 148-165 行的 `} else { // cfg 驱动(无规则)` 段落），把外层 `if (sources) { ... } else { ... }` 改写为直接 `for (const source of sources) { ... }`（`sources` 现在恒有值；`let mappings/sources` 的旧声明一并删除）。`CompiledSource` import 保留。

- [ ] **Step 3: 改 engine.ts 的 registerMapping**

`src/core/pipeline/engine.ts` 第 97 行：

```ts
st.registerMapping(cfg.bigTableFolder, loadRules(ws, cfg.bigTableFolder).length);
```

import 加 `loadRules`（来自 `../rule/store`）。

- [ ] **Step 4: 同步更新其余测试 fixture**

对 `tests/core/pipeline-integration.test.ts`、`tests/core/pipeline-engine.test.ts`、`tests/ipc/handlers.test.ts`、`tests/core/tools.test.ts`：在其 `savePipeline` clean 配置上删 `headerRow`/`mappings`，并在 `beforeEach` 里对该大表写一份规则 YAML（字段按各自用例的映射：pipeline-engine/handlers 用 date/debit，pipeline-integration 用 period/debit/note）。规则 sources 统一 `[{ pattern: '**/*', headerRow: 1 }]`，transforms 对应 `coerce_date`/`coerce_cents`/`coerce_string`。

- [ ] **Step 5: 运行全部测试与类型检查**

Run: `npm test`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/pipeline/config.ts src/core/pipeline/clean-runner.ts src/core/pipeline/engine.ts tests/core/clean-runner.test.ts tests/core/pipeline-integration.test.ts tests/core/pipeline-engine.test.ts tests/ipc/handlers.test.ts tests/core/tools.test.ts
git commit -m "refactor(clean): 删 cfg 映射双轨,clean 唯一由规则 YAML 驱动"
```

---

### Task 10: 删死代码 + `workspace.pick` 并入 `workspace.open`

**Files:**
- Modify: `src/core/agent/tools.ts`（删 `toolListContext`）
- Modify: `src/ipc/contracts.ts`（删 `workspace.pick`）
- Modify: `src/main/index.ts`（删 pick 特判,加 `onw:pick-workspace` 对话框通道）
- Modify: `src/main/preload.ts`（加 `pickWorkspace`）
- Modify: `src/renderer/global.d.ts`（补 `pickWorkspace` 类型）
- Modify: `src/renderer/shell/TopBar.tsx`（改用 `pickWorkspace` + `workspace.open`）
- Modify: `src/renderer/mock/onw-mock.ts`（删 pick case,加 `pickWorkspace`）

**Interfaces:**
- Produces: 契约里唯一的开工作区命令是 `workspace.open {path}`；目录选择是 Electron UI 的 `onw:pick-workspace` 桥，返回 `string | null`。

- [ ] **Step 1: 确认死代码后删除**

Run: `grep -rn "toolListContext" src tests scripts` 确认除定义外无调用。

删 `src/core/agent/tools.ts` 的 `toolListContext` 函数。

- [ ] **Step 2: 改契约与主进程**

1. `src/ipc/contracts.ts`：`CommandPayloads` 删 `'workspace.pick'` 行；`IpcRequest`/`ApiCommand` 自动随之收窄。
2. `src/main/index.ts`：删 `workspace.pick` 特判块；新增：

```ts
ipcMain.handle('onw:pick-workspace', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});
```

3. `src/main/preload.ts` 加：

```ts
pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('onw:pick-workspace') as Promise<string | null>,
```

4. `src/renderer/global.d.ts` 的 `onw` 类型加：

```ts
pickWorkspace(): Promise<string | null>;
```

- [ ] **Step 3: 改 TopBar 与 onw-mock**

`src/renderer/shell/TopBar.tsx` `handlePick`：

```ts
async function handlePick() {
  const path = await window.onw.pickWorkspace();
  if (!path) return;
  const res = await window.onw.invoke({ cmd: 'workspace.open', path });
  if (res.ok) {
    const ws = res.data as { root: string };
    setWsName(ws.root);
  }
}
```

`src/renderer/mock/onw-mock.ts`：删 `case 'workspace.pick':`，在 `installMockOnw` 的对象里加 `pickWorkspace: async () => 'D:/演示工作区',`。

- [ ] **Step 4: 运行类型检查与测试**

Run: `npm run typecheck`（含 renderer，`workspace.pick` 残留引用会报错）
Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/contracts.ts src/main/index.ts src/main/preload.ts src/renderer/global.d.ts src/renderer/shell/TopBar.tsx src/renderer/mock/onw-mock.ts
git commit -m "refactor(workspace): 删 toolListContext;workspace.pick 并入 workspace.open(目录选择走 pickWorkspace 桥)"
```

---

## Part D — 补缺口

### Task 11: #13 清洗结果预览 `bigtable.previewRows`

**Files:**
- Modify: `src/core/agent/tools.ts`（加 `toolPreviewCleanResult`，删 `toolVerifyData`）
- Modify: `src/ipc/contracts.ts`（`CommandPayloads`/`CommandResults` 加 `bigtable.previewRows`）
- Modify: `src/ipc/handlers.ts`（加 handler）
- Modify: `src/core/agent/flow.ts`（`verifyData` 步改用预览 tool + 总表 count）
- Modify: `src/renderer/mock/onw-mock.ts`（加 case）
- Test: `tests/core/tools.test.ts`、`tests/core/agent-flow.test.ts`

**Interfaces:**
- Produces:
  - `toolPreviewCleanResult(ws: Workspace, folder: string, opts?: { limit?: number; offset?: number }): { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; total: number }`（只读大表 DB）
  - command `{ cmd: 'bigtable.previewRows'; folder: string; limit?: number; offset?: number }` → 上述结果

- [ ] **Step 1: 写失败测试**

`tests/core/tools.test.ts` 追加：

```ts
import { toolPreviewCleanResult } from '../../src/core/agent/tools';
it('toolPreviewCleanResult reads the big table DB read-only', async () => {
  await toolRunPipeline(ws, 'c1');
  const res = toolPreviewCleanResult(ws, 'seq');
  expect(res.columns).toContain('date');
  expect(res.total).toBe(2);
  expect(res.rows).toHaveLength(2);
  const paged = toolPreviewCleanResult(ws, 'seq', { limit: 1, offset: 1 });
  expect(paged.rows).toHaveLength(1);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: FAIL，`toolPreviewCleanResult` 未定义。

- [ ] **Step 3: 实现 tool 并删 toolVerifyData**

`src/core/agent/tools.ts`：

```ts
/** tool: 清洗结果预览 —— 只读查大表 DB(替换 toolVerifyData)。 */
export function toolPreviewCleanResult(
  ws: Workspace,
  bigTableFolder: string,
  opts?: { limit?: number; offset?: number },
): { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; total: number } {
  const cfg = loadBigTableConfig(ws, bigTableFolder);
  const db = openDatabase(bigTableDbPath(ws, bigTableFolder));
  try {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${cfg.tableName}"`).get() as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM "${cfg.tableName}" LIMIT ${limit} OFFSET ${offset}`)
      .all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: rows.length, total };
  } finally {
    db.close();
  }
}
```

删除 `toolVerifyData`。

- [ ] **Step 4: 接契约与 handler**

`src/ipc/contracts.ts`：`CommandPayloads` 加 `'bigtable.previewRows': { folder: string; limit?: number; offset?: number };`；`CommandResults` 加 `'bigtable.previewRows': { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; total: number };`

`src/ipc/handlers.ts` 加：

```ts
'bigtable.previewRows': async (ctx, p) =>
  toolPreviewCleanResult(ctx.ws, p.folder, { limit: p.limit, offset: p.offset }),
```

import 加 `toolPreviewCleanResult`（替换 `toolVerifyData` 的 import）。

`src/renderer/mock/onw-mock.ts` 加：

```ts
case 'bigtable.previewRows':
  return ok({
    columns: ['date', 'debit'],
    rows: [{ date: '2024-01', debit: 10000 }],
    rowCount: 1,
    total: 1,
  });
```

- [ ] **Step 5: 更新 flow.ts 的 verifyData 步**

`src/core/agent/flow.ts`：把 `toolVerifyData` 步改为预览 + 总表 count：

```ts
const preview = (await push('previewCleanResult', () =>
  toolPreviewCleanResult(ws, bigTableFolder),
)) as { rows: Record<string, unknown>[]; total: number };
const masterCount = (await push('masterCount', () =>
  toolQuery(ws, `SELECT COUNT(*) AS n FROM "${tableName ?? 'seq'}"`),
)) as { rows: Record<string, unknown>[] };
const verify = { rows: preview.total, masterRows: Number(masterCount.rows[0]?.n ?? 0) };
```

import 把 `toolVerifyData` 换成 `toolPreviewCleanResult`、`toolQuery`。

`tests/core/agent-flow.test.ts` 的步骤名断言里把 `'verifyData'` 改为 `'previewCleanResult'`。

- [ ] **Step 6: 运行测试与类型检查**

Run: `npm test`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/contracts.ts src/ipc/handlers.ts src/core/agent/flow.ts src/renderer/mock/onw-mock.ts tests/core/tools.test.ts tests/core/agent-flow.test.ts
git commit -m "feat(preview): bigtable.previewRows 只读预览清洗结果,吸收 toolVerifyData"
```

---

### Task 12: #9 `toolSaveTemplate`

**Files:**
- Modify: `src/core/agent/tools.ts`（加 `toolSaveTemplate`）
- Modify: `src/ipc/handlers.ts`（`template.save` 委托 tool）
- Test: `tests/core/tools.test.ts`

**Interfaces:**
- Produces: `toolSaveTemplate(ws: Workspace, tpl: MappingTemplate): { saved: string }`

- [ ] **Step 1: 写失败测试**

`tests/core/tools.test.ts` 追加：

```ts
import { toolSaveTemplate } from '../../src/core/agent/tools';
import { listTemplates } from '../../src/core/template/store';
it('toolSaveTemplate persists a mapping template', () => {
  const res = toolSaveTemplate(ws, { name: 'tpl1', mappings: [], createdAt: '2026-08-25T00:00:00.000Z' });
  expect(res).toEqual({ saved: 'tpl1' });
  expect(listTemplates(ws)).toContain('tpl1');
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: FAIL，`toolSaveTemplate` 未定义。

- [ ] **Step 3: 实现并接线**

`src/core/agent/tools.ts`：

```ts
import { loadTemplate, applyTemplateToSheet, saveTemplate, type MappingTemplate } from '../template/store';

/** tool: 保存字段映射模板。 */
export function toolSaveTemplate(ws: Workspace, tpl: MappingTemplate): { saved: string } {
  saveTemplate(ws, tpl);
  return { saved: tpl.name };
}
```

`src/ipc/handlers.ts` `'template.save'` 改为委托 tool：

```ts
'template.save': async (ctx, p) => toolSaveTemplate(ctx.ws, p.template),
```

import 里加 `toolSaveTemplate`（`saveTemplate` 直连调用可删）。

- [ ] **Step 4: 运行测试与类型检查**

Run: `npx vitest run tests/core/tools.test.ts`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/handlers.ts tests/core/tools.test.ts
git commit -m "feat(tools): toolSaveTemplate 存模板,handler 委托 tool 层"
```

---

### Task 13: #8 多映射追加(ruleName + 多规则合并)

**Files:**
- Modify: `src/core/agent/tools.ts`（`toolSetMapping` 加 `opts.ruleName`）
- Modify: `src/ipc/contracts.ts`（`mapping.save` 加 `ruleName?`）
- Modify: `src/ipc/handlers.ts`（透传 ruleName）
- Modify: `src/core/pipeline/clean-runner.ts`（合并全部规则而非 rules[0]）
- Test: `tests/core/tools.test.ts`

**Interfaces:**
- Produces: `toolSetMapping(ws: Workspace, folder: string, headerRow: number, mappings: FieldMapping[], opts?: { ruleName?: string }): { ruleFile: string }`（`ruleName` 缺省 `${folder}_rule`）；clean 运行合并所有规则的 sources+mappings（按 outputName 去重，先到先得）。

- [ ] **Step 1: 写失败测试**

`tests/core/tools.test.ts` 追加：

```ts
import { toolSetMapping } from '../../src/core/agent/tools';
import { listRules } from '../../src/core/rule/store';
it('toolSetMapping appends a second named rule, both apply on clean', async () => {
  // 在现有 sourceDir 里追加一个带「摘要」列的源文件(两个文件共 4 行)
  const wsx = XLSX.utils.aoa_to_sheet([
    ['日期', '借方金额', '摘要'],
    ['2024-03', 300, '工资'],
    ['2024-04', 400, '报销'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
  XLSX.writeFile(wb, join(sourceDir, 'b.xlsx'));

  // 第一份规则(默认名):日期/借方
  toolSetMapping(ws, 'seq', 1, [
    { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
    { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
  ]);
  // 追加第二份规则:摘要(不同 ruleName,不覆盖)
  toolSetMapping(ws, 'seq', 1, [
    { sourceHeader: '摘要', outputName: 'note', transform: 'trim' },
  ], { ruleName: 'seq_rule_2' });
  expect(listRules(ws, 'seq').length).toBe(2);

  const eng = new PipelineEngine(ws);
  const r = await eng.run('c1');
  eng.close();
  expect(r.ok).toBe(true);
  const preview = toolPreviewCleanResult(ws, 'seq');
  expect(preview.columns).toContain('note');
  expect(preview.total).toBe(4); // a.xlsx 2 行 + b.xlsx 2 行
});
```

> import 补充：`import { PipelineEngine } from '../../src/core/pipeline/engine';`、`import { toolSetMapping, toolPreviewCleanResult } from '../../src/core/agent/tools';`、`import { listRules } from '../../src/core/rule/store';`。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/tools.test.ts`
Expected: FAIL（`toolSetMapping` 无 `opts` 参数 / clean 只读 `rules[0]`，第二份规则不生效）。

- [ ] **Step 3: 实现 toolSetMapping 追加语义**

`src/core/agent/tools.ts`：

```ts
/** tool: 设置字段映射 —— 只写 YAML 规则,不生成管线。ruleName 缺省 `<folder>_rule`,可传不同名追加第 N 份。 */
export function toolSetMapping(
  ws: Workspace,
  bigTableFolder: string,
  headerRow: number,
  mappings: FieldMapping[],
  opts?: { ruleName?: string },
): { ruleFile: string } {
  const name = opts?.ruleName ?? `${bigTableFolder}_rule`;
  const rule: RuleYaml = {
    name,
    display: `提取规则: ${name}`,
    version: 1,
    sources: [{ pattern: '**/*', headerRow }],
    fields: mappings.map((m, i) => ({
      sourceHeader: m.sourceHeader,
      outputName: m.outputName,
      included: true,
      order: i + 1,
      transforms: [{ kind: transformToKind(m.transform) }],
    })),
  };
  const ruleFile = saveRule(ws, bigTableFolder, rule);
  return { ruleFile };
}
```

- [ ] **Step 4: 透传 ruleName + clean-runner 合并全部规则**

`src/ipc/contracts.ts` `CommandPayloads['mapping.save']` 加 `ruleName?: string;`；`src/ipc/handlers.ts`：

```ts
'mapping.save': async (ctx, p) =>
  toolSetMapping(ctx.ws, p.folder, p.headerRow ?? 1, p.mappings, { ruleName: p.ruleName }),
```

`src/core/pipeline/clean-runner.ts` 把「确定有效映射与来源」改为合并全部规则：

```ts
const rules = loadRules(ws, cfg.bigTableFolder);
if (rules.length === 0) {
  throw new AppError({
    module: 'pipeline/clean',
    code: 'CLEAN_NO_RULE',
    message: `big table ${cfg.bigTableFolder} has no rule YAML`,
    data: { bigTableFolder: cfg.bigTableFolder },
  });
}
const sources: CompiledSource[] = [];
const mappings: FieldMapping[] = [];
const seenSource = new Set<string>();
for (const rule of rules) {
  const compiled = compileRule(rule);
  // sources 按 (pattern|sheetName|headerRow) 去重,避免相同来源在多次规则里被重复处理
  for (const s of compiled.sources) {
    const key = `${s.pattern}|${s.sheetName ?? ''}|${s.headerRow}`;
    if (seenSource.has(key)) continue;
    seenSource.add(key);
    sources.push(s);
  }
  for (const m of compiled.mappings) {
    if (!mappings.some((e) => e.outputName === m.outputName)) mappings.push(m);
  }
}
if (mappings.length === 0) {
  throw new AppError({
    module: 'pipeline/clean',
    code: 'CLEAN_NO_FIELDS',
    message: `rules for ${cfg.bigTableFolder} have no included fields`,
    data: { bigTableFolder: cfg.bigTableFolder },
  });
}
```

`FieldMapping`/`CompiledSource` import 保留（文件头已 `import { applyMapping, type FieldMapping }`、`import { compileRule, type CompiledSource }`）。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npm test`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/agent/tools.ts src/ipc/contracts.ts src/ipc/handlers.ts src/core/pipeline/clean-runner.ts tests/core/tools.test.ts
git commit -m "feat(mapping): toolSetMapping 支持 ruleName 追加第 N 份映射,clean 合并全部规则"
```

---

### Task 14: MCP server(JSON-RPC 2.0 / stdio 子集)

**Files:**
- Create: `src/mcp/server.ts`（`handleMcpRequest` 纯函数）
- Modify: `src/cli/index.ts`（加 `mcp <path>` 子命令）
- Modify: `tsconfig.main.json`（include 加 `"src/mcp"`）
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Produces:
  - `interface McpRequest { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: Record<string, unknown>; }`
  - `interface McpResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string }; }`
  - `handleMcpRequest(ctx: ApiContext, req: McpRequest): Promise<McpResponse | null>`（notification 返回 null = 不回包）
  - CLI 子命令：`onw mcp <workspace-path>` 跑 stdio MCP 循环。

- [ ] **Step 1: 写失败测试**

创建 `tests/mcp/server.test.ts`（复用 handlers.test 的 ctx fixture 模式）：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import type { ApiContext } from '../../src/ipc/handlers';
import { handleMcpRequest } from '../../src/mcp/server';

describe('mcp server', () => {
  let dir: string;
  let ws: Workspace;
  let ctx: ApiContext;
  let engine: PipelineEngine | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    ws = initWorkspace(dir);
    ctx = {
      ws,
      dbPath: join(ws.onworkingDir, 'db', 'master.db'),
      getEngine: () => (engine ??= new PipelineEngine(ws)),
    };
  });

  afterEach(() => {
    engine?.close();
    engine = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers initialize with protocol version', async () => {
    const res = await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res?.id).toBe(1);
    expect((res?.result as { protocolVersion?: string })?.protocolVersion).toBeTruthy();
  });

  it('lists one tool per api command', async () => {
    const res = await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.map((t) => t.name)).toContain('state.summary');
  });

  it('calls a tool and returns the dispatch result as text content', async () => {
    const res = await handleMcpRequest(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'state.summary', arguments: {} },
    });
    const content = (res?.result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('workspace');
  });

  it('returns a JSON-RPC error for unknown method or tool', async () => {
    const unknownMethod = await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 4, method: 'nope' });
    expect(unknownMethod?.error?.code).toBe(-32601);
    const unknownTool = await handleMcpRequest(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'no.such.tool', arguments: {} },
    });
    expect(unknownTool?.error?.code).toBe(-32602);
  });

  it('returns null for notifications (no reply expected)', async () => {
    const res = await handleMcpRequest(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL，`src/mcp/server` 不存在。

- [ ] **Step 3: 实现 `src/mcp/server.ts`**

```ts
// src/mcp/server.ts
// MCP 适配:同一个 dispatch 包成 MCP server(JSON-RPC 2.0 / stdio 子集)。
// 每个 ApiCommand 映射成一个 MCP tool;tools/call 委托 dispatchIpc。零新依赖。
import { dispatchIpc } from '../ipc/handlers';
import { handlers } from '../ipc/handlers';
import type { ApiCommand } from '../ipc/contracts';
import type { IpcRequest } from '../ipc/contracts';
import type { ApiContext } from '../ipc/handlers';

const PROTOCOL_VERSION = '2024-11-05';

export interface McpRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 注册的所有命令名(来自 handler 表,运行时可查,无类型漂移)。 */
export const commandKinds = Object.keys(handlers).sort();

/** 处理一条 JSON-RPC 请求;notification 无 id,返回 null 表示不回包。 */
export async function handleMcpRequest(
  ctx: ApiContext,
  req: McpRequest,
): Promise<McpResponse | null> {
  const id = req.id ?? null;
  if (req.method.startsWith('notifications/')) return null;

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'onworking', version: '0.2.0' },
      },
    };
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: commandKinds.map((name) => ({
          name,
          description: `onworking command: ${name}`,
          inputSchema: { type: 'object' },
        })),
      },
    };
  }

  if (req.method === 'tools/call') {
    const name = req.params?.name as string | undefined;
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    if (!name || !commandKinds.includes(name)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(name)}` } };
    }
    const request: IpcRequest = { ...(args as unknown as ApiCommand), cmd: name as ApiCommand['cmd'], reqId: 1 };
    const env = await dispatchIpc(request, ctx);
    return {
      jsonrpc: '2.0',
      id,
      result: env.result.ok
        ? { content: [{ type: 'text', text: JSON.stringify(env.result.data) }] }
        : { content: [{ type: 'text', text: JSON.stringify(env.result.error) }], isError: true },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${req.method}` } };
}
```

> 需要 `src/ipc/handlers.ts` 额外 `export const handlers`（当前是局部 const）。Step 3.1：在 handlers.ts 把 `const handlers: {...}` 改为 `export const handlers: {...}`。

- [ ] **Step 4: CLI 加 `mcp <path>` 子命令**

`src/cli/index.ts` 的 `main` 开头加：

```ts
import { handleMcpRequest } from '../mcp/server';

if (argv[0] === 'mcp' && argv[1]) {
  const ctx = createContext(argv[1]);
  for await (const line of stdin) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: import('../mcp/server').McpRequest;
    try {
      req = JSON.parse(trimmed) as import('../mcp/server').McpRequest;
    } catch {
      writer.stderr(JSON.stringify({ error: 'invalid JSON', line: trimmed.slice(0, 200) }));
      continue;
    }
    const res = await handleMcpRequest(ctx, req);
    if (res) writer.stdout(JSON.stringify(res));
  }
  return 0;
}
```

`tsconfig.main.json` 的 include 加 `"src/mcp"`。

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run tests/mcp/server.test.ts`
Run: `npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/ipc/handlers.ts src/cli/index.ts tsconfig.main.json tests/mcp/server.test.ts
git commit -m "feat(mcp): 同一 dispatch 封装 JSON-RPC stdio server,onw mcp <path>"
```

---

## 自审(计划对照 spec)

- **§7 顺序**:① 收契约(T1-T3)② CLI(T4-T6)③ 删冗余(T7-T10)④ 补缺口(T11-T14)全部覆盖。
- **§3 四缺口**:#13 预览(T11)、#9 存模板 tool(T12)、#8 多映射追加(T13)、MCP(T14) 逐一对应。
- **§4 冗余**:3 执行器(T7)、4 批量工具(T8)、cfg 双轨(T9)、`workspace.pick` 与死代码(T10) 逐一对应。`onw-mock.ts` 报告建议「CLI 先行后可删或改造成 CLI 输出做 mock」——本计划保留它（浏览器 vite dev 仍需 `window.onw`），仅在 T10/T11 同步增删 case，标注为可选后续。
- **§5 契约问题**:强类型(T1)、显式 id(T3)、reqId(T2) 已覆盖；`toolImportFiles` 假实现(§5-3)、`toolGetFileHeaders` 形状(§5-4)、`toolApplyTemplate` 重复解析(§5-5)、进度结构化(§5-6) 不在 §7 的 4 阶段清单内，标记为后续独立任务，不在本计划范围。
- **§6 CLI 路径**:createContext 抽出(T4)、NDJSON 循环(T5)、bin 接入(T6)、前端走 IPC 薄客户端(保持 Electron main 现状,方案 a)、MCP 顺势封装(T14) 全部落地。
