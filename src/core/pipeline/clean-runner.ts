// src/core/pipeline/clean-runner.ts
// 清洗管线执行器:源目录 → 扫描 → 解析(表头行)→ 字段映射 → 行级血缘 → 批量写入大表(独立 DB)。
// 表结构按「映射输出列」建(类型取大表字段,默认 TEXT),保证与插入数据一致,不因旧表漂移报错。
// 合并 = 重建大表(先 DROP 再写),重复运行不追加。
import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import type { Workspace } from '../workspace/workspace';
import { scanSourceDir } from '../ingest/scanner';
import { parseCsvFile, readExcelSheetStream, type SheetRowStream } from '../ingest/parser';
import { applyMappingRow, buildColIndex, type FieldMapping } from '../etl/transform';
import { canonicalizeHeaders, resolveHeaderIndex } from '../etl/headers';
import { insertRowsInBatches, type ColumnDef } from '../etl/writer';
import { attachLineage, lineageColumnNames } from '../lineage';
import { AppError } from '../errors';
import { logger } from '../logging';
import { loadRules } from '../rule/store';
import { compileRule } from '../rule/compile';
import { patternToRegex } from '../glob';
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
  /** 源文件中存在但未被任何映射引用的表头(数据未导入大表)。 */
  unusedHeaders: string[];
}

export interface CleanProgress {
  stage: 'scan' | 'parse' | 'map' | 'write';
  percent: number;
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
  // 字段列:所有规则的输出列按 outputName 去重(建表结构)。
  // 行处理不再全局合并映射——不同规则可有不同 sourceHeader 映射到同一列(如各月「N月应付工资暂估→current_month_estimate」)。
  const colMappings: FieldMapping[] = [];
  {
    const seen = new Set<string>();
    for (const rule of rules) {
      for (const m of compileRule(rule).mappings) {
        if (!seen.has(m.outputName)) { seen.add(m.outputName); colMappings.push(m); }
      }
    }
  }
  if (colMappings.length === 0) {
    throw new AppError({
      module: 'pipeline/clean',
      code: 'CLEAN_NO_FIELDS',
      message: `rules for ${cfg.bigTableFolder} have no included fields`,
      data: { bigTableFolder: cfg.bigTableFolder },
    });
  }

  // 表结构按映射输出列建 → 与插入数据一致,不因旧表列名漂移报错
  const colDefs = buildColDefs(colMappings, bigTable);

  const extractedAt = new Date().toISOString();
  const warnings = new Set<string>();
  const seenSource = new Set<string>();
  // 源表头中被映射引用之外的(数据未导入大表)。跨文件/跨规则去重汇总。
  const unusedHeaders = new Set<string>();

  // 按规则独立处理:每条规则只把自己的映射应用到它匹配的文件。
  // produceRows() 是惰性 AsyncGenerator:insertRowsInBatches 边拉边写,全程不物化 allRows。
  async function* produceRows(): AsyncGenerator<Record<string, unknown>> {
    let processedFiles = 0;
    for (const rule of rules) {
      const compiled = compileRule(rule);
      const ruleMappings = compiled.mappings;
      for (const source of compiled.sources) {
        const srcKey = `${source.pattern}|${source.sheetName ?? ''}|${source.headerRow}`;
        if (seenSource.has(srcKey)) continue;
        seenSource.add(srcKey);
        const re = patternToRegex(source.pattern);
        const matched = files.filter((f) => re.test(f.relPath) || re.test(f.path));
        for (const file of matched) {
          processedFiles++;
          onProgress?.({ stage: 'parse', percent: Math.round((processedFiles / files.length) * 70) });
          let stream: SheetRowStream | null;
          try {
            // 有 sheetName → 只解析该 sheet(避免全表解析被「格式蔓延」的假大范围拖慢);否则取第一张
            const isCsv = file.path.toLowerCase().endsWith('.csv');
            if (isCsv) {
              const sheets = parseCsvFile(file.path, { headerRow: source.headerRow });
              const sheet = source.sheetName
                ? sheets.find((s) => s.sheetName === source.sheetName)
                : sheets[0];
              stream = sheet
                ? { sheetName: sheet.sheetName, headers: sheet.headers, rows: csvRows(sheet.rows) }
                : null;
            } else {
              stream = await readExcelSheetStream(file.path, source.sheetName, { headerRow: source.headerRow });
            }
          } catch (e) {
            // 单个文件读不了(如密码保护/损坏)不拖垮整条管线:跳过并在告警里说明
            warnings.add(`跳过无法读取的文件 ${basename(file.path)}: ${(e as Error).message}`);
            continue;
          }
          if (!stream) continue; // 目标 sheet 不存在 → 该文件跳过

          // 统一规范化表头 + 解析映射:裸名命中重复表头 → 整个 run 失败(配置错误,
          // 必须抛错,不落入上面"跳过文件"的 catch 分支 → engine 包成 ok:false)
          const canonical = canonicalizeHeaders(stream.headers);
          for (const m of ruleMappings) {
            const r = resolveHeaderIndex(canonical, m.sourceHeader);
            if (r.kind === 'duplicate-bare') {
              throw new AppError({
                module: 'pipeline/clean',
                code: 'CLEAN_DUPLICATE_HEADER',
                message: r.error,
                data: { sourceFile: file.path, sourceHeader: m.sourceHeader },
              });
            }
          }
          // 未用表头检测:源表头(规范名)里没被当前规则任一映射 sourceHeader 引用的,
          // 数据不会进大表 —— 收集起来返回给 agent(可能有映射漏写/拼写不匹配)
          const mappedHeaders = new Set(ruleMappings.map((m) => m.sourceHeader));
          for (const h of canonical.names) {
            if (!mappedHeaders.has(h)) unusedHeaders.add(h);
          }
          const colIndex = buildColIndex(canonical.names);
          let rowNo = 0;
          try {
            for await (const row of stream.rows) {
              const mapped = applyMappingRow(row, colIndex, ruleMappings);
              attachLineage([mapped], {
                sourceFile: file.path,
                sourceSheet: stream.sheetName,
                sourceRow: source.headerRow + 1 + rowNo,
              }, extractedAt);
              rowNo++;
              yield mapped;
            }
          } catch (e) {
            warnings.add(`跳过无法读取的文件 ${basename(file.path)}: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  const result = await insertRowsInBatches(db, bigTable.tableName, colDefs, produceRows(), {
    dropExisting: true, // 合并 = 重建大表
  });
  onProgress?.({ stage: 'write', percent: 100 });

  const unused = [...unusedHeaders].sort();
  if (unused.length > 0) {
    warnings.add(`以下源表头未被任何映射使用(数据未导入大表): ${unused.join(', ')}`);
  }

  logger.info(MODULE, 'clean complete', {
    pipelineId: cfg.id,
    rows: result.rowsInserted,
    files: files.length,
    warnings: [...warnings],
    unusedHeaders: unused,
  });

  return {
    pipelineId: cfg.id,
    bigTableFolder: cfg.bigTableFolder,
    tableName: bigTable.tableName,
    rowsInserted: result.rowsInserted,
    files: files.length,
    warnings: [...warnings],
    unusedHeaders: unused,
  };
}

/** 把已物化的 CSV 行包成异步生成器(与 readExcelSheetStream 的 rows 同构)。 */
function csvRows(rows: unknown[][]): AsyncGenerator<unknown[]> {
  return (async function* () {
    for (const r of rows) yield r;
  })();
}
