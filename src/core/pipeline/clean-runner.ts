// src/core/pipeline/clean-runner.ts
// 清洗管线执行器:源目录 → 扫描 → 解析(表头行)→ 字段映射 → 行级血缘 → 批量写入大表(独立 DB)。
// 表结构按「映射输出列」建(类型取大表字段,默认 TEXT),保证与插入数据一致,不因旧表漂移报错。
// 合并 = 重建大表(先 DROP 再写),重复运行不追加。
import type Database from 'better-sqlite3';
import type { Workspace } from '../workspace/workspace';
import { scanSourceDir } from '../ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../ingest/parser';
import { applyMapping, type FieldMapping } from '../etl/transform';
import { writeBigTable, type ColumnDef } from '../etl/writer';
import { attachLineage, lineageColumnNames } from '../lineage';
import { AppError } from '../errors';
import { logger } from '../logging';
import { loadRules } from '../rule/store';
import { compileRule, type CompiledSource } from '../rule/compile';
import type { CleanPipelineConfig } from './config';
import type { BigTableConfig } from '../bigtable/schema';

const MODULE = 'pipeline/clean';

export interface CleanResult {
  pipelineId: string;
  bigTableFolder: string;
  tableName: string;
  rowsInserted: number;
  files: number;
  /** 入库告警(如重复表头导致映射只取一列、其余列数据不入)。 */
  warnings: string[];
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
        re += '(?:.*/)?';
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

/** 列定义按映射输出列建(类型取大表字段,默认 TEXT)+ 血缘列。 */
function buildColDefs(mappings: FieldMapping[], bigTable: BigTableConfig): ColumnDef[] {
  const fieldType = new Map(bigTable.fields.map((f) => [f.name, f.type]));
  const fieldCols = mappings.map((m) => ({
    name: m.outputName,
    sqlType: fieldType.get(m.outputName) ?? 'TEXT',
  }));
  const lineageCols = lineageColumnNames().map((c) => ({
    name: c,
    sqlType: c === '__source_row' ? 'INTEGER' : 'TEXT',
  }));
  return [...fieldCols, ...lineageCols];
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

  // 映射与来源唯一来自规则 YAML;多份规则按 (pattern|sheetName|headerRow) 去重来源、按 outputName 去重字段
  const rules = loadRules(ws, cfg.bigTableFolder);
  if (rules.length === 0) {
    throw new AppError({
      module: 'pipeline/clean',
      code: 'CLEAN_NO_RULE',
      message: `big table ${cfg.bigTableFolder} has no rule YAML`,
      data: { bigTableFolder: cfg.bigTableFolder },
    });
  }
  const sources: CompiledSource[] = [];
  const mappings: FieldMapping[] = [];
  const seenSource = new Set<string>();
  for (const rule of rules) {
    const compiled = compileRule(rule);
    for (const s of compiled.sources) {
      const key = `${s.pattern}|${s.sheetName ?? ''}|${s.headerRow}`;
      if (seenSource.has(key)) continue;
      seenSource.add(key);
      sources.push(s);
    }
    for (const m of compiled.mappings) {
      if (!mappings.some((e) => e.outputName === m.outputName)) mappings.push(m);
    }
  }
  if (mappings.length === 0) {
    throw new AppError({
      module: 'pipeline/clean',
      code: 'CLEAN_NO_FIELDS',
      message: `rules for ${cfg.bigTableFolder} have no included fields`,
      data: { bigTableFolder: cfg.bigTableFolder },
    });
  }

  // 表结构按映射输出列建 → 与插入数据一致,不因旧表列名漂移报错
  const colDefs = buildColDefs(mappings, bigTable);

  const extractedAt = new Date().toISOString();
  const allRows: Record<string, unknown>[] = [];
  const warnings = new Set<string>();

  // 按规则 sources 处理
  let processedFiles = 0;
  for (const source of sources) {
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
        // 重复表头检测:同名 sourceHeader 多次出现 → 映射只取其一,其余列数据不入(静默丢列)
        for (const m of mappings) {
          const n = sheet.headers.filter((h) => h === m.sourceHeader).length;
          if (n > 1) {
            warnings.add(`表头「${m.sourceHeader}」出现 ${n} 次,映射只取其一,其余列数据不入`);
          }
        }
        const mapped = applyMapping(sheet, mappings);
        attachLineage(mapped, { sourceFile: file.path, sourceSheet: sheet.sheetName, sourceRow: source.headerRow + 1 }, extractedAt);
        allRows.push(...mapped);
      }
    }
  }

  onProgress?.({ stage: 'write', percent: 70 });
  const result = await writeBigTable(
    db,
    bigTable.tableName,
    colDefs,
    allRows,
    (p) => {
      onProgress?.({ stage: 'write', percent: 70 + Math.round(p.percent * 0.3) });
    },
    { dropExisting: true }, // 合并 = 重建大表
  );

  logger.info(MODULE, 'clean complete', {
    pipelineId: cfg.id,
    rows: result.rowsInserted,
    files: files.length,
    warnings: [...warnings],
  });

  return {
    pipelineId: cfg.id,
    bigTableFolder: cfg.bigTableFolder,
    tableName: bigTable.tableName,
    rowsInserted: result.rowsInserted,
    files: files.length,
    warnings: [...warnings],
  };
}
