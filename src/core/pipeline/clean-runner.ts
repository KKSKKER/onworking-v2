// src/core/pipeline/clean-runner.ts
// 清洗管线执行器:源目录 → 扫描 → 解析(表头行)→ 字段映射 → 行级血缘 → 批量写入大表(独立 DB)。
// 映射来源:优先读该大表的规则 YAML(规则驱动);无规则则回退 cfg.headerRow + cfg.mappings。
import type Database from 'better-sqlite3';
import type { Workspace } from '../workspace/workspace';
import { scanSourceDir } from '../ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../ingest/parser';
import { applyMapping } from '../etl/transform';
import { writeBigTable } from '../etl/writer';
import { attachLineage, lineageColumnNames } from '../lineage';
import { AppError } from '../errors';
import { logger } from '../logging';
import { loadRules } from '../rule/store';
import { compileRule } from '../rule/compile';
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

/** 简单 glob → 正则(pattern 相对于源目录)。双星斜杠匹配任意(含零)层目录。 */
function patternToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?'; // 双星斜杠 → 任意层目录(含零层)
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/\\\\]*';
      i += 1;
    } else if ('+?^${}()|[].\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export async function runCleanPipeline(
  ws: Workspace,
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

  const fieldCols = bigTable.fields
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((f) => ({ name: f.name, sqlType: f.type }));
  const lineageCols = lineageColumnNames().map((c) => ({
    name: c,
    sqlType: c === '__source_row' ? 'INTEGER' : 'TEXT',
  }));
  const colDefs = [...fieldCols, ...lineageCols];

  const extractedAt = new Date().toISOString();
  const allRows: Record<string, unknown>[] = [];

  // 优先规则驱动:读该大表 rules/*.yaml
  const rules = loadRules(ws, cfg.bigTableFolder);
  if (rules.length > 0) {
    let processedFiles = 0;
    for (const rule of rules) {
      const compiled = compileRule(rule);
      for (const source of compiled.sources) {
        const re = patternToRegex(source.pattern);
        const matched = files.filter((f) => re.test(f.relPath) || re.test(f.path));
        for (const file of matched) {
          processedFiles++;
          onProgress?.({ stage: 'parse', percent: Math.round((processedFiles / files.length) * 40) });
          const sheets =
            file.path.toLowerCase().endsWith('.csv')
              ? parseCsvFile(file.path, { headerRow: source.headerRow })
              : parseExcelFile(file.path, { headerRow: source.headerRow });
          const target = source.sheetName
            ? sheets.filter((s) => s.sheetName === source.sheetName)
            : sheets.slice(0, 1);
          for (const sheet of target) {
            const mapped = applyMapping(sheet, compiled.mappings);
            attachLineage(
              mapped,
              { sourceFile: file.path, sourceRow: source.headerRow + 1 },
              extractedAt,
            );
            allRows.push(...mapped);
          }
        }
      }
    }
  } else if (cfg.headerRow && cfg.mappings) {
    // 回退:cfg 驱动(无规则)
    const headerRow = cfg.headerRow;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.({ stage: 'parse', percent: Math.round((i / files.length) * 40) });
      const sheets =
        file.path.toLowerCase().endsWith('.csv')
          ? parseCsvFile(file.path, { headerRow })
          : parseExcelFile(file.path, { headerRow });
      const target = cfg.sheetName
        ? sheets.filter((s) => s.sheetName === cfg.sheetName)
        : sheets.slice(0, 1);
      for (const sheet of target) {
        const mapped = applyMapping(sheet, cfg.mappings);
        attachLineage(mapped, { sourceFile: file.path, sourceRow: headerRow + 1 }, extractedAt);
        allRows.push(...mapped);
      }
    }
  } else {
    throw new AppError({
      module: 'pipeline/clean',
      code: 'CLEAN_NO_RULE_OR_MAPPING',
      message: `big table ${cfg.bigTableFolder} has no rule YAML and cfg has no mappings`,
      data: { bigTableFolder: cfg.bigTableFolder },
    });
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
