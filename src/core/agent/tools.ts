// src/core/agent/tools.ts
// AI 工具函数层:SVG 泳道图里 AI(Agent)调用的每个 tool 封装成一个函数。
// 入参 AI 友好,返回结构化结果(含下一步可用的项目状态)。底层复用 core。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openWorkspace, type Workspace } from '../workspace/workspace';
import {
  saveBigTableConfig,
  listBigTables,
  loadBigTableConfig,
  bigTableDbPath,
  bigTableSourceDir,
} from '../bigtable/store';
import type { BigTableConfig, BigTableField } from '../bigtable/schema';
import { scanSourceDir, type ScannedFile } from '../ingest/scanner';
import { parseCsvFile, parseExcelFile, type ParsedSheet } from '../ingest/parser';
import { detectSourceConfig } from '../pipeline/setup';
import { savePipeline, listPipelines, loadPipeline } from '../pipeline/store';
import { PipelineEngine, type RunSummary } from '../pipeline/engine';
import { ProjectState } from '../state/project';
import { loadTemplate, applyTemplateToSheet, saveTemplate, type MappingTemplate } from '../template/store';
import type { FieldMapping } from '../etl/transform';
import { openDatabase } from '../db/database';
import { AppError } from '../errors';
import { saveRule } from '../rule/store';
import type { RuleYaml } from '../rule/rule';
import { transformToKind } from '../rule/compile';

/** tool: 打开/初始化工作区。 */
export function toolOpenWorkspace(path: string): Workspace {
  return openWorkspace(path);
}

/** tool: 项目状态机当前状态(Agent 决定下一步)。 */
export function toolGetProjectState(ws: Workspace): string {
  return new ProjectState(ws).getSummary();
}

/** tool: 创建大表。 */
export function toolCreateBigTable(ws: Workspace, folder: string, config: BigTableConfig): void {
  saveBigTableConfig(ws, folder, config);
}

/** tool: 给大表增加源文件 —— 拷贝到大表自己的 source/ 目录。同名文件:overwrite=false(缺省)跳过,overwrite=true 覆盖。 */
export function toolAddFilesToBigTable(
  ws: Workspace,
  folder: string,
  files: string[],
  opts?: { overwrite?: boolean },
): { added: string[]; overwritten: string[]; skipped: string[] } {
  const destDir = bigTableSourceDir(ws, folder);
  mkdirSync(destDir, { recursive: true });
  const overwrite = opts?.overwrite ?? false;
  const added: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      throw new AppError({
        module: 'bigtable/addFiles',
        code: 'FILE_NOT_FOUND',
        message: `source file not found: ${file}`,
        data: { file },
      });
    }
    const base = basename(file);
    const target = join(destDir, base);
    const existed = existsSync(target);
    if (existed && !overwrite) {
      skipped.push(base);
      continue;
    }
    copyFileSync(file, target);
    if (existed) overwritten.push(base);
    else added.push(base);
  }
  return { added, overwritten, skipped };
}

/** tool: 设置大表字段。 */
export function toolSetBigTableFields(
  ws: Workspace,
  folder: string,
  fields: BigTableField[],
): void {
  const existing = loadBigTableConfig(ws, folder);
  saveBigTableConfig(ws, folder, { ...existing, fields });
}

/** tool: 获取文件表头(sheets 列表 + 自动检测结果)。 */
export function toolGetFileHeaders(filePath: string): {
  sheets: string[];
  detected: { sheetName: string; headerRow: number; headers: string[] };
} {
  const sheets = filePath.toLowerCase().endsWith('.csv') ? parseCsvFile(filePath) : parseExcelFile(filePath);
  return { sheets: sheets.map((s) => s.sheetName), detected: detectSourceConfig(filePath) };
}

/** tool: 导入文件(扫描源目录,返回文件清单)。 */
export function toolImportFiles(ws: Workspace, bigTableFolder: string, sourceDir: string): ScannedFile[] {
  void ws;
  void bigTableFolder;
  const files = scanSourceDir(sourceDir);
  if (files.length === 0) {
    throw new AppError({
      module: 'agent/import',
      code: 'AGENT_NO_FILES',
      message: `no source files in ${sourceDir}`,
      data: { sourceDir },
    });
  }
  return files;
}

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

/** tool: 保存字段映射模板。 */
export function toolSaveTemplate(ws: Workspace, tpl: MappingTemplate): { saved: string } {
  saveTemplate(ws, tpl);
  return { saved: tpl.name };
}

/** tool: 引用模板套用映射。 */
export function toolApplyTemplate(
  ws: Workspace,
  filePath: string,
  templateName: string,
): { mappings: FieldMapping[]; matched: number; skipped: string[] } {
  const sheets = filePath.toLowerCase().endsWith('.csv') ? parseCsvFile(filePath) : parseExcelFile(filePath);
  const sheet: ParsedSheet = sheets[0];
  return applyTemplateToSheet(sheet, loadTemplate(ws, templateName));
}

/** tool: 运行任意管线(按 kind 交给 engine.run:clean→大表 DB,sql-clean/query→总表 DB)。 */
export async function toolRunPipeline(ws: Workspace, id: string): Promise<RunSummary> {
  const eng = new PipelineEngine(ws);
  try {
    return await eng.run(id);
  } finally {
    eng.close();
  }
}

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

/** tool: 创建查询管线(泳道图「保存 pipeline 配置」)。SQL 跑在总表 DB。 */
export function toolCreateQueryPipeline(
  ws: Workspace,
  id: string,
  opts: { sql: string; dependencies: string[]; resultTable: string },
): { pipelineId: string } {
  savePipeline(ws, {
    kind: 'query',
    id,
    label: id,
    sql: opts.sql,
    dependencies: opts.dependencies,
    resultTable: opts.resultTable,
    createdAt: new Date().toISOString(),
  });
  return { pipelineId: id };
}

/** tool: 创建 SQL 清洗管线(大表 → 总表,泳道图「清洗导到 master」)。 */
export function toolCreateSqlCleanPipeline(
  ws: Workspace,
  id: string,
  opts: { bigTables: string[]; sql: string; resultTable: string },
): { pipelineId: string } {
  savePipeline(ws, {
    kind: 'sql-clean',
    id,
    label: id,
    bigTables: opts.bigTables,
    sql: opts.sql,
    resultTable: opts.resultTable,
    createdAt: new Date().toISOString(),
  });
  return { pipelineId: id };
}

/** tool: 临时查询(ad-hoc,SQL 工作台等价)。 */
export function toolQuery(
  ws: Workspace,
  sql: string,
): { columns: string[]; rows: Record<string, unknown>[]; rowCount: number } {
  const eng = new PipelineEngine(ws);
  try {
    return eng.query(sql);
  } finally {
    eng.close();
  }
}

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
