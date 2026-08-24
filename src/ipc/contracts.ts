// src/ipc/contracts.ts
// API 契约:渲染层经 window.onw.invoke 发出的命令 + 统一返回。
// 原则:一切操作都是 API —— UI / 插件 / AI 走同一个入口(设计 §2.3)。
import type { BigTableConfig } from '../core/bigtable/schema';
import type { PipelineConfig } from '../core/pipeline/config';
import type { MappingTemplate } from '../core/template/store';
import type { ParsedSheet } from '../core/ingest/parser';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type ApiCommand =
  | { cmd: 'workspace.open'; path: string }
  | { cmd: 'workspace.pick' }
  | { cmd: 'bigtable.list' }
  | { cmd: 'bigtable.get'; folder: string }
  | { cmd: 'bigtable.save'; folder: string; config: BigTableConfig }
  | { cmd: 'pipeline.list' }
  | { cmd: 'pipeline.save'; config: PipelineConfig }
  | { cmd: 'pipeline.delete'; id: string }
  | { cmd: 'pipeline.run'; id: string }
  | { cmd: 'pipeline.recomputeAll' }
  | { cmd: 'pipeline.recomputeByDependency'; trigger: string }
  | { cmd: 'setup.detectSource'; filePath: string; sheetName?: string }
  | { cmd: 'template.list' }
  | { cmd: 'template.save'; template: MappingTemplate }
  | { cmd: 'template.apply'; name: string; sheet: ParsedSheet }
  | { cmd: 'schema.tables' }
  | { cmd: 'state.summary' }
  | { cmd: 'vcs.status' };

/** IPC 消息信封:请求带 reqId,响应带对应 reqId。 */
export type IpcRequest = ApiCommand & { reqId: number };

export type IpcResponse =
  | { reqId: number; result: ApiResult<unknown> }
  | { reqId: number; event: 'progress' | 'log'; payload: unknown };
