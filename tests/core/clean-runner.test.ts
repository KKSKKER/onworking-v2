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
    cfg = {
      kind: 'clean',
      id: 'c1',
      label: '',
      bigTableFolder: 'seq',
      sourceDir,
      headerRow: 1,
      mappings: [
        { sourceHeader: '日期', outputName: 'date', transform: 'normalize-date' },
        { sourceHeader: '借方金额', outputName: 'debit', transform: 'to-cents' },
        { sourceHeader: '摘要', outputName: 'note', transform: 'trim' },
      ],
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
    expect(rows[0].__source_row).toBe(2); // 数据从第 2 行起
    expect(typeof rows[0].debit).toBe('number');
  });

  it('reports write progress reaching 100', async () => {
    const stages: string[] = [];
    await runCleanPipeline(workspace, db, cfg, bigTable, (p) => stages.push(`${p.stage}:${p.percent}`));
    expect(stages.join(',')).toMatch(/write:100/);
  });

  it('re-runs with a different mapping rebuilds the table (no schema drift)', async () => {
    await runCleanPipeline(workspace, db, cfg, bigTable); // 首次:date/debit/note
    // 换映射:只留 date
    const cfg2: CleanPipelineConfig = { ...cfg, id: 'c2', mappings: [cfg.mappings![0]] };
    await runCleanPipeline(workspace, db, cfg2, bigTable);
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

  it('logs clean start and complete (logging wired)', async () => {
    const out: LogEntry[] = [];
    logger.addSink(arraySink(out));
    await runCleanPipeline(workspace, db, cfg, bigTable);
    expect(out.some((e) => e.level === 'info' && e.message === 'clean start')).toBe(true);
    expect(out.some((e) => e.level === 'info' && e.message === 'clean complete')).toBe(true);
  });
});
