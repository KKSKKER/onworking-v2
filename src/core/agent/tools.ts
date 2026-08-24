// src/core/agent/tools.ts
// AI 工具函数层:SVG 泳道图里 AI(Agent)调用的每个 tool 封装成一个函数。
// 入参 AI 友好,返回结构化结果(含下一步可用的项目状态)。底层复用 core。
import { openWorkspace, masterDbPath, type Workspace } from '../workspace/workspace';
import {
  saveBigTableConfig,
  listBigTables,
  loadBigTableConfig,
  bigTableDbPath,
} from '../bigtable/store';
import type { BigTableConfig, BigTableField } from '../bigtable/schema';
import { scanSourceDir, type ScannedFile } from '../ingest/scanner';
import { parseCsvFile, parseExcelFile, type ParsedSheet } from '../ingest/parser';
import { detectSourceConfig } from '../pipeline/setup';
import { savePipeline, listPipelines } from '../pipeline/store';
import { PipelineEngine, type RunSummary } from '../pipeline/engine';
import { ProjectState } from '../state/project';
import { loadTemplate, applyTemplateToSheet } from '../template/store';
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

/** tool: 设置映射 → 写 YAML 规则 + 建清洗管线(规则驱动,参考 V1)。 */
export function toolSetupMapping(
  ws: Workspace,
  bigTableFolder: string,
  sourceDir: string,
  headerRow: number,
  mappings: FieldMapping[],
): { pipelineId: string; ruleFile: string } {
  // 写 YAML 规则(源→大表映射的唯一真源)
  const rule: RuleYaml = {
    name: `${bigTableFolder}_rule`,
    display: `提取规则: ${bigTableFolder}`,
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

  const pipelineId = `c_${Date.now()}`;
  savePipeline(ws, {
    kind: 'clean',
    id: pipelineId,
    label: `${bigTableFolder}清洗`,
    bigTableFolder,
    sourceDir,
    createdAt: new Date().toISOString(),
  });
  return { pipelineId, ruleFile };
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

/** tool: 运行清洗管线(源→大表独立 DB)。 */
export async function toolRunCleaning(ws: Workspace, pipelineId: string): Promise<RunSummary> {
  const eng = new PipelineEngine(ws);
  try {
    return await eng.run(pipelineId);
  } finally {
    eng.close();
  }
}

/** tool: 构建总表(SQL 清洗管线:各大表 DB → 总表 DB)。 */
export async function toolBuildMasterTable(
  ws: Workspace,
  sqlCleanPipelineId: string,
): Promise<RunSummary> {
  const eng = new PipelineEngine(ws);
  try {
    return await eng.run(sqlCleanPipelineId);
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

/** tool: 运行查询管线(SQL → 物化结果表,总表 DB)。 */
export async function toolRunQueryPipeline(ws: Workspace, id: string): Promise<RunSummary> {
  const eng = new PipelineEngine(ws);
  try {
    return await eng.run(id);
  } finally {
    eng.close();
  }
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

/** tool: 验证数据(大表 DB 行数 + 总表 DB 行数)。 */
export function toolVerifyData(ws: Workspace, bigTableFolder: string): { rows: number; masterRows: number } {
  const cfg = loadBigTableConfig(ws, bigTableFolder);
  const btdb = openDatabase(bigTableDbPath(ws, bigTableFolder));
  let rows = 0;
  try {
    rows = (btdb.prepare(`SELECT COUNT(*) AS n FROM "${cfg.tableName}"`).get() as { n: number }).n;
  } finally {
    btdb.close();
  }
  const mdb = openDatabase(masterDbPath(ws));
  let masterRows = 0;
  try {
    masterRows = (mdb.prepare(`SELECT COUNT(*) AS n FROM "${cfg.tableName}"`).get() as { n: number }).n;
  } finally {
    mdb.close();
  }
  return { rows, masterRows };
}

/** 辅助:列出已有大表与管线(Agent 上下文)。 */
export function toolListContext(ws: Workspace): { bigTables: string[]; pipelines: string[] } {
  return {
    bigTables: listBigTables(ws),
    pipelines: listPipelines(ws),
  };
}
