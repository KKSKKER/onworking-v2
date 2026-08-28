import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { initWorkspace, masterDbPath, type Workspace } from '../../src/core/workspace/workspace';
import { saveBigTableConfig, bigTableDbPath } from '../../src/core/bigtable/store';
import { openDatabase } from '../../src/core/db/database';
import { savePipeline } from '../../src/core/pipeline/store';
import { saveRule } from '../../src/core/rule/store';
import { PipelineEngine } from '../../src/core/pipeline/engine';
import { runSqlCleanPipeline } from '../../src/core/pipeline/sql-clean-runner';
import type { SqlCleanPipelineConfig } from '../../src/core/pipeline/config';
import { gitCurrentCommit } from '../../src/core/versioning/git';
import { toolQuery } from '../../src/core/agent/tools';

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

  it('sql-clean with missing resultTable fails with a clean error, not a TypeError', async () => {
    const mdb = openDatabase(':memory:');
    const cfg = {
      kind: 'sql-clean', id: 'bad', label: '', bigTables: ['seq'],
      sql: 'SELECT 1 AS x', resultTable: undefined, createdAt: '',
    } as unknown as SqlCleanPipelineConfig;
    await expect(runSqlCleanPipeline(mdb, ws, cfg)).rejects.toMatchObject({ code: 'SQLCLEAN_NO_RESULT_TABLE' });
    mdb.close();
  });

  it('sql-clean rejects non-SELECT/WITH sql (consistent with workbench)', async () => {
    const mdb = openDatabase(':memory:');
    const cfg = {
      kind: 'sql-clean', id: 'bad', label: '', bigTables: ['seq'],
      sql: 'DELETE FROM "seq"', resultTable: 'r', createdAt: '',
    } as SqlCleanPipelineConfig;
    await expect(runSqlCleanPipeline(mdb, ws, cfg)).rejects.toMatchObject({ code: 'SQLCLEAN_NOT_SELECT' });
    mdb.close();
  });

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

  it('workbench query runs write statements against master db', async () => {
    const eng = new PipelineEngine(ws);
    await eng.recomputeAll();
    const w = eng.query('UPDATE total SET total = 1 WHERE total = 30000');
    expect(w.changes).toBe(1);
    const out = eng.query('SELECT total FROM "total"');
    expect(out.rows[0].total).toBe(1);
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

  it('queryOn 无 LIMIT 自动封顶 5000 并标记 truncated;显式 limit/LIMIT 不注入;toolQuery 透传 limit', () => {
    // 主库是 master.db(不是 onworking.db):engine.queryOn 走 masterDbPath
    const db = openDatabase(masterDbPath(ws));
    db.exec('CREATE TABLE IF NOT EXISTS big (n INTEGER)');
    db.exec('DELETE FROM big');
    const ins = db.prepare('INSERT INTO big VALUES (?)');
    const tx = db.transaction(() => { for (let i = 0; i < 6000; i++) ins.run(i); });
    tx();
    db.close();

    const eng = new PipelineEngine(ws);
    const capped = eng.query('SELECT * FROM big');
    expect(capped.rows.length).toBe(5000);
    expect(capped.truncated).toBe(true);

    const withLimit = eng.query('SELECT * FROM big', 10);
    expect(withLimit.rows.length).toBe(10);
    expect(withLimit.truncated).toBe(false);

    const own = eng.query('SELECT * FROM big LIMIT 100');
    expect(own.rows.length).toBe(100);
    expect(own.truncated).toBe(false);

    const semi = eng.query('SELECT * FROM big;');
    expect(semi.rows.length).toBe(5000);
    expect(semi.truncated).toBe(true);

    const tool = toolQuery(ws, 'SELECT * FROM big', undefined, 5);
    expect(tool.rows.length).toBe(5);
    expect(tool.truncated).toBe(false);

    const toolFull = toolQuery(ws, 'SELECT * FROM big');
    expect(toolFull.rows.length).toBe(5000);
    expect(toolFull.truncated).toBe(true);
    eng.close();
  });

  it('sql-clean 游标物化 12000 行(多批事务)', async () => {
    // 直接在大表 DB 造数据(绕开大文件导入耗时);需先跑 clean 建出大表结构
    const eng = new PipelineEngine(ws);
    await eng.run('c1');
    const btPath = bigTableDbPath(ws, 'seq');
    const btdb = openDatabase(btPath, { wal: false });
    btdb.exec('DELETE FROM seq'); // 清掉 clean 已导入的源数据,保证精确 12000 行
    const ins = btdb.prepare('INSERT INTO seq (date, debit) VALUES (?, ?)');
    const tx = btdb.transaction(() => { for (let i = 0; i < 12000; i++) ins.run('2024-01', i); });
    tx();
    btdb.close();

    const r = await eng.run('m1'); // m1: SELECT date, debit FROM "bt_seq".seq → resultTable 'seq'
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(12000);
    // sql-clean 物化到总表 master.db(不是 onworking.db)
    const db = openDatabase(masterDbPath(ws));
    const n = (db.prepare('SELECT COUNT(*) AS n FROM seq').get() as { n: number }).n;
    expect(n).toBe(12000);
    db.close();
    eng.close();
  });

  it('sql-clean 空结果集仍建 (empty INTEGER)', async () => {
    savePipeline(ws, {
      kind: 'sql-clean', id: 'm2', label: '', bigTables: ['seq'],
      sql: 'SELECT date FROM "bt_seq".seq WHERE 1 = 0', resultTable: 'empty_out', createdAt: '',
    });
    const eng = new PipelineEngine(ws);
    await eng.run('c1'); // 先跑 clean 建出大表 seq(否则 ATTACH 的库没有表,SELECT 会失败)
    const r = await eng.run('m2');
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(0);
    const db = openDatabase(masterDbPath(ws));
    const cols = db.prepare('PRAGMA table_info(empty_out)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(['empty']);
    db.close();
    eng.close();
  });
});
