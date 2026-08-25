import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig, bigTableDbPath } from '../../src/core/bigtable/store';
import { openDatabase } from '../../src/core/db/database';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import { gitCurrentCommit } from '../../src/core/versioning/git';

describe('pipeline engine', () => {
  let dir: string;
  let ws: Workspace;
  let sourceDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eng-'));
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
    // SQL 清洗管线:大表 DB → 总表 DB
    savePipeline(ws, {
      kind: 'sql-clean',
      id: 'm1',
      label: '',
      bigTables: ['seq'],
      sql: 'SELECT date, debit FROM "bt_seq".seq',
      resultTable: 'seq',
      createdAt: '',
    });
    savePipeline(ws, {
      kind: 'query',
      id: 'q1',
      label: '',
      sql: 'SELECT SUM(debit) AS total FROM seq',
      dependencies: ['seq'],
      resultTable: 'total',
      createdAt: '',
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const dbPath = () => join(ws.onworkingDir, 'db', 'onworking.db');

  it('runs a single clean pipeline', async () => {
    const eng = new PipelineEngine(ws);
    const r = await eng.run('c1');
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(2);
    // 数据落在大表自己的 DB(每大表独立)
    const bt = openDatabase(bigTableDbPath(ws, 'seq'));
    const tables = bt.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.map((t) => (t as { name: string }).name)).toContain('seq');
    bt.close();
    eng.close();
  });

  it('recomputeAll runs clean → sql-clean → query; master table query works', async () => {
    const eng = new PipelineEngine(ws);
    const results = await eng.recomputeAll();
    expect(results.filter((r) => r.ok)).toHaveLength(3); // c1 + m1 + q1
    const out = eng.query('SELECT total FROM "total"');
    expect(out.rows[0].total).toBe(30000); // 100+200 元 → 分
    // 版本追踪已接入:运行后 .onworking 配置变更已 git 提交
    expect(gitCurrentCommit(ws)).toBeTruthy();
    eng.close();
  });

  it('recomputeByDependency on the source triggers clean→sql-clean→query in order', async () => {
    const eng = new PipelineEngine(ws);
    const results = await eng.recomputeByDependency(`src:${sourceDir}`);
    expect(results.map((r) => r.pipelineId)).toEqual(['c1', 'm1', 'q1']);
    expect(results.every((r) => r.ok)).toBe(true);
    eng.close();
  });

  it('recomputeMany runs selected pipelines in dependency order even if given shuffled', async () => {
    const eng = new PipelineEngine(ws);
    const results = await eng.recomputeMany(['q1', 'c1', 'm1']);
    expect(results.map((r) => r.pipelineId)).toEqual(['c1', 'm1', 'q1']);
    eng.close();
  });

  it('returns ok:false with error for a failing pipeline', async () => {
    savePipeline(ws, {
      kind: 'query',
      id: 'bad',
      label: '',
      sql: 'DELETE FROM seq',
      dependencies: [],
      resultTable: 'x',
      createdAt: '',
    });
    const eng = new PipelineEngine(ws);
    const r = await eng.run('bad');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    eng.close();
  });
});
