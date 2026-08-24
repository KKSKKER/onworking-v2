// src/ipc/handlers.ts
// API handlers:命令 → 工具函数层(前端与 AI 走同一套封装函数),统一返回 ApiResult。
// 操作类命令委托给 src/core/agent/tools.ts 的 tool* 函数;读类命令直接走核心。
import type { Workspace } from '../core/workspace/workspace';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listBigTables, loadBigTableConfig } from '../core/bigtable/store';
import { listPipelines, deletePipeline, loadPipeline } from '../core/pipeline/store';
import { scanSourceDir } from '../core/ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../core/ingest/parser';
import { PipelineEngine } from '../core/pipeline/engine';
import {
  listTemplates,
  saveTemplate,
  loadTemplate,
  applyTemplateToSheet,
} from '../core/template/store';
import { gitStatus } from '../core/versioning/git';
import { ensureWorkspaceVcs } from '../core/versioning/workspace-vcs';
import { AppError, captureError } from '../core/errors';
import type { ApiCommand, ApiResult } from './contracts';
import {
  toolCreateBigTable,
  toolGetFileHeaders,
  toolSetMapping,
  toolCreateCleaningPipeline,
  toolCreateSqlCleanPipeline,
  toolCreateQueryPipeline,
  toolRunCleaning,
  toolMergeBigTable,
  toolMergeAll,
  toolBuildMasterTable,
  toolRunQueryPipeline,
  toolQuery,
  toolGetProjectState,
} from '../core/agent/tools';
import type { PipelineConfig } from '../core/pipeline/config';

export interface ApiContext {
  ws: Workspace;
  dbPath: string;
  /** 惰性获取 PipelineEngine(读表/重算等核心能力)。 */
  getEngine(): PipelineEngine;
  /** 进度事件回调(主进程转发到渲染层)。 */
  emitProgress?(payload: unknown): void;
}

type Payload = Record<string, unknown>;
type Handler = (ctx: ApiContext, payload: Payload) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  'workspace.open': async (ctx) => ctx.ws,

  'bigtable.list': async (ctx) => listBigTables(ctx.ws),
  'bigtable.get': async (_ctx, p) => loadBigTableConfig(_ctx.ws, String(p.folder)),
  'bigtable.save': async (ctx, p) => {
    // 前端保存大表配置 → 工具函数
    toolCreateBigTable(ctx.ws, String(p.folder), p.config as never);
    return { saved: p.folder };
  },
  'bigtable.sourceFiles': async (ctx, p) => {
    const dir = join(ctx.ws.onworkingDir, 'bigtables', String(p.folder), 'source');
    return existsSync(dir) ? scanSourceDir(dir).map((f) => f.path) : [];
  },

  'pipeline.list': async (ctx) => listPipelines(ctx.ws),
  'pipeline.save': async (ctx, p) => {
    // 前端保存管线 → 按类型分发到工具函数(clean 只建管线,不写规则)
    const config = p.config as PipelineConfig;
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
    return toolCreateCleaningPipeline(ctx.ws, config.bigTableFolder, config.sourceDir);
  },
  'mapping.save': async (ctx, p) => {
    // 文件字段映射:只写 YAML 规则,不生成管线
    const folder = String(p.folder);
    const headerRow = Number(p.headerRow ?? 1);
    const mappings = p.mappings as never;
    return toolSetMapping(ctx.ws, folder, headerRow, mappings);
  },
  'pipeline.delete': async (ctx, p) => {
    deletePipeline(ctx.ws, String(p.id));
    return { deleted: p.id };
  },
  'pipeline.run': async (ctx, p) => {
    // 前端运行管线 → 按类型分发到工具函数
    const id = String(p.id);
    const cfg = loadPipeline(ctx.ws, id);
    if (cfg.kind === 'clean') return toolRunCleaning(ctx.ws, id);
    if (cfg.kind === 'sql-clean') return toolBuildMasterTable(ctx.ws, id);
    return toolRunQueryPipeline(ctx.ws, id);
  },
  'pipeline.mergeBigTable': async (ctx, p) => toolMergeBigTable(ctx.ws, String(p.folder)),
  'pipeline.mergeAll': async (ctx) => toolMergeAll(ctx.ws),
  'pipeline.recomputeAll': async (ctx) => ctx.getEngine().recomputeAll(),
  'pipeline.recomputeByDependency': async (ctx, p) =>
    ctx.getEngine().recomputeByDependency(String(p.trigger)),

  'setup.detectSource': async (_ctx, p) => toolGetFileHeaders(String(p.filePath)).detected,
  'setup.sheets': async (_ctx, p) => {
    const filePath = String(p.filePath);
    const sheets = filePath.toLowerCase().endsWith('.csv') ? parseCsvFile(filePath) : parseExcelFile(filePath);
    return sheets.map((s) => s.sheetName);
  },
  'setup.preview': async (_ctx, p) => {
    const filePath = String(p.filePath);
    const offset = Number(p.offset ?? 0);
    const limit = Number(p.limit ?? 100);
    const sheets = filePath.toLowerCase().endsWith('.csv') ? parseCsvFile(filePath) : parseExcelFile(filePath);
    const sheet = (p.sheetName ? sheets.find((s) => s.sheetName === p.sheetName) : undefined) ?? sheets[0];
    const headerRow = Number(p.headerRow ?? 1);
    const full = [sheet.headers, ...sheet.rows];
    const headers = (full[headerRow - 1] ?? []).map((c) => String(c));
    const rows = full.slice(headerRow).slice(offset, offset + limit);
    return { sheetName: sheet.sheetName, headerRow, headers, rows, total: full.length - headerRow };
  },

  'template.list': async (ctx) => listTemplates(ctx.ws),
  'template.save': async (ctx, p) => {
    saveTemplate(ctx.ws, p.template as never);
    return { saved: (p.template as { name: string }).name };
  },
  'template.apply': async (ctx, p) =>
    applyTemplateToSheet(p.sheet as never, loadTemplate(ctx.ws, String(p.name))),

  'schema.tables': async (ctx) => ctx.getEngine().schemaTables(),

  'query.run': async (ctx, p) => {
    const sql = String(p.sql).trim();
    if (!/^(SELECT|WITH)\b/i.test(sql)) {
      throw new AppError({
        module: 'query',
        code: 'QUERY_NOT_SELECT',
        message: 'only SELECT/WITH queries are allowed in the workbench',
        data: { sql },
      });
    }
    return toolQuery(ctx.ws, sql); // 前端查询 → 工具函数
  },

  'state.summary': async (ctx) => toolGetProjectState(ctx.ws),

  'vcs.status': async (ctx) => {
    ensureWorkspaceVcs(ctx.ws);
    return gitStatus(ctx.ws);
  },
};

/** 分发命令;统一捕获错误为 { ok:false }。 */
export async function dispatch(command: ApiCommand, ctx: ApiContext): Promise<ApiResult<unknown>> {
  const handler = handlers[command.cmd];
  if (!handler) {
    return { ok: false, error: { code: 'UNKNOWN_CMD', message: `unknown command: ${command.cmd}` } };
  }
  try {
    const data = await handler(ctx, command as Payload);
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
