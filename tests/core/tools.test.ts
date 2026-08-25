import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { toolRunPipeline, toolRunPipelines, toolPreviewCleanResult, toolSaveTemplate, toolSetMapping, toolAddFilesToBigTable } from '../../src/core/agent/tools';
import { listTemplates } from '../../src/core/template/store';
import { listRules } from '../../src/core/rule/store';
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
});
