// src/core/agent/tools.ts
// AI 工具函数层:SVG 泳道图里 AI(Agent)调用的每个 tool 封装成一个函数。
// 入参 AI 友好,返回结构化结果(含下一步可用的项目状态)。底层复用 core。
import { copyFileSync, mkdirSync, existsSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import { openWorkspace, masterDbPath, type Workspace } from '../workspace/workspace';
import { loadSettings, saveSettings, type WorkspaceSettings, type AiOpenMode } from '../workspace/settings';
import {
  saveBigTableConfig,
  listBigTables,
  loadBigTableConfig,
  bigTableDbPath,
  bigTableSourceDir,
} from '../bigtable/store';
import type { BigTableConfig, BigTableField } from '../bigtable/schema';
import { scanSourceDir, type ScannedFile } from '../ingest/scanner';
import { parseCsvFile, parseExcelFile, parseExcelSheet, type ParsedSheet } from '../ingest/parser';
import { detectSourceConfig } from '../pipeline/setup';
import { savePipeline, listPipelines, loadPipeline, listPipelinesForBigTable } from '../pipeline/store';
import { PipelineEngine, type RunSummary, type TableInfo, type QueryOutcome } from '../pipeline/engine';
import { patternToRegex } from '../glob';
import { ProjectState } from '../state/project';
import { loadTemplate, applyTemplateToSheet, saveTemplate, type MappingTemplate } from '../template/store';
import type { FieldMapping, ValueTransform } from '../etl/transform';
import { openDatabase } from '../db/database';
import { AppError } from '../errors';
import { saveRule, loadRules } from '../rule/store';
import type { RuleYaml } from '../rule/rule';
import { transformToKind } from '../rule/compile';
import type { PipelineConfig } from '../pipeline/config';

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

/** CSV 字段转义(RFC 4180):含逗号/引号/换行时用双引号包裹,内部引号翻倍。 */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** tool: 导出大表数据到 CSV 文件。缺省不含血缘列,写 `<工作区根>/exports/<tableName>.csv`。未清洗/空表导出空 CSV(表头取配置字段名)。 */
export function toolExportBigTableCsv(
  ws: Workspace,
  folder: string,
  opts?: { path?: string; includeLineage?: boolean },
): { file: string; rows: number } {
  const cfg = loadBigTableConfig(ws, folder);
  const dbPath = bigTableDbPath(ws, folder);
  let rows: Record<string, unknown>[] = [];
  if (existsSync(dbPath)) {
    const db = openDatabase(dbPath);
    try {
      const tableExists = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(cfg.tableName);
      if (tableExists) {
        rows = db.prepare(`SELECT * FROM "${cfg.tableName}"`).all() as Record<string, unknown>[];
      }
    } finally {
      db.close();
    }
  }
  const allCols = rows.length > 0 ? Object.keys(rows[0]) : cfg.fields.map((f) => f.name);
  const cols = opts?.includeLineage ? allCols : allCols.filter((c) => !c.startsWith('__'));
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  const file = opts?.path ?? join(ws.root, 'exports', `${cfg.tableName}.csv`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n'), 'utf-8');
  return { file, rows: rows.length };
}

/** tool: 从总表导出查询结果到 CSV(交付清洗后的总表)。仅 SELECT/WITH。folder 给定时导出大表 DB。 */
export function toolExportQueryCsv(
  ws: Workspace,
  sql: string,
  opts?: { path?: string; folder?: string },
): { file: string; rows: number } {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new AppError({
      module: 'query',
      code: 'QUERY_NOT_SELECT',
      message: 'only SELECT/WITH queries are allowed in the workbench',
      data: { sql },
    });
  }
  const db = openDatabase(opts?.folder ? bigTableDbPath(ws, opts.folder) : masterDbPath(ws), { wal: false });
  try {
    const rows = db.prepare(trimmed).all() as Record<string, unknown>[];
    const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    const file = opts?.path ?? join(ws.root, 'exports', 'query.csv');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join('\n'), 'utf-8');
    return { file, rows: rows.length };
  } finally {
    db.close();
  }
}

/** tool: 读取工作区设置(含 AI 开放模式)。 */
export function toolGetSettings(ws: Workspace): WorkspaceSettings {
  return loadSettings(ws);
}

/** tool: 设置 AI 开放模式(写入 .onworking/settings.json)。 */
export function toolSetAiMode(ws: Workspace, mode: AiOpenMode): { mode: AiOpenMode } {
  saveSettings(ws, { ...loadSettings(ws), aiOpenMode: mode });
  return { mode };
}

/** tool: 列出全部管线配置(含 kind/依赖/结果表),供「管线管理」视图分组展示。 */
export function toolListPipelineConfigs(ws: Workspace): PipelineConfig[] {
  return listPipelines(ws).map((id) => loadPipeline(ws, id));
}

/** tool: 读取选中大表关联的全部配置(大表配置 + 规则 YAML + 关联管线),供前端实时渲染。 */
export function toolGetBigTableContext(ws: Workspace, folder: string): {
  folder: string;
  /** 大表自己的源文件目录(sourceDir 清洗输入,确定性的,不用用户手填)。 */
  sourceDir: string;
  config: BigTableConfig;
  rules: RuleYaml[];
  pipelines: PipelineConfig[];
} {
  const config = loadBigTableConfig(ws, folder);
  const rules = loadRules(ws, folder);
  const pipelines = listPipelinesForBigTable(ws, folder);
  return { folder, sourceDir: bigTableSourceDir(ws, folder), config, rules, pipelines };
}

/** tool: 导出源文件指定 sheet 为 CSV(与预览同视角,含表头行)。 */
export function toolExportSourceCsv(
  ws: Workspace,
  filePath: string,
  opts?: { sheetName?: string; headerRow?: number; path?: string },
): { file: string; rows: number } {
  const headerRow = opts?.headerRow ?? 1;
  const sheets = filePath.toLowerCase().endsWith('.csv')
    ? parseCsvFile(filePath, { headerRow })
    : parseExcelFile(filePath, { headerRow });
  const sheet = (opts?.sheetName ? sheets.find((s) => s.sheetName === opts.sheetName) : undefined) ?? sheets[0];
  const cols = sheet.headers;
  const lines = [cols.join(',')];
  for (const row of sheet.rows) lines.push(cols.map((_, j) => csvEscape(row[j])).join(','));
  const base = basename(filePath).replace(/\.(xlsx|xls|csv)$/i, '');
  const file = opts?.path ?? join(ws.root, 'exports', `${base}.csv`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n'), 'utf-8');
  return { file, rows: sheet.rows.length };
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

function assertSafeFolder(folder: string): void {
  if (!folder || /[\\/]|\.\./.test(folder)) {
    throw new AppError({
      module: 'agent',
      code: 'BAD_FOLDER',
      message: `folder 必须是简单名称(不能含路径分隔符或 ..): ${folder}`,
      data: { folder },
    });
  }
}

/** tool: 删除大表 —— 删掉 .onworking/bigtables/<folder> 整个文件夹 + 状态记录。破坏性操作,UI 侧需确认。 */
export function toolDeleteBigTable(ws: Workspace, folder: string): { deleted: string } {
  assertSafeFolder(folder);
  rmSync(join(ws.onworkingDir, 'bigtables', folder), { recursive: true, force: true });
  new ProjectState(ws).removeBigTable(folder);
  return { deleted: folder };
}

/** tool: 删除大表源文件 —— 只删 source 目录内的一个文件;路径必须落在 source 目录内。 */
export function toolDeleteSourceFile(ws: Workspace, folder: string, file: string): { deleted: string } {
  assertSafeFolder(folder);
  const destDir = resolve(bigTableSourceDir(ws, folder));
  const target = resolve(destDir, file);
  if (target !== destDir && !target.startsWith(destDir + sep)) {
    throw new AppError({
      module: 'agent',
      code: 'BAD_FILE_PATH',
      message: `file 必须在大表 source 目录内: ${file}`,
      data: { folder, file },
    });
  }
  if (!existsSync(target)) {
    throw new AppError({
      module: 'agent',
      code: 'FILE_NOT_FOUND',
      message: `source file not found: ${file}`,
      data: { folder, file },
    });
  }
  unlinkSync(target);
  return { deleted: relative(destDir, target) || basename(target) };
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

/** tool: 获取文件表头(sheets 列表 + 自动检测结果)。sheetName 指定对哪个 sheet 检测。 */
export function toolGetFileHeaders(filePath: string, sheetName?: string): {
  sheets: string[];
  detected: { sheetName: string; headerRow: number; headers: string[] };
} {
  const sheets = filePath.toLowerCase().endsWith('.csv') ? parseCsvFile(filePath) : parseExcelFile(filePath);
  return { sheets: sheets.map((s) => s.sheetName), detected: detectSourceConfig(filePath, sheetName) };
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

const VALID_TRANSFORMS: ReadonlySet<ValueTransform> = new Set<ValueTransform>(['none', 'to-cents', 'normalize-date', 'trim']);

/** 校验规则的 sourceHeader 是否存在于规则匹配的实际文件的表头。
 *  返回缺失的 sourceHeader 与目标表头合集;无法解析(无匹配文件/密码保护/读不了)时返回空(跳过校验)。 */
function findMissingSourceHeaders(
  ws: Workspace,
  bigTableFolder: string,
  pattern: string,
  sheetName: string | undefined,
  headerRow: number,
  mappings: FieldMapping[],
): { missing: string[]; actual: string[] } {
  const dir = bigTableSourceDir(ws, bigTableFolder);
  if (!existsSync(dir)) return { missing: [], actual: [] };
  const re = patternToRegex(pattern);
  const files = scanSourceDir(dir).filter((f) => re.test(f.relPath) || re.test(f.path));
  if (files.length === 0) return { missing: [], actual: [] };
  const parsedSheets: ParsedSheet[] = [];
  for (const file of files) {
    try {
      const isCsv = file.path.toLowerCase().endsWith('.csv');
      const sheet = sheetName
        ? (isCsv ? parseCsvFile(file.path, { headerRow }).find((s) => s.sheetName === sheetName) : parseExcelSheet(file.path, sheetName, { headerRow }))
        : (isCsv ? parseCsvFile(file.path, { headerRow })[0] : parseExcelFile(file.path, { headerRow })[0]);
      if (sheet) parsedSheets.push(sheet);
    } catch { /* 单文件读不了跳过 */ }
  }
  if (parsedSheets.length === 0) return { missing: [], actual: [] }; // 无法解析 → 跳过校验
  const actual = [...new Set(parsedSheets.flatMap((s) => s.headers))].filter((h) => h !== '');
  const missing = mappings.filter((m) => !parsedSheets.some((s) => s.headers.includes(m.sourceHeader))).map((m) => m.sourceHeader);
  return { missing, actual };
}

/** tool: 设置字段映射 —— 只写 YAML 规则,不生成管线。ruleName 缺省 `<folder>_rule`,可传不同名追加第 N 份;pattern 指定文件匹配(缺省匹配全部文件),sheetName 指定某个 sheet —— 一个规则 = 一个「文件 × sheet」映射。 */
export function toolSetMapping(
  ws: Workspace,
  bigTableFolder: string,
  headerRow: number,
  mappings: FieldMapping[],
  opts?: { ruleName?: string; sheetName?: string; pattern?: string },
): { ruleFile: string } {
  // 入参校验:结构错误(尤其 outputName 写成 targetField)会静默生成 undefined 列、写废整表数据,必须在写规则前拒绝。
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw new AppError({
      module: 'agent',
      code: 'MAPPING_BAD_FIELD',
      message: 'mapping.save 需要 mappings 数组(至少一条,每项 = {sourceHeader, outputName})',
    });
  }
  mappings.forEach((m, i) => {
    const idx = `mappings[${i}]`;
    if (typeof m?.sourceHeader !== 'string' || m.sourceHeader.trim() === '') {
      throw new AppError({
        module: 'agent',
        code: 'MAPPING_BAD_FIELD',
        message: `${idx}.sourceHeader 必填(源文件列名)`,
        data: { index: i, field: 'sourceHeader' },
      });
    }
    if (typeof m?.outputName !== 'string' || m.outputName.trim() === '') {
      throw new AppError({
        module: 'agent',
        code: 'MAPPING_BAD_FIELD',
        message: `${idx}.outputName 必填(目标列名)。注意字段名是 outputName,不是 targetField —— 写错会静默生成 undefined 列`,
        data: { index: i, field: 'outputName' },
      });
    }
    if (m.transform !== undefined && !VALID_TRANSFORMS.has(m.transform)) {
      throw new AppError({
        module: 'agent',
        code: 'MAPPING_BAD_FIELD',
        message: `${idx}.transform 取值「${String(m.transform)}」不合法;允许: ${[...VALID_TRANSFORMS].join(' | ')}`,
        data: { index: i, field: 'transform', value: m.transform },
      });
    }
  });
  // 表头校验:sourceHeader 必须存在于规则匹配的实际文件表头,否则规则写入即错(如「01月」vs「1月」前导 0 差异)。
  const { missing, actual } = findMissingSourceHeaders(ws, bigTableFolder, opts?.pattern ?? '**/*', opts?.sheetName, headerRow, mappings);
  if (missing.length > 0) {
    throw new AppError({
      module: 'agent',
      code: 'MAPPING_HEADER_MISMATCH',
      message: `映射的源字段在目标文件表头中不存在: ${missing.join(', ')}\n目标表头有: ${actual.slice(0, 40).join('、')}。请核对源字段(注意前导 0 / 空格 / 换行差异)`,
      data: { missing },
    });
  }
  const name = opts?.ruleName ?? `${bigTableFolder}_rule`;
  const rule: RuleYaml = {
    name,
    display: `提取规则: ${name}`,
    version: 1,
    sources: [{
      pattern: opts?.pattern ?? '**/*',
      headerRow,
      ...(opts?.sheetName ? { sheetName: opts.sheetName } : {}),
    }],
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

/** tool: 临时查询(ad-hoc,SQL 工作台等价)。folder 给定时操作大表 DB,否则总表 DB。 */
export function toolQuery(
  ws: Workspace,
  sql: string,
  folder?: string,
): QueryOutcome {
  const eng = new PipelineEngine(ws);
  try {
    return folder ? eng.queryBigTable(folder, sql) : eng.query(sql);
  } finally {
    eng.close();
  }
}

/** tool: 表清单(含列结构)。folder 给定时列大表 DB,否则总表 DB。 */
export function toolSchemaTables(ws: Workspace, folder?: string): TableInfo[] {
  const eng = new PipelineEngine(ws);
  try {
    return folder ? eng.schemaTablesBigTable(folder) : eng.schemaTables();
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
