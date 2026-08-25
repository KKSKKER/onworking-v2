// scripts/demo-import.ts
// 真实数据端到端演示:源目录 → 自动检测表头/映射 → 清洗管线 → 大表 → 计时。
// 用法: npm run demo:import -- <源目录>
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../src/core/workspace/workspace';
import { useConsoleLogging } from '../src/core/logging';
import { scanSourceDir } from '../src/core/ingest/scanner';
import { parseCsvFile, parseExcelFile } from '../src/core/ingest/parser';
import { detectHeaderRow } from '../src/core/ingest/header-detect';
import { saveBigTableConfig } from '../src/core/bigtable/store';
import { savePipeline } from '../src/core/pipeline/store';
import { saveRule } from '../src/core/rule/store';
import { transformToKind } from '../src/core/rule/compile';
import { PipelineEngine } from '../src/core/pipeline/engine';
import type { FieldMapping } from '../src/core/etl/transform';

useConsoleLogging('info');

const sourceDir = process.argv[2];
if (!sourceDir || !existsSync(sourceDir)) {
  console.error('用法: npm run demo:import -- <源目录>');
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
  const files = scanSourceDir(sourceDir);
  if (files.length === 0) {
    console.error(`源目录没有 xlsx/xls/csv 文件: ${sourceDir}`);
    process.exit(1);
  }
  console.log(`源目录: ${sourceDir}(${files.length} 个文件)`);

  // 用第一个文件自动检测表头并生成映射
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
  console.log(`表头行: ${headerRow}; 列(${headers.length}): ${headers.join(' | ')}`);
  console.log(`映射: ${mappings.map((m) => `${m.sourceHeader}→${m.outputName}:${m.transform}`).join(', ')}`);

  // 临时演示工作区
  const dir = mkdtempSync(join(tmpdir(), 'onw-demo-'));
  const ws = initWorkspace(dir);
  saveBigTableConfig(ws, 'big', {
    tableName: 'big',
    autoIncrement: true,
    fields: mappings.map((m, i) => ({ name: m.outputName, type: dbTypeForTransform(m.transform), order: i + 1 })),
  });
  saveRule(ws, 'big', {
    name: 'big_rule',
    display: 'demo',
    version: 1,
    sources: [{ pattern: '**/*', headerRow }],
    fields: mappings.map((m, i) => ({
      sourceHeader: m.sourceHeader,
      outputName: m.outputName,
      included: true,
      order: i + 1,
      transforms: [{ kind: transformToKind(m.transform) }],
    })),
  });
  savePipeline(ws, {
    kind: 'clean',
    id: 'c1',
    label: 'demo',
    bigTableFolder: 'big',
    sourceDir,
    createdAt: new Date().toISOString(),
  });

  const t0 = Date.now();
  const eng = new PipelineEngine(ws);
  const results = await eng.recomputeAll();
  const elapsed = Date.now() - t0;
  for (const r of results) {
    console.log(`  ${r.pipelineId}: ${r.ok ? `OK ${r.rows} 行` : `失败: ${r.error}`}`);
  }
  const total = results.filter((r) => r.ok).reduce((s, r) => s + (r.rows ?? 0), 0);
  const rate = elapsed > 0 ? Math.round((total / elapsed) * 1000) : 0;
  console.log(`\n总行数: ${total}; 耗时: ${elapsed}ms; 吞吐: ${rate} 行/秒`);
  console.log(`演示工作区(临时): ${dir}`);
  eng.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
