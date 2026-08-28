import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/core/db/database';
import { runCleanPipeline } from '../../src/core/pipeline/clean-runner';
import { logger } from '../../src/core/logging';
import { arraySink } from '../../src/core/logging/sinks';
import type { LogEntry } from '../../src/core/logging/logger';
import type { CleanPipelineConfig } from '../../src/core/pipeline/config';
import type { BigTableConfig } from '../../src/core/bigtable/schema';
import { initWorkspace, type Workspace } from '../../src/core/workspace/workspace';
import { saveRule } from '../../src/core/rule/store';

describe('clean pipeline runner', () => {
  let dir: string;
  let sourceDir: string;
  let db: Database.Database;
  let cfg: CleanPipelineConfig;
  let workspace: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cl-'));
    sourceDir = join(dir, 'src');
    mkdirSync(sourceDir, { recursive: true });
    db = openDatabase(':memory:');
    workspace = initWorkspace(dir);
    const sheetWs = XLSX.utils.aoa_to_sheet([
      ['日期', '借方金额', '摘要'],
      ['2024-01-15', 123.45, '工资'],
      ['2024-02-20', 100, '报销'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetWs, 'Sheet1');
    XLSX.writeFile(wb, join(sourceDir, 'a.xlsx'));
    saveRule(workspace, 'seq', {
      name: 'seq_rule',
      display: '规则',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
        { sourceHeader: '借方金额', outputName: 'debit', included: true, order: 2, transforms: [{ kind: 'coerce_cents' }] },
        { sourceHeader: '摘要', outputName: 'note', included: true, order: 3, transforms: [{ kind: 'coerce_string' }] },
      ],
    });
    cfg = {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      createdAt: '',
    };
  });

  afterEach(() => {
    logger.clearSinks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const bigTable: BigTableConfig = {
    tableName: 'seq',
    autoIncrement: true,
    fields: [
      { name: 'date', type: 'TEXT', order: 1 },
      { name: 'debit', type: 'INTEGER', order: 2 },
      { name: 'note', type: 'TEXT', order: 3 },
    ],
  };

  it('scans, parses, maps, attaches lineage, and writes into the big table', async () => {
    const res = await runCleanPipeline(workspace, db, cfg, bigTable);
    expect(res.files).toBe(1);
    expect(res.rowsInserted).toBe(2);
    const rows = db.prepare('SELECT * FROM seq ORDER BY date').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0].debit).toBe(12345); // 元→分,整数
    expect(rows[0].note).toBe('工资');
    expect(String(rows[0].__source_file)).toContain('a.xlsx');
    expect(rows[0].__source_sheet).toBe('Sheet1');
    expect(rows[0].__source_row).toBe(2); // 数据从第 2 行起
    expect(typeof rows[0].debit).toBe('number');
  });

  it('reports write progress reaching 100', async () => {
    const stages: string[] = [];
    await runCleanPipeline(workspace, db, cfg, bigTable, (p) => stages.push(`${p.stage}:${p.percent}`));
    expect(stages.join(',')).toMatch(/write:100/);
  });

  it('imports a single file with more than 100k rows without stack overflow (allRows.push(...mapped) spread 超过 V8 参数上限)', async () => {
    const bigDir = join(dir, 'big-src');
    mkdirSync(bigDir, { recursive: true });
    const N = 150_000; // 无行数上限后大文件常见;超过 V8 对函数实参 spread 的 ~125k 上限
    const rows: unknown[][] = [['日期', '金额']];
    for (let i = 0; i < N; i++) rows.push(['2024-01-15', i]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, join(bigDir, 'big.xlsx'));

    const bigCfg: CleanPipelineConfig = { kind: 'clean', id: 'c3', label: '', bigTableFolder: 'seq', sourceDir: bigDir, createdAt: '' };
    const res = await runCleanPipeline(workspace, db, bigCfg, bigTable);
    expect(res.rowsInserted).toBe(N);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM seq').get() as { n: number }).n;
    expect(n).toBe(N);
  });

  it('re-runs with a different rule rebuilds the table (no schema drift)', async () => {
    await runCleanPipeline(workspace, db, cfg, bigTable); // 首次:date/debit/note
    // 覆盖同名规则 seq_rule 为「只有 date」→ 重跑重建表,去掉 debit/note
    saveRule(workspace, 'seq', {
      name: 'seq_rule',
      display: '精简',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
      ],
    });
    await runCleanPipeline(workspace, db, cfg, bigTable);
    const cols = db.prepare('PRAGMA table_info(seq)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('date');
    expect(names).not.toContain('debit');
    expect(names).not.toContain('note');
    // 行数仍是 2(不重复追加)
    const n = (db.prepare('SELECT COUNT(*) AS n FROM seq').get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it('throws when the source dir has no supported files', async () => {
    const empty: CleanPipelineConfig = {
      ...cfg,
      sourceDir: join(dir, 'empty'),
    };
    await expect(runCleanPipeline(workspace, db, empty, bigTable)).rejects.toThrow();
  });

  it('warns when a mapped source header is duplicated in the source', async () => {
    const dupDir = join(dir, 'dup-src');
    mkdirSync(dupDir, { recursive: true });
    const wsx = XLSX.utils.aoa_to_sheet([
      ['日期', '其他', '借方金额', '其他'],
      ['2024-01', 'x', 100, 'y'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsx, 'Sheet1');
    XLSX.writeFile(wb, join(dupDir, 'dup.xlsx'));
    saveRule(workspace, 'seq', {
      name: 'seq_dup_rule',
      display: '重复表头',
      version: 1,
      sources: [{ pattern: '**/*', headerRow: 1 }],
      fields: [
        { sourceHeader: '日期', outputName: 'date', included: true, order: 1, transforms: [{ kind: 'coerce_date' }] },
        { sourceHeader: '其他', outputName: 'other', included: true, order: 2, transforms: [{ kind: 'none' }] },
      ],
    });
    const dupCfg: CleanPipelineConfig = { kind: 'clean', id: 'c2', label: '', bigTableFolder: 'seq', sourceDir: dupDir, createdAt: '' };
    const res = await runCleanPipeline(workspace, db, dupCfg, bigTable);
    expect(res.warnings.some((w) => w.includes('其他'))).toBe(true);
  });

  it('logs clean start and complete (logging wired)', async () => {
    const out: LogEntry[] = [];
    logger.addSink(arraySink(out));
    await runCleanPipeline(workspace, db, cfg, bigTable);
    expect(out.some((e) => e.level === 'info' && e.message === 'clean start')).toBe(true);
    expect(out.some((e) => e.level === 'info' && e.message === 'clean complete')).toBe(true);
  });

  it('流式:不物化 allRows——进度无 map 阶段,write 只发一次 100,parse 到 70', async () => {
    const stages: { stage: string; percent: number }[] = [];
    await runCleanPipeline(workspace, db, cfg, bigTable, (p) => stages.push(p));
    expect(stages[0]).toEqual({ stage: 'scan', percent: 0 });
    expect(stages.some((s) => s.stage === 'map')).toBe(false);
    const parse = stages.filter((s) => s.stage === 'parse');
    expect(parse.length).toBeGreaterThan(0);
    expect(Math.max(...parse.map((s) => s.percent))).toBe(70);
    const write = stages.filter((s) => s.stage === 'write');
    expect(write).toHaveLength(1);
    expect(write[0]).toEqual({ stage: 'write', percent: 100 });
  });
});
