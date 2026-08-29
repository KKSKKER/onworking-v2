import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig, bigTableSourceDir } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { toolRunPipeline, toolRunPipelines, toolPreviewCleanResult, toolSaveTemplate, toolSetMapping, toolAddFilesToBigTable, toolExportBigTableCsv, toolExportQueryCsv, toolExportSourceCsv, toolGetBigTableContext, toolListPipelineConfigs, toolDeleteBigTable, toolDeleteSourceFile, toolQuery, toolSchemaTables } from '../../src/core/agent/tools';
import { listTemplates } from '../../src/core/template/store';
import { listRules, loadRules } from '../../src/core/rule/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import { ProjectState } from '../../src/core/state/project';

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

  it('toolSetMapping accepts a numbered sourceHeader on duplicate-header files', () => {
    // 文件放进大表自己的 source 目录(与真实 addFiles 流程一致),校验才看得到
    const src = bigTableSourceDir(ws, 'seq');
    mkdirSync(src, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(src, 'dup.xlsx'));

    const { ruleFile } = toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '姓名_2', outputName: 'name', transform: 'none' },
    ], { pattern: 'dup.xlsx', sheetName: 'Sheet1' });
    expect(ruleFile).toMatch(/\.yaml$/);
  });

  it('toolSetMapping rejects a bare sourceHeader on duplicate-header files (MAPPING_DUPLICATE_HEADER)', () => {
    const src = bigTableSourceDir(ws, 'seq');
    mkdirSync(src, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['姓名', '出生日期', '姓名', '账号', '姓名', '备注'],
      ['', '1990-01-01', '张三', 'A1', '', 'x'],
      ['', '1991-02-02', '李四', 'A2', '', 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(src, 'dup.xlsx'));

    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '姓名', outputName: 'name', transform: 'none' },
    ], { pattern: 'dup.xlsx', sheetName: 'Sheet1' })).toThrowError(/MAPPING_DUPLICATE_HEADER|姓名_1/);
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
    const res = await toolExportBigTableCsv(ws, 'seq');
    expect(res.rows).toBe(2);
    expect(existsSync(res.file)).toBe(true);
    expect(res.file).toContain('exports');
    const header = readFileSync(res.file, 'utf-8').split('\n')[0];
    expect(header).toContain('date');
    expect(header).toContain('debit');
    expect(header).not.toContain('__source_file'); // 默认不带血缘列
    expect(readFileSync(res.file, 'utf-8')).toContain('2024-01');

    // includeLineage:true 带血缘列
    const withLineage = await toolExportBigTableCsv(ws, 'seq', { includeLineage: true });
    expect(readFileSync(withLineage.file, 'utf-8').split('\n')[0]).toContain('__source_file');
  });

  it('toolExportBigTableCsv writes to a caller-supplied path', async () => {
    const custom = join(dir, 'out.csv');
    const res = await toolExportBigTableCsv(ws, 'seq', { path: custom });
    expect(res.file).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });

  it('toolDeleteBigTable removes the folder and its state record', () => {
    toolDeleteBigTable(ws, 'seq');
    expect(existsSync(join(ws.onworkingDir, 'bigtables', 'seq'))).toBe(false);
    expect(new ProjectState(ws).listBigTables()).not.toContain('seq');
  });

  it('toolDeleteBigTable rejects unsafe folder names (path traversal)', () => {
    expect(() => toolDeleteBigTable(ws, '../evil')).toThrowError(/folder 必须是简单名称/);
    expect(() => toolDeleteBigTable(ws, 'a/b')).toThrowError(/folder 必须是简单名称/);
  });

  it('toolDeleteSourceFile deletes a file inside the big table source dir', () => {
    const src = bigTableSourceDir(ws, 'seq');
    mkdirSync(src, { recursive: true });
    const f = join(src, 'x.xlsx');
    writeFileSync(f, 'x');
    toolDeleteSourceFile(ws, 'seq', f);
    expect(existsSync(f)).toBe(false);
  });

  it('toolDeleteSourceFile rejects paths outside the source dir and missing files', () => {
    expect(() => toolDeleteSourceFile(ws, 'seq', join(dir, 'outside.xlsx'))).toThrowError(/source 目录内/);
    expect(() => toolDeleteSourceFile(ws, 'seq', '不存在.xlsx')).toThrowError(/not found/);
  });

  it('toolSetMapping writes sheetName into the rule sources', () => {
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'none' },
    ], { sheetName: '202208' });
    const rule = loadRules(ws, 'seq')[0];
    expect(rule.sources[0].sheetName).toBe('202208');
  });

  it('toolSetMapping writes pattern and sheetName into the rule sources', () => {
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'none' },
    ], { pattern: 'a.xlsx', sheetName: '202208' });
    const rule = loadRules(ws, 'seq')[0];
    expect(rule.sources[0]).toMatchObject({ pattern: 'a.xlsx', headerRow: 1, sheetName: '202208' });
  });

  it('toolSetMapping rejects mappings missing outputName (silent undefined-column guard)', () => {
    // 坑:outputName 写成 targetField → 静默生成 undefined 列、写废整表。应在写规则前拒绝。
    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', targetField: '日期' } as never,
    ])).toThrowError(/outputName 必填/);
    expect(listRules(ws, 'seq').length).toBe(1); // 仅 beforeEach 的默认规则,失败未新增
  });

  it('toolSetMapping rejects empty mappings and missing sourceHeader', () => {
    expect(() => toolSetMapping(ws, 'seq', 1, [])).toThrowError(/mappings 数组/);
    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '', outputName: 'date' } as never,
    ])).toThrowError(/sourceHeader 必填/);
    expect(listRules(ws, 'seq').length).toBe(1);
  });

  it('toolSetMapping rejects invalid transform values', () => {
    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'upper' as never },
    ])).toThrowError(/transform 取值/);
    expect(listRules(ws, 'seq').length).toBe(1);
  });

  it('toolSetMapping rejects sourceHeaders absent from the matched file headers (MAPPING_HEADER_MISMATCH)', () => {
    // 把文件放进大表自己的 source 目录(与真实 addFiles 流程一致),表头 = 日期/借方金额
    const src = bigTableSourceDir(ws, 'seq');
    mkdirSync(src, { recursive: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['日期', '借方金额'], ['2024-01', 100]]), 'Sheet1');
    XLSX.writeFile(wb, join(src, 'a.xlsx'));
    // 写不存在的表头(如「01月…」前导 0 错误)→ 报错
    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '01月应付工资暂估', outputName: 'current_month_estimate', transform: 'none' },
    ], { pattern: 'a.xlsx', sheetName: 'Sheet1' })).toThrowError(/源字段在目标文件表头中不存在/);
    // 匹配实际表头的正常通过
    expect(() => toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'none' },
    ], { pattern: 'a.xlsx', sheetName: 'Sheet1' })).not.toThrow();
  });

  it('clean imports per (file, sheet) via pattern rules', async () => {
    // b.xlsx: sheet B(姓名/金额);c.xlsx: 无任何规则匹配,不应被导入
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['姓名', '金额'], ['张三', 999]]), 'B');
    XLSX.writeFile(wb, join(sourceDir, 'b.xlsx'));
    const wc = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wc, XLSX.utils.aoa_to_sheet([['日期', '借方金额'], ['2024-09', 900]]), 'Sheet1');
    XLSX.writeFile(wc, join(sourceDir, 'c.xlsx'));
    // 规则1: 只匹配 a*.xlsx 的 Sheet1 → date/debit(覆盖默认 seq_rule)
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
      { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
    ], { pattern: 'a*.xlsx', sheetName: 'Sheet1' });
    // 规则2: 只匹配 b.xlsx 的 B → name/amount
    toolSetMapping(ws, 'seq', 1, [
      { sourceHeader: '姓名', outputName: 'name', transform: 'none' },
      { sourceHeader: '金额', outputName: 'amount', transform: 'to-cents' },
    ], { ruleName: 'seq_rule_2', pattern: 'b.xlsx', sheetName: 'B' });
    expect(listRules(ws, 'seq').length).toBe(2);

    const eng = new PipelineEngine(ws);
    const r = await eng.run('c1');
    eng.close();
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(3); // a.xlsx 2 行 + b.xlsx 1 行(c.xlsx 无规则匹配,不入)
    const preview = toolPreviewCleanResult(ws, 'seq');
    expect(preview.total).toBe(3);
    expect(preview.columns).toContain('debit'); // a 的列
    expect(preview.columns).toContain('name'); // b 的列
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

  it('toolExportQueryCsv exports a query result from the master DB', async () => {
    // 先跑 clean + sql-clean,总表有数据
    const eng = new PipelineEngine(ws);
    await eng.run('c1');
    await eng.run('m1');
    eng.close();
    const res = await toolExportQueryCsv(ws, 'SELECT date, debit FROM seq ORDER BY date');
    expect(res.rows).toBe(2);
    expect(existsSync(res.file)).toBe(true);
    const header = readFileSync(res.file, 'utf-8').split('\n')[0];
    expect(header).toBe('date,debit');
    expect(readFileSync(res.file, 'utf-8')).toContain('2024-01');
  });

  it('toolExportQueryCsv rejects non-SELECT', async () => {
    await expect(toolExportQueryCsv(ws, 'DELETE FROM seq')).rejects.toThrow(/only SELECT/);
  });

  it('toolListPipelineConfigs returns all pipeline configs', () => {
    const cfgs = toolListPipelineConfigs(ws);
    const ids = cfgs.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['c1', 'm1']));
  });

  it('toolExportSourceCsv exports a source file sheet to CSV', async () => {
    const res = await toolExportSourceCsv(ws, join(sourceDir, 'a.xlsx'), { sheetName: 'Sheet1', headerRow: 1 });
    expect(res.rows).toBe(2);
    expect(existsSync(res.file)).toBe(true);
    expect(readFileSync(res.file, 'utf-8').split('\n')[0]).toBe('日期,借方金额');
  });

  it('toolGetBigTableContext returns folder, sourceDir, config, rules and related pipelines', () => {
    const ctx = toolGetBigTableContext(ws, 'seq');
    expect(ctx.folder).toBe('seq');
    expect(ctx.sourceDir).toMatch(/bigtables[\\/]seq[\\/]source/);
    expect(ctx.config.tableName).toBe('seq');
    expect(ctx.rules.length).toBe(1);
    const ids = ctx.pipelines.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['c1', 'm1'])); // clean(直接引用)+ sql-clean(引用其表)
  });

  it('toolSchemaTables / toolQuery operate on a big table DB when folder given (workbench dual-source)', async () => {
    const eng = new PipelineEngine(ws);
    const r = await eng.run('c1');
    eng.close();
    expect(r.ok).toBe(true);
    const tables = toolSchemaTables(ws, 'seq');
    expect(tables.map((t) => t.name)).toContain('seq');
    const out = toolQuery(ws, 'SELECT date, debit FROM seq ORDER BY date', 'seq');
    expect(out.rows.length).toBeGreaterThan(0);
  });
});
