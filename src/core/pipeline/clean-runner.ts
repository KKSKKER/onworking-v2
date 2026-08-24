// src/core/pipeline/clean-runner.ts
// 清洗管线执行器:源目录 → 扫描 → 解析(带表头行)→ 字段映射 → 行级血缘 → 批量写入大表。
import type Database from 'better-sqlite3';
import { scanSourceDir } from '../ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../ingest/parser';
import { applyMapping, dbTypeFor } from '../etl/transform';
import { writeBigTable } from '../etl/writer';
import { attachLineage, lineageColumnNames } from '../lineage';
import { AppError } from '../errors';
import { logger } from '../logging';
import type { CleanPipelineConfig } from './config';
import type { BigTableConfig } from '../bigtable/schema';

const MODULE = 'pipeline/clean';

export interface CleanResult {
  pipelineId: string;
  bigTableFolder: string;
  tableName: string;
  rowsInserted: number;
  files: number;
}

export interface CleanProgress {
  stage: 'scan' | 'parse' | 'map' | 'write';
  percent: number;
}

export async function runCleanPipeline(
  db: Database.Database,
  cfg: CleanPipelineConfig,
  bigTable: BigTableConfig,
  onProgress?: (p: CleanProgress) => void,
): Promise<CleanResult> {
  onProgress?.({ stage: 'scan', percent: 0 });
  const files = scanSourceDir(cfg.sourceDir);
  logger.info(MODULE, 'clean start', {
    pipelineId: cfg.id,
    sourceDir: cfg.sourceDir,
    files: files.length,
  });
  if (files.length === 0) {
    throw new AppError({
      module: 'pipeline/clean',
      code: 'CLEAN_NO_FILES',
      message: `no source files in ${cfg.sourceDir}`,
      data: { sourceDir: cfg.sourceDir },
    });
  }

  // 列定义:大表字段(SQLite 原生类型)+ 血缘列
  const fieldCols = bigTable.fields
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => ({ name: f.name, sqlType: dbTypeFor(f.type) }));
  // __source_row 是行号,须 INTEGER(否则 better-sqlite3 存成 '2.0' 文本)
  const lineageCols = lineageColumnNames().map((c) => ({
    name: c,
    sqlType: c === '__source_row' ? 'INTEGER' : 'TEXT',
  }));
  const colDefs = [...fieldCols, ...lineageCols];

  const extractedAt = new Date().toISOString();
  const allRows: Record<string, unknown>[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.({ stage: 'parse', percent: Math.round((i / files.length) * 40) });
    const sheets =
      file.path.toLowerCase().endsWith('.csv')
        ? parseCsvFile(file.path, { headerRow: cfg.headerRow })
        : parseExcelFile(file.path, { headerRow: cfg.headerRow });
    // 取命名的 sheet;未指定则取第一个
    const target = cfg.sheetName
      ? sheets.filter((s) => s.sheetName === cfg.sheetName)
      : sheets.slice(0, 1);
    for (const sheet of target) {
      const mapped = applyMapping(sheet, cfg.mappings);
      attachLineage(
        mapped,
        { sourceFile: file.path, sourceRow: cfg.headerRow + 1 },
        extractedAt,
      );
      allRows.push(...mapped);
    }
  }

  onProgress?.({ stage: 'write', percent: 70 });
  const result = await writeBigTable(db, bigTable.tableName, colDefs, allRows, (p) => {
    onProgress?.({ stage: 'write', percent: 70 + Math.round(p.percent * 0.3) });
  });

  logger.info(MODULE, 'clean complete', {
    pipelineId: cfg.id,
    rows: result.rowsInserted,
    files: files.length,
  });

  return {
    pipelineId: cfg.id,
    bigTableFolder: cfg.bigTableFolder,
    tableName: bigTable.tableName,
    rowsInserted: result.rowsInserted,
    files: files.length,
  };
}
