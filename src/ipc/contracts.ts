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
import type { RuleYaml } from '../core/rule/rule';
import type { WorkspaceSettings, AiOpenMode } from '../core/workspace/settings';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** 命令名 → 载荷。这是契约的唯一事实来源。 */
export interface CommandPayloads {
  'workspace.open': { path: string };
  'bigtable.list': {};
  'bigtable.get': { folder: string };
  'bigtable.save': { folder: string; config: BigTableConfig };
  'bigtable.sourceFiles': { folder: string };
  'bigtable.previewRows': { folder: string; limit?: number; offset?: number };
  'bigtable.addFiles': { folder: string; files: string[]; overwrite?: boolean };
  'bigtable.exportCsv': { folder: string; path?: string; includeLineage?: boolean };
  'bigtable.config': { folder: string };
  'mapping.save': { folder: string; headerRow?: number; mappings: FieldMapping[]; ruleName?: string; sheetName?: string; pattern?: string };
  'pipeline.list': {};
  'pipeline.configs': {};
  'pipeline.save': { config: PipelineConfig };
  'pipeline.delete': { id: string };
  'pipeline.run': { id: string };
  'pipeline.mergeBigTable': { folder: string };
  'pipeline.mergeAll': {};
  'pipeline.buildMasterBigTable': { folder: string };
  'pipeline.buildMasterAll': {};
  'pipeline.recomputeAll': {};
  'pipeline.recomputeByDependency': { trigger: string };
  'setup.detectSource': { filePath: string; sheetName?: string };
  'setup.sheets': { filePath: string };
  'setup.preview': { filePath: string; sheetName?: string; headerRow?: number; offset?: number; limit?: number };
  'setup.exportCsv': { filePath: string; sheetName?: string; headerRow?: number; path?: string };
  'query.run': { sql: string; limit?: number };
  'query.exportCsv': { sql: string; path?: string };
  'template.list': {};
  'template.save': { template: MappingTemplate };
  'template.apply': { name: string; sheet: ParsedSheet };
  'schema.tables': {};
  'state.summary': {};
  'vcs.status': {};
  'settings.get': {};
  'settings.setAiMode': { mode: AiOpenMode };
}

/** 命令名 → 成功结果类型。 */
export interface CommandResults {
  'workspace.open': Workspace;
  'bigtable.list': string[];
  'bigtable.get': BigTableConfig;
  'bigtable.save': { saved: string };
  'bigtable.sourceFiles': string[];
  'bigtable.previewRows': { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; total: number };
  'bigtable.addFiles': { added: string[]; overwritten: string[]; skipped: string[] };
  'bigtable.exportCsv': { file: string; rows: number };
  'bigtable.config': { config: BigTableConfig; rules: RuleYaml[]; pipelines: PipelineConfig[] };
  'mapping.save': { ruleFile: string };
  'pipeline.list': string[];
  'pipeline.configs': PipelineConfig[];
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
  'setup.exportCsv': { file: string; rows: number };
  'query.run': QueryOutcome;
  'query.exportCsv': { file: string; rows: number };
  'template.list': string[];
  'template.save': { saved: string };
  'template.apply': { mappings: FieldMapping[]; matched: number; skipped: string[] };
  'schema.tables': { name: string; columns: { name: string; type: string }[] }[];
  'state.summary': string;
  'vcs.status': { staged: string[]; unstaged: string[]; untracked: string[] };
  'settings.get': WorkspaceSettings;
  'settings.setAiMode': { mode: AiOpenMode };
}

export type ApiCommand = {
  [K in keyof CommandPayloads]: { cmd: K } & CommandPayloads[K];
}[keyof CommandPayloads];

/** IPC 消息信封:请求带 reqId,响应带对应 reqId。 */
export type IpcRequest = ApiCommand & { reqId: number };

export type IpcResponse =
  | { reqId: number; result: ApiResult<unknown> }
  | { reqId: number; event: 'progress' | 'log'; payload: unknown };
