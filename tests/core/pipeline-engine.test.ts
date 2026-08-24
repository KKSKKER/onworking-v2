import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig } from '../../src/core/bigtable/store';
import { savePipeline } from '../../src/core/pipeline/store';
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
        { name: 'date', type: 'date', order: 1 },
        { name: 'debit', type: 'cents', order: 2 },
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
    savePipeline(ws, {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      headerRow: 1,
      mappings: [
        { sourceHeader: '日期', outputName: 'date', type: 'date' },
        { sourceHeader: '借方金额', outputName: 'debit', type: 'cents' },
      ],
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
    const eng = new PipelineEngine(ws, dbPath());
    const r = await eng.run('c1');
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(2);
    eng.close();
  });

  it('recomputeAll runs clean then query; query result materialized', async () => {
    const eng = new PipelineEngine(ws, dbPath());
    const results = await eng.recomputeAll();
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const row = eng.db.prepare('SELECT total FROM "total"').get() as { total: number };
    expect(row.total).toBe(30000); // 100+200 元 → 分
    // 版本追踪已接入:运行后 .onworking 配置变更已 git 提交
    expect(gitCurrentCommit(ws)).toBeTruthy();
    eng.close();
  });

  it('recomputeByDependency on the source triggers clean then query in order', async () => {
    const eng = new PipelineEngine(ws, dbPath());
    const results = await eng.recomputeByDependency(`src:${sourceDir}`);
    expect(results.map((r) => r.pipelineId)).toEqual(['c1', 'q1']);
    expect(results.every((r) => r.ok)).toBe(true);
    eng.close();
  });

  it('recomputeMany runs selected pipelines in dependency order even if given shuffled', async () => {
    const eng = new PipelineEngine(ws, dbPath());
    const results = await eng.recomputeMany(['q1', 'c1']);
    expect(results.map((r) => r.pipelineId)).toEqual(['c1', 'q1']);
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
    const eng = new PipelineEngine(ws, dbPath());
    const r = await eng.run('bad');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    eng.close();
  });
});
