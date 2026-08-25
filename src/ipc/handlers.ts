// src/ipc/handlers.ts
// API handlers:命令 → 工具函数层(前端与 AI 走同一套封装函数),统一返回 ApiResult。
// 操作类命令委托给 src/core/agent/tools.ts 的 tool* 函数;读类命令直接走核心。
// handler 表按 CommandPayloads/CommandResults 强类型:载荷字段由命令名收窄,零 as never/String() 强转。
import type { Workspace } from '../core/workspace/workspace';
import { existsSync } from 'node:fs';
import { listBigTables, loadBigTableConfig, bigTableSourceDir } from '../core/bigtable/store';
import { listPipelines, deletePipeline } from '../core/pipeline/store';
import { scanSourceDir } from '../core/ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../core/ingest/parser';
import { PipelineEngine } from '../core/pipeline/engine';
import {
  listTemplates,
  loadTemplate,
  applyTemplateToSheet,
} from '../core/template/store';
import { gitStatus } from '../core/versioning/git';
import { ensureWorkspaceVcs } from '../core/versioning/workspace-vcs';
import { AppError, captureError } from '../core/errors';
import type { ApiCommand, ApiResult, CommandPayloads, CommandResults, IpcRequest, IpcResponse } from './contracts';
import {
  toolCreateBigTable,
  toolGetFileHeaders,
  toolSetMapping,
  toolCreateCleaningPipeline,
  toolCreateSqlCleanPipeline,
  toolCreateQueryPipeline,
  toolRunPipeline,
  toolRunPipelines,
  toolPreviewCleanResult,
  toolSaveTemplate,
  toolAddFilesToBigTable,
  toolExportBigTableCsv,
  toolExportQueryCsv,
  toolGetBigTableContext,
  toolQuery,
  toolGetProjectState,
} from '../core/agent/tools';

export interface ApiContext {
  ws: Workspace;
  dbPath: string;
  /** 惰性获取 PipelineEngine(读表/重算等核心能力)。 */
  getEngine(): PipelineEngine;
  /** 进度事件回调(主进程转发到渲染层)。 */
  emitProgress?(payload: unknown): void;
}

type HandlerFor<K extends keyof CommandPayloads> = (
  ctx: ApiContext,
  payload: CommandPayloads[K],
) => Promise<CommandResults[K]> | CommandResults[K];

/** 会话命令(排除传输层引导命令 workspace.open)。 */
type SessionCommands = Exclude<keyof CommandPayloads, 'workspace.open'>;

export const handlers: { [K in SessionCommands]: HandlerFor<K> } = {
  'bigtable.list': async (ctx) => listBigTables(ctx.ws),
  'bigtable.get': async (ctx, p) => loadBigTableConfig(ctx.ws, p.folder),
  'bigtable.save': async (ctx, p) => {
    toolCreateBigTable(ctx.ws, p.folder, p.config);
    return { saved: p.folder };
  },
  'bigtable.sourceFiles': async (ctx, p) => {
    const dir = bigTableSourceDir(ctx.ws, p.folder);
    return existsSync(dir) ? scanSourceDir(dir).map((f) => f.path) : [];
  },
  'bigtable.previewRows': async (ctx, p) =>
    toolPreviewCleanResult(ctx.ws, p.folder, { limit: p.limit, offset: p.offset }),
  'bigtable.addFiles': async (ctx, p) =>
    toolAddFilesToBigTable(ctx.ws, p.folder, p.files, { overwrite: p.overwrite }),
  'bigtable.exportCsv': async (ctx, p) =>
    toolExportBigTableCsv(ctx.ws, p.folder, { path: p.path, includeLineage: p.includeLineage }),
  'bigtable.config': async (ctx, p) => toolGetBigTableContext(ctx.ws, p.folder),

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
  'mapping.save': async (ctx, p) =>
    toolSetMapping(ctx.ws, p.folder, p.headerRow ?? 1, p.mappings, { ruleName: p.ruleName, sheetName: p.sheetName, pattern: p.pattern }),
  'pipeline.delete': async (ctx, p) => {
    deletePipeline(ctx.ws, p.id);
    return { deleted: p.id };
  },
  'pipeline.run': async (ctx, p) => toolRunPipeline(ctx.ws, p.id),
  'pipeline.mergeBigTable': async (ctx, p) => toolRunPipelines(ctx.ws, { kind: 'clean', bigTableFolder: p.folder }),
  'pipeline.mergeAll': async (ctx) => toolRunPipelines(ctx.ws, { kind: 'clean' }),
  'pipeline.buildMasterBigTable': async (ctx, p) => toolRunPipelines(ctx.ws, { kind: 'sql-clean', bigTableFolder: p.folder }),
  'pipeline.buildMasterAll': async (ctx) => toolRunPipelines(ctx.ws, { kind: 'sql-clean' }),
  'pipeline.recomputeAll': async (ctx) => ctx.getEngine().recomputeAll(),
  'pipeline.recomputeByDependency': async (ctx, p) => ctx.getEngine().recomputeByDependency(p.trigger),

  'setup.detectSource': async (_ctx, p) => toolGetFileHeaders(p.filePath, p.sheetName).detected,
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
  'template.save': async (ctx, p) => toolSaveTemplate(ctx.ws, p.template),
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

  'query.exportCsv': async (ctx, p) => toolExportQueryCsv(ctx.ws, p.sql, { path: p.path }),

  'state.summary': async (ctx) => toolGetProjectState(ctx.ws),

  'vcs.status': async (ctx) => {
    ensureWorkspaceVcs(ctx.ws);
    return gitStatus(ctx.ws);
  },
};

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

/** 带 reqId 信封的分发(CLI 与 Electron 传输层共用):请求带 reqId,响应回填同 reqId。 */
export async function dispatchIpc(req: IpcRequest, ctx: ApiContext): Promise<IpcResponse> {
  const result = await dispatch(req, ctx);
  return { reqId: req.reqId, result };
}
