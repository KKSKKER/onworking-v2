// src/ipc/handlers.ts
// API handlers:命令 → 核心调用,统一返回 ApiResult。
// 主进程把 ipcMain.handle 接到 dispatch;渲染层经 window.onw.invoke 调用。
import type { Workspace } from '../core/workspace/workspace';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listBigTables, loadBigTableConfig, saveBigTableConfig } from '../core/bigtable/store';
import { listPipelines, savePipeline, deletePipeline } from '../core/pipeline/store';
import { scanSourceDir } from '../core/ingest/scanner';
import { PipelineEngine } from '../core/pipeline/engine';
import { detectSourceConfig } from '../core/pipeline/setup';
import {
  listTemplates,
  saveTemplate,
  loadTemplate,
  applyTemplateToSheet,
} from '../core/template/store';
import { ProjectState } from '../core/state/project';
import { gitStatus } from '../core/versioning/git';
import { ensureWorkspaceVcs } from '../core/versioning/workspace-vcs';
import { captureError } from '../core/errors';
import type { ApiCommand, ApiResult } from './contracts';

export interface ApiContext {
  ws: Workspace;
  dbPath: string;
  /** 惰性获取 PipelineEngine(主进程缓存单例;测试可每次新建)。 */
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
    saveBigTableConfig(ctx.ws, String(p.folder), p.config as never);
    return { saved: p.folder };
  },
  'bigtable.sourceFiles': async (ctx, p) => {
    // 大表源目录:.onworking/bigtables/<folder>/source/(不存在返回空)
    const dir = join(ctx.ws.onworkingDir, 'bigtables', String(p.folder), 'source');
    return existsSync(dir) ? scanSourceDir(dir).map((f) => f.path) : [];
  },

  'pipeline.list': async (ctx) => listPipelines(ctx.ws),
  'pipeline.save': async (ctx, p) => {
    savePipeline(ctx.ws, p.config as never);
    return { saved: (p.config as { id: string }).id };
  },
  'pipeline.delete': async (ctx, p) => {
    deletePipeline(ctx.ws, String(p.id));
    return { deleted: p.id };
  },
  'pipeline.run': async (ctx, p) => {
    const eng = ctx.getEngine();
    try {
      return await eng.run(String(p.id), (prog) =>
        ctx.emitProgress?.({ pipelineId: p.id, progress: prog }),
      );
    } finally {
      eng.close();
    }
  },
  'pipeline.recomputeAll': async (ctx) => {
    const eng = ctx.getEngine();
    try {
      return await eng.recomputeAll();
    } finally {
      eng.close();
    }
  },
  'pipeline.recomputeByDependency': async (ctx, p) => {
    const eng = ctx.getEngine();
    try {
      return await eng.recomputeByDependency(String(p.trigger));
    } finally {
      eng.close();
    }
  },

  'setup.detectSource': async (_ctx, p) =>
    detectSourceConfig(String(p.filePath), p.sheetName ? String(p.sheetName) : undefined),

  'template.list': async (ctx) => listTemplates(ctx.ws),
  'template.save': async (ctx, p) => {
    saveTemplate(ctx.ws, p.template as never);
    return { saved: (p.template as { name: string }).name };
  },
  'template.apply': async (ctx, p) =>
    applyTemplateToSheet(p.sheet as never, loadTemplate(ctx.ws, String(p.name))),

  'schema.tables': async (ctx) => {
    const eng = ctx.getEngine();
    try {
      return eng.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();
    } finally {
      eng.close();
    }
  },

  'state.summary': async (ctx) => new ProjectState(ctx.ws).getSummary(),

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
