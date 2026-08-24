// scripts/setup-demo-workspace.ts
// 创建持久化 V2 演示工作区:自动检测表头 → 建大表 → 建清洗管线 → 导入真实数据。
// 用法: npm run demo:workspace -- <工作区目录> <源目录>
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initWorkspace } from '../src/core/workspace/workspace';
import { useConsoleLogging } from '../src/core/logging';
import { scanSourceDir } from '../src/core/ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../src/core/ingest/parser';
import { detectHeaderRow } from '../src/core/ingest/header-detect';
import { saveBigTableConfig } from '../src/core/bigtable/store';
import { savePipeline } from '../src/core/pipeline/store';
import { PipelineEngine } from '../src/core/pipeline/engine';
import type { FieldMapping } from '../src/core/etl/transform';

useConsoleLogging('info');

const wsPath = process.argv[2];
const sourceDir = process.argv[3];
if (!wsPath || !sourceDir || !existsSync(sourceDir)) {
  console.error('用法: npm run demo:workspace -- <工作区目录> <源目录>');
  process.exit(1);
}

function guessMappings(headers: string[]): FieldMapping[] {
  return headers
    .map((h, i) => ({
      sourceHeader: String(h).trim(),
      outputName: `col_${i}`,
      transform: /金额|借方|贷方|余额|amount|amt/i.test(String(h)) ? ('to-cents' as const) : ('none' as const),
    }))
    .filter((m) => m.sourceHeader !== '');
}

function dbTypeForTransform(t: FieldMapping['transform']): 'TEXT' | 'INTEGER' | 'REAL' {
  return t === 'to-cents' ? 'INTEGER' : 'TEXT';
}

async function main(): Promise<void> {
  mkdirSync(wsPath, { recursive: true });
  const ws = initWorkspace(wsPath);
  console.log(`工作区: ${wsPath}`);

  const files = scanSourceDir(sourceDir);
  if (files.length === 0) {
    console.error(`源目录没有文件: ${sourceDir}`);
    process.exit(1);
  }
  const first = files[0];
  const sheets =
    first.path.toLowerCase().endsWith('.csv')
      ? parseCsvFile(first.path)
      : parseExcelFile(first.path);
  const sheet = sheets[0];
  const fullRows = [sheet.headers, ...sheet.rows];
  const headerIdx = detectHeaderRow({ sheetName: sheet.sheetName, headers: [], rows: fullRows });
  const headerRow = headerIdx === -1 ? 1 : headerIdx + 1;
  const headers = headerRow <= 1 ? sheet.headers : fullRows[headerRow - 1].map((c) => String(c));
  const mappings = guessMappings(headers);
  console.log(`源目录: ${sourceDir}(${files.length} 文件),表头行 ${headerRow},${headers.length} 列`);

  saveBigTableConfig(ws, '序时账', {
    tableName: 'seq',
    autoIncrement: true,
    fields: mappings.map((m, i) => ({ name: m.outputName, type: dbTypeForTransform(m.transform), order: i + 1 })),
  });
  savePipeline(ws, {
    kind: 'clean',
    id: 'c1',
    label: '序时账清洗',
    bigTableFolder: '序时账',
    sourceDir,
    headerRow,
    mappings,
    createdAt: new Date().toISOString(),
  });
  // SQL 清洗管线:大表 DB → 总表 DB
  const alias = 'bt_序时账';
  savePipeline(ws, {
    kind: 'sql-clean',
    id: 'm1',
    label: '构建总表',
    bigTables: ['序时账'],
    sql: `SELECT * FROM "${alias}".seq`,
    resultTable: 'seq',
    createdAt: new Date().toISOString(),
  });

  const eng = new PipelineEngine(ws);
  const results = await eng.recomputeAll();
  for (const r of results) {
    console.log(`  ${r.pipelineId}: ${r.ok ? `OK ${r.rows} 行` : `失败 ${r.error}`}`);
  }
  eng.close();
  console.log(`\n演示工作区已就绪。在应用里「打开工作区」选: ${wsPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
