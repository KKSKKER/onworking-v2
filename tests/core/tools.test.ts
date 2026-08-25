import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { toolRunPipeline, toolRunPipelines, toolPreviewCleanResult, toolSaveTemplate, toolSetMapping, toolAddFilesToBigTable, toolExportBigTableCsv } from '../../src/core/agent/tools';
import { listTemplates } from '../../src/core/template/store';
import { listRules, loadRules } from '../../src/core/rule/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';

describe('tools', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tools-'));
    ws = initWorkspace(dir);
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    saveBigTableConfig(ws, 'seq', {
      tableName: 'seq',
      autoIncrement: true,
      fields: [
        { name: 'date', type: 'TEXT', order: 1 },
        { name: 'debit', type: 'INTEGER', order: 2 },
      ],
    });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额'],
      ['2024-01', 100],
      ['2024-02', 200],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
    saveRule(ws, 'seq', {
      name: 'seq_rule',
      display: '规则',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
        { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
      ],
    });
    savePipeline(ws, {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      createdAt: '',
    });
    savePipeline(ws, {
      kind: 'sql-clean',
      id: 'm1',
      label: '',
      bigTables: ['seq'],
      sql: 'SELECT date, debit FROM "bt_seq".seq',
      resultTable: 'seq',
      createdAt: '',
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('toolRunPipeline runs any kind by id', async () => {
    const clean = await toolRunPipeline(ws, 'c1');
    expect(clean.ok).toBe(true);
    expect(clean.rows).toBe(2);
    const master = await toolRunPipeline(ws, 'm1');
    expect(master.ok).toBe(true);
  });

  it('toolRunPipelines filters pipelines by kind and folder', async () => {
    const cleanOnly = await toolRunPipelines(ws, { kind: 'clean' });
    expect(cleanOnly.map((r) => r.pipelineId)).toEqual(['c1']);

    const masterOne = await toolRunPipelines(ws, { kind: 'sql-clean', bigTableFolder: 'seq' });
    expect(masterOne.map((r) => r.pipelineId)).toEqual(['m1']);

    const none = await toolRunPipelines(ws, { kind: 'clean', bigTableFolder: 'other' });
    expect(none).toEqual([]);
  });

  it('toolPreviewCleanResult reads the big table DB read-only', async () => {
    await toolRunPipeline(ws, 'c1');
    const res = toolPreviewCleanResult(ws, 'seq');
    expect(res.columns).toContain('date');
    expect(res.total).toBe(2);
    expect(res.rows).toHaveLength(2);
    const paged = toolPreviewCleanResult(ws, 'seq', { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
  });

  it('toolSaveTemplate persists a mapping template', () => {
    const res = toolSaveTemplate(ws, { name: 'tpl1', mappings: [], createdAt: '2026-08-25T00:00:00.000Z' });
    expect(res).toEqual({ saved: 'tpl1' });
    expect(listTemplates(ws)).toContain('tpl1');
  });

  it('toolSetMapping appends a second named rule, both apply on clean', async () => {
    // 在现有 sourceDir 里追加一个带「摘要」列的源文件(两个文件共 4 行)
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额', '摘要'],
      ['2024-03', 300, '工资'],
      ['2024-04', 400, '报销'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'b.xlsx'));

    // 第一份规则(默认名):日期/借方
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
      { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
    ]);
    // 追加第二份规则:摘要(不同 ruleName,不覆盖)
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '摘要', outputName: 'note', transform: 'trim' },
    ], { ruleName: 'seq_rule_2' });
    expect(listRules(ws, 'seq').length).toBe(2);

    const eng = new PipelineEngine(ws);
    const r = await eng.run('c1');
    eng.close();
    expect(r.ok).toBe(true);
    const preview = toolPreviewCleanResult(ws, 'seq');
    expect(preview.columns).toContain('note');
    expect(preview.total).toBe(4); // a.xlsx 2 行 + b.xlsx 2 行
  });

  it('toolAddFilesToBigTable copies files into the big table source dir', () => {
    const srcFile = join(dir, 'a.xlsx');
    writeFileSync(srcFile, 'content-a');
    const r1 = toolAddFilesToBigTable(ws, 'seq', [srcFile]);
    expect(r1.added).toEqual(['a.xlsx']);
    expect(r1.overwritten).toEqual([]);
    expect(r1.skipped).toEqual([]);
    const dest = join(ws.onworkingDir, 'bigtables', 'seq', 'source', 'a.xlsx');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('content-a');

    // 同名 + 默认不覆盖 → skipped
    const r2 = toolAddFilesToBigTable(ws, 'seq', [srcFile]);
    expect(r2.skipped).toEqual(['a.xlsx']);
    expect(r2.added).toEqual([]);

    // 同名 + overwrite=true → overwritten,内容更新
    writeFileSync(srcFile, 'content-b');
    const r3 = toolAddFilesToBigTable(ws, 'seq', [srcFile], { overwrite: true });
    expect(r3.overwritten).toEqual(['a.xlsx']);
    expect(readFileSync(dest, 'utf-8')).toBe('content-b');
  });

  it('toolAddFilesToBigTable throws FILE_NOT_FOUND for a missing source file', () => {
    expect(() => toolAddFilesToBigTable(ws, 'seq', [join(dir, 'nope.xlsx')])).toThrow(/not found/);
  });

  it('toolExportBigTableCsv exports the big table to a CSV file', async () => {
    await toolRunPipeline(ws, 'c1');
    const res = toolExportBigTableCsv(ws, 'seq');
    expect(res.rows).toBe(2);
    expect(existsSync(res.file)).toBe(true);
    expect(res.file).toContain('exports');
    const header = readFileSync(res.file, 'utf-8').split('\n')[0];
    expect(header).toContain('date');
    expect(header).toContain('debit');
    expect(header).not.toContain('__source_file'); // 默认不带血缘列
    expect(readFileSync(res.file, 'utf-8')).toContain('2024-01');

    // includeLineage:true 带血缘列
    const withLineage = toolExportBigTableCsv(ws, 'seq', { includeLineage: true });
    expect(readFileSync(withLineage.file, 'utf-8').split('\n')[0]).toContain('__source_file');
  });

  it('toolExportBigTableCsv writes to a caller-supplied path', () => {
    const custom = join(dir, 'out.csv');
    const res = toolExportBigTableCsv(ws, 'seq', { path: custom });
    expect(res.file).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });

  it('toolSetMapping writes sheetName into the rule sources', () => {
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'none' },
    ], { sheetName: '202208' });
    const rule = loadRules(ws, 'seq')[0];
    expect(rule.sources[0].sheetName).toBe('202208');
  });

  it('clean imports only the configured sheet', async () => {
    // 多 sheet 文件:Sheet1 一行,202208 两行
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['日期', '借方金额'], ['2024-01', 100]]), 'Sheet1');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['日期', '借方金额'], ['2024-05', 500], ['2024-06', 600]]), '202208');
    XLSX.writeFile(wb, join(sourceDir, 'multi.xlsx'));
    // 规则指定 202208(覆盖 beforeEach 的默认规则)
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
      { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
    ], { sheetName: '202208' });
    const eng = new PipelineEngine(ws);
    const r = await eng.run('c1');
    eng.close();
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(2); // 只 202208 的 2 行(Sheet1 与 a.xlsx 无 202208 sheet,跳过)
    const preview = toolPreviewCleanResult(ws, 'seq');
    expect(preview.total).toBe(2);
    expect(preview.rows[0].date).toBe('2024-05');
  });
});
